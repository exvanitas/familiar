//! A run's two handshakes with core. Core says it's ready once, handing over its channel, and has
//! `READY_WITHIN` to do so. A quit tells core, then waits for `quit_ready` at most `QUIT_WAIT`.
//! Nothing here needs core to answer: a core that never does still lets the run end.

use std::time::{Duration, Instant};

pub const READY_WITHIN: Duration = Duration::from_secs(30);
pub const QUIT_WAIT: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct Run {
    ready: bool,
    quit_started: Option<Instant>,
    quit_ready: bool,
}

impl Run {
    /// Core is up. Once a run.
    pub fn ready(&mut self) -> Result<(), String> {
        if self.ready {
            return Err("shell_ready was already called this run".into());
        }
        self.ready = true;
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// False if a quit had already started.
    pub fn start_quit(&mut self, now: Instant) -> bool {
        if self.quit_started.is_some() {
            return false;
        }
        self.quit_started = Some(now);
        true
    }

    /// Core has finished its last writes. Only after `quitting`.
    pub fn quit_ready(&mut self) -> Result<(), String> {
        if self.quit_started.is_none() {
            return Err("quit_ready is for after quitting".into());
        }
        self.quit_ready = true;
        Ok(())
    }

    /// Whether the run can end now: core said so, core was never there to tell, or time ran out.
    pub fn quit_done(&self, now: Instant) -> bool {
        let Some(start) = self.quit_started else { return false };
        !self.ready || self.quit_ready || now.saturating_duration_since(start) >= QUIT_WAIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_once() {
        let mut r = Run::default();
        assert!(!r.is_ready());
        r.ready().unwrap();
        assert!(r.ready().is_err());
        assert!(r.is_ready());
    }

    #[test]
    fn quit_waits_for_core_then_gives_up() {
        let t = Instant::now();
        let mut r = Run::default();
        r.ready().unwrap();
        assert!(r.quit_ready().is_err(), "not before quitting");
        assert!(!r.quit_done(t), "not started");
        assert!(r.start_quit(t));
        assert!(!r.start_quit(t), "once");
        assert!(!r.quit_done(t + QUIT_WAIT - Duration::from_millis(1)));
        assert!(r.quit_done(t + QUIT_WAIT), "a core that never answers");
        r.quit_ready().unwrap();
        assert!(r.quit_done(t));
    }

    #[test]
    fn a_core_that_never_started_is_not_waited_for() {
        let t = Instant::now();
        let mut r = Run::default();
        r.start_quit(t);
        assert!(r.quit_done(t));
    }
}
