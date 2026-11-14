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
    address::{self, IpClass, Kind, Normalized, Reach},
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
    clients: OnceLock<[Client; 3]>,
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
            let kept = address::keep_answers(reach, &answers);
            if kept.is_empty() {
                return Err(Box::new(Blocked) as _);
            }
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
    fn client(&self, reach: Reach) -> &Client {
        let all = self.clients.get_or_init(|| [client(Reach::Public), client(Reach::Lan), client(Reach::Loopback)]);
        &all[match reach {
            Reach::Public => 0,
            Reach::Lan => 1,
            Reach::Loopback => 2,
        }]
    }

    fn take(&self, id: &str) -> Option<Arc<Request>> {
        lock(&self.open).remove(id)
    }
}

/// Ends every open request under an address, with `revoked`. Called when it's removed.
pub fn revoke(app: &AppHandle, address_id: &str) {
    let Some(net) = app.try_state::<Net>() else { return };
    let gone: Vec<Arc<Request>> = {
        let mut open = lock(&net.open);
        let ids: Vec<String> = open.iter().filter(|(_, r)| r.address == address_id).map(|(id, _)| id.clone()).collect();
        ids.iter().filter_map(|id| open.remove(id)).collect()
    };
    for r in gone {
        let _ = r.stop.send(Stop::Revoked);
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
async fn check_public_name(n: &Normalized) -> Result<(), FetchError> {
    if n.reach.is_some() {
        return Ok(());
    }
    let host = n.host.clone();
    let answers = tokio::task::spawn_blocking(move || look_up(&host)).await.map_err(|_| FetchError::Network)?.map_err(|_| FetchError::Network)?;
    if answers.is_empty() || answers.iter().any(|ip| address::class_ip(*ip) != IpClass::Reach(Reach::Public)) {
        return Err(FetchError::BlockedAddress);
    }
    Ok(())
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
    let (saved, norm) = app.state::<Addresses>().get(&spec.address).ok_or(FetchError::NotSaved)?;
    if !matches!(Kind::parse(&saved.kind), Some(Kind::Model | Kind::Server)) {
        return Err(FetchError::NotSaved);
    }
    let reach = crate::addresses::reach(&saved).ok_or(FetchError::NotSaved)?;
    let mut url = address::under(&norm, &spec.url)?;
    let method = Method::from_bytes(fetch::check_method(&spec.method)?.as_bytes()).map_err(|_| FetchError::Invalid)?;
    let headers = fetch::request_headers(spec.headers)?;
    fetch::check_body(body.len())?;
    let limits = fetch::limits(spec.max_bytes, spec.headers_ms, spec.idle_ms)?;
    let key = secrets::address_key(&saved.id);
    let swapped = secret::swap(headers, key.as_deref()).map_err(|_| FetchError::NoKey)?;
    let secrets: Vec<String> = if swapped.used { key.into_iter().collect() } else { vec![] };
    if reach == Reach::Public {
        check_public_name(&norm).await?;
    }

    let (stop, mut stopped) = watch::channel(Stop::Running);
    let req = Arc::new(Request { address: saved.id.clone(), stop, body: AsyncMutex::new(None) });
    {
        let mut open = lock(&net.open);
        if open.len() >= fetch::MAX_OPEN {
            return Err(FetchError::Busy);
        }
        open.insert(spec.id.clone(), req.clone());
    }
    let result = send(net.client(reach), &mut stopped, method, &mut url, &swapped.headers, body, &norm, &secrets, &limits).await;
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
    let req = lock(&net.open).get(&id).cloned().ok_or(fail(FetchError::Cancelled))?;
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
    if let Some(r) = net.take(&id) {
        let _ = r.stop.send(Stop::Cancelled);
    }
}
