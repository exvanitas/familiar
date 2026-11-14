//! The one owner of every saved address's and every guarded request's state: shell-core's
//! `owner::Ledger`, behind one lock that's never held across a wait, with each open request's
//! stop signal and read queue beside it. See "5c. The guarded fetch" in docs/shell-design.md.
//!
//! Every transition is one call here. A request's transport is one task (`net.rs`) that says when
//! it has terminated; a cancel and a removal end their requests at once, then wait, without
//! blocking a thread, until every one of those tasks has said so, before they return or go on.

use crate::shell::lock;
use shell_core::{
    fetch::{self, FetchError},
    owner::{Ledger, ReqState, WriteRefused},
};
use std::{
    collections::HashMap,
    sync::Mutex,
};
use tokio::sync::{mpsc, watch, Notify};

/// What a request's transport task watches: running, or ended and why.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stop {
    Running,
    Ended(FetchError),
}

/// One open request, as the owner holds it: how to stop its task, and how to ask it for a read.
struct Live<R> {
    stop: watch::Sender<Stop>,
    reads: mpsc::Sender<R>,
}

struct Book<R> {
    ledger: Ledger,
    live: HashMap<String, Live<R>>,
}

pub struct Owner<R> {
    book: Mutex<Book<R>>,
    /// Woken whenever a transport terminates or a key write ends.
    changed: Notify,
}

impl<R> Owner<R> {
    /// The owner, from the list as loaded: each id, and whether it's marked as being removed.
    pub fn new(loaded: impl IntoIterator<Item = (String, bool)>) -> Owner<R> {
        let mut ledger = Ledger::default();
        for (id, removing) in loaded {
            if removing {
                ledger.loaded_removing(&id);
            } else {
                ledger.saved(&id);
            }
        }
        Owner { book: Mutex::new(Book { ledger, live: HashMap::new() }), changed: Notify::new() }
    }

    /// A new address, once durably written.
    pub fn saved(&self, id: &str) {
        lock(&self.book).ledger.saved(id);
    }

    /// Registers a request, its address checked, in one step. Returns what its transport task
    /// watches and the queue its reads come in on.
    pub fn register(&self, id: &str, address: &str, fetchable: bool) -> Result<(watch::Receiver<Stop>, mpsc::Receiver<R>), FetchError> {
        let mut book = lock(&self.book);
        book.ledger.register(id, address, fetchable, fetch::MAX_OPEN)?;
        let (stop, stopped) = watch::channel(Stop::Running);
        let (reads, queue) = mpsc::channel(4);
        book.live.insert(id.to_string(), Live { stop, reads });
        Ok((stopped, queue))
    }

    pub fn advance(&self, id: &str, to: ReqState) -> Result<(), FetchError> {
        lock(&self.book).ledger.advance(id, to)
    }

    pub fn check(&self, id: &str) -> Result<ReqState, FetchError> {
        lock(&self.book).ledger.check(id)
    }

    /// Where to ask an open request for a read.
    pub fn reads(&self, id: &str) -> Option<mpsc::Sender<R>> {
        lock(&self.book).live.get(id).map(|l| l.reads.clone())
    }

    /// The request ended by itself: with an error, or at the real end of its body.
    pub fn end(&self, id: &str, why: Option<FetchError>) {
        let mut book = lock(&self.book);
        match why {
            Some(e) => {
                book.ledger.end(id, e);
            }
            None => book.ledger.finish(id),
        }
    }

    /// Its transport task has terminated: connection dropped, nothing more can be sent.
    pub fn terminated(&self, id: &str) {
        {
            let mut book = lock(&self.book);
            book.ledger.terminated(id);
            book.live.remove(id);
        }
        self.changed.notify_waiters();
    }

    fn signal(book: &Book<R>, id: &str, why: FetchError) {
        if let Some(l) = book.live.get(id) {
            let _ = l.stop.send(Stop::Ended(why));
        }
    }

    /// Waits, without blocking a thread, until `done` holds.
    async fn until(&self, done: impl Fn(&Ledger) -> bool) {
        loop {
            let woken = self.changed.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if done(&lock(&self.book).ledger) {
                return;
            }
            woken.await;
        }
    }

    /// `net_cancel`: the request ends now (or an id not yet registered is ended, so its
    /// registration is refused), and this returns only once its transport has terminated.
    pub async fn cancel(&self, id: &str) {
        {
            let mut book = lock(&self.book);
            if book.ledger.cancel(id, fetch::valid_id(id)) {
                Self::signal(&book, id, FetchError::Cancelled);
            }
        }
        self.until(|l| !l.running(id)).await;
    }

    /// A removal begins or is retried: the address is `Removing`, and every request under it ends
    /// `revoked`. Then waits until each of their transports has terminated and no key write for
    /// the address is running.
    pub async fn begin_remove(&self, address: &str) -> Result<(), FetchError> {
        {
            let mut book = lock(&self.book);
            for id in book.ledger.begin_remove(address)? {
                Self::signal(&book, &id, FetchError::Revoked);
            }
        }
        self.until(|l| l.settled(address)).await;
        Ok(())
    }

    /// The list without the address is durably written.
    pub fn removed(&self, address: &str) {
        lock(&self.book).ledger.removed(address);
    }

    pub fn begin_write(&self, address: &str) -> Result<(), WriteRefused> {
        lock(&self.book).ledger.begin_write(address)
    }

    pub fn end_write(&self, address: &str) {
        lock(&self.book).ledger.end_write(address);
        self.changed.notify_waiters();
    }
}
