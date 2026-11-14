//! One setup's server, as a state machine. In the exe, each setup has one actor that owns
//! everything about it (the run, its job, its stdin, its sweep record) and handles one message at
//! a time; this is its plain logic, so every state meets every message in a test. The actor
//! carries out the effects: blocking work (the walk and the dialog, the spawn, waiting on the
//! job) runs on threads of its own, which report back as messages. See "5b. Starting a local MCP
//! server" in docs/shell-design.md.
//!
//! - `Idle`: nothing runs. A start takes a slot and asks.
//! - `Asking`: the walk, the approval check and, if it's new or changed, the dialog.
//! - `Starting`: the approval is stored and the child is being made, suspended, in its job.
//! - `Running`: the child runs.
//! - `Stopping`: its input is closed; at the deadline the job is ended.
//! - `Forgetting`: the approval is being removed. Starts are refused (`revoked`) until the
//!   removal is durable and no start of before is still in flight.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Asking,
    Starting,
    Running,
    Stopping,
    Forgetting,
}

/// What the actor hears: commands, and what its own threads report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    Start,
    /// The walk and the ask are done: approved (and whether the approval must be stored), or
    /// refused with this kind.
    AskDone(Result<bool, &'static str>),
    /// The approval store said whether the write or the removal is durable.
    Stored(bool),
    Removed(bool),
    /// The child exists, suspended, in its job, waiting for `Go` or `Abort`.
    Spawned,
    /// It resumed.
    Resumed,
    /// The start failed at the spawn, the record, the job, the assignment or the resume, or was
    /// aborted, and the child is reaped.
    SpawnFailed(&'static str),
    /// The program ended, its job ended, and its output drained.
    Exited,
    Stop,
    /// The stop's deadline came.
    Deadline,
    Forget,
}

/// What the actor must do. Replies go to every command of that kind waiting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    BeginAsk,
    StoreApproval,
    BeginSpawn,
    Go,
    Abort,
    CloseInput,
    ArmDeadline,
    Terminate,
    RemoveApproval,
    ReplyStart(Result<(), &'static str>),
    ReplyStop(Result<(), &'static str>),
    ReplyForget(Result<(), &'static str>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    pub state: State,
    /// A forget waits for the run to stop.
    forget_after_stop: bool,
    /// A start of before the forget is still in flight on a thread: its report must come before
    /// the setup can be idle again.
    start_in_flight: bool,
    /// The forget's removal is durable.
    removed: bool,
    /// Waiting stops, to answer once the run is gone.
    stops: bool,
}

impl Default for Machine {
    fn default() -> Self {
        Machine { state: State::Idle, forget_after_stop: false, start_in_flight: false, removed: false, stops: false }
    }
}

use Effect::*;
use State::*;

impl Machine {
    /// Whether this state holds a slot: everything but `Idle` and a forget with no run.
    pub fn holds_slot(&self) -> bool {
        self.state != Idle && (self.state != Forgetting || self.start_in_flight)
    }

    fn begin_stopping(&mut self, forget: bool) -> Vec<Effect> {
        self.state = Stopping;
        self.forget_after_stop |= forget;
        vec![CloseInput, ArmDeadline]
    }

    fn begin_forgetting(&mut self, start_in_flight: bool) -> Vec<Effect> {
        self.state = Forgetting;
        self.start_in_flight = start_in_flight;
        self.removed = false;
        self.forget_after_stop = false;
        vec![RemoveApproval]
    }

    /// The run is gone (exited, or never resumed): answer the stops, then forget or go idle.
    fn run_gone(&mut self, mut fx: Vec<Effect>) -> Vec<Effect> {
        if std::mem::take(&mut self.stops) {
            fx.push(ReplyStop(Ok(())));
        }
        if std::mem::take(&mut self.forget_after_stop) {
            fx.extend(self.begin_forgetting(false));
        } else {
            self.state = Idle;
        }
        fx
    }

    /// The forget's last step: idle once the removal is durable and no old start is in flight.
    fn settle_forget(&mut self, mut fx: Vec<Effect>) -> Vec<Effect> {
        if self.removed && !self.start_in_flight {
            self.state = Idle;
            self.removed = false;
        }
        fx.shrink_to_fit();
        fx
    }

    pub fn handle(&mut self, msg: Msg) -> Vec<Effect> {
        match (self.state, msg) {
            // ---------- a start ----------
            (Idle, Msg::Start) => {
                self.state = Asking;
                vec![BeginAsk]
            }
            (Forgetting, Msg::Start) => vec![ReplyStart(Err("revoked"))],
            (_, Msg::Start) => vec![ReplyStart(Err("busy"))],

            (Asking, Msg::AskDone(Ok(true))) => vec![StoreApproval],
            (Asking, Msg::AskDone(Ok(false))) => {
                self.state = Starting;
                vec![BeginSpawn]
            }
            (Asking, Msg::AskDone(Err(kind))) => {
                self.state = Idle;
                vec![ReplyStart(Err(kind))]
            }
            (Asking, Msg::Stored(true)) => {
                self.state = Starting;
                vec![BeginSpawn]
            }
            (Asking, Msg::Stored(false)) => {
                self.state = Idle;
                vec![ReplyStart(Err("failed"))]
            }
            // A forget came while asking: the answer is never stored, nothing starts.
            (Forgetting, Msg::AskDone(_)) if self.start_in_flight => {
                self.start_in_flight = false;
                self.settle_forget(vec![ReplyStart(Err("revoked"))])
            }

            (Starting, Msg::Spawned) => {
                self.state = Running;
                vec![Go]
            }
            (Starting, Msg::SpawnFailed(kind)) => {
                self.state = Idle;
                vec![ReplyStart(Err(kind))]
            }
            // A forget came while the child was being made: it's ended before it ever runs.
            (Forgetting, Msg::Spawned) if self.start_in_flight => vec![Abort],
            (Forgetting, Msg::SpawnFailed(_)) if self.start_in_flight => {
                self.start_in_flight = false;
                self.settle_forget(vec![ReplyStart(Err("revoked"))])
            }

            (Running, Msg::Resumed) | (Stopping, Msg::Resumed) => vec![ReplyStart(Ok(()))],
            // The resume failed: the child is reaped, the run never was.
            (Running, Msg::SpawnFailed(kind)) => {
                self.state = Idle;
                vec![ReplyStart(Err(kind))]
            }
            (Stopping, Msg::SpawnFailed(kind)) => self.run_gone(vec![ReplyStart(Err(kind))]),

            // ---------- the run ending ----------
            (Running, Msg::Exited) => {
                self.state = Idle;
                vec![]
            }
            (Stopping, Msg::Exited) => self.run_gone(vec![]),

            // ---------- a stop ----------
            (Running, Msg::Stop) => {
                self.stops = true;
                self.begin_stopping(false)
            }
            (Stopping, Msg::Stop) => {
                self.stops = true;
                vec![]
            }
            (_, Msg::Stop) => vec![ReplyStop(Err("missing"))],
            (Stopping, Msg::Deadline) => vec![Terminate],
            (_, Msg::Deadline) => vec![],

            // ---------- a forget ----------
            (Idle, Msg::Forget) => self.begin_forgetting(false),
            (Asking, Msg::Forget) | (Starting, Msg::Forget) => self.begin_forgetting(true),
            (Running, Msg::Forget) => self.begin_stopping(true),
            (Stopping, Msg::Forget) => {
                self.forget_after_stop = true;
                vec![]
            }
            // Another forget during one answers with it.
            (Forgetting, Msg::Forget) => vec![],
            (Forgetting, Msg::Removed(ok)) => {
                self.removed = true;
                let reply = ReplyForget(if ok { Ok(()) } else { Err("failed") });
                self.settle_forget(vec![reply])
            }

            // Anything else is a report for a state that's gone: nothing to do.
            (_, _) => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(state: State) -> Machine {
        // Reach each state the way the actor does.
        let mut m = Machine::default();
        let path: &[Msg] = match state {
            Idle => &[],
            Asking => &[Msg::Start],
            Starting => &[Msg::Start, Msg::AskDone(Ok(false))],
            Running => &[Msg::Start, Msg::AskDone(Ok(false)), Msg::Spawned, Msg::Resumed],
            Stopping => &[Msg::Start, Msg::AskDone(Ok(false)), Msg::Spawned, Msg::Resumed, Msg::Stop],
            Forgetting => &[Msg::Forget],
        };
        for msg in path {
            m.handle(msg.clone());
        }
        assert_eq!(m.state, state);
        m
    }

    const ALL: [State; 6] = [Idle, Asking, Starting, Running, Stopping, Forgetting];

    #[test]
    fn a_start_from_each_state() {
        for s in ALL {
            let mut m = at(s);
            let fx = m.handle(Msg::Start);
            match s {
                Idle => assert_eq!((m.state, fx), (Asking, vec![BeginAsk])),
                Forgetting => assert_eq!((m.state, fx), (Forgetting, vec![ReplyStart(Err("revoked"))])),
                _ => assert_eq!((m.state, fx), (s, vec![ReplyStart(Err("busy"))]), "{s:?}"),
            }
        }
    }

    #[test]
    fn the_happy_path_and_its_refusals() {
        let mut m = Machine::default();
        assert_eq!(m.handle(Msg::Start), vec![BeginAsk]);
        assert_eq!(m.handle(Msg::AskDone(Ok(true))), vec![StoreApproval], "a new approval is stored first");
        assert_eq!(m.state, Asking);
        assert_eq!(m.handle(Msg::Stored(true)), vec![BeginSpawn]);
        assert_eq!(m.handle(Msg::Spawned), vec![Go]);
        assert_eq!(m.handle(Msg::Resumed), vec![ReplyStart(Ok(()))]);
        assert_eq!(m.state, Running);
        assert_eq!(m.handle(Msg::Exited), vec![]);
        assert_eq!(m.state, Idle);

        let mut m = at(Asking);
        assert_eq!(m.handle(Msg::AskDone(Err("declined"))), vec![ReplyStart(Err("declined"))]);
        assert_eq!(m.state, Idle);
        let mut m = at(Asking);
        m.handle(Msg::AskDone(Ok(true)));
        assert_eq!(m.handle(Msg::Stored(false)), vec![ReplyStart(Err("failed"))], "no start without a durable approval");
        assert_eq!(m.state, Idle);
    }

    #[test]
    fn a_failed_spawn_record_job_or_resume_goes_back_to_idle() {
        let mut m = at(Starting);
        assert_eq!(m.handle(Msg::SpawnFailed("start-failed")), vec![ReplyStart(Err("start-failed"))]);
        assert_eq!(m.state, Idle);
        // Resume fails after Go: the run never was.
        let mut m = at(Starting);
        m.handle(Msg::Spawned);
        assert_eq!(m.handle(Msg::SpawnFailed("start-failed")), vec![ReplyStart(Err("start-failed"))]);
        assert_eq!(m.state, Idle);
        assert!(!m.holds_slot());
    }

    #[test]
    fn a_stop_from_each_state() {
        for s in ALL {
            let mut m = at(s);
            let fx = m.handle(Msg::Stop);
            match s {
                Running => assert_eq!((m.state, fx), (Stopping, vec![CloseInput, ArmDeadline])),
                Stopping => assert_eq!((m.state, fx), (Stopping, vec![])),
                _ => assert_eq!((m.state, fx), (s, vec![ReplyStop(Err("missing"))]), "{s:?}"),
            }
        }
        let mut m = at(Stopping);
        assert_eq!(m.handle(Msg::Deadline), vec![Terminate]);
        assert_eq!(m.handle(Msg::Exited), vec![ReplyStop(Ok(()))]);
        assert_eq!(m.state, Idle);
    }

    #[test]
    fn forget_in_running_stops_then_removes() {
        let mut m = at(Running);
        assert_eq!(m.handle(Msg::Forget), vec![CloseInput, ArmDeadline]);
        assert_eq!(m.state, Stopping);
        assert_eq!(m.handle(Msg::Start), vec![ReplyStart(Err("busy"))]);
        assert_eq!(m.handle(Msg::Deadline), vec![Terminate]);
        assert_eq!(m.handle(Msg::Exited), vec![RemoveApproval]);
        assert_eq!(m.state, Forgetting);
        assert_eq!(m.handle(Msg::Start), vec![ReplyStart(Err("revoked"))], "a start during the forget");
        assert_eq!(m.handle(Msg::Removed(true)), vec![ReplyForget(Ok(()))]);
        assert_eq!(m.state, Idle);
        assert_eq!(m.handle(Msg::Start), vec![BeginAsk], "after it, a start asks again");
    }

    #[test]
    fn forget_during_asking_never_stores_and_never_starts() {
        let mut m = at(Asking);
        assert_eq!(m.handle(Msg::Forget), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(true)), vec![ReplyForget(Ok(()))], "the forget returns once removed");
        assert_eq!(m.state, Forgetting, "but the old ask is still out");
        assert_eq!(m.handle(Msg::Start), vec![ReplyStart(Err("revoked"))]);
        assert_eq!(m.handle(Msg::AskDone(Ok(true))), vec![ReplyStart(Err("revoked"))], "approved after the forget: not stored");
        assert_eq!(m.state, Idle);
        // The ask answering before the removal does too.
        let mut m = at(Asking);
        m.handle(Msg::Forget);
        assert_eq!(m.handle(Msg::AskDone(Ok(true))), vec![ReplyStart(Err("revoked"))]);
        assert_eq!(m.state, Forgetting);
        assert_eq!(m.handle(Msg::Removed(true)), vec![ReplyForget(Ok(()))]);
        assert_eq!(m.state, Idle);
    }

    #[test]
    fn forget_during_starting_ends_the_child_before_it_runs() {
        let mut m = at(Starting);
        assert_eq!(m.handle(Msg::Forget), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Spawned), vec![Abort], "the child exists: ended, never resumed");
        assert_eq!(m.handle(Msg::SpawnFailed("revoked")), vec![ReplyStart(Err("revoked"))]);
        assert_eq!(m.state, Forgetting);
        assert!(!m.holds_slot(), "no run, no slot");
        assert_eq!(m.handle(Msg::Removed(true)), vec![ReplyForget(Ok(()))]);
        assert_eq!(m.state, Idle);
    }

    #[test]
    fn forget_between_go_and_resume_stops_the_run() {
        let mut m = at(Starting);
        m.handle(Msg::Spawned);
        assert_eq!(m.handle(Msg::Forget), vec![CloseInput, ArmDeadline]);
        assert_eq!(m.handle(Msg::Resumed), vec![ReplyStart(Ok(()))]);
        assert_eq!(m.handle(Msg::Exited), vec![RemoveApproval]);
        assert_eq!(m.handle(Msg::Removed(true)), vec![ReplyForget(Ok(()))]);
        assert_eq!(m.state, Idle);
    }

    #[test]
    fn a_failed_removal_is_said_and_the_setup_idles() {
        let mut m = at(Forgetting);
        assert_eq!(m.handle(Msg::Removed(false)), vec![ReplyForget(Err("failed"))]);
        assert_eq!(m.state, Idle);
    }

    #[test]
    fn stray_reports_do_nothing() {
        for s in ALL {
            for msg in [Msg::Deadline, Msg::Exited, Msg::Resumed, Msg::Removed(true), Msg::Stored(true), Msg::AskDone(Ok(false)), Msg::Spawned, Msg::SpawnFailed("x")] {
                let mut m = at(s);
                let before = m.clone();
                let fx = m.handle(msg.clone());
                let expected_change = matches!(
                    (s, &msg),
                    (Asking, Msg::Stored(_) | Msg::AskDone(_))
                        | (Starting, Msg::Spawned | Msg::SpawnFailed(_))
                        | (Running, Msg::Exited | Msg::SpawnFailed(_) | Msg::Resumed)
                        | (Stopping, Msg::Deadline | Msg::Exited | Msg::SpawnFailed(_) | Msg::Resumed)
                        | (Forgetting, Msg::Removed(_))
                );
                if !expected_change {
                    assert_eq!((&m, fx), (&before, vec![]), "{s:?} {msg:?}");
                }
            }
        }
    }

    #[test]
    fn slots_are_held_while_a_run_or_a_start_exists() {
        assert!(!at(Idle).holds_slot());
        for s in [Asking, Starting, Running, Stopping] {
            assert!(at(s).holds_slot(), "{s:?}");
        }
        assert!(!at(Forgetting).holds_slot(), "a forget with nothing in flight holds none");
        let mut m = at(Asking);
        m.handle(Msg::Forget);
        assert!(m.holds_slot(), "the old ask is still out");
    }
}
