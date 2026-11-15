//! One setup's server, as a state machine. In the exe, each setup has one actor that owns
//! everything about it (the approved launch, the run, its job, its stdin, its sweep record) and
//! handles one message at a time; this is its plain logic, so every state meets every message in a
//! test. See "5b. Starting a local MCP server" in docs/shell-design.md.
//!
//! Two properties hold by construction, and a property test checks them over thousands of random
//! sequences:
//! - **Every caller is answered exactly once.** Each command carries a token, and each token
//!   ends in exactly one `Reply` (or, for a write, one `Forward` to the writer, which answers it).
//! - **Every report carries its generation.** Each start attempt gets a new generation, which is
//!   also the run's id. A report, a deadline, a stop or a write for another generation is dropped,
//!   so nothing meant for run A ever touches run B. A stale `Spawned` is answered `Abort`, so the
//!   child it names is ended rather than left waiting.
//!
//! - **A forget succeeds only once the approval's removal is durable.** A removal that fails is
//!   kept: the setup stays `Forgetting`, its forgets answer the failure or retry the removal, and
//!   no start is admitted (`revoked`) until a removal succeeds. A start then retries the removal
//!   itself, and asks only if it succeeded, so an approval the person asked to forget is never
//!   used again.
//!
//! States: `Idle` (nothing runs); `Asking` (the walk, the approval check, maybe the dialog);
//! `Starting` (the approval stored, the child being made in its job); `Running`; `Stopping` (input
//! closed, the job ended at the deadline); `Forgetting` (the approval being removed, an old
//! attempt still in flight, or a removal that failed: starts are refused `revoked`). No state
//! lasts without an event pending that leaves it, except `Idle`, `Running` and `Forgetting` after
//! a failed removal, which a forget or a start leaves by retrying it.
//!
//! The approval store is synchronous to the actor: `StoreApproval(g)` is answered by `Stored(g, _)`
//! before any other message, so a forget can't fall between a store and its answer.

pub type Token = u64;
pub type Gen = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Asking,
    Starting,
    Running,
    Stopping,
    Forgetting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    Start(Token),
    Stop(Token, Gen),
    Forget(Token),
    Write(Token, Gen),
    /// The walk and the ask: approved, and whether the approval must be stored; or refused.
    AskDone(Gen, Result<bool, &'static str>),
    Stored(Gen, bool),
    /// The child exists, suspended, in its job, waiting for `Go` or `Abort`.
    Spawned(Gen),
    Resumed(Gen),
    /// The start failed at the spawn, the record, the job or the resume, or was aborted, and the
    /// child is reaped.
    SpawnFailed(Gen, &'static str),
    /// The program ended, its job too, and its output drained.
    Exited(Gen),
    Deadline(Gen),
    Removed(bool),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    BeginAsk(Gen),
    StoreApproval(Gen),
    BeginSpawn(Gen),
    Go(Gen),
    Abort(Gen),
    CloseInput(Gen),
    ArmDeadline(Gen),
    Terminate(Gen),
    RemoveApproval,
    /// A write goes to the run's writer, which answers it.
    Forward(Token),
    /// A start's answer is `Ok(Some(gen))`, the run's id; the others' `Ok(None)`.
    Reply(Token, Result<Option<Gen>, &'static str>),
}

use Effect::*;
use State::*;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Machine {
    state: StateCell,
    next: Gen,
    /// The attempt in flight, or the run.
    current: Option<Gen>,
    start: Option<Token>,
    stops: Vec<Token>,
    forgets: Vec<Token>,
    forget_after_stop: bool,
    removing: bool,
    /// The last removal failed: the approval may still be on disk, so the revocation isn't
    /// durable. Kept until a removal succeeds.
    unrevoked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StateCell(State);

impl Default for StateCell {
    fn default() -> Self {
        StateCell(Idle)
    }
}

impl Machine {
    pub fn state(&self) -> State {
        self.state.0
    }

    /// The run's id while there's a run.
    pub fn run(&self) -> Option<Gen> {
        matches!(self.state(), Running | Stopping).then_some(self.current).flatten()
    }

    /// Whether a start would begin an attempt now (so the exe takes a slot for it): from `Idle`,
    /// or from a failed removal with nothing in flight, which the start retries first.
    pub fn admits_start(&self) -> bool {
        self.state() == Idle || self.retry_ready()
    }

    fn retry_ready(&self) -> bool {
        self.state() == Forgetting && self.unrevoked && !self.removing && self.current.is_none()
    }

    /// Whether this holds a slot: anything with an attempt or a run in flight.
    pub fn holds_slot(&self) -> bool {
        self.current.is_some()
    }

    fn set(&mut self, s: State) {
        self.state.0 = s;
    }

    fn is(&self, g: Gen) -> bool {
        self.current == Some(g)
    }

    fn reply_start(&mut self, r: Result<Option<Gen>, &'static str>) -> Vec<Effect> {
        self.start.take().map(|t| vec![Reply(t, r)]).unwrap_or_default()
    }

    fn begin_forgetting(&mut self) -> Vec<Effect> {
        self.set(Forgetting);
        self.removing = true;
        vec![RemoveApproval]
    }

    /// The attempt or run is over: idle, unless a forget is under way or waiting.
    fn attempt_over(&mut self, mut fx: Vec<Effect>) -> Vec<Effect> {
        self.current = None;
        for t in self.stops.drain(..) {
            fx.push(Reply(t, Ok(None)));
        }
        if std::mem::take(&mut self.forget_after_stop) {
            fx.extend(self.begin_forgetting());
        } else if !(self.state() == Forgetting && (self.removing || self.unrevoked)) {
            self.set(Idle);
        }
        fx
    }

    fn begin_attempt(&mut self, t: Token) -> Vec<Effect> {
        let g = self.next;
        self.next += 1;
        self.current = Some(g);
        self.start = Some(t);
        self.set(Asking);
        vec![BeginAsk(g)]
    }

    pub fn handle(&mut self, msg: Msg) -> Vec<Effect> {
        let s = self.state();
        match msg {
            // ---------- commands ----------
            Msg::Start(t) => match s {
                Idle => self.begin_attempt(t),
                // A failed removal, nothing in flight: the start retries it, and goes on only if
                // it's durable.
                Forgetting if self.retry_ready() => {
                    self.start = Some(t);
                    self.begin_forgetting()
                }
                Forgetting => vec![Reply(t, Err("revoked"))],
                _ => vec![Reply(t, Err("busy"))],
            },
            Msg::Stop(t, g) => match s {
                Running if self.is(g) => {
                    self.stops.push(t);
                    self.set(Stopping);
                    vec![CloseInput(g), ArmDeadline(g)]
                }
                Stopping if self.is(g) => {
                    self.stops.push(t);
                    vec![]
                }
                _ => vec![Reply(t, Err("missing"))],
            },
            Msg::Write(t, g) => match s {
                Running if self.is(g) => vec![Forward(t)],
                _ => vec![Reply(t, Err("missing"))],
            },
            Msg::Forget(t) => match s {
                Idle | Asking | Starting => {
                    self.forgets.push(t);
                    self.begin_forgetting()
                }
                Running => {
                    let g = self.current.expect("a run");
                    self.forgets.push(t);
                    self.forget_after_stop = true;
                    self.set(Stopping);
                    vec![CloseInput(g), ArmDeadline(g)]
                }
                Stopping => {
                    self.forgets.push(t);
                    self.forget_after_stop = true;
                    vec![]
                }
                // A removal under way answers it too; one already done answers it now, since the
                // approval is gone and the old attempt in flight will be revoked.
                Forgetting if self.removing => {
                    self.forgets.push(t);
                    vec![]
                }
                // The last removal failed: this forget retries it, and answers its result.
                Forgetting if self.unrevoked => {
                    self.forgets.push(t);
                    self.begin_forgetting()
                }
                Forgetting => vec![Reply(t, Ok(None))],
            },

            // ---------- reports ----------
            Msg::Removed(ok) => {
                if !(s == Forgetting && self.removing) {
                    return vec![];
                }
                self.removing = false;
                // Kept, so no later forget can report success over it and no start can use the
                // approval it left.
                self.unrevoked = !ok;
                let r = if ok { Ok(None) } else { Err("failed") };
                let mut fx: Vec<Effect> = self.forgets.drain(..).map(|t| Reply(t, r)).collect();
                if self.current.is_none() {
                    // A start that retried the removal: it asks now, or it's refused.
                    let waiting = self.start.take();
                    match (ok, waiting) {
                        (true, Some(t)) => fx.extend(self.begin_attempt(t)),
                        (true, None) => self.set(Idle),
                        (false, Some(t)) => fx.push(Reply(t, Err("revoked"))),
                        (false, None) => {}
                    }
                }
                fx
            }
            Msg::AskDone(g, r) if self.is(g) => match (s, r) {
                (Asking, Ok(true)) => vec![StoreApproval(g)],
                (Asking, Ok(false)) => {
                    self.set(Starting);
                    vec![BeginSpawn(g)]
                }
                (Asking, Err(kind)) => {
                    let fx = self.reply_start(Err(kind));
                    self.attempt_over(fx)
                }
                (Forgetting, _) => {
                    let fx = self.reply_start(Err("revoked"));
                    self.attempt_over(fx)
                }
                _ => vec![],
            },
            Msg::Stored(g, ok) if self.is(g) && s == Asking => {
                if ok {
                    self.set(Starting);
                    vec![BeginSpawn(g)]
                } else {
                    let fx = self.reply_start(Err("failed"));
                    self.attempt_over(fx)
                }
            }
            Msg::Spawned(g) => match s {
                Starting if self.is(g) => {
                    self.set(Running);
                    vec![Go(g)]
                }
                // Anything else, a forget meanwhile or a stale generation: ended before it runs.
                _ => vec![Abort(g)],
            },
            Msg::Resumed(g) if self.is(g) && matches!(s, Running | Stopping) => self.reply_start(Ok(Some(g))),
            Msg::SpawnFailed(g, kind) if self.is(g) => {
                let kind = if s == Forgetting { "revoked" } else { kind };
                let fx = self.reply_start(Err(kind));
                self.attempt_over(fx)
            }
            Msg::Exited(g) if self.is(g) && matches!(s, Running | Stopping) => {
                let fx = self.reply_start(Err("start-failed"));
                self.attempt_over(fx)
            }
            Msg::Deadline(g) if self.is(g) && s == Stopping => vec![Terminate(g)],
            // A report for another generation, or for a state it no longer fits: dropped.
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    fn at(state: State) -> Machine {
        let mut m = Machine::default();
        let path: Vec<Msg> = match state {
            Idle => vec![],
            Asking => vec![Msg::Start(1)],
            Starting => vec![Msg::Start(1), Msg::AskDone(0, Ok(false))],
            Running => vec![Msg::Start(1), Msg::AskDone(0, Ok(false)), Msg::Spawned(0), Msg::Resumed(0)],
            Stopping => vec![Msg::Start(1), Msg::AskDone(0, Ok(false)), Msg::Spawned(0), Msg::Resumed(0), Msg::Stop(2, 0)],
            Forgetting => vec![Msg::Forget(1)],
        };
        for msg in path {
            m.handle(msg);
        }
        assert_eq!(m.state(), state);
        m
    }

    const ALL: [State; 6] = [Idle, Asking, Starting, Running, Stopping, Forgetting];

    #[test]
    fn a_start_from_each_state() {
        for s in ALL {
            let mut m = at(s);
            let fx = m.handle(Msg::Start(9));
            match s {
                Idle => assert_eq!((m.state(), fx), (Asking, vec![BeginAsk(0)])),
                Forgetting => assert_eq!((m.state(), fx), (Forgetting, vec![Reply(9, Err("revoked"))])),
                _ => assert_eq!((m.state(), fx), (s, vec![Reply(9, Err("busy"))]), "{s:?}"),
            }
        }
    }

    #[test]
    fn the_happy_path_answers_the_start_with_the_runs_id() {
        let mut m = Machine::default();
        assert_eq!(m.handle(Msg::Start(1)), vec![BeginAsk(0)]);
        assert_eq!(m.handle(Msg::AskDone(0, Ok(true))), vec![StoreApproval(0)]);
        assert_eq!(m.handle(Msg::Stored(0, true)), vec![BeginSpawn(0)]);
        assert_eq!(m.handle(Msg::Spawned(0)), vec![Go(0)]);
        assert_eq!(m.handle(Msg::Resumed(0)), vec![Reply(1, Ok(Some(0)))]);
        assert_eq!((m.state(), m.run()), (Running, Some(0)));
        assert_eq!(m.handle(Msg::Write(2, 0)), vec![Forward(2)]);
        assert_eq!(m.handle(Msg::Exited(0)), vec![]);
        assert_eq!(m.state(), Idle);
        // The next attempt is another generation.
        assert_eq!(m.handle(Msg::Start(3)), vec![BeginAsk(1)]);
    }

    #[test]
    fn a_second_forget_during_an_outstanding_ask_is_answered() {
        let mut m = at(Asking);
        assert_eq!(m.handle(Msg::Forget(5)), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(true)), vec![Reply(5, Ok(None))]);
        assert_eq!(m.state(), Forgetting, "the old ask is still out");
        assert_eq!(m.handle(Msg::Forget(6)), vec![Reply(6, Ok(None))], "the approval is gone: answered at once");
        assert_eq!(m.handle(Msg::AskDone(0, Ok(true))), vec![Reply(1, Err("revoked"))]);
        assert_eq!(m.state(), Idle);
    }

    #[test]
    fn a_failed_removal_never_becomes_a_successful_forget() {
        // An approved setup's ask is out (it will say "approved before"); the removal fails, and a
        // second forget comes before the ask's answer.
        let mut m = at(Asking);
        assert_eq!(m.handle(Msg::Forget(5)), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(false)), vec![Reply(5, Err("failed"))]);
        assert_eq!(m.handle(Msg::Forget(6)), vec![RemoveApproval], "the second forget retries the removal");
        assert_eq!(m.handle(Msg::Removed(false)), vec![Reply(6, Err("failed"))], "and reports its failure, never success");
        assert_eq!(m.handle(Msg::Start(7)), vec![Reply(7, Err("revoked"))], "no start while the old ask is out");
        assert_eq!(m.handle(Msg::AskDone(0, Ok(false))), vec![Reply(1, Err("revoked"))]);
        assert_eq!(m.state(), Forgetting, "the old attempt settled, the revocation still not durable");
        assert!(!m.holds_slot());
        // A start retries the removal; while it fails, the start is refused, never admitted.
        assert!(m.admits_start());
        assert_eq!(m.handle(Msg::Start(8)), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(false)), vec![Reply(8, Err("revoked"))]);
        assert_eq!(m.state(), Forgetting);
        // Once a removal is durable, the start asks: a new attempt, which can't find the approval.
        assert_eq!(m.handle(Msg::Start(9)), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(true)), vec![BeginAsk(1)]);
        assert_eq!(m.state(), Asking);
        // A forget retried after a failure, with nothing in flight, ends idle once durable.
        let mut m = at(Idle);
        m.handle(Msg::Forget(1));
        assert_eq!(m.handle(Msg::Removed(false)), vec![Reply(1, Err("failed"))]);
        assert_eq!(m.state(), Forgetting);
        assert_eq!(m.handle(Msg::Forget(2)), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(true)), vec![Reply(2, Ok(None))]);
        assert_eq!(m.state(), Idle);
    }

    #[test]
    fn commands_and_reports_for_another_run_never_touch_this_one() {
        let mut m = at(Running);
        // Run 0 ends; run 1 starts.
        m.handle(Msg::Exited(0));
        m.handle(Msg::Start(3));
        m.handle(Msg::AskDone(1, Ok(false)));
        m.handle(Msg::Spawned(1));
        m.handle(Msg::Resumed(1));
        assert_eq!(m.run(), Some(1));
        let before = m.clone();
        assert_eq!(m.handle(Msg::Write(4, 0)), vec![Reply(4, Err("missing"))]);
        assert_eq!(m.handle(Msg::Stop(5, 0)), vec![Reply(5, Err("missing"))]);
        for stale in [Msg::Deadline(0), Msg::Exited(0), Msg::Resumed(0), Msg::SpawnFailed(0, "x"), Msg::AskDone(0, Ok(false)), Msg::Stored(0, true)] {
            assert_eq!(m.handle(stale.clone()), vec![], "{stale:?}");
        }
        assert_eq!(m, before, "run 1 is untouched");
        assert_eq!(m.handle(Msg::Spawned(0)), vec![Abort(0)], "a stale child is ended");
    }

    /* ---------- the property test ---------- */

    /// What the world owes the machine: the reports its effects started.
    #[derive(Default)]
    struct World {
        pending: Vec<Msg>,
        alive: BTreeSet<Gen>,
        /// Every report ever delivered, to deliver again later as a stale duplicate.
        old: Vec<Msg>,
        /// Whether the approval is on disk.
        disk: bool,
        /// A forget was asked since the last approval stored from a dialog.
        forgot: bool,
        /// Removals succeed from now on (the final settling).
        removals_succeed: bool,
        forget_tokens: BTreeSet<Token>,
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n
        }
    }

    /// One run of the machine against a random world. Returns the replies counted per token.
    fn trial(seed: u64, steps: usize) -> (Machine, BTreeMap<Token, usize>, BTreeSet<Token>) {
        let mut rng = Rng(seed | 1);
        let mut m = Machine::default();
        let mut w = World { disk: rng.next(2) == 0, ..World::default() };
        let mut asked: BTreeSet<Token> = BTreeSet::new();
        let mut answers: BTreeMap<Token, usize> = BTreeMap::new();
        let mut token: Token = 0;
        let kinds = ["declined", "busy", "unsafe-path"];
        let feed = |m: &mut Machine, w: &mut World, rng: &mut Rng, answers: &mut BTreeMap<Token, usize>, msg: Msg| {
            let mut queue = vec![msg];
            while let Some(msg) = queue.pop() {
                let run_before = m.run();
                // The store's side: what's on disk once each report is true.
                match msg {
                    Msg::Removed(true) => w.disk = false,
                    Msg::Forget(_) => w.forgot = true,
                    _ => {}
                }
                for e in m.handle(msg.clone()) {
                    // A forget succeeds only once the removal is durable; nothing starts from an
                    // approval the person asked to forget, and no dialog-less spawn follows one.
                    match (&e, &msg) {
                        (Reply(t, Ok(None)), _) if w.forget_tokens.contains(t) => assert!(!w.disk, "seed {seed}: forget {t} succeeded with the approval on disk"),
                        (BeginAsk(_), _) => assert!(!(w.disk && w.forgot), "seed {seed}: a start admitted with a forgotten approval on disk"),
                        (BeginSpawn(_), Msg::AskDone(_, Ok(false))) => assert!(!w.forgot, "seed {seed}: a spawn without a dialog after a forget"),
                        _ => {}
                    }
                    // Each effect is for the generation its message named, never another run's.
                    match (&e, &msg) {
                        (Terminate(g), Msg::Deadline(d)) => assert_eq!(g, d, "seed {seed}: a deadline ended another run"),
                        (Terminate(_), other) => panic!("seed {seed}: Terminate after {other:?}"),
                        (Go(g) | Abort(g), Msg::Spawned(d)) => assert_eq!(g, d),
                        (Go(_) | Abort(_), other) => panic!("seed {seed}: Go or Abort after {other:?}"),
                        (CloseInput(g) | ArmDeadline(g), Msg::Stop(_, d)) => assert_eq!((Some(*g), g), (run_before, d), "seed {seed}: a stop for another run"),
                        (Forward(_), Msg::Write(_, d)) => assert_eq!(run_before, Some(*d), "seed {seed}: a write for another run"),
                        _ => {}
                    }
                    match e {
                        Reply(t, _) | Forward(t) => *answers.entry(t).or_insert(0) += 1,
                        // "Approved before" only if the approval is on disk when the ask reads it.
                        BeginAsk(g) => w.pending.push(Msg::AskDone(g, match rng.next(4) {
                            0 | 1 if w.disk => Ok(rng.next(2) == 0),
                            0 | 1 => Ok(true),
                            _ => Err(kinds[rng.next(3) as usize]),
                        })),
                        // Synchronous: answered before any other message.
                        StoreApproval(g) => {
                            let ok = rng.next(5) != 0;
                            if ok {
                                w.disk = true;
                                w.forgot = false;
                            }
                            queue.push(Msg::Stored(g, ok))
                        }
                        BeginSpawn(g) => w.pending.push(if rng.next(5) == 0 { Msg::SpawnFailed(g, "start-failed") } else { Msg::Spawned(g) }),
                        Go(g) => {
                            if rng.next(6) == 0 {
                                w.pending.push(Msg::SpawnFailed(g, "start-failed"));
                            } else {
                                w.alive.insert(g);
                                w.pending.push(Msg::Resumed(g));
                            }
                        }
                        Abort(g) => w.pending.push(Msg::SpawnFailed(g, "revoked")),
                        CloseInput(_) => {}
                        ArmDeadline(g) => w.pending.push(Msg::Deadline(g)),
                        Terminate(g) => {
                            if w.alive.remove(&g) {
                                w.pending.push(Msg::Exited(g));
                            }
                        }
                        // One removal in three fails.
                        RemoveApproval => w.pending.push(Msg::Removed(w.removals_succeed || rng.next(3) != 0)),
                    }
                }
            }
        };
        for _ in 0..steps {
            let g = rng.next(4);
            let msg = match rng.next(10) {
                0 | 1 => {
                    token += 1;
                    asked.insert(token);
                    Msg::Start(token)
                }
                2 => {
                    token += 1;
                    asked.insert(token);
                    Msg::Stop(token, g)
                }
                3 => {
                    token += 1;
                    asked.insert(token);
                    w.forget_tokens.insert(token);
                    Msg::Forget(token)
                }
                4 => {
                    token += 1;
                    asked.insert(token);
                    Msg::Write(token, g)
                }
                // A program that ends by itself.
                5 if !w.alive.is_empty() => {
                    let g = *w.alive.iter().next().unwrap();
                    w.alive.remove(&g);
                    Msg::Exited(g)
                }
                // A stale duplicate of an old report.
                6 if !w.old.is_empty() => w.old[rng.next(w.old.len() as u64) as usize].clone(),
                _ if !w.pending.is_empty() => {
                    let i = rng.next(w.pending.len() as u64) as usize;
                    let msg = w.pending.swap_remove(i);
                    // A removal's report has no generation: the exe's store answers it at once,
                    // so it's never late or repeated.
                    if !matches!(msg, Msg::Spawned(_) | Msg::Removed(_)) {
                        w.old.push(msg.clone());
                    }
                    msg
                }
                _ => continue,
            };
            // Exited only for a run that resumed and is alive (a stale one is a duplicate).
            feed(&mut m, &mut w, &mut rng, &mut answers, msg);
        }
        // Drain: deliver everything owed, stopping runs too, until the world owes nothing.
        let mut guard = 0;
        while !w.pending.is_empty() {
            guard += 1;
            assert!(guard < 10_000, "seed {seed}: the world never settles");
            let msg = w.pending.remove(0);
            feed(&mut m, &mut w, &mut rng, &mut answers, msg);
        }
        // A failed removal rests in Forgetting; once removals succeed, one forget leaves it.
        let rested = m.state();
        if rested == Forgetting {
            assert!(m.admits_start() && !m.holds_slot(), "seed {seed}: Forgetting with something in flight");
            w.removals_succeed = true;
            token += 1;
            asked.insert(token);
            w.forget_tokens.insert(token);
            feed(&mut m, &mut w, &mut rng, &mut answers, Msg::Forget(token));
            while !w.pending.is_empty() {
                let msg = w.pending.remove(0);
                feed(&mut m, &mut w, &mut rng, &mut answers, msg);
            }
        }
        (m, answers, asked)
    }

    #[test]
    fn every_caller_is_answered_exactly_once_and_the_machine_always_settles() {
        let mut cases = 0;
        for seed in 0..5_000u64 {
            let (m, answers, asked) = trial(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(7), 60);
            cases += 1;
            for (t, n) in &answers {
                assert_eq!(*n, 1, "seed {seed}: token {t} answered {n} times");
                assert!(asked.contains(t), "seed {seed}: a reply to nobody");
            }
            let unanswered: Vec<&Token> = asked.iter().filter(|t| !answers.contains_key(t)).collect();
            // Only the start of the run still running may be answered already; every other caller is.
            assert!(unanswered.is_empty(), "seed {seed}: {unanswered:?} never answered, state {:?}", m.state());
            assert!(matches!(m.state(), Idle | Running), "seed {seed}: settled in {:?}", m.state());
            assert_eq!(m.holds_slot(), m.state() == Running, "seed {seed}: a slot held in {:?}", m.state());
        }
        assert_eq!(cases, 5_000);
    }
}
