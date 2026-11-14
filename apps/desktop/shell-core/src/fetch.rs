//! The guarded fetch's plain rules: the request's id, method and headers, the limits, which
//! response headers a page sees, and whether a redirect is followed. Where it may connect is in
//! `address`, the key swap in `secret`, redaction in `redact`. See "5c. The guarded fetch".

use std::time::Duration;

use url::Url;

use crate::address::{self, Normalized};
use crate::redact;

pub const MAX_REQUEST_HEADERS: usize = 64;
/// One request header, name and value together.
pub const MAX_REQUEST_HEADER_BYTES: usize = 8 * 1024;
pub const MAX_REQUEST_BODY: usize = 16 * 1024 * 1024;
/// All of a response's headers together.
pub const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;
/// `maxBytes` when the page gives none, counted after decompression.
pub const DEFAULT_MAX_BYTES: u64 = 32 * 1024 * 1024;
pub const HARD_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// `headersMs` and `idleMs` when the page gives none.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(120);
pub const MAX_WAIT: Duration = Duration::from_secs(15 * 60);
pub const MAX_OPEN: usize = 32;
/// The most one `net_read` returns.
pub const MAX_READ: usize = 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;

/// Every error a fetch can end with. No error carries a key, a URL's query or a body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchError {
    NotSaved,
    Insecure,
    BlockedAddress,
    RedirectRefused,
    NoKey,
    TooLarge,
    Timeout,
    Tls,
    Network,
    Cancelled,
    Revoked,
    Busy,
    Invalid,
}

impl FetchError {
    pub const ALL: [FetchError; 13] = [
        FetchError::NotSaved,
        FetchError::Insecure,
        FetchError::BlockedAddress,
        FetchError::RedirectRefused,
        FetchError::NoKey,
        FetchError::TooLarge,
        FetchError::Timeout,
        FetchError::Tls,
        FetchError::Network,
        FetchError::Cancelled,
        FetchError::Revoked,
        FetchError::Busy,
        FetchError::Invalid,
    ];

    pub fn kind(self) -> &'static str {
        match self {
            FetchError::NotSaved => "not-saved",
            FetchError::Insecure => "insecure",
            FetchError::BlockedAddress => "blocked-address",
            FetchError::RedirectRefused => "redirect-refused",
            FetchError::NoKey => "no-key",
            FetchError::TooLarge => "too-large",
            FetchError::Timeout => "timeout",
            FetchError::Tls => "tls",
            FetchError::Network => "network",
            FetchError::Cancelled => "cancelled",
            FetchError::Revoked => "revoked",
            FetchError::Busy => "busy",
            FetchError::Invalid => "invalid",
        }
    }
}

impl From<address::AddrError> for FetchError {
    fn from(e: address::AddrError) -> FetchError {
        match e {
            address::AddrError::Invalid => FetchError::Invalid,
            address::AddrError::Insecure => FetchError::Insecure,
            address::AddrError::BlockedAddress => FetchError::BlockedAddress,
            address::AddrError::NotSaved => FetchError::NotSaved,
        }
    }
}

/// A request id the page chose: 128 random bits as 32 hex digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A method: an HTTP token, but never `CONNECT` or `TRACE`, which aren't requests to an API.
pub fn check_method(method: &str) -> Result<String, FetchError> {
    let m = method.to_ascii_uppercase();
    if m.is_empty() || m.len() > 16 || !m.bytes().all(is_tchar) || matches!(m.as_str(), "CONNECT" | "TRACE" | "TRACK") {
        return Err(FetchError::Invalid);
    }
    Ok(m)
}

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// Request headers a page may not set. Each is dropped, with no error.
fn dropped(name: &str) -> bool {
    matches!(
        name,
        "host" | "content-length" | "transfer-encoding" | "connection" | "cookie" | "te" | "upgrade" | "keep-alive" | "trailer" | "expect"
    ) || name.starts_with("proxy-")
}

/// The page's request headers, names lower-cased, with the ones it may not set dropped. A name
/// that isn't a token, a value with a control character other than tab, too many headers or
/// one too long is `invalid`.
pub fn request_headers(headers: Vec<(String, String)>) -> Result<Vec<(String, String)>, FetchError> {
    if headers.len() > MAX_REQUEST_HEADERS {
        return Err(FetchError::Invalid);
    }
    let mut out = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if name.is_empty() || !name.bytes().all(is_tchar) || name.len() + value.len() > MAX_REQUEST_HEADER_BYTES {
            return Err(FetchError::Invalid);
        }
        if value.chars().any(|c| c.is_control() && c != '\t') {
            return Err(FetchError::Invalid);
        }
        let name = name.to_ascii_lowercase();
        if !dropped(&name) {
            out.push((name, value));
        }
    }
    Ok(out)
}

/// Whether a response header reaches the page. There's no cookie store, so cookies don't.
pub fn response_header_kept(name: &str) -> bool {
    !(name.eq_ignore_ascii_case("set-cookie") || name.eq_ignore_ascii_case("set-cookie2"))
}

/// Whether a response's headers fit, counting each name, value and line ending.
pub fn response_headers_fit(headers: &[(String, String)]) -> bool {
    headers.iter().map(|(n, v)| n.len() + v.len() + 4).sum::<usize>() <= MAX_RESPONSE_HEADER_BYTES
}

/// A request body's size.
pub fn check_body(len: usize) -> Result<(), FetchError> {
    (len <= MAX_REQUEST_BODY).then_some(()).ok_or(FetchError::TooLarge)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: u64,
    pub headers: Duration,
    pub idle: Duration,
}

/// The page's limits, with the defaults filled in. A value past its cap is held to the cap, and
/// zero is `invalid`.
pub fn limits(max_bytes: Option<u64>, headers_ms: Option<u64>, idle_ms: Option<u64>) -> Result<Limits, FetchError> {
    let wait = |ms: Option<u64>| match ms {
        None => Ok(DEFAULT_WAIT),
        Some(0) => Err(FetchError::Invalid),
        Some(ms) => Ok(Duration::from_millis(ms).min(MAX_WAIT)),
    };
    let max_bytes = match max_bytes {
        None => DEFAULT_MAX_BYTES,
        Some(0) => return Err(FetchError::Invalid),
        Some(n) => n.min(HARD_MAX_BYTES),
    };
    Ok(Limits { max_bytes, headers: wait(headers_ms)?, idle: wait(idle_ms)? })
}

/// Whether a redirect is followed. `hop` counts redirects already followed. The target is
/// resolved against the current URL and must be under the same saved address, and neither the
/// `Location` value nor the target may hold a secret the request used, raw or percent-decoded,
/// so a key can't come back as a path. Anything else is `redirect-refused`.
pub fn redirect<S: AsRef<[u8]>>(
    hop: usize,
    current: &Url,
    location: &str,
    saved: &Normalized,
    secrets: &[S],
) -> Result<Url, FetchError> {
    if hop >= MAX_REDIRECTS || location.is_empty() || location.chars().any(|c| c.is_control()) {
        return Err(FetchError::RedirectRefused);
    }
    if redact::holds_secret(location, secrets) {
        return Err(FetchError::RedirectRefused);
    }
    let target = current.join(location).map_err(|_| FetchError::RedirectRefused)?;
    if redact::holds_secret(target.as_str(), secrets) || !address::under_parsed(saved, &target) {
        return Err(FetchError::RedirectRefused);
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::address::normalize;

    fn h(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn error_kinds() {
        let kinds: Vec<&str> = FetchError::ALL.iter().map(|e| e.kind()).collect();
        assert_eq!(
            kinds,
            [
                "not-saved", "insecure", "blocked-address", "redirect-refused", "no-key", "too-large", "timeout", "tls", "network",
                "cancelled", "revoked", "busy", "invalid"
            ]
        );
    }

    #[test]
    fn ids_and_methods() {
        assert!(valid_id("0123456789abcdef0123456789ABCDEF"));
        for bad in ["", "0123", "0123456789abcdef0123456789abcdeg", "0123456789abcdef0123456789abcdef0"] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert_eq!(check_method("post"), Ok("POST".into()));
        for ok in ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            assert!(check_method(ok).is_ok());
        }
        for bad in ["", "CONNECT", "connect", "TRACE", "TRACK", "GE T", "GET\r\n", "PO(ST", &"A".repeat(17)] {
            assert_eq!(check_method(bad), Err(FetchError::Invalid), "{bad:?}");
        }
    }

    #[test]
    fn request_headers_are_filtered() {
        let got = request_headers(h(&[
            ("Content-Type", "application/json"),
            ("Host", "evil.example"),
            ("Content-Length", "5"),
            ("Transfer-Encoding", "chunked"),
            ("Connection", "upgrade"),
            ("Cookie", "a=b"),
            ("Proxy-Authorization", "Basic x"),
            ("proxy-connection", "keep-alive"),
            ("TE", "trailers"),
            ("Upgrade", "websocket"),
            ("Keep-Alive", "timeout=5"),
            ("Trailer", "x-a"),
            ("Expect", "100-continue"),
            ("Authorization", "Bearer x"),
            ("x-tab", "a\tb"),
        ]))
        .unwrap();
        assert_eq!(got, h(&[("content-type", "application/json"), ("authorization", "Bearer x"), ("x-tab", "a\tb")]));
        for bad in [
            h(&[("x-a", "a\r\nInjected: 1")]),
            h(&[("x-a", "a\nb")]),
            h(&[("x-a", "a\0b")]),
            h(&[("x a", "v")]),
            h(&[("x:a", "v")]),
            h(&[("", "v")]),
            h(&[("é", "v")]),
            h(&[("x-a", &"v".repeat(MAX_REQUEST_HEADER_BYTES))]),
        ] {
            assert_eq!(request_headers(bad.clone()), Err(FetchError::Invalid), "{bad:?}");
        }
        assert!(request_headers(h(&[("x-a", &"v".repeat(MAX_REQUEST_HEADER_BYTES - 3))])).is_ok());
        let many: Vec<(String, String)> = (0..MAX_REQUEST_HEADERS).map(|i| (format!("x-{i}"), "v".into())).collect();
        assert!(request_headers(many.clone()).is_ok());
        let mut more = many;
        more.push(("x-last".into(), "v".into()));
        assert_eq!(request_headers(more), Err(FetchError::Invalid));
    }

    #[test]
    fn response_headers() {
        assert!(!response_header_kept("set-cookie"));
        assert!(!response_header_kept("Set-Cookie"));
        assert!(!response_header_kept("set-cookie2"));
        assert!(response_header_kept("content-type"));
        assert!(response_headers_fit(&h(&[("a", &"b".repeat(MAX_RESPONSE_HEADER_BYTES - 5))])));
        assert!(!response_headers_fit(&h(&[("a", &"b".repeat(MAX_RESPONSE_HEADER_BYTES - 4))])));
    }

    #[test]
    fn the_limits() {
        assert_eq!(MAX_REQUEST_BODY, 16 << 20);
        assert_eq!(MAX_RESPONSE_HEADER_BYTES, 64 << 10);
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(20));
        assert_eq!(MAX_OPEN, 32);
        assert_eq!(MAX_READ, 1 << 20);
        assert_eq!(check_body(MAX_REQUEST_BODY), Ok(()));
        assert_eq!(check_body(MAX_REQUEST_BODY + 1), Err(FetchError::TooLarge));
        assert_eq!(
            limits(None, None, None),
            Ok(Limits { max_bytes: 32 << 20, headers: Duration::from_secs(120), idle: Duration::from_secs(120) })
        );
        assert_eq!(
            limits(Some(u64::MAX), Some(u64::MAX), Some(3_600_000)),
            Ok(Limits { max_bytes: 256 << 20, headers: Duration::from_secs(900), idle: Duration::from_secs(900) })
        );
        assert_eq!(limits(Some(1000), Some(50), Some(10)).unwrap().idle, Duration::from_millis(10));
        assert_eq!(limits(Some(0), None, None), Err(FetchError::Invalid));
        assert_eq!(limits(None, Some(0), None), Err(FetchError::Invalid));
        assert_eq!(limits(None, None, Some(0)), Err(FetchError::Invalid));
    }

    #[test]
    fn redirects() {
        let saved = normalize("https://api.example.com/v1").unwrap();
        let here = Url::parse("https://api.example.com/v1/chat").unwrap();
        let none: &[&str] = &[];
        assert_eq!(redirect(0, &here, "/v1/chat2", &saved, none).unwrap().as_str(), "https://api.example.com/v1/chat2");
        assert_eq!(redirect(0, &here, "models", &saved, none).unwrap().as_str(), "https://api.example.com/v1/models");
        assert_eq!(redirect(4, &here, "https://API.example.com/v1/x?y=1", &saved, none).unwrap().as_str(), "https://api.example.com/v1/x?y=1");
        assert_eq!(redirect(5, &here, "/v1/x", &saved, none), Err(FetchError::RedirectRefused), "five is the most");
        for bad in [
            "/v2/x",
            "/",
            "../x",
            "/v10",
            "http://api.example.com/v1/x",
            "https://other.example.com/v1/x",
            "https://api.example.com:8443/v1/x",
            "https://127.0.0.1/v1/x",
            "//evil.example/v1",
            "https://user\u{40}api.example.com/v1/x",
            "javascript:alert(1)",
            "",
            "/v1/a\nb",
        ] {
            assert_eq!(redirect(0, &here, bad, &saved, none), Err(FetchError::RedirectRefused), "{bad:?}");
        }
        let key: String = (0..24).map(|i| char::from(b'k' + (i % 9) as u8)).collect();
        let enc: String = key.bytes().map(|b| format!("%{b:02x}")).collect();
        for echo in [format!("/v1/{key}"), format!("/v1/{enc}"), format!("/v1/x?k={key}"), format!("https://api.example.com/v1/{key}")] {
            assert_eq!(redirect(0, &here, &echo, &saved, &[key.as_str()]), Err(FetchError::RedirectRefused), "{echo}");
        }
        assert!(redirect(0, &here, "/v1/fine", &saved, &[key.as_str()]).is_ok());
        for enc in ["/v1/%2e%2e%2fadmin", "/v1/%2E%2E%2Fadmin", "/v1/a%5cb", "https://api.example.com/v1/x%2fy"] {
            assert_eq!(redirect(0, &here, enc, &saved, none), Err(FetchError::RedirectRefused), "{enc}");
        }
    }
}
