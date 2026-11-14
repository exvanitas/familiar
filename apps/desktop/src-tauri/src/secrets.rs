//! Keys, in Windows Credential Manager, write-only. See "5a. Credentials" in
//! docs/shell-design.md. The rules are `shell_core::secret`'s: refs, the value rules, the sealed
//! blob bound to an address or setup, the hint, and who may set what. There is no command that
//! reads a key back. Inside the exe, `address_key` gives the guarded fetch its address's key and
//! `server_secret` gives a server start its setup's secret; nothing else reads one.

use crate::addresses::Addresses;
use serde::Serialize;
use shell_core::{
    address::Kind,
    secret::{self, Caller, SecretError, SecretRef},
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Fail {
    Fail { kind, message: message.into() }
}

impl From<SecretError> for Fail {
    fn from(e: SecretError) -> Fail {
        fail(e.kind(), "refused")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    present: bool,
    bound_to: Option<String>,
    hint: Option<String>,
}

fn entry(r: &SecretRef) -> Result<keyring::Entry, Fail> {
    keyring::Entry::new(secret::SERVICE, &r.user()).map_err(|_| fail("failed", "Credential Manager couldn't be reached"))
}

/// The stored value for `r`, if there is one and it's bound to `bound`.
fn read(r: &SecretRef, bound: &str) -> Option<String> {
    let blob = entry(r).ok()?.get_secret().ok()?;
    secret::open(&blob, bound)
}

/// What a ref is bound to, from the exe's own records: an `addr:` ref to its saved address (and
/// that address's kind), a `server:` ref to its setup id. A page's word is never taken for it.
fn binding(app: &AppHandle, r: &SecretRef) -> (String, Option<Kind>) {
    match r {
        SecretRef::Addr { id } => {
            let kind = app.state::<Addresses>().get(id).and_then(|(a, _)| Kind::parse(&a.kind));
            (id.clone(), kind)
        }
        SecretRef::Server { setup, .. } => (setup.clone(), None),
    }
}

/// The key the guarded fetch puts in place of the placeholder, for a request under `address_id`.
pub fn address_key(address_id: &str) -> Option<String> {
    let r = SecretRef::Addr { id: address_id.to_string() };
    read(&r, address_id)
}

/// A local server's secret setting, for its launch: the value of `server:<setup_id>:<name>`, if
/// it's set and bound to that setup. For the server side only.
#[allow(dead_code)] // the server start calls it
pub fn server_secret(setup_id: &str, name: &str) -> Option<String> {
    let r = SecretRef::parse(&format!("server:{setup_id}:{name}")).ok()?;
    read(&r, setup_id)
}

/// Deletes a ref's credential. A missing one is fine.
pub fn delete(r: &SecretRef) -> Result<(), Fail> {
    match entry(r)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(fail("failed", "the key couldn't be deleted")),
    }
}

/// Settings stores any `addr:` key for a saved address and any `server:` secret. Core stores only
/// a peer address's token. The caller is the window the request came from, never the page's word.
#[tauri::command(async)]
pub fn secret_set(app: AppHandle, window: WebviewWindow, id: String, value: String) -> Result<(), Fail> {
    let r = SecretRef::parse(&id)?;
    // From the address check through the credential's commit, no removal can run: a key is never
    // stored for an address that's gone.
    let addresses = app.state::<Addresses>();
    let _keys = addresses.keys();
    let (bound, kind) = binding(&app, &r);
    if !secret::may_set(Caller::from_label(window.label()), &r, kind) {
        return Err(SecretError::NotAllowed.into());
    }
    let blob = secret::seal(&bound, &value)?;
    entry(&r)?.set_secret(&blob).map_err(|_| fail("failed", "the key couldn't be stored"))?;
    // The value is never logged; the ref names only ids.
    if let Some(shell) = app.try_state::<crate::shell::Shell>() {
        shell.log.line(&format!("key set for {}", r.user()));
    }
    Ok(())
}

/// Whether a key is set, what it's bound to, and a hint for a long one. Never the key.
#[tauri::command(async)]
pub fn secret_status(app: AppHandle, id: String) -> Result<Status, Fail> {
    let r = SecretRef::parse(&id)?;
    let (bound, _) = binding(&app, &r);
    Ok(match read(&r, &bound) {
        Some(v) => Status { present: true, bound_to: Some(bound), hint: secret::hint(&v) },
        None => Status { present: false, bound_to: None, hint: None },
    })
}

#[tauri::command(async)]
pub fn secret_delete(id: String) -> Result<(), Fail> {
    delete(&SecretRef::parse(&id)?)
}
