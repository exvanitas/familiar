//! The one owner of every saved address's and every guarded request's state. See "5c. The guarded
//! fetch" in docs/shell-design.md. Plain logic, so every state is tested against every event here;
//! the exe keeps one `Ledger` behind one lock, which it never holds across a wait, and acts on
//! what each transition returns.
//!
//! - An address is `Saved`, `Removing` or `Removed`. `Removing` begins a removal: it ends every
//!   request under the address with `revoked` and refuses new ones and new key writes. It lasts
//!   until the list without the address is durably written; a failed write leaves it `Removing`,
//!   still refusing, and a retry continues from there.
//! - A request is `Registered` (its address checked, nothing touched yet), `Resolving` (its key
//!   read and its name looked up, under a deadline), `Sending`, `Streaming`, or `Ended` with a
//!   kind, or `Done` at the real end of its body. Registration, every step, a cancel and a revocation are each one transition, so a
//!   cancel can't fall between a check and a registration: a cancel for an id not yet registered
//!   leaves the id ended, and its registration is refused.
//! - A key write for an address is counted while it runs. It may start only while the address is
//!   `Saved`, and a removal deletes the key only once no write is running, so a write and a
//!   removal are always ordered.
//! - Each registered request's transport is one task that says when it has terminated (its
//!   connection dropped, nothing more can be sent). Ending a request is a transition; its
//!   termination is another, and a cancel or a removal waits for it (`running`, `settled`) before
//!   it returns or goes on.
//! - A removal is made durable before anything irreversible: the address is written to the list
//!   as removing, then its key is deleted, then the list is written without it (`run_removal`). An
//!   entry loaded as removing starts `Removing`, refusing everything, and the removal is finished.

use crate::fetch::FetchError;
use std::collections::HashMap;
use std::time::Duration;

/// How long a request may spend reading its key and looking its name up before it's sent.
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddrState {
    Saved,
    Removing,
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReqState {
    Registered,
    Resolving,
    Sending,
    Streaming,
    Ended(FetchError),
    /// Its body read to the real end.
    Done,
}

impl ReqState {
    fn over(self) -> bool {
        matches!(self, ReqState::Ended(_) | ReqState::Done)
    }
}

/// Why a key write can't start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteRefused {
    /// No such address, or it's gone.
    NotSaved,
    /// Its removal has begun.
    Removing,
}

struct Addr {
    state: AddrState,
    writes: u32,
}

struct Req {
    address: Option<String>,
    state: ReqState,
    /// Whether a `net_fetch` has used this id. An id is never used twice.
    used: bool,
    /// Whether its transport task is still running: true from registration until it says it has
    /// terminated.
    transport: bool,
}

#[derive(Default)]
pub struct Ledger {
    addrs: HashMap<String, Addr>,
    reqs: HashMap<String, Req>,
}

impl Ledger {
    /// A saved address, from the list at start or once a new one is durably written.
    pub fn saved(&mut self, id: &str) {
        self.addrs.entry(id.to_string()).or_insert(Addr { state: AddrState::Saved, writes: 0 });
    }

    /// An address the list holds as being removed: it starts `Removing`.
    pub fn loaded_removing(&mut self, id: &str) {
        self.addrs.insert(id.to_string(), Addr { state: AddrState::Removing, writes: 0 });
    }

    pub fn address(&self, id: &str) -> Option<AddrState> {
        self.addrs.get(id).map(|a| a.state)
    }

    pub fn request(&self, id: &str) -> Option<ReqState> {
        self.reqs.get(id).map(|r| r.state)
    }

    fn open(&self) -> usize {
        self.reqs.values().filter(|r| r.used && !r.state.over()).count()
    }

    /// A new request under `address`, if it may start: its id unused and not cancelled already,
    /// the address `Saved` and of a kind the fetch serves, and fewer than `max_open` open.
    pub fn register(&mut self, id: &str, address: &str, fetchable: bool, max_open: usize) -> Result<(), FetchError> {
        if let Some(r) = self.reqs.get_mut(id) {
            if r.used {
                return Err(FetchError::Invalid);
            }
            // Cancelled before it arrived.
            r.used = true;
            return Err(match r.state {
                ReqState::Ended(e) => e,
                _ => FetchError::Invalid,
            });
        }
        let refusal = match self.addrs.get(address).map(|a| a.state) {
            Some(AddrState::Saved) if fetchable => None,
            Some(AddrState::Removing) => Some(FetchError::Revoked),
            _ => Some(FetchError::NotSaved),
        };
        if let Some(e) = refusal.or((self.open() >= max_open).then_some(FetchError::Busy)) {
            self.reqs.insert(id.to_string(), Req { address: Some(address.to_string()), state: ReqState::Ended(e), used: true, transport: false });
            return Err(e);
        }
        self.reqs.insert(id.to_string(), Req { address: Some(address.to_string()), state: ReqState::Registered, used: true, transport: true });
        Ok(())
    }

    /// The request's transport task has terminated: its connection is dropped and nothing more
    /// can be sent. Ends the request too, if it hadn't ended.
    pub fn terminated(&mut self, id: &str) {
        if let Some(r) = self.reqs.get_mut(id) {
            if !r.state.over() {
                r.state = ReqState::Ended(FetchError::Cancelled);
            }
            r.transport = false;
        }
    }

    /// Whether the request's transport is still running, so a cancel must wait for it.
    pub fn running(&self, id: &str) -> bool {
        self.reqs.get(id).is_some_and(|r| r.transport)
    }

    /// Whether a removal may go on: no key write is running for the address, and every request
    /// under it has terminated.
    pub fn settled(&self, address: &str) -> bool {
        self.writes(address) == 0 && !self.reqs.values().any(|r| r.transport && r.address.as_deref() == Some(address))
    }

    /// One step forward: `Registered` to `Resolving` or `Sending`, `Resolving` to `Sending`,
    /// `Sending` to `Streaming`. Checked on entering every step: an ended request says why.
    pub fn advance(&mut self, id: &str, to: ReqState) -> Result<(), FetchError> {
        let r = self.reqs.get_mut(id).ok_or(FetchError::Invalid)?;
        let allowed = matches!(
            (r.state, to),
            (ReqState::Registered, ReqState::Resolving) | (ReqState::Registered, ReqState::Sending) | (ReqState::Resolving, ReqState::Sending) | (ReqState::Sending, ReqState::Streaming)
        );
        match r.state {
            ReqState::Ended(e) => Err(e),
            ReqState::Done => Err(FetchError::Invalid),
            _ if allowed => {
                r.state = to;
                Ok(())
            }
            _ => Err(FetchError::Invalid),
        }
    }

    /// Whether the request may go on, checked on leaving a wait: its state, or why it ended.
    pub fn check(&self, id: &str) -> Result<ReqState, FetchError> {
        match self.request(id) {
            Some(ReqState::Ended(e)) => Err(e),
            Some(ReqState::Done) | None => Err(FetchError::Invalid),
            Some(s) => Ok(s),
        }
    }

    /// Ends a request with `why`, the first ending kept. True if it was open, so its connection
    /// has to be dropped.
    pub fn end(&mut self, id: &str, why: FetchError) -> bool {
        match self.reqs.get_mut(id) {
            Some(r) if !r.state.over() => {
                r.state = ReqState::Ended(why);
                true
            }
            _ => false,
        }
    }

    /// The body was read to its real end.
    pub fn finish(&mut self, id: &str) {
        if let Some(r) = self.reqs.get_mut(id) {
            if !r.state.over() {
                r.state = ReqState::Done;
            }
        }
    }

    /// `net_cancel`: an open request ends `cancelled` (true: drop its connection); an id not yet
    /// registered is ended now, so its registration is refused. `valid` is whether the id has the
    /// form of one.
    pub fn cancel(&mut self, id: &str, valid: bool) -> bool {
        if self.reqs.contains_key(id) {
            return self.end(id, FetchError::Cancelled);
        }
        if valid {
            self.reqs.insert(id.to_string(), Req { address: None, state: ReqState::Ended(FetchError::Cancelled), used: false, transport: false });
        }
        false
    }

    /// A removal begins, or a failed one is retried: the address becomes `Removing`, and every
    /// open request under it ends `revoked`. Returns those requests, whose connections have to be
    /// dropped.
    pub fn begin_remove(&mut self, address: &str) -> Result<Vec<String>, FetchError> {
        let a = self.addrs.get_mut(address).ok_or(FetchError::NotSaved)?;
        match a.state {
            AddrState::Removed => return Err(FetchError::NotSaved),
            AddrState::Saved | AddrState::Removing => a.state = AddrState::Removing,
        }
        let ended: Vec<String> = self
            .reqs
            .iter()
            .filter(|(_, r)| r.address.as_deref() == Some(address) && !r.state.over())
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ended {
            self.end(id, FetchError::Revoked);
        }
        Ok(ended)
    }

    /// Whether a removal may delete the key now: no key write for the address is still running.
    pub fn writes(&self, address: &str) -> u32 {
        self.addrs.get(address).map_or(0, |a| a.writes)
    }

    /// The list without the address is durably written: it's gone.
    pub fn removed(&mut self, address: &str) {
        if let Some(a) = self.addrs.get_mut(address) {
            if a.state == AddrState::Removing {
                a.state = AddrState::Removed;
            }
        }
    }

    /// A key write for an address may start only while it's `Saved`.
    pub fn begin_write(&mut self, address: &str) -> Result<(), WriteRefused> {
        match self.addrs.get_mut(address) {
            Some(a) if a.state == AddrState::Saved => {
                a.writes += 1;
                Ok(())
            }
            Some(a) if a.state == AddrState::Removing => Err(WriteRefused::Removing),
            _ => Err(WriteRefused::NotSaved),
        }
    }

    /// A key write is over, stored or not.
    pub fn end_write(&mut self, address: &str) {
        if let Some(a) = self.addrs.get_mut(address) {
            a.writes = a.writes.saturating_sub(1);
        }
    }
}

/// The durable steps of a removal, each safe to repeat.
pub trait RemovalStore {
    /// Writes the list with the address marked as being removed.
    fn mark_removing(&mut self, id: &str) -> Result<(), String>;
    fn delete_key(&mut self, id: &str) -> Result<(), String>;
    /// Writes the list without the address.
    fn write_without(&mut self, id: &str) -> Result<(), String>;
}

/// A removal's durable part, in the one safe order: marked first, so that whatever happens after,
/// a restart finds it removing rather than saved without its key.
pub fn run_removal(store: &mut impl RemovalStore, id: &str) -> Result<(), String> {
    store.mark_removing(id)?;
    store.delete_key(id)?;
    store.write_without(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use FetchError::*;

    const A: &str = "a";
    const R: &str = "r1";

    fn with_address() -> Ledger {
        let mut l = Ledger::default();
        l.saved(A);
        l
    }

    /// A ledger with one request in `state`, under a saved address.
    fn at(state: ReqState) -> Ledger {
        let mut l = with_address();
        l.register(R, A, true, 32).unwrap();
        match state {
            ReqState::Registered => {}
            ReqState::Resolving => l.advance(R, ReqState::Resolving).unwrap(),
            ReqState::Sending => l.advance(R, ReqState::Sending).unwrap(),
            ReqState::Streaming => {
                l.advance(R, ReqState::Sending).unwrap();
                l.advance(R, ReqState::Streaming).unwrap();
            }
            ReqState::Ended(e) => assert!(l.end(R, e)),
            ReqState::Done => {
                l.advance(R, ReqState::Sending).unwrap();
                l.advance(R, ReqState::Streaming).unwrap();
                l.finish(R);
            }
        }
        l
    }

    const LIVE: [ReqState; 4] = [ReqState::Registered, ReqState::Resolving, ReqState::Sending, ReqState::Streaming];

    #[test]
    fn registration_checks_the_address_the_id_and_the_count() {
        let mut l = with_address();
        assert_eq!(l.register(R, "nowhere", true, 32), Err(NotSaved));
        assert_eq!(l.register("r2", A, false, 32), Err(NotSaved), "a peer isn't fetched");
        assert_eq!(l.register("r3", A, true, 32), Ok(()));
        assert_eq!(l.register("r3", A, true, 32), Err(Invalid), "an id is used once");
        assert_eq!(l.register(R, A, true, 32), Err(Invalid), "a refused id is used too");
        assert_eq!(l.register("r4", A, true, 1), Err(Busy));
        l.end("r3", Network);
        assert_eq!(l.register("r5", A, true, 1), Ok(()), "an ended request isn't open");
    }

    #[test]
    fn a_cancel_before_registration_refuses_it_and_the_id_stays_used() {
        let mut l = with_address();
        assert!(!l.cancel(R, true));
        assert_eq!(l.register(R, A, true, 32), Err(Cancelled));
        assert_eq!(l.register(R, A, true, 32), Err(Invalid));
        assert!(!l.cancel("bad id", false));
        assert_eq!(l.request("bad id"), None, "an id of the wrong form leaves nothing behind");
    }

    #[test]
    fn a_cancel_in_every_live_state_ends_it_and_every_later_step_says_cancelled() {
        for s in LIVE {
            let mut l = at(s);
            assert!(l.cancel(R, true), "{s:?}: the connection has to be dropped");
            assert_eq!(l.check(R), Err(Cancelled), "{s:?}");
            for to in LIVE {
                assert_eq!(l.advance(R, to), Err(Cancelled), "{s:?} then {to:?}");
            }
            assert!(!l.cancel(R, true), "{s:?}: a second cancel does nothing");
        }
    }

    #[test]
    fn a_cancel_after_the_end_keeps_the_first_ending() {
        let mut l = at(ReqState::Ended(TooLarge));
        assert!(!l.cancel(R, true));
        assert_eq!(l.check(R), Err(TooLarge));
    }

    #[test]
    fn revocation_ends_every_live_state_and_only_that_address() {
        for s in LIVE {
            let mut l = at(s);
            l.saved("b");
            l.register("other", "b", true, 32).unwrap();
            assert_eq!(l.begin_remove(A), Ok(vec![R.to_string()]), "{s:?}");
            assert_eq!(l.check(R), Err(Revoked), "{s:?}");
            assert_eq!(l.advance(R, ReqState::Streaming), Err(Revoked), "{s:?}");
            assert_eq!(l.check("other"), Ok(ReqState::Registered));
        }
    }

    #[test]
    fn removing_refuses_new_requests_and_key_writes_until_the_write_is_durable() {
        let mut l = at(ReqState::Streaming);
        l.begin_remove(A).unwrap();
        assert_eq!(l.address(A), Some(AddrState::Removing));
        assert_eq!(l.register("r2", A, true, 32), Err(Revoked));
        assert_eq!(l.begin_write(A), Err(WriteRefused::Removing));
        l.removed(A);
        assert_eq!(l.address(A), Some(AddrState::Removed));
        assert_eq!(l.register("r3", A, true, 32), Err(NotSaved));
        assert_eq!(l.begin_write(A), Err(WriteRefused::NotSaved));
        assert_eq!(l.begin_remove(A), Err(NotSaved));
    }

    #[test]
    fn a_failed_write_stays_removing_and_a_retry_continues_from_there() {
        let mut l = with_address();
        l.begin_remove(A).unwrap();
        // The list couldn't be written: nothing is called, so the address stays `Removing`.
        assert_eq!(l.address(A), Some(AddrState::Removing));
        assert_eq!(l.register(R, A, true, 32), Err(Revoked), "still refused after the failure");
        assert_eq!(l.begin_remove(A), Ok(vec![]), "the retry continues");
        l.removed(A);
        assert_eq!(l.address(A), Some(AddrState::Removed));
    }

    #[test]
    fn a_key_write_and_a_removal_are_ordered() {
        let mut l = with_address();
        l.begin_write(A).unwrap();
        l.begin_remove(A).unwrap();
        assert_eq!(l.writes(A), 1, "the removal waits to delete the key");
        l.end_write(A);
        assert_eq!(l.writes(A), 0, "now it may");
        assert_eq!(l.begin_write(A), Err(WriteRefused::Removing), "and no new write starts");
        l.end_write(A);
        assert_eq!(l.writes(A), 0, "an extra end never goes below none");
    }

    #[test]
    fn the_deadline_ends_a_resolving_request_as_timeout() {
        let mut l = at(ReqState::Resolving);
        assert!(l.end(R, Timeout));
        assert_eq!(l.advance(R, ReqState::Sending), Err(Timeout));
        assert!(!l.cancel(R, true), "a cancel after it changes nothing");
        assert_eq!(l.check(R), Err(Timeout));
        assert_eq!(RESOLVE_DEADLINE, Duration::from_secs(20));
    }

    #[test]
    fn a_finished_request_is_closed_to_every_event() {
        let mut l = at(ReqState::Done);
        assert!(!l.cancel(R, true));
        assert!(!l.end(R, Network));
        assert_eq!(l.check(R), Err(Invalid));
        assert_eq!(l.advance(R, ReqState::Streaming), Err(Invalid));
        assert_eq!(l.register("r2", A, true, 0), Err(Busy), "the count still applies");
        assert_eq!(l.begin_remove(A), Ok(vec![]), "nothing left to revoke");
        let mut l = at(ReqState::Done);
        assert_eq!(l.register("r3", A, true, 1), Ok(()), "a finished request isn't open");
    }

    #[test]
    fn a_cancel_and_a_removal_wait_for_the_transport_to_terminate() {
        for s in LIVE {
            let mut l = at(s);
            assert!(l.cancel(R, true));
            assert_eq!(l.check(R), Err(Cancelled), "{s:?}: ended at once");
            assert!(l.running(R), "{s:?}: but the cancel can't return yet");
            l.terminated(R);
            assert!(!l.running(R), "{s:?}: now it can");
            let mut l = at(s);
            l.begin_remove(A).unwrap();
            assert!(!l.settled(A), "{s:?}: the removal waits for the transport");
            l.terminated(R);
            assert!(l.settled(A), "{s:?}: and goes on once it has terminated");
        }
        // A request that ended on its own still holds a removal until its task is done.
        let mut l = at(ReqState::Streaming);
        l.finish(R);
        l.begin_remove(A).unwrap();
        assert!(!l.settled(A));
        l.terminated(R);
        assert!(l.settled(A));
        // A write holds it too.
        let mut l = with_address();
        l.begin_write(A).unwrap();
        l.begin_remove(A).unwrap();
        assert!(!l.settled(A));
        l.end_write(A);
        assert!(l.settled(A));
        // A transport that terminates by itself ends its request.
        let mut l = at(ReqState::Sending);
        l.terminated(R);
        assert_eq!(l.check(R), Err(Cancelled));
        // Nothing waits on an id that never registered.
        let mut l = with_address();
        l.cancel("r9", true);
        assert!(!l.running("r9"));
    }

    /// A list file and a credential store, where any step can fail, and a restart reads what's
    /// durable.
    #[derive(Clone, Default)]
    struct Disk {
        /// id -> marked removing
        file: HashMap<String, bool>,
        keys: std::collections::HashSet<String>,
        fail_at: Option<usize>,
        steps: usize,
    }
    impl Disk {
        fn step(&mut self) -> Result<(), String> {
            self.steps += 1;
            if self.fail_at == Some(self.steps) {
                return Err(format!("step {} failed", self.steps));
            }
            Ok(())
        }
        /// A restart: the ledger as the exe loads it.
        fn restart(&self) -> Ledger {
            let mut l = Ledger::default();
            for (id, removing) in &self.file {
                if *removing {
                    l.loaded_removing(id);
                } else {
                    l.saved(id);
                }
            }
            l
        }
    }
    impl RemovalStore for Disk {
        fn mark_removing(&mut self, id: &str) -> Result<(), String> {
            self.step()?;
            self.file.insert(id.to_string(), true);
            Ok(())
        }
        fn delete_key(&mut self, id: &str) -> Result<(), String> {
            self.step()?;
            self.keys.remove(id);
            Ok(())
        }
        fn write_without(&mut self, id: &str) -> Result<(), String> {
            self.step()?;
            self.file.remove(id);
            Ok(())
        }
    }

    #[test]
    fn a_removal_that_stops_at_any_step_never_comes_back_saved_without_its_key() {
        for fail_at in [Some(1), Some(2), Some(3), None] {
            let mut d = Disk { fail_at, ..Disk::default() };
            d.file.insert(A.into(), false);
            d.keys.insert(A.into());
            let r = run_removal(&mut d, A);
            assert_eq!(r.is_ok(), fail_at.is_none(), "{fail_at:?}");
            // Restarted from what's on disk.
            let mut l = d.restart();
            match l.address(A) {
                Some(AddrState::Saved) => assert!(d.keys.contains(A), "{fail_at:?}: saved again, so its key must still be there"),
                Some(AddrState::Removing) => {
                    assert_eq!(l.register(R, A, true, 32), Err(Revoked), "{fail_at:?}: refused until it's finished");
                    // Startup finishes it.
                    d.fail_at = None;
                    run_removal(&mut d, A).unwrap();
                    assert!(!d.file.contains_key(A) && !d.keys.contains(A), "{fail_at:?}: finished");
                }
                None => assert!(!d.keys.contains(A), "{fail_at:?}: gone, and its key too"),
                Some(AddrState::Removed) => unreachable!(),
            }
            // Only a failure before anything durable leaves it saved.
            assert_eq!(d.restart().address(A).is_some_and(|s| s == AddrState::Saved), fail_at == Some(1), "{fail_at:?}");
        }
    }

    #[test]
    fn steps_only_go_forward() {
        let mut l = at(ReqState::Streaming);
        assert_eq!(l.advance(R, ReqState::Sending), Err(Invalid));
        let mut l = at(ReqState::Registered);
        assert_eq!(l.advance(R, ReqState::Streaming), Err(Invalid));
        assert_eq!(l.advance("nobody", ReqState::Sending), Err(Invalid));
    }

    #[test]
    fn registration_and_cancel_from_two_threads_never_leave_a_request_running_after_its_cancel() {
        use std::sync::{Arc, Barrier, Mutex};
        for i in 0..2000 {
            let l = Arc::new(Mutex::new(with_address()));
            let id = format!("r{i}");
            let b = Arc::new(Barrier::new(2));
            let (l2, b2, id2) = (l.clone(), b.clone(), id.clone());
            let t = std::thread::spawn(move || {
                b2.wait();
                l2.lock().unwrap().cancel(&id2, true)
            });
            b.wait();
            let registered = l.lock().unwrap().register(&id, A, true, 32);
            let _ = t.join().unwrap();
            // Whichever came first, the request is ended now.
            assert_eq!(l.lock().unwrap().check(&id), Err(Cancelled), "try {i}: registered {registered:?}");
        }
    }
}
