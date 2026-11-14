//! The confirm gate: what keeps the native confirms and window operations from racing. See "The
//! native confirms" in docs/shell-design.md. Plain logic over `confirm::Throttle`, so it's tested
//! here; the exe supplies the windows.
//!
//! - One lock serializes reserving a confirm, the freeze's snapshot and every window operation,
//!   held until the operation has really finished. So a window opened just before a confirm is
//!   either finished before the snapshot, and frozen with the rest, or refused as `busy`.
//! - A reservation ends on every way out, a panic included: unused, it's released; asked and not
//!   finished, it counts as a refusal.
//! - The freeze records each window's state before changing it, and puts back everything it
//!   recorded on every way out, a failure part-way included. A live window it can't read, or that
//!   doesn't read back frozen, fails the freeze. Restoring sets always-on-top and enabled each on
//!   its own, so one failing doesn't stop the other, reads the result back, and reports every
//!   failure.

use crate::confirm::{Refused, Throttle};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
pub struct Gate {
    /// Held through a whole window operation, and through reserving and freezing.
    windows: Mutex<()>,
    throttle: Mutex<Throttle>,
}

impl Gate {
    /// True while a confirm is reserved or open.
    pub fn busy(&self) -> bool {
        lock(&self.throttle).is_open()
    }

    pub fn stopped(&self) -> bool {
        lock(&self.throttle).stopped()
    }

    pub fn reenable(&self) {
        lock(&self.throttle).reenable();
    }

    /// Runs one window operation to its end, unless a confirm is reserved or open. Holds the
    /// window lock throughout, so no reservation can start part-way through it.
    pub fn window_op<T>(&self, f: impl FnOnce() -> T) -> Result<T, Refused> {
        let _w = lock(&self.windows);
        if lock(&self.throttle).is_open() {
            return Err(Refused::Busy);
        }
        Ok(f())
    }

    /// Reserves the one confirm. Waits for a window operation in progress to finish first.
    pub fn reserve(self: &Arc<Self>) -> Result<Reservation, Refused> {
        let _w = lock(&self.windows);
        lock(&self.throttle).begin()?;
        Ok(Reservation { gate: self.clone(), asked: false, done: false })
    }
}

impl Gate {
    /// Holds the dialog slot for a native file dialog, like a reservation: window operations and
    /// asks are `busy` until it goes. Waits for a window operation in progress. Never refused by a
    /// stop, and never counted.
    pub fn hold(self: &Arc<Self>) -> Result<Hold, Refused> {
        let _w = lock(&self.windows);
        lock(&self.throttle).hold()?;
        Ok(Hold { gate: self.clone() })
    }
}

/// A held file dialog. Released when it goes, on every way out.
pub struct Hold {
    gate: Arc<Gate>,
}

impl Hold {
    /// Freezes the windows under the window lock, as a confirm does.
    pub fn freeze<W: Freezable>(&self, windows: Vec<W>, report: Report) -> Result<Frozen<W>, String> {
        let _w = lock(&self.gate.windows);
        freeze(windows, report)
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        lock(&self.gate.throttle).release();
    }
}

/// One reserved confirm. Ends when it's finished or dropped, whatever happened in between.
pub struct Reservation {
    gate: Arc<Gate>,
    asked: bool,
    done: bool,
}

impl Reservation {
    /// The dialog is about to be shown: from here, an end without `finish` counts as a refusal.
    pub fn asking(&mut self) {
        self.asked = true;
    }

    /// Freezes the windows under the window lock, so nothing changes them meanwhile.
    pub fn freeze<W: Freezable>(&self, windows: Vec<W>, report: Report) -> Result<Frozen<W>, String> {
        let _w = lock(&self.gate.windows);
        freeze(windows, report)
    }

    pub fn finish(mut self, approved: bool) {
        self.done = true;
        lock(&self.gate.throttle).end(approved);
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.done {
            // Unused: released. Asked and never finished (a panic, a failure): a refusal.
            lock(&self.gate.throttle).end(!self.asked);
        }
    }
}

/// A window the freeze can read and set.
pub trait Freezable {
    /// (enabled, always on top)
    fn read(&self) -> Result<(bool, bool), String>;
    fn set_on_top(&self, on: bool) -> Result<(), String>;
    fn set_enabled(&self, on: bool) -> Result<(), String>;
    /// False once the window has gone; it's then skipped when restoring.
    fn alive(&self) -> bool;
    /// For a report: which window.
    fn name(&self) -> String;
}

/// Where a restore's failures are reported.
pub type Report = Box<dyn Fn(&str) + Send>;

/// Every window frozen: disabled, not always-on-top. Each one's state was recorded before it
/// was changed, and is put back when this goes.
pub struct Frozen<W: Freezable> {
    saved: Vec<(W, bool, bool)>,
    report: Report,
}

impl<W: Freezable> Drop for Frozen<W> {
    fn drop(&mut self) {
        for (w, enabled, on_top) in self.saved.drain(..).rev() {
            if !w.alive() {
                continue;
            }
            // Always-on-top first: changing it can rebuild a window's styles, undoing an enable
            // made before it. Each is tried whatever happened to the other.
            if let Err(e) = w.set_on_top(on_top) {
                (self.report)(&format!("{}: always-on-top couldn't be put back: {e}", w.name()));
            }
            if let Err(e) = w.set_enabled(enabled) {
                (self.report)(&format!("{}: enabled couldn't be put back: {e}", w.name()));
            }
            match w.read() {
                Ok(now) if now == (enabled, on_top) => {}
                Ok((e, t)) => (self.report)(&format!("{}: reads enabled {e}, on top {t} after restoring, not {enabled}, {on_top}", w.name())),
                Err(e) => (self.report)(&format!("{}: couldn't be read after restoring: {e}", w.name())),
            }
        }
    }
}

/// Freezes every window. A live window that can't be read, or doesn't read back frozen, fails it;
/// a failure part-way puts back everything already changed, and returns the error: the dialog is
/// then not shown.
pub fn freeze<W: Freezable>(windows: Vec<W>, report: Report) -> Result<Frozen<W>, String> {
    let mut frozen = Frozen { saved: Vec::with_capacity(windows.len()), report };
    for w in windows {
        if !w.alive() {
            continue;
        }
        let (enabled, on_top) = w.read().map_err(|e| format!("{} couldn't be read: {e}", w.name()))?;
        frozen.saved.push((w, enabled, on_top));
        let w = &frozen.saved.last().expect("just pushed").0;
        w.set_on_top(false)?;
        w.set_enabled(false)?;
        if w.read()? != (false, false) {
            return Err(format!("{} didn't freeze", w.name()));
        }
    }
    Ok(frozen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    #[test]
    fn a_window_op_finishes_before_a_reservation_and_after_one_is_refused() {
        let gate = Arc::new(Gate::default());
        let g = gate.clone();
        let started = Instant::now();
        let op = std::thread::spawn(move || g.window_op(|| std::thread::sleep(Duration::from_millis(300))));
        std::thread::sleep(Duration::from_millis(50));
        let r = gate.reserve().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(300), "the reservation waited for the op");
        assert!(op.join().unwrap().is_ok());
        assert_eq!(gate.window_op(|| ()), Err(Refused::Busy));
        assert!(gate.busy());
        r.finish(true);
        assert!(!gate.busy());
        assert_eq!(gate.window_op(|| 7), Ok(7));
    }

    #[test]
    fn a_reservation_always_ends() {
        let gate = Arc::new(Gate::default());
        drop(gate.reserve().unwrap());
        assert!(!gate.busy(), "released");
        // A panic while asking: the throttle opens again and counts a refusal.
        for _ in 0..3 {
            let g = gate.clone();
            let r = std::panic::catch_unwind(move || {
                let mut res = g.reserve().unwrap();
                res.asking();
                panic!("the dialog's thread couldn't start");
            });
            assert!(r.is_err());
            assert!(!gate.busy());
        }
        assert!(gate.stopped(), "three failed asks count as three refusals");
        gate.reenable();
        assert_eq!(gate.reserve().map(|r| r.finish(false)).err(), None);
        assert_eq!(gate.reserve().map(|_| ()).err(), None);
    }

    #[derive(Clone)]
    struct Fake {
        name: &'static str,
        state: Rc<RefCell<(bool, bool)>>,
        fail_read: bool,
        /// Disabling fails.
        fail_set: bool,
        /// Setting always-on-top back to true fails.
        fail_on_top: bool,
        /// Disabling is dispatched but doesn't take.
        ignores_disable: bool,
        alive: bool,
        log: Rc<RefCell<Vec<String>>>,
    }
    impl Freezable for Fake {
        fn read(&self) -> Result<(bool, bool), String> {
            if self.fail_read {
                return Err("read".into());
            }
            Ok(*self.state.borrow())
        }
        fn set_on_top(&self, on: bool) -> Result<(), String> {
            if self.fail_on_top && on {
                return Err("on top".into());
            }
            self.log.borrow_mut().push(format!("{} on-top {on}", self.name));
            self.state.borrow_mut().1 = on;
            Ok(())
        }
        fn set_enabled(&self, on: bool) -> Result<(), String> {
            if self.fail_set && !on {
                return Err("set".into());
            }
            self.log.borrow_mut().push(format!("{} enabled {on}", self.name));
            if !(self.ignores_disable && !on) {
                self.state.borrow_mut().0 = on;
            }
            Ok(())
        }
        fn alive(&self) -> bool {
            self.alive
        }
        fn name(&self) -> String {
            self.name.into()
        }
    }
    fn fake(name: &'static str, s: (bool, bool), log: &Rc<RefCell<Vec<String>>>) -> Fake {
        Fake { name, state: Rc::new(RefCell::new(s)), fail_read: false, fail_set: false, fail_on_top: false, ignores_disable: false, alive: true, log: log.clone() }
    }
    /// A report that collects into `into`.
    fn reports(into: &std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> Report {
        let into = into.clone();
        Box::new(move |m| into.lock().unwrap().push(m.to_string()))
    }
    fn quiet() -> Report {
        Box::new(|_| {})
    }

    #[test]
    fn a_freeze_puts_everything_back() {
        let log = Rc::new(RefCell::new(vec![]));
        let (a, b) = (fake("a", (true, true), &log), fake("b", (false, false), &log));
        let f = freeze(vec![a.clone(), b.clone()], quiet()).unwrap();
        assert_eq!((*a.state.borrow(), *b.state.borrow()), ((false, false), (false, false)));
        drop(f);
        assert_eq!((*a.state.borrow(), *b.state.borrow()), ((true, true), (false, false)));
    }

    #[test]
    fn a_freeze_that_fails_part_way_puts_back_what_it_changed() {
        let log = Rc::new(RefCell::new(vec![]));
        let a = fake("a", (true, true), &log);
        let mut b = fake("b", (true, false), &log);
        b.fail_read = true;
        assert!(freeze(vec![a.clone(), b], quiet()).is_err());
        assert_eq!(*a.state.borrow(), (true, true), "a was frozen, then put back");
        let mut c = fake("c", (true, true), &log);
        c.fail_set = true;
        let d = fake("d", (true, true), &log);
        assert!(freeze(vec![d.clone(), c.clone()], quiet()).is_err());
        assert_eq!(*d.state.borrow(), (true, true));
        assert!(log.borrow().iter().any(|l| l == "c on-top true"), "the one whose set failed is put back too");
        assert_eq!(*c.state.borrow(), (true, true));
    }

    #[test]
    fn a_restore_whose_on_top_fails_still_enables_and_reports_it() {
        let log = Rc::new(RefCell::new(vec![]));
        let mut a = fake("a", (true, true), &log);
        a.fail_on_top = true;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        drop(freeze(vec![a.clone()], reports(&seen)).unwrap());
        assert_eq!(*a.state.borrow(), (true, false), "enabled again, though on-top failed");
        let seen = seen.lock().unwrap();
        assert!(seen.iter().any(|m| m.starts_with("a: always-on-top couldn't be put back")), "{seen:?}");
        assert!(seen.iter().any(|m| m.contains("after restoring")), "the read-back shows it: {seen:?}");
    }

    #[test]
    fn a_window_that_doesnt_read_back_frozen_fails_the_freeze() {
        let log = Rc::new(RefCell::new(vec![]));
        let a = fake("a", (true, false), &log);
        let mut b = fake("b", (true, false), &log);
        b.ignores_disable = true;
        let e = freeze(vec![a.clone(), b.clone()], quiet()).err().expect("refused");
        assert!(e.contains("b didn't freeze"), "{e}");
        assert_eq!((*a.state.borrow(), *b.state.borrow()), ((true, false), (true, false)));
    }

    #[test]
    fn a_live_window_that_cant_be_read_fails_the_freeze_and_a_gone_one_is_skipped() {
        let log = Rc::new(RefCell::new(vec![]));
        let mut a = fake("a", (true, false), &log);
        a.fail_read = true;
        assert!(freeze(vec![a.clone()], quiet()).err().expect("refused").contains("a couldn't be read"));
        a.alive = false;
        assert!(freeze(vec![a], quiet()).is_ok(), "a window that's gone isn't frozen");
    }

    #[test]
    fn a_held_file_dialog_is_busy_for_everything_else_and_counts_nothing() {
        let gate = Arc::new(Gate::default());
        let hold = gate.hold().unwrap();
        assert!(gate.busy());
        assert_eq!(gate.window_op(|| ()).err(), Some(Refused::Busy), "no window changes behind it");
        assert!(gate.reserve().is_err(), "no confirm meanwhile");
        assert!(gate.hold().is_err(), "one at a time");
        drop(hold);
        assert!(!gate.busy() && !gate.stopped(), "released, and not a refusal");
        assert!(gate.window_op(|| ()).is_ok());
    }
}
