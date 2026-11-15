//! The guarded fetch: the only way out of Familiar to the network, and only to saved addresses.
//! See "5c. The guarded fetch" in docs/shell-design.md. The rules are shell-core's: where it may
//! connect (`address`), the request and its limits and redirects (`fetch`), the key swap
//! (`secret`), redaction (`redact`), and every request's state (`owner`). This file runs them on
//! reqwest.
//!
//! A request is pull-based: `net_fetch` returns the head, then each `net_read` returns up to 1 MiB
//! of the body after redaction, and an empty read only at the real end. Its state is the owner's
//! (`crate::owner`): registered with its address checked, resolving under a deadline, sending,
//! streaming, ended. Its transport, from the lookup to the last byte, is one task that owns the
//! connection and tells the owner when it has terminated; `net_read` asks it for each read.
//! `net_cancel` and removing the address end it in the owner and return only after it has
//! terminated. Every wait checks the request's state first (a biased select), so nothing is sent
//! once it has ended.

use crate::{
    addresses::{Addresses, Saved},
    owner::Stop,
    secrets,
};
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
    Client, Method, StatusCode,
};
use serde::{Deserialize, Serialize};
use shell_core::{
    address::{self, Kind, Normalized, Reach},
    fetch::{self, FetchError, Limits},
    owner::{Helpers, ReqState, RESOLVE_DEADLINE},
    redact::{self, Redactor, KEY_MARK},
    secret,
};
use std::{
    future::Future,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};
use tauri::{ipc::Response, AppHandle, Manager};
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(e: FetchError) -> Fail {
    Fail { kind: e.kind(), message: format!("the request ended: {}", e.kind()) }
}

/// A request's body, once its head has come.
pub struct Body {
    response: reqwest::Response,
    redactor: Redactor,
    out: Vec<u8>,
    total: u64,
    limits: Limits,
    ended: bool,
}

/// A read, asked of a request's transport task: where its answer goes.
pub type Read = oneshot::Sender<Result<Vec<u8>, FetchError>>;

pub type Owner = crate::owner::Owner<Read>;

/// Nothing kept: every request gets its own client, so its resolver's lookups belong to that
/// request's transport. Every request's state is the owner's, in `Addresses`.
#[derive(Default)]
pub struct Net {}

/// A resolver that uses a lookup only if every answer is of the address's reach, so a name that
/// later resolves somewhere else (DNS rebinding) reaches nothing. TLS still checks the certificate
/// against the name. Its lookups are its request's helpers: one still queued when the request
/// ends never runs, and the transport doesn't terminate while one is running.
struct KeepReach(Reach, Arc<Helpers>);

#[derive(Debug)]
struct Blocked;
impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no answer of the address's reach")
    }
}
impl std::error::Error for Blocked {}

fn look_up(host: &str) -> std::io::Result<Vec<IpAddr>> {
    Ok((host, 0).to_socket_addrs()?.map(|s| s.ip()).collect())
}

impl Resolve for KeepReach {
    fn resolve(&self, name: Name) -> Resolving {
        let (reach, host, helpers) = (self.0, name.as_str().to_string(), self.1.clone());
        Box::pin(async move {
            type BoxError = Box<dyn std::error::Error + Send + Sync>;
            let answers = helper(&helpers, move || look_up(&host)).await.map_err(|_| Box::new(Blocked) as BoxError).and_then(|r| r.map_err(|e| Box::new(e) as BoxError))?;
            // Every answer of the address's reach, or none used at all: one answer elsewhere among
            // good ones is a rebinding attempt, not noise to filter out.
            let kept = shell_core::reach::all_of(reach, &answers).ok_or_else(|| Box::new(Blocked) as BoxError)?;
            Ok(Box::new(kept.into_iter().map(|ip| SocketAddr::new(ip, 0))) as Addrs)
        })
    }
}

fn client(reach: Reach, helpers: Arc<Helpers>) -> Client {
    let b = Client::builder()
        .dns_resolver(KeepReach(reach, helpers))
        .redirect(Policy::none())
        .connect_timeout(fetch::CONNECT_TIMEOUT)
        .user_agent("Familiar");
    // Only public addresses go through the system proxy; lan and loopback never do.
    let b = if reach == Reach::Public { b } else { b.no_proxy() };
    b.build().expect("the fetch's client")
}


/// The request's spec, from the `x-spec` header, percent-encoded JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    id: String,
    address: String,
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    max_bytes: Option<u64>,
    headers_ms: Option<u64>,
    idle_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct Head {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: Vec<(String, String)>,
    url: String,
    redirected: bool,
}

/// What a reqwest error becomes. A refusal of the resolver is `blocked-address`; a certificate
/// problem `tls`.
fn kind_of(e: &reqwest::Error) -> FetchError {
    if e.is_timeout() {
        return FetchError::Timeout;
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = source {
        if s.is::<Blocked>() {
            return FetchError::BlockedAddress;
        }
        let text = format!("{s:?}");
        if text.contains("Certificate") || text.contains("certificate") || text.contains("UnknownIssuer") {
            return FetchError::Tls;
        }
        source = s.source();
    }
    FetchError::Network
}

/// Resolves once the owner has ended the request, with why. Checked on the first poll, so in a
/// biased select it wins over anything else that's ready.
async fn stopped(stop: &mut watch::Receiver<Stop>) -> FetchError {
    loop {
        if let Stop::Ended(e) = *stop.borrow_and_update() {
            return e;
        }
        if stop.changed().await.is_err() {
            return FetchError::Cancelled;
        }
    }
}

/// One wait of a request: `f`, unless the owner ends the request first or `limit` passes. The
/// state is checked before `f` is first polled and on every wake, so an ended request never
/// polls `f` again; the owner's state is checked again on leaving.
async fn wait<T>(owner: &Owner, id: &str, stop: &mut watch::Receiver<Stop>, limit: Duration, f: impl Future<Output = Result<T, FetchError>>) -> Result<T, FetchError> {
    owner.check(id)?;
    let r = tokio::select! {
        biased;
        e = stopped(stop) => Err(e),
        r = tokio::time::timeout(limit, f) => r.unwrap_or(Err(FetchError::Timeout)),
    };
    owner.check(id)?;
    r
}

/// Blocking work, off the async workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, FetchError> {
    tokio::task::spawn_blocking(f).await.map_err(|_| FetchError::Network)
}

/// A request's blocking work, as one of its helpers: it runs only if the request is still running
/// when a blocking thread picks it up, and holds the transport's termination while it runs.
async fn helper<T: Send + 'static>(helpers: &Arc<Helpers>, f: impl FnOnce() -> T + Send + 'static) -> Result<T, FetchError> {
    let h = helpers.clone();
    // A check build only: the helper blocks the async worker it was called on, the regression
    // security.exec.responsive must catch.
    #[cfg(feature = "check-blocking")]
    {
        std::thread::sleep(Duration::from_secs(3));
        let _running = h.start().ok_or(FetchError::Cancelled)?;
        Ok(f())
    }
    #[cfg(not(feature = "check-blocking"))]
    tokio::task::spawn_blocking(move || {
        let _running = h.start()?;
        Some(f())
    })
    .await
    .map_err(|_| FetchError::Network)?
    .ok_or(FetchError::Cancelled)
}

#[tauri::command]
pub async fn net_fetch(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Head, Fail> {
    let spec = request.headers().get("x-spec").and_then(|v| v.to_str().ok()).map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned());
    let spec: Spec = spec.and_then(|s| serde_json::from_str(&s).ok()).ok_or(fail(FetchError::Invalid))?;
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => vec![],
    };
    start(&app, spec, body).await.map_err(fail)
}

/// Registers the request, its address checked, in one step of the owner, then starts its
/// transport task and waits for the head.
async fn start(app: &AppHandle, spec: Spec, body: Vec<u8>) -> Result<Head, FetchError> {
    if !fetch::valid_id(&spec.id) {
        return Err(FetchError::Invalid);
    }
    let addresses = app.state::<Addresses>();
    let found = addresses.get(&spec.address);
    let fetchable = found.as_ref().is_some_and(|(a, _)| matches!(Kind::parse(&a.kind), Some(Kind::Model | Kind::Server)));
    let (stop, reads) = addresses.owner.register(&spec.id, &spec.address, fetchable)?;
    let found = found.expect("registered, so it's saved");
    let (head, got) = oneshot::channel();
    tauri::async_runtime::spawn(transport(app.clone(), spec, found, body, stop, reads, head));
    got.await.unwrap_or(Err(FetchError::Network))
}

/// Tells the owner the transport has terminated when it goes, on every way out, a panic
/// included. Declared first in the task, so it goes last, after the connection.
struct Terminated {
    app: AppHandle,
    id: String,
    helpers: Arc<Helpers>,
}

impl Drop for Terminated {
    /// No helper starts from now on, and the owner hears of the termination only once every
    /// helper that had started has finished.
    fn drop(&mut self) {
        self.helpers.stop();
        let (app, id, helpers) = (self.app.clone(), std::mem::take(&mut self.id), self.helpers.clone());
        tauri::async_runtime::spawn(async move {
            while !helpers.idle() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            app.state::<Addresses>().owner.terminated(&id);
        });
    }
}

/// One request's transport, from its lookup to its last byte: it owns the connection, answers
/// reads, and ends when the body does, on an error, or when the owner ends the request.
async fn transport(app: AppHandle, spec: Spec, found: (Saved, Normalized), body: Vec<u8>, mut stop: watch::Receiver<Stop>, mut reads: mpsc::Receiver<Read>, head: oneshot::Sender<Result<Head, FetchError>>) {
    let helpers = Arc::new(Helpers::default());
    let _terminated = Terminated { app: app.clone(), id: spec.id.clone(), helpers: helpers.clone() };
    let id = spec.id.clone();
    let addresses = app.state::<Addresses>();
    let owner = &addresses.owner;
    let mut b = match go(owner, &helpers, &mut stop, found, spec, body).await {
        Ok((h, b)) => {
            if head.send(Ok(h)).is_err() {
                owner.end(&id, Some(FetchError::Cancelled));
                return;
            }
            b
        }
        Err(e) => {
            owner.end(&id, Some(e));
            let _ = head.send(Err(e));
            return;
        }
    };
    loop {
        let reply = tokio::select! {
            biased;
            _ = stopped(&mut stop) => return,
            r = reads.recv() => match r {
                Some(r) => r,
                None => return,
            },
        };
        let out = read_once(owner, &id, &mut stop, &mut b).await;
        let over = !matches!(&out, Ok(v) if !v.is_empty());
        match &out {
            Err(e) => owner.end(&id, Some(*e)),
            Ok(v) if v.is_empty() => owner.end(&id, None),
            Ok(_) => {}
        }
        let _ = reply.send(out);
        if over {
            return;
        }
    }
}

async fn go(owner: &Owner, helpers: &Arc<Helpers>, stop: &mut watch::Receiver<Stop>, (saved, norm): (Saved, Normalized), spec: Spec, body: Vec<u8>) -> Result<(Head, Body), FetchError> {
    let id = spec.id.as_str();
    let reach = crate::addresses::reach(&saved).ok_or(FetchError::NotSaved)?;
    let mut url = address::under(&norm, spec.url.as_str())?;
    let method = Method::from_bytes(fetch::check_method(&spec.method)?.as_bytes()).map_err(|_| FetchError::Invalid)?;
    let headers = fetch::request_headers(spec.headers)?;
    fetch::check_body(body.len())?;
    let limits = fetch::limits(spec.max_bytes, spec.headers_ms, spec.idle_ms)?;
    // Resolving: the key read and, for a public name, Familiar's own lookup first even when a
    // proxy will resolve it, together under one deadline.
    owner.advance(id, ReqState::Resolving)?;
    let (address_id, host, public_name) = (saved.id.clone(), norm.host.clone(), reach == Reach::Public && norm.reach.is_none());
    let h = helpers.clone();
    let key = wait(owner, id, stop, RESOLVE_DEADLINE, async move {
        let key = helper(&h, move || secrets::address_key(&address_id)).await?;
        if public_name {
            let answers = helper(&h, move || look_up(&host)).await?.map_err(|_| FetchError::Network)?;
            shell_core::reach::all_of(Reach::Public, &answers).ok_or(FetchError::BlockedAddress)?;
        }
        Ok(key)
    })
    .await?;
    let swapped = secret::swap(headers, key.as_deref()).map_err(|_| FetchError::NoKey)?;
    // The address's stored key is redacted from the response, and kept out of redirects, whether
    // or not this request carried it: an endpoint can hold it from earlier requests.
    let secrets: Vec<String> = key.into_iter().collect();
    owner.advance(id, ReqState::Sending)?;
    let (response, redirected) = send(owner, id, stop, &client(reach, helpers.clone()), method, &mut url, &swapped.headers, body, &norm, &secrets, &limits).await?;
    let head = redact::redact_head(
        redact::Head {
            status_text: response.status().canonical_reason().unwrap_or("").to_string(),
            headers: response
                .headers()
                .iter()
                .filter(|(n, _)| fetch::response_header_kept(n.as_str()))
                .map(|(n, v)| (n.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect(),
            url: url.to_string(),
        },
        &secrets,
    );
    if !fetch::response_headers_fit(&head.headers) {
        return Err(FetchError::TooLarge);
    }
    let status = response.status().as_u16();
    let body = Body { response, redactor: Redactor::new(&secrets, KEY_MARK), out: vec![], total: 0, limits, ended: false };
    owner.advance(id, ReqState::Streaming)?;
    Ok((Head { status, status_text: head.status_text, headers: head.headers, url: head.url, redirected }, body))
}

/// Sends, following redirects only under the same saved address.
#[allow(clippy::too_many_arguments)]
async fn send(
    owner: &Owner,
    id: &str,
    stop: &mut watch::Receiver<Stop>,
    client: &Client,
    mut method: Method,
    url: &mut url::Url,
    headers: &[(String, String)],
    body: Vec<u8>,
    norm: &Normalized,
    secrets: &[String],
    limits: &Limits,
) -> Result<(reqwest::Response, bool), FetchError> {
    let mut body = Some(bytes::Bytes::from(body));
    for hop in 0..=fetch::MAX_REDIRECTS {
        let mut rb = client.request(method.clone(), url.clone());
        for (n, v) in headers {
            rb = rb.header(n, v);
        }
        if let Some(b) = &body {
            if !b.is_empty() {
                rb = rb.body(b.clone());
            }
        }
        let response = wait(owner, id, stop, limits.headers, async move { rb.send().await.map_err(|e| kind_of(&e)) }).await?;
        let status = response.status();
        if !status.is_redirection() || status == StatusCode::NOT_MODIFIED {
            return Ok((response, hop > 0));
        }
        let location = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or(FetchError::RedirectRefused)?.to_string();
        *url = fetch::redirect(hop, url, &location, norm, secrets)?;
        if matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER) && method != Method::HEAD {
            method = Method::GET;
            body = None;
        }
    }
    Err(FetchError::RedirectRefused)
}

/// Up to 1 MiB of the body, after redaction. Waits for output; empty only at the real end.
async fn read_once(owner: &Owner, id: &str, stop: &mut watch::Receiver<Stop>, b: &mut Body) -> Result<Vec<u8>, FetchError> {
    loop {
        if !b.out.is_empty() {
            let n = b.out.len().min(fetch::MAX_READ);
            return Ok(b.out.drain(..n).collect());
        }
        if b.ended {
            return Ok(vec![]);
        }
        let response = &mut b.response;
        match wait(owner, id, stop, b.limits.idle, async { response.chunk().await.map_err(|e| kind_of(&e)) }).await? {
            Some(chunk) => {
                // Counted after decompression, so a small compressed body can't grow past it.
                b.total += chunk.len() as u64;
                if b.total > b.limits.max_bytes {
                    return Err(FetchError::TooLarge);
                }
                let out = b.redactor.feed(&chunk);
                b.out.extend(out);
            }
            None => {
                let out = b.redactor.finish();
                b.out.extend(out);
                b.ended = true;
            }
        }
    }
}

/// Asks the request's transport task for the next read.
#[tauri::command]
pub async fn net_read(app: AppHandle, id: String) -> Result<Response, Fail> {
    let addresses = app.state::<Addresses>();
    let owner = &addresses.owner;
    let gone = || fail(owner.check(&id).err().unwrap_or(FetchError::Invalid));
    if owner.check(&id).map_err(fail)? != ReqState::Streaming {
        return Err(fail(FetchError::Invalid));
    }
    let Some(reads) = owner.reads(&id) else { return Err(gone()) };
    let (reply, answer) = oneshot::channel();
    reads.send(reply).await.map_err(|_| gone())?;
    match answer.await {
        Ok(r) => r.map(Response::new).map_err(fail),
        Err(_) => Err(gone()),
    }
}

/// Ends a request at any moment, before or after its head, and returns only once its transport
/// has terminated: nothing of it is sent after this returns.
#[tauri::command]
pub async fn net_cancel(app: AppHandle, id: String) -> Result<(), Fail> {
    app.state::<Addresses>().owner.cancel(&id).await;
    Ok(())
}

/// The per-user system proxy setting, and whether the guarded fetch uses it. Settings shows it:
/// behind a proxy, the private-network rule rests on the proxy. Only a manual proxy is used; with a
/// PAC script or auto-detect set, the fetch goes direct, so `in_use` is false for them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proxy {
    in_use: bool,
    kind: &'static str,
}

#[tauri::command]
pub async fn net_proxy() -> Result<Proxy, Fail> {
    let kind = blocking(proxy_kind).await.map_err(fail)?;
    Ok(Proxy { in_use: kind == "manual", kind })
}

#[cfg(windows)]
fn proxy_kind() -> &'static str {
    use windows::{
        core::HSTRING,
        Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ},
    };
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    let key = HSTRING::from(KEY);
    let dword = |name: &str| {
        let (mut v, mut size) = (0u32, 4u32);
        let ok = unsafe { RegGetValueW(HKEY_CURRENT_USER, &key, &HSTRING::from(name), RRF_RT_REG_DWORD, None, Some((&mut v as *mut u32).cast()), Some(&mut size)) }.is_ok();
        ok.then_some(v)
    };
    let text = |name: &str| {
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let ok = unsafe { RegGetValueW(HKEY_CURRENT_USER, &key, &HSTRING::from(name), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) }.is_ok();
        ok.then(|| String::from_utf16_lossy(&buf[..buf.iter().position(|c| *c == 0).unwrap_or(0)]))
    };
    if text("AutoConfigURL").is_some_and(|u| !u.is_empty()) {
        return "pac";
    }
    if dword("ProxyEnable") == Some(1) && text("ProxyServer").is_some_and(|s| !s.is_empty()) {
        return "manual";
    }
    // "Automatically detect settings" is bit 8 of the ninth byte of the default connection's
    // settings blob.
    let conn = HSTRING::from(format!("{KEY}\\Connections"));
    let mut blob = vec![0u8; 4096];
    let mut size = blob.len() as u32;
    let read = unsafe { RegGetValueW(HKEY_CURRENT_USER, &conn, &HSTRING::from("DefaultConnectionSettings"), RRF_RT_REG_BINARY, None, Some(blob.as_mut_ptr().cast()), Some(&mut size)) }.is_ok();
    if read && size > 8 && blob[8] & 0x08 != 0 {
        return "auto-detect";
    }
    "none"
}

#[cfg(not(windows))]
fn proxy_kind() -> &'static str {
    "none"
}
