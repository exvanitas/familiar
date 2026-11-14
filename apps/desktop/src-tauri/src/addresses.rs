//! Saved addresses: the only places data may go. See "5c. The guarded fetch" in
//! docs/shell-design.md. The rules are `shell_core::address`'s; this file keeps the list and runs
//! the order: normalize, an identical address returns at once, the confirm state, the ask, and
//! only after Allow one lookup of a name and its class. Nothing touches the network before the
//! person says yes. The list is `shell\addresses.json`, written only here, atomically; a file that
//! can't be read counts as an empty list.

use crate::{confirm, shell::lock};
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
use tauri::{AppHandle, Manager, State};

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
}

#[derive(Serialize, Deserialize)]
struct File {
    v: u32,
    addresses: Vec<Saved>,
}

pub struct Addresses {
    path: PathBuf,
    list: Mutex<Vec<Saved>>,
    log: Arc<Log>,
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
    let written = std::fs::write(&temp, bytes).and_then(|()| std::fs::File::open(&temp)?.sync_all()).and_then(|()| std::fs::rename(&temp, path));
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
        Addresses { path, list: Mutex::new(list), log }
    }

    fn sound(a: &Saved) -> bool {
        let Some(kind) = Kind::parse(&a.kind) else { return false };
        address::check_add(kind, &a.url, &a.label, a.ports).is_ok_and(|c| c.identity.url == a.url) && reach_of(&a.reach).is_some() && a.id.len() == 32
    }

    fn save(&self, list: &[Saved]) -> Result<(), Fail> {
        let bytes = serde_json::to_vec_pretty(&File { v: 1, addresses: list.to_vec() }).map_err(|e| fail("failed", e.to_string()))?;
        write_atomic(&self.path, &bytes).map_err(|e| fail("failed", format!("the list couldn't be saved: {e}")))
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

#[tauri::command(async)]
pub fn address_list(addresses: State<Addresses>) -> Vec<Saved> {
    addresses.all()
}

#[tauri::command(async)]
pub fn address_add(app: AppHandle, kind: String, url: String, label: String, owner: Option<String>, ports: Option<(u16, u16)>) -> Result<Saved, Fail> {
    let addresses = app.state::<Addresses>();
    // 1. The form, with no network access.
    let kind = Kind::parse(&kind).ok_or_else(|| fail("invalid", "kind is model, server or peer"))?;
    let candidate = address::check_add(kind, &url, &label, ports)?;
    // 2. An identical address: returned, with no dialog.
    let same = |a: &Saved| a.kind == kind.as_str() && a.url == candidate.identity.url && a.ports == candidate.identity.ports;
    if let Some(a) = lock(&addresses.list).iter().find(|a| same(a)) {
        return Ok(a.clone());
    }
    // 3. The confirm state, before any lookup. 4. The ask, on a copy made now.
    let ticket = confirm::reserve(&app).map_err(|e| fail(e.kind(), "not asked"))?;
    let ask = shell_core::confirm::add_address(&candidate, &label);
    if !ticket.ask(owner.as_deref(), ask).map_err(|e| fail(e.kind(), "the dialog couldn't be shown"))? {
        return Err(fail("declined", "the person didn't allow it"));
    }
    // 5. After Allow: a literal's reach is known; a name is looked up once and classed.
    let reach = match candidate.normalized.reach {
        Some(r) => r,
        None => look_up(&candidate.normalized)?,
    };
    let saved = Saved {
        id: new_id(),
        kind: kind.as_str().into(),
        url: candidate.identity.url.clone(),
        label,
        reach: reach.as_str().into(),
        ports: candidate.identity.ports,
    };
    let mut list = lock(&addresses.list);
    if let Some(a) = list.iter().find(|a| same(a)) {
        return Ok(a.clone());
    }
    list.push(saved.clone());
    addresses.save(&list)?;
    addresses.log.line(&format!("address added {} ({}, {})", saved.id, saved.kind, saved.reach));
    Ok(saved)
}

#[tauri::command(async)]
pub fn address_remove(app: AppHandle, id: String) -> Result<(), Fail> {
    let addresses = app.state::<Addresses>();
    {
        let mut list = lock(&addresses.list);
        let before = list.len();
        list.retain(|a| a.id != id);
        if list.len() == before {
            return Err(fail("not-saved", "no such address"));
        }
        addresses.save(&list)?;
    }
    addresses.log.line(&format!("address removed {id}"));
    // Its open requests end with `revoked`, and its key goes.
    crate::net::revoke(&app, &id);
    crate::secrets::delete(&shell_core::secret::SecretRef::Addr { id }).map_err(|_| fail("failed", "the address went, but its key couldn't be deleted"))?;
    Ok(())
}
