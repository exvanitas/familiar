//! The servers that run, and the starts under way, under one lock in the exe. A start takes a
//! slot before it spawns, so concurrent starts can't pass the limit, and gives it back on every
//! failure. A forget bumps its setup's generation, so a start that began before it, approved
//! then, can't finish: the check just before resume refuses it. See "Limits" and `server_forget`
//! in "5b. Starting a local MCP server".

use std::collections::HashMap;

use crate::setup::MAX_RUNNING;

/// A start's place: its setup and the setup's generation when it began.
#[derive(Debug, PartialEq, Eq)]
pub struct Slot {
    setup: String,
    generation: u64,
    open: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunsError {
    /// 16 run or are starting.
    Busy,
    /// The setup was forgotten after this start began.
    Revoked,
}

impl RunsError {
    pub fn kind(self) -> &'static str {
        match self {
            RunsError::Busy => "busy",
            RunsError::Revoked => "revoked",
        }
    }
}

#[derive(Debug)]
pub struct Runs<R> {
    runs: HashMap<String, (String, R)>,
    pending: usize,
    generation: HashMap<String, u64>,
}

impl<R> Default for Runs<R> {
    fn default() -> Self {
        Runs { runs: HashMap::new(), pending: 0, generation: HashMap::new() }
    }
}

impl<R: Clone> Runs<R> {
    fn gen(&self, setup: &str) -> u64 {
        self.generation.get(setup).copied().unwrap_or(0)
    }

    /// Takes a slot for a start of `setup`, or `busy` if 16 run or are starting.
    pub fn reserve(&mut self, setup: &str) -> Result<Slot, RunsError> {
        if self.runs.len() + self.pending >= MAX_RUNNING {
            return Err(RunsError::Busy);
        }
        self.pending += 1;
        Ok(Slot { setup: setup.to_string(), generation: self.gen(setup), open: true })
    }

    /// Whether the setup was forgotten since the slot was taken.
    pub fn revoked(&self, slot: &Slot) -> bool {
        self.gen(&slot.setup) != slot.generation
    }

    /// Gives a slot back, for a start that failed. Once only.
    pub fn release(&mut self, slot: &mut Slot) {
        if slot.open {
            slot.open = false;
            self.pending -= 1;
        }
    }

    /// The last check, just before resume: if the setup wasn't forgotten meanwhile, the run takes
    /// the slot's place. Otherwise the slot is given back and the start is `revoked`.
    pub fn commit(&mut self, slot: &mut Slot, run: &str, r: R) -> Result<(), RunsError> {
        if self.revoked(slot) {
            self.release(slot);
            return Err(RunsError::Revoked);
        }
        if slot.open {
            slot.open = false;
            self.pending -= 1;
        }
        self.runs.insert(run.to_string(), (slot.setup.clone(), r));
        Ok(())
    }

    /// Bumps the setup's generation, and returns its runs, to be stopped.
    pub fn forget(&mut self, setup: &str) -> Vec<(String, R)> {
        *self.generation.entry(setup.to_string()).or_insert(0) += 1;
        self.runs.iter().filter(|(_, (s, _))| s == setup).map(|(k, (_, r))| (k.clone(), r.clone())).collect()
    }

    pub fn get(&self, run: &str) -> Option<R> {
        self.runs.get(run).map(|(_, r)| r.clone())
    }

    pub fn contains(&self, run: &str) -> bool {
        self.runs.contains_key(run)
    }

    pub fn remove(&mut self, run: &str) -> Option<R> {
        self.runs.remove(run).map(|(_, r)| r)
    }

    pub fn len(&self) -> usize {
        self.runs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    pub fn pending(&self) -> usize {
        self.pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_starts_cant_pass_the_limit() {
        let mut r: Runs<u8> = Runs::default();
        let mut slots: Vec<Slot> = (0..MAX_RUNNING).map(|_| r.reserve("s").unwrap()).collect();
        assert_eq!(r.reserve("s"), Err(RunsError::Busy), "16 starting, none running yet");
        r.release(&mut slots[0]);
        r.release(&mut slots[0]);
        assert_eq!(r.pending(), MAX_RUNNING - 1, "a slot goes back once");
        let mut again = r.reserve("s").unwrap();
        for (i, s) in slots.iter_mut().skip(1).enumerate() {
            r.commit(s, &format!("run{i}"), 0).unwrap();
        }
        r.commit(&mut again, "last", 0).unwrap();
        assert_eq!((r.len(), r.pending()), (MAX_RUNNING, 0));
        assert_eq!(r.reserve("t"), Err(RunsError::Busy));
        r.remove("last");
        assert!(r.reserve("t").is_ok());
    }

    #[test]
    fn a_forget_revokes_a_start_under_way() {
        let mut r: Runs<u8> = Runs::default();
        let mut early = r.reserve("s").unwrap();
        let mut other = r.reserve("o").unwrap();
        assert!(r.forget("s").is_empty(), "nothing runs yet");
        assert!(r.revoked(&early));
        assert_eq!(r.commit(&mut early, "e", 1), Err(RunsError::Revoked));
        assert_eq!(r.pending(), 1, "its slot went back");
        assert!(!r.contains("e"));
        r.commit(&mut other, "o1", 2).unwrap();
        // A start that begins after the forget is fine.
        let mut late = r.reserve("s").unwrap();
        r.commit(&mut late, "l", 3).unwrap();
        assert_eq!(r.forget("s"), vec![("l".to_string(), 3)]);
        assert_eq!(r.get("o1"), Some(2), "another setup's run stays");
        assert_eq!(RunsError::Revoked.kind(), "revoked");
    }
}
