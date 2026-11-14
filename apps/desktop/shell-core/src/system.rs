//! What the OS says about the session, in the app's words, and the one native deadline. See
//! `system()` and `wake_at` in "5d. The rest", and "6. ... system state" in docs/shell-design.md.

use serde::Serialize;
use std::time::Duration;

/// How often the exe looks at the user state, to tell core when it changes.
pub const POLL: Duration = Duration::from_secs(5);
/// The longest a deadline waits before it looks at the clock again, so one due during sleep
/// fires within a second of the resume.
pub const WAKE_STEP: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct System {
    pub user_state: &'static str,
    pub idle_ms: u64,
}

/// `SHQueryUserNotificationState`'s QUERY_USER_NOTIFICATION_STATE values, in the design's words.
pub fn user_state(quns: i32) -> &'static str {
    match quns {
        1 => "away",         // QUNS_NOT_PRESENT: locked, a screen saver, another user
        2 | 3 => "fullscreen", // QUNS_BUSY (a full-screen app), QUNS_RUNNING_D3D_FULL_SCREEN
        4 => "presentation", // QUNS_PRESENTATION_MODE
        6 => "quiet",        // QUNS_QUIET_TIME
        7 => "busy",         // QUNS_APP: a Windows Store app is running full screen
        _ => "normal",       // QUNS_ACCEPTS_NOTIFICATIONS, and any failure
    }
}

/// Milliseconds since the last input, from `GetLastInputInfo` and `GetTickCount`, both 32-bit
/// tick counts that wrap after 49.7 days.
pub fn idle_ms(now_ticks: u32, last_input_ticks: u32) -> u64 {
    now_ticks.wrapping_sub(last_input_ticks) as u64
}

/// The one pending deadline. Each `set` replaces it.
#[derive(Debug, Default)]
pub struct Wake {
    at: Option<u64>,
}

impl Wake {
    /// A deadline in Unix milliseconds. Zero or one before the year 2000 is refused.
    pub fn set(&mut self, at: u64) -> Result<(), &'static str> {
        if at < 946_684_800_000 {
            return Err("at is Unix milliseconds");
        }
        self.at = Some(at);
        Ok(())
    }

    pub fn pending(&self) -> Option<u64> {
        self.at
    }

    /// If the deadline has come, takes it: it fires once.
    pub fn due(&mut self, now_ms: u64) -> Option<u64> {
        match self.at {
            Some(at) if now_ms >= at => self.at.take(),
            _ => None,
        }
    }

    /// How long to wait before looking again: until the deadline, but never more than a second,
    /// since the clock can jump (a sleep) while the wait doesn't count it.
    pub fn wait(&self, now_ms: u64) -> Duration {
        match self.at {
            Some(at) => Duration::from_millis(at.saturating_sub(now_ms)).min(WAKE_STEP),
            None => WAKE_STEP,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_has_a_word() {
        let words: Vec<_> = (0..=8).map(user_state).collect();
        assert_eq!(words, ["normal", "away", "fullscreen", "fullscreen", "presentation", "normal", "quiet", "busy", "normal"]);
    }

    #[test]
    fn idle_across_the_tick_wrap() {
        assert_eq!(idle_ms(5000, 1000), 4000);
        assert_eq!(idle_ms(100, u32::MAX - 99), 200);
        assert_eq!(idle_ms(7, 7), 0);
    }

    #[test]
    fn the_app_sees_camel_case() {
        let s = System { user_state: "quiet", idle_ms: 12 };
        assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!({ "userState": "quiet", "idleMs": 12 }));
    }

    #[test]
    fn one_deadline_that_fires_once() {
        let t0 = 1_800_000_000_000;
        let mut w = Wake::default();
        assert_eq!(w.due(t0), None);
        assert_eq!(w.wait(t0), WAKE_STEP);
        w.set(t0 + 10_000).unwrap();
        w.set(t0 + 300).unwrap();
        assert_eq!(w.pending(), Some(t0 + 300), "each call replaces it");
        assert_eq!(w.wait(t0), Duration::from_millis(300));
        assert_eq!(w.due(t0 + 299), None);
        assert_eq!(w.due(t0 + 300), Some(t0 + 300));
        assert_eq!(w.due(t0 + 301), None, "once");
        assert_eq!(w.set(1000), Err("at is Unix milliseconds"));
    }

    #[test]
    fn a_deadline_passed_during_sleep_fires_at_the_next_look() {
        let t0 = 1_800_000_000_000;
        let mut w = Wake::default();
        w.set(t0 + 60_000).unwrap();
        assert_eq!(w.wait(t0), WAKE_STEP, "never waits more than a second");
        // The PC slept for an hour: the next look is late, and fires.
        assert_eq!(w.due(t0 + 3_600_000), Some(t0 + 60_000));
    }
}
