//! The guarded fetch: the only way out of Familiar to the network, and only to saved addresses.
//! See "5c. The guarded fetch" in docs/shell-design.md. The rules are shell-core's: where it may
//! connect (`address`), the request and its limits and redirects (`fetch`), the key swap
//! (`secret`) and redaction (`redact`). This file runs them on reqwest.
//!
//! A request is pull-based: `net_fetch` returns the head, then each `net_read` returns up to 1 MiB
//! of the body after redaction, and an empty read only at the real end. `net_cancel` ends it at any
//! moment, and removing its address ends it with `revoked`.

use crate::{addresses::Addresses, secrets, shell::lock};
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
    Client, Method, StatusCode,
};
use serde::{Deserialize, Serialize};
use shell_core::{
    address::{self, Kind, Normalized, Reach},
    fetch::{self, FetchError, Limits},
    redact::{self, Redactor, KEY_MARK},
    secret,
};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{ipc::Response, AppHandle, Manager, State};
use tokio::sync::{watch, Mutex as AsyncMutex};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(e: FetchError) -> Fail {
    Fail { kind: e.kind(), message: format!("the request ended: {}", e.kind()) }
}

/// Why a request was ended from outside: `net_cancel`, or its address removed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stop {
    Running,
    Cancelled,
    Revoked,
}

struct Body {
    response: reqwest::Response,
    redactor: Redactor,
    out: Vec<u8>,
    total: u64,
    limits: Limits,
    ended: bool,
}

struct Request {
    address: String,
    stop: watch::Sender<Stop>,
    body: AsyncMutex<Option<Body>>,
}

/// Open requests, and every id used this run, since an id is never reused.
#[derive(Default)]
pub struct Net {
    open: Mutex<HashMap<String, Arc<Request>>>,
    used: Mutex<HashSet<String>>,
    /// Requests ended from outside, and why, so a later read says `revoked` rather than only that
    /// the request is gone.
    ended: Mutex<HashMap<String, FetchError>>,
    /// Addresses being removed: no new request may start under one. Kept under `open`'s lock.
    revoked: Mutex<HashSet<String>>,
    /// Lan and loopback, which never use a proxy, so they can be kept.
    local: OnceLock<[Client; 2]>,
}

/// A resolver that keeps only answers of the address's reach, so a name that later resolves
/// somewhere else (DNS rebinding) reaches nothing. TLS still checks the certificate against the
/// name.
struct KeepReach(Reach);

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
        let (reach, host) = (self.0, name.as_str().to_string());
        Box::pin(async move {
            type BoxError = Box<dyn std::error::Error + Send + Sync>;
            let answers = tokio::task::spawn_blocking(move || look_up(&host)).await.map_err(|e| Box::new(e) as BoxError)?.map_err(|e| Box::new(e) as BoxError)?;
            // Every answer of the address's reach, or none used at all: one answer elsewhere among
            // good ones is a rebinding attempt, not noise to filter out.
            let kept = shell_core::reach::all_of(reach, &answers).ok_or_else(|| Box::new(Blocked) as BoxError)?;
            Ok(Box::new(kept.into_iter().map(|ip| SocketAddr::new(ip, 0))) as Addrs)
        })
    }
}

fn client(reach: Reach) -> Client {
    let b = Client::builder()
        .dns_resolver(KeepReach(reach))
        .redirect(Policy::none())
        .connect_timeout(fetch::CONNECT_TIMEOUT)
        .user_agent("Familiar");
    // Only public addresses go through the system proxy; lan and loopback never do.
    let b = if reach == Reach::Public { b } else { b.no_proxy() };
    b.build().expect("the fetch's client")
}

impl Net {
    /// A public address gets a client made for this request, so it uses the system proxy as it is
    /// now, not as it was when Familiar started.
    fn client(&self, reach: Reach) -> Client {
        let local = self.local.get_or_init(|| [client(Reach::Lan), client(Reach::Loopback)]);
        match reach {
            Reach::Public => client(Reach::Public),
            Reach::Lan => local[0].clone(),
            Reach::Loopback => local[1].clone(),
        }
    }

    fn take(&self, id: &str) -> Option<Arc<Request>> {
        lock(&self.open).remove(id)
    }
}

/// Ends every open request under an address, with `revoked`. Called when it's removed.
pub fn revoke(app: &AppHandle, address_id: &str) {
    let Some(net) = app.try_state::<Net>() else { return };
    let (ids, gone): (Vec<String>, Vec<Arc<Request>>) = {
        let mut open = lock(&net.open);
        // Under the same lock a new request registers under, so none can slip in after this.
        lock(&net.revoked).insert(address_id.to_string());
        let ids: Vec<String> = open.iter().filter(|(_, r)| r.address == address_id).map(|(id, _)| id.clone()).collect();
        let gone = ids.iter().filter_map(|id| open.remove(id)).collect();
        (ids, gone)
    };
    let mut ended = lock(&net.ended);
    for r in gone {
        let _ = r.stop.send(Stop::Revoked);
    }
    for id in ids {
        ended.insert(id, FetchError::Revoked);
    }
}

/// The address is staying after all (its removal couldn't be saved): requests may start again.
pub fn unrevoke(app: &AppHandle, address_id: &str) {
    if let Some(net) = app.try_state::<Net>() {
        let _open = lock(&net.open);
        lock(&net.revoked).remove(address_id);
    }
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

/// Waits for `f`, or for the request to be stopped from outside, or for `limit`.
async fn guarded<T>(stop: &mut watch::Receiver<Stop>, limit: std::time::Duration, f: impl std::future::Future<Output = Result<T, reqwest::Error>>) -> Result<T, FetchError> {
    let stopped = |s: Stop| if s == Stop::Revoked { FetchError::Revoked } else { FetchError::Cancelled };
    if *stop.borrow() != Stop::Running {
        return Err(stopped(*stop.borrow()));
    }
    tokio::select! {
        r = tokio::time::timeout(limit, f) => match r {
            Err(_) => Err(FetchError::Timeout),
            Ok(Err(e)) => Err(kind_of(&e)),
            Ok(Ok(v)) => Ok(v),
        },
        _ = stop.changed() => Err(stopped(*stop.borrow())),
    }
}

/// For a public name, looked up by Familiar first even when a proxy will resolve it: any answer
/// that isn't public is refused.
async fn check_public_name(n: &Normalized, stop: &mut watch::Receiver<Stop>) -> Result<(), FetchError> {
    if n.reach.is_some() {
        return Ok(());
    }
    let host = n.host.clone();
    let lookup = async {
        let answers = tokio::task::spawn_blocking(move || look_up(&host)).await.map_err(|_| FetchError::Network)?.map_err(|_| FetchError::Network)?;
        shell_core::reach::all_of(Reach::Public, &answers).map(|_| ()).ok_or(FetchError::BlockedAddress)
    };
    // A cancel or a removal ends a slow lookup too.
    tokio::select! {
        r = lookup => r,
        _ = stop.changed() => Err(if *stop.borrow() == Stop::Revoked { FetchError::Revoked } else { FetchError::Cancelled }),
    }
}

#[tauri::command]
pub async fn net_fetch(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Head, Fail> {
    let spec = request.headers().get("x-spec").and_then(|v| v.to_str().ok()).map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned());
    let spec: Spec = spec.and_then(|s| serde_json::from_str(&s).ok()).ok_or(fail(FetchError::Invalid))?;
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => vec![],
    };
    run(&app, spec, body).await.map_err(fail)
}

async fn run(app: &AppHandle, spec: Spec, body: Vec<u8>) -> Result<Head, FetchError> {
    let net = app.state::<Net>();
    if !fetch::valid_id(&spec.id) || !lock(&net.used).insert(spec.id.clone()) {
        return Err(FetchError::Invalid);
    }
    // Registered first, atomically with the address check, so a cancel or a removal reaches the
    // request from here on, before its key is loaded or its name resolved.
    let (stop, mut stopped) = watch::channel(Stop::Running);
    let (saved, norm, req) = {
        let mut open = lock(&net.open);
        if let Some(e) = lock(&net.ended).get(&spec.id) {
            return Err(*e);
        }
        let (saved, norm) = app.state::<Addresses>().get(&spec.address).ok_or(FetchError::NotSaved)?;
        if lock(&net.revoked).contains(&saved.id) || !matches!(Kind::parse(&saved.kind), Some(Kind::Model | Kind::Server)) {
            return Err(FetchError::NotSaved);
        }
        if open.len() >= fetch::MAX_OPEN {
            return Err(FetchError::Busy);
        }
        let req = Arc::new(Request { address: saved.id.clone(), stop, body: AsyncMutex::new(None) });
        open.insert(spec.id.clone(), req.clone());
        (saved, norm, req)
    };
    let prepared = prepare(&saved, &norm, spec.url.as_str(), &spec.method, spec.headers, body.len(), (spec.max_bytes, spec.headers_ms, spec.idle_ms), &mut stopped).await;
    let (reach, mut url, method, headers, secrets, limits) = match prepared {
        Ok(p) => p,
        Err(e) => {
            net.take(&spec.id);
            return Err(e);
        }
    };
    // `send` checks the request wasn't cancelled or revoked right before it sends.
    let result = send(&net.client(reach), &mut stopped, method, &mut url, &headers, body, &norm, &secrets, &limits).await;
    let (response, redirected) = match result {
        Ok(r) => r,
        Err(e) => {
            net.take(&spec.id);
            return Err(e);
        }
    };
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
        net.take(&spec.id);
        return Err(FetchError::TooLarge);
    }
    let status = response.status().as_u16();
    *req.body.lock().await = Some(Body { response, redactor: Redactor::new(&secrets, KEY_MARK), out: vec![], total: 0, limits, ended: false });
    Ok(Head { status, status_text: head.status_text, headers: head.headers, url: head.url, redirected })
}

type Prepared = (Reach, url::Url, Method, Vec<(String, String)>, Vec<String>, Limits);

/// Everything a request needs before it's sent, checked while it can already be cancelled.
#[allow(clippy::too_many_arguments)]
async fn prepare(
    saved: &crate::addresses::Saved,
    norm: &Normalized,
    url: &str,
    method: &str,
    headers: Vec<(String, String)>,
    body_len: usize,
    (max_bytes, headers_ms, idle_ms): (Option<u64>, Option<u64>, Option<u64>),
    stopped: &mut watch::Receiver<Stop>,
) -> Result<Prepared, FetchError> {
    let reach = crate::addresses::reach(saved).ok_or(FetchError::NotSaved)?;
    let url = address::under(norm, url)?;
    let method = Method::from_bytes(fetch::check_method(method)?.as_bytes()).map_err(|_| FetchError::Invalid)?;
    let headers = fetch::request_headers(headers)?;
    fetch::check_body(body_len)?;
    let limits = fetch::limits(max_bytes, headers_ms, idle_ms)?;
    let key = secrets::address_key(&saved.id);
    let swapped = secret::swap(headers, key.as_deref()).map_err(|_| FetchError::NoKey)?;
    // The address's stored key is redacted from the response, and kept out of redirects, whether
    // or not this request carried it: an endpoint can hold it from earlier requests.
    let secrets: Vec<String> = key.into_iter().collect();
    if reach == Reach::Public {
        check_public_name(norm, stopped).await?;
    }
    Ok((reach, url, method, swapped.headers, secrets, limits))
}

/// Sends, following redirects only under the same saved address.
#[allow(clippy::too_many_arguments)]
async fn send(
    client: &Client,
    stopped: &mut watch::Receiver<Stop>,
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
        let response = guarded(stopped, limits.headers, rb.send()).await?;
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
#[tauri::command]
pub async fn net_read(net: State<'_, Net>, id: String) -> Result<Response, Fail> {
    let Some(req) = lock(&net.open).get(&id).cloned() else {
        return Err(fail(lock(&net.ended).get(&id).copied().unwrap_or(FetchError::Cancelled)));
    };
    let mut stopped = req.stop.subscribe();
    let mut guard = req.body.lock().await;
    let Some(b) = guard.as_mut() else { return Err(fail(FetchError::Invalid)) };
    let outcome: Result<Vec<u8>, FetchError> = loop {
        if !b.out.is_empty() {
            let n = b.out.len().min(fetch::MAX_READ);
            return Ok(Response::new(b.out.drain(..n).collect::<Vec<u8>>()));
        }
        if b.ended {
            break Ok(vec![]);
        }
        match guarded(&mut stopped, b.limits.idle, b.response.chunk()).await {
            Ok(Some(chunk)) => {
                // Counted after decompression, so a small compressed body can't grow past it.
                b.total += chunk.len() as u64;
                if b.total > b.limits.max_bytes {
                    break Err(FetchError::TooLarge);
                }
                let out = b.redactor.feed(&chunk);
                b.out.extend(out);
            }
            Ok(None) => {
                let out = b.redactor.finish();
                b.out.extend(out);
                b.ended = true;
            }
            Err(e) => break Err(e),
        }
    };
    // The end, or an error: the request is over either way.
    drop(guard);
    net.take(&id);
    outcome.map(Response::new).map_err(fail)
}

/// Ends a request at any moment, before or after its head.
#[tauri::command]
pub fn net_cancel(net: State<'_, Net>, id: String) {
    match net.take(&id) {
        Some(r) => {
            let _ = r.stop.send(Stop::Cancelled);
        }
        // A cancel that comes before its request: the request is refused when it arrives.
        None if fetch::valid_id(&id) => {
            let _open = lock(&net.open);
            lock(&net.ended).entry(id).or_insert(FetchError::Cancelled);
        }
        None => {}
    }
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

#[tauri::command(async)]
pub fn net_proxy() -> Proxy {
    let kind = proxy_kind();
    Proxy { in_use: kind == "manual", kind }
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
