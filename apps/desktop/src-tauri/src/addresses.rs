//! Saved addresses: the only places data may go. See "5c. The guarded fetch" in
//! docs/shell-design.md. The rules are `shell_core::address`'s; this file keeps the list and runs
//! the order: normalize, an identical address returns at once, the confirm state, the ask, and
//! only after Allow one lookup of a name and its class. Nothing touches the network before the
//! person says yes. The list is `shell\addresses.json`, written only here, atomically; a file that
//! can't be read counts as an empty list.
//!
//! Whether an address may be used is the owner's (`crate::owner`): `Saved`, `Removing` from the
//! moment its removal begins until the list without it is durably written, then `Removed`. A
//! removal is durable before anything irreversible: the entry is written as `removing` first,
//! then its key is deleted, then the list is written without it. An entry loaded as `removing`
//! starts `Removing`, refusing everything, and the removal is finished at start. Every
//! command here is async, and anything that blocks (the dialog, a lookup, a file or credential
//! write) runs off the async workers.

use crate::{confirm, net::Owner, shell::lock};
use serde::{Deserialize, Serialize};
use shell_core::{
    address::{self, AddrError, Kind, Normalized, Reach},
    log::Log,
};
use std::{
    net::{IpAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

/// One saved address, as stored and as pages see it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Saved {
    pub id: String,
    pub kind: String,
    pub url: String,
    pub label: String,
    pub reach: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<(u16, u16)>,
    /// Its removal has begun and isn't finished.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub removing: bool,
}

#[derive(Serialize, Deserialize)]
struct File {
    v: u32,
    addresses: Vec<Saved>,
}

pub struct Addresses {
    path: PathBuf,
    /// Held only for a moment, never across a write.
    list: Mutex<Vec<Saved>>,
    /// Held by whoever writes the list, on a blocking thread, from reading it through the write.
    save: Mutex<()>,
    log: Arc<Log>,
    /// Every address's and every request's state.
    pub owner: Owner,
}

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Fail {
    Fail { kind, message: message.into() }
}

impl From<AddrError> for Fail {
    fn from(e: AddrError) -> Fail {
        fail(e.kind(), "the address was refused")
    }
}

fn reach_of(s: &str) -> Option<Reach> {
    match s {
        "public" => Some(Reach::Public),
        "lan" => Some(Reach::Lan),
        "loopback" => Some(Reach::Loopback),
        _ => None,
    }
}

/// 128 random bits, as hex.
pub fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the system's random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Writes `bytes` to `path` through a fresh temporary file beside it, then a rename, so the file
/// is always whole: the old one or the new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no folder"))?;
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!(".~{}.tmp", &new_id()[..16]));
    let written = (|| {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        f.write_all(bytes)?;
        // Flushed through the handle it was written with: a read-only one can't be flushed.
        f.sync_all()?;
        drop(f);
        std::fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

impl Addresses {
    /// The list from `shell\addresses.json`. An unreadable file, or one with an entry that no
    /// longer passes the rules, counts as an empty list: nothing is trusted that isn't whole.
    pub fn load(data_dir: &Path, log: Arc<Log>) -> Addresses {
        let path = data_dir.join("shell").join("addresses.json");
        let list = match std::fs::read(&path) {
            Err(_) => vec![],
            Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
                Ok(f) if f.v == 1 && f.addresses.iter().all(Self::sound) => f.addresses,
                _ => {
                    log.line("addresses: the saved list couldn't be read, so it counts as empty");
                    vec![]
                }
            },
        };
        let owner = Owner::new(list.iter().map(|a| (a.id.clone(), a.removing)));
        let unfinished: Vec<String> = list.iter().filter(|a| a.removing).map(|a| a.id.clone()).collect();
        let addresses = Addresses { path, list: Mutex::new(list), save: Mutex::new(()), log, owner };
        // A removal a run before didn't finish: finished now, before any page runs. Until it is,
        // the address refuses everything.
        for id in unfinished {
            match shell_core::owner::run_removal(&mut Durable(&addresses), &id) {
                Ok(()) => {
                    addresses.owner.removed(&id);
                    addresses.log.line(&format!("address removed {id}, finishing a removal from before"));
                }
                Err(e) => addresses.log.line(&format!("address {id} is still being removed: {e}")),
            }
        }
        addresses
    }

    fn sound(a: &Saved) -> bool {
        let Some(kind) = Kind::parse(&a.kind) else { return false };
        address::check_add(kind, &a.url, &a.label, a.ports).is_ok_and(|c| c.identity.url == a.url) && reach_of(&a.reach).is_some() && a.id.len() == 32
    }

    fn save(&self, list: &[Saved]) -> Result<(), Fail> {
        let bytes = serde_json::to_vec_pretty(&File { v: 1, addresses: list.to_vec() }).map_err(|e| fail("failed", e.to_string()))?;
        write_atomic(&self.path, &bytes).map_err(|e| fail("failed", format!("the list couldn't be saved: {e}")))
    }

    /// Adds an address, written durably before it's in memory. An identical one already saved is
    /// returned instead. Blocking.
    fn add_durably(&self, saved: Saved, same: impl Fn(&Saved) -> bool) -> Result<Saved, Fail> {
        let _save = lock(&self.save);
        let mut next = lock(&self.list).clone();
        if let Some(a) = next.iter().find(|a| same(a)) {
            return Ok(a.clone());
        }
        next.push(saved.clone());
        self.save(&next)?;
        *lock(&self.list) = next;
        Ok(saved)
    }

    /// Writes the list with the address marked as being removed. Blocking.
    fn mark_removing_durably(&self, id: &str) -> Result<(), Fail> {
        let _save = lock(&self.save);
        let mut next = lock(&self.list).clone();
        let a = next.iter_mut().find(|a| a.id == id).ok_or_else(|| fail("not-saved", "no such address"))?;
        if a.removing {
            return Ok(());
        }
        a.removing = true;
        self.save(&next)?;
        *lock(&self.list) = next;
        Ok(())
    }

    /// Writes the list without the address, then drops it from memory. Blocking.
    fn remove_durably(&self, id: &str) -> Result<(), Fail> {
        let _save = lock(&self.save);
        let next: Vec<Saved> = lock(&self.list).iter().filter(|a| a.id != id).cloned().collect();
        self.save(&next)?;
        *lock(&self.list) = next;
        Ok(())
    }

    pub fn all(&self) -> Vec<Saved> {
        lock(&self.list).clone()
    }

    /// A saved address by id, with its URL parsed for the fetch.
    pub fn get(&self, id: &str) -> Option<(Saved, Normalized)> {
        let a = lock(&self.list).iter().find(|a| a.id == id).cloned()?;
        let n = address::normalize(&a.url).ok()?;
        Some((a, n))
    }
}

/// The reach of a saved address, as the fetch uses it.
pub fn reach(a: &Saved) -> Option<Reach> {
    reach_of(&a.reach)
}

/// One lookup of a name, only after Allow. That lookup is egress the person just approved.
fn look_up(n: &Normalized) -> Result<Reach, AddrError> {
    let port = n.port.unwrap_or(if n.scheme == "https" { 443 } else { 80 });
    let answers: Vec<IpAddr> = (n.host.as_str(), port).to_socket_addrs().map_err(|_| AddrError::BlockedAddress)?.map(|s| s.ip()).collect();
    address::class_answers(&n.scheme, &answers)
}

/// Blocking work, off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, Fail> {
    tokio::task::spawn_blocking(f).await.map_err(|_| fail("failed", "the work stopped"))
}

#[tauri::command]
pub async fn address_list(app: AppHandle) -> Result<Vec<Saved>, Fail> {
    Ok(app.state::<Addresses>().all())
}

#[tauri::command]
pub async fn address_add(app: AppHandle, kind: String, url: String, label: String, owner: Option<String>, ports: Option<(u16, u16)>) -> Result<Saved, Fail> {
    // 1. The form, with no network access.
    let kind = Kind::parse(&kind).ok_or_else(|| fail("invalid", "kind is model, server or peer"))?;
    let candidate = address::check_add(kind, &url, &label, ports)?;
    // 2. An identical address: returned, with no dialog.
    let identity = candidate.identity.clone();
    // An address being removed isn't the same address: asking again saves a new one.
    let same = move |a: &Saved| !a.removing && a.kind == kind.as_str() && a.url == identity.url && a.ports == identity.ports;
    if let Some(a) = app.state::<Addresses>().all().into_iter().find(|a| same(a)) {
        return Ok(a);
    }
    // 3. The confirm state, before any lookup. 4. The ask, on a copy made now. Both wait, so
    // they run on a blocking thread; the dialog itself has a thread of its own.
    let ask = shell_core::confirm::add_address(&candidate, &label);
    let a = app.clone();
    let approved = blocking(move || {
        let ticket = confirm::reserve(&a).map_err(|e| fail(e.kind(), "not asked"))?;
        ticket.ask(owner.as_deref(), ask).map_err(|e| fail(e.kind(), "the dialog couldn't be shown"))
    })
    .await??;
    if !approved {
        return Err(fail("declined", "the person didn't allow it"));
    }
    // 5. After Allow: a literal's reach is known; a name is looked up once and classed.
    let reach = match candidate.normalized.reach {
        Some(r) => r,
        None => {
            let n = candidate.normalized.clone();
            blocking(move || look_up(&n)).await??
        }
    };
    let saved = Saved {
        id: new_id(),
        kind: kind.as_str().into(),
        url: candidate.identity.url.clone(),
        label,
        reach: reach.as_str().into(),
        ports: candidate.identity.ports,
        removing: false,
    };
    let a = app.clone();
    let stored = blocking(move || a.state::<Addresses>().add_durably(saved, same)).await??;
    let addresses = app.state::<Addresses>();
    addresses.owner.saved(&stored.id);
    addresses.log.line(&format!("address added {} ({}, {})", stored.id, stored.kind, stored.reach));
    Ok(stored)
}

/// A removal's durable steps on the real list and Credential Manager. Blocking.
struct Durable<'a>(&'a Addresses);

impl shell_core::owner::RemovalStore for Durable<'_> {
    fn mark_removing(&mut self, id: &str) -> Result<(), String> {
        self.0.mark_removing_durably(id).map_err(|e| e.message)
    }
    fn delete_key(&mut self, id: &str) -> Result<(), String> {
        crate::secrets::delete(&shell_core::secret::SecretRef::Addr { id: id.to_string() }).map_err(|_| "the address's key couldn't be deleted".to_string())
    }
    fn write_without(&mut self, id: &str) -> Result<(), String> {
        self.0.remove_durably(id).map_err(|e| e.message)
    }
}

/// Removes an address. From the first moment it's `Removing`: its requests end `revoked`, and new
/// requests and key writes are refused. Once every one of its requests' transports has terminated
/// and no key write is running, the removal is made durable (`run_removal`): the entry written as
/// removing, its key deleted, the list written without it, and only then is it `Removed`. If any
/// step fails it stays `Removing`, still refusing everything, across a restart too, and a retry,
/// or the next start, continues from there.
#[tauri::command]
pub async fn address_remove(app: AppHandle, id: String) -> Result<(), Fail> {
    let addresses = app.state::<Addresses>();
    addresses.owner.begin_remove(&id).await.map_err(|_| fail("not-saved", "no such address"))?;
    let (a, i) = (app.clone(), id.clone());
    let done = blocking(move || shell_core::owner::run_removal(&mut Durable(a.state::<Addresses>().inner()), &i)).await?;
    if let Err(e) = done {
        addresses.log.line(&format!("address {id} not removed yet: it stays refused until a retry completes"));
        return Err(fail("failed", e));
    }
    addresses.owner.removed(&id);
    addresses.log.line(&format!("address removed {id}"));
    Ok(())
}
