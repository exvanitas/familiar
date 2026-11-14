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
//!   recorded on every way out, a failure part-way included.

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
    pub fn freeze<W: Freezable>(&self, windows: Vec<W>) -> Result<Frozen<W>, String> {
        let _w = lock(&self.gate.windows);
        freeze(windows)
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
    fn set(&self, enabled: bool, on_top: bool) -> Result<(), String>;
    /// False once the window has gone; it's then skipped when restoring.
    fn alive(&self) -> bool;
}

/// Every window frozen: disabled, not always-on-top. Each one's state was recorded before it
/// was changed, and is put back when this goes.
pub struct Frozen<W: Freezable> {
    saved: Vec<(W, bool, bool)>,
}

impl<W: Freezable> Drop for Frozen<W> {
    fn drop(&mut self) {
        for (w, enabled, on_top) in self.saved.drain(..).rev() {
            if w.alive() {
                let _ = w.set(enabled, on_top);
            }
        }
    }
}

/// Freezes every window. A failure part-way puts back everything already changed, and returns
/// the error: the dialog is then not shown.
pub fn freeze<W: Freezable>(windows: Vec<W>) -> Result<Frozen<W>, String> {
    let mut frozen = Frozen { saved: Vec::with_capacity(windows.len()) };
    for w in windows {
        let (enabled, on_top) = w.read()?;
        frozen.saved.push((w, enabled, on_top));
        let w = &frozen.saved.last().expect("just pushed").0;
        w.set(false, false)?;
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
        fail_set: bool,
        log: Rc<RefCell<Vec<String>>>,
    }
    impl Freezable for Fake {
        fn read(&self) -> Result<(bool, bool), String> {
            if self.fail_read {
                return Err("read".into());
            }
            Ok(*self.state.borrow())
        }
        fn set(&self, enabled: bool, on_top: bool) -> Result<(), String> {
            if self.fail_set && !enabled {
                return Err("set".into());
            }
            self.log.borrow_mut().push(format!("{} {enabled} {on_top}", self.name));
            *self.state.borrow_mut() = (enabled, on_top);
            Ok(())
        }
        fn alive(&self) -> bool {
            true
        }
    }
    fn fake(name: &'static str, s: (bool, bool), log: &Rc<RefCell<Vec<String>>>) -> Fake {
        Fake { name, state: Rc::new(RefCell::new(s)), fail_read: false, fail_set: false, log: log.clone() }
    }

    #[test]
    fn a_freeze_puts_everything_back() {
        let log = Rc::new(RefCell::new(vec![]));
        let (a, b) = (fake("a", (true, true), &log), fake("b", (false, false), &log));
        let f = freeze(vec![a.clone(), b.clone()]).unwrap();
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
        assert!(freeze(vec![a.clone(), b]).is_err());
        assert_eq!(*a.state.borrow(), (true, true), "a was frozen, then put back");
        let mut c = fake("c", (true, true), &log);
        c.fail_set = true;
        let d = fake("d", (true, true), &log);
        assert!(freeze(vec![d.clone(), c.clone()]).is_err());
        assert_eq!(*d.state.borrow(), (true, true));
        assert!(log.borrow().iter().any(|l| l == "c true true"), "the one whose set failed is put back too");
    }
}
