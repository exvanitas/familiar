//! The one owner of every saved address's and every guarded request's state: shell-core's
//! `owner::Ledger`, behind one lock that's never held across a wait, with each open request's
//! connection beside it. See "5c. The guarded fetch" in docs/shell-design.md. Every transition is
//! one call here, and whatever it ends is ended in the same critical section: its connection is
//! dropped and its waits are woken.

use crate::shell::lock;
use shell_core::{
    fetch::{self, FetchError},
    owner::{Ledger, ReqState, WriteRefused},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

/// Why a request was ended from outside, as its waits see it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stop {
    Running,
    Ended(FetchError),
}

/// One open request: how to stop its waits, and its body once the head has come.
pub struct Live<B> {
    pub stop: watch::Sender<Stop>,
    pub body: AsyncMutex<Option<B>>,
}

struct Book<B> {
    ledger: Ledger,
    live: HashMap<String, Arc<Live<B>>>,
}

pub struct Owner<B> {
    book: Mutex<Book<B>>,
    /// Woken whenever a key write ends, for a removal waiting to delete the key.
    writes_done: Notify,
}

impl<B> Owner<B> {
    pub fn new(saved: impl IntoIterator<Item = String>) -> Owner<B> {
        let mut ledger = Ledger::default();
        for id in saved {
            ledger.saved(&id);
        }
        Owner { book: Mutex::new(Book { ledger, live: HashMap::new() }), writes_done: Notify::new() }
    }

    /// A new address, once durably written.
    pub fn saved(&self, id: &str) {
        lock(&self.book).ledger.saved(id);
    }

    /// Registers a request: the address checked and the request open, in one step.
    pub fn register(&self, id: &str, address: &str, fetchable: bool) -> Result<(Arc<Live<B>>, watch::Receiver<Stop>), FetchError> {
        let mut book = lock(&self.book);
        book.ledger.register(id, address, fetchable, fetch::MAX_OPEN)?;
        let (stop, stopped) = watch::channel(Stop::Running);
        let live = Arc::new(Live { stop, body: AsyncMutex::new(None) });
        book.live.insert(id.to_string(), live.clone());
        Ok((live, stopped))
    }

    pub fn advance(&self, id: &str, to: ReqState) -> Result<(), FetchError> {
        lock(&self.book).ledger.advance(id, to)
    }

    pub fn check(&self, id: &str) -> Result<ReqState, FetchError> {
        lock(&self.book).ledger.check(id)
    }

    pub fn live(&self, id: &str) -> Option<Arc<Live<B>>> {
        lock(&self.book).live.get(id).cloned()
    }

    fn drop_live(book: &mut Book<B>, id: &str, why: Option<FetchError>) {
        if let Some(l) = book.live.remove(id) {
            if let Some(e) = why {
                let _ = l.stop.send(Stop::Ended(e));
            }
        }
    }

    /// The request ended on its own, with an error or at the real end of its body.
    pub fn end(&self, id: &str, why: Option<FetchError>) {
        let mut book = lock(&self.book);
        match why {
            Some(e) => {
                book.ledger.end(id, e);
            }
            None => book.ledger.finish(id),
        }
        Self::drop_live(&mut book, id, None);
    }

    /// `net_cancel`: in one step, an open request ends and its connection goes, or an id not yet
    /// registered is ended so its registration is refused.
    pub fn cancel(&self, id: &str) {
        let mut book = lock(&self.book);
        if book.ledger.cancel(id, fetch::valid_id(id)) {
            Self::drop_live(&mut book, id, Some(FetchError::Cancelled));
        }
    }

    /// A removal begins or is retried: the address is `Removing`, and every request under it
    /// ends `revoked` with its connection.
    pub fn begin_remove(&self, address: &str) -> Result<(), FetchError> {
        let mut book = lock(&self.book);
        for id in book.ledger.begin_remove(address)? {
            Self::drop_live(&mut book, &id, Some(FetchError::Revoked));
        }
        Ok(())
    }

    /// Waits, without blocking a thread, until no key write for the address is running. None can
    /// start once its removal has begun.
    pub async fn writes_over(&self, address: &str) {
        loop {
            let woken = self.writes_done.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if lock(&self.book).ledger.writes(address) == 0 {
                return;
            }
            woken.await;
        }
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
        self.writes_done.notify_waiters();
    }
}
