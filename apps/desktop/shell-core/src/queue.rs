//! What the exe tells core before core has said it's ready: a second launch in the first moments,
//! a tray click. Kept in a small queue and handed over when core calls `shell_ready`. The oldest
//! go first when it's full, and are counted.

use std::collections::VecDeque;

/// Messages kept for core before it's ready.
pub const HELD: usize = 8;

pub struct Pending<T> {
    items: VecDeque<T>,
    dropped: u64,
}

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Pending { items: VecDeque::with_capacity(HELD), dropped: 0 }
    }
}

impl<T> Pending<T> {
    pub fn push(&mut self, item: T) {
        if self.items.len() == HELD {
            self.items.pop_front();
            self.dropped += 1;
        }
        self.items.push_back(item);
    }

    /// Everything held, oldest first, and how many were dropped. Empties the queue.
    pub fn take(&mut self) -> (Vec<T>, u64) {
        let dropped = std::mem::take(&mut self.dropped);
        (self.items.drain(..).collect(), dropped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_in_order_and_handed_over_once() {
        let mut p = Pending::default();
        p.push(1);
        p.push(2);
        assert_eq!(p.take(), (vec![1, 2], 0));
        assert_eq!(p.take(), (vec![], 0));
    }

    #[test]
    fn the_oldest_go_when_full_and_are_counted() {
        let mut p = Pending::default();
        for i in 0..(HELD as u32 + 3) {
            p.push(i);
        }
        let (items, dropped) = p.take();
        assert_eq!(dropped, 3);
        assert_eq!(items, (3..(HELD as u32 + 3)).collect::<Vec<_>>());
    }
}
