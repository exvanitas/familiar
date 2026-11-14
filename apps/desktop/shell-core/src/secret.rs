//! Keys: their refs, the value rules, the blob kept in Credential Manager, the masked hint, the
//! placeholder swap, and who may set what. See "5a. Credentials" in docs/shell-design.md.

use serde::{Deserialize, Serialize};

use crate::address::Kind;
use crate::{redact, setup};

/// What the app passes as a model SDK's key. The fetch swaps it for the stored one.
pub const PLACEHOLDER: &str = "familiar-stored-key";
/// The only headers the swap touches. Never the URL or the body.
pub const SWAP_HEADERS: [&str; 4] = ["authorization", "x-api-key", "api-key", "x-goog-api-key"];
pub const MAX_REF: usize = 128;
pub const MIN_VALUE: usize = 8;
pub const MAX_VALUE: usize = 1024;
/// Credential Manager's limit on a credential's blob.
pub const MAX_BLOB: usize = 2560;
/// The hint shows only for values at least this many characters long.
pub const HINT_FROM: usize = 20;
/// The credential's service name.
pub const SERVICE: &str = crate::identity::IDENTIFIER;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretError {
    Invalid,
    NoKey,
    /// The caller may not set this ref.
    NotAllowed,
}

impl SecretError {
    pub fn kind(self) -> &'static str {
        match self {
            SecretError::Invalid => "invalid",
            SecretError::NoKey => "no-key",
            SecretError::NotAllowed => "not-allowed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretRef {
    /// A saved address's key: a model endpoint, a remote server, or a peer's token.
    Addr { id: String },
    /// One secret setting of a local server's setup.
    Server { setup: String, name: String },
}

impl SecretRef {
    /// `addr:<addressId>` or `server:<setupId>:<NAME>`. Anything else is `invalid`.
    pub fn parse(s: &str) -> Result<SecretRef, SecretError> {
        if s.len() > MAX_REF {
            return Err(SecretError::Invalid);
        }
        if let Some(id) = s.strip_prefix("addr:") {
            if setup::valid_id(id) {
                return Ok(SecretRef::Addr { id: id.to_string() });
            }
        } else if let Some(rest) = s.strip_prefix("server:") {
            if let Some((id, name)) = rest.split_once(':') {
                if setup::valid_id(id) && setup::valid_name(name) {
                    return Ok(SecretRef::Server { setup: id.to_string(), name: name.to_string() });
                }
            }
        }
        Err(SecretError::Invalid)
    }

    /// The credential's user name. A server secret's name is folded, since setting names are
    /// case-insensitive: `server:x:api_key` and `server:x:API_KEY` are one credential.
    pub fn user(&self) -> String {
        match self {
            SecretRef::Addr { id } => format!("addr:{id}"),
            SecretRef::Server { setup, name } => format!("server:{setup}:{}", setup::fold(name)),
        }
    }

    /// What the key is bound to: the address id or the setup id.
    pub fn bound_to(&self) -> &str {
        match self {
            SecretRef::Addr { id } => id,
            SecretRef::Server { setup, .. } => setup,
        }
    }
}

/// 8 to 1024 bytes, no control characters (CR or LF in a key would split a header), and
/// nothing a redaction marker could complete: see `touches_a_marker`. This holds for every
/// secret: keys, server secrets and peer tokens.
pub fn check_value(value: &str) -> Result<(), SecretError> {
    let ok = (MIN_VALUE..=MAX_VALUE).contains(&value.len())
        && !value.chars().any(char::is_control)
        && !touches_a_marker(value);
    ok.then_some(()).ok_or(SecretError::Invalid)
}

/// Whether a value holds a marker, starts with the end of one, or ends with the start of one.
/// Redacted output is plain runs of the input with markers between them, and a secret in a
/// plain run would have been redacted. So a copy of a secret in the output would have to
/// overlap a marker, and with these refused, none can.
pub fn touches_a_marker(value: &str) -> bool {
    [redact::KEY_MARK, redact::HIDDEN_MARK].iter().any(|m| {
        value.contains(m) || (1..=m.len()).any(|k| value.starts_with(&m[m.len() - k..]) || value.ends_with(&m[..k]))
    })
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Blob {
    v: u32,
    #[serde(rename = "for")]
    bound: String,
    value: String,
}

/// The stored secret: `{"v":1,"for":"<address or setup id>","value":"..."}` as UTF-8 bytes.
pub fn seal(bound: &str, value: &str) -> Result<Vec<u8>, SecretError> {
    check_value(value)?;
    let bytes = serde_json::to_vec(&Blob { v: 1, bound: bound.to_string(), value: value.to_string() }).map_err(|_| SecretError::Invalid)?;
    (bytes.len() <= MAX_BLOB).then_some(bytes).ok_or(SecretError::Invalid)
}

/// A stored value, if the blob is well formed and bound to `bound`. A key bound elsewhere is
/// never used, so an old key can't go to a new address.
pub fn open(blob: &[u8], bound: &str) -> Option<String> {
    let b: Blob = serde_json::from_slice(blob).ok()?;
    (b.v == 1 && b.bound == bound && check_value(&b.value).is_ok()).then_some(b.value)
}

/// What `secret_status` shows of a value: its last 4 characters as `…abcd`, only when it is at
/// least 20 characters long.
pub fn hint(value: &str) -> Option<String> {
    let n = value.chars().count();
    (n >= HINT_FROM).then(|| format!("…{}", value.chars().skip(n - 4).collect::<String>()))
}

/// The result of the swap: the headers to send, and whether the key went into them, so the
/// response is redacted for it.
#[derive(Debug, PartialEq, Eq)]
pub struct Swapped {
    pub headers: Vec<(String, String)>,
    pub used: bool,
}

/// Replaces exact occurrences of the placeholder with the address's key, only in the values of
/// the swap headers. The placeholder there with no key stored is `no-key`. Elsewhere it is left
/// as it is.
pub fn swap(headers: Vec<(String, String)>, key: Option<&str>) -> Result<Swapped, SecretError> {
    let mut used = false;
    let mut out = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if SWAP_HEADERS.iter().any(|h| name.eq_ignore_ascii_case(h)) && value.contains(PLACEHOLDER) {
            let key = key.ok_or(SecretError::NoKey)?;
            out.push((name, value.replace(PLACEHOLDER, key)));
            used = true;
        } else {
            out.push((name, value));
        }
    }
    Ok(Swapped { headers: out, used })
}

/// Who called `secret_set`, read from the IPC request's window label, never from the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    Settings,
    Core,
    View,
}

impl Caller {
    pub fn from_label(label: &str) -> Caller {
        match label {
            "settings" => Caller::Settings,
            "core" => Caller::Core,
            _ => Caller::View,
        }
    }
}

/// Whether `caller` may set `r`. `addr_kind` is the kind of the saved address an `addr:` ref
/// names, or `None` if no such address is saved, which nobody may set a key for.
/// Settings: `addr:` and `server:` refs. Core: only `addr:` refs whose address is a peer.
pub fn may_set(caller: Caller, r: &SecretRef, addr_kind: Option<Kind>) -> bool {
    match (caller, r) {
        (Caller::Settings, SecretRef::Addr { .. }) => addr_kind.is_some(),
        (Caller::Settings, SecretRef::Server { .. }) => true,
        (Caller::Core, SecretRef::Addr { .. }) => addr_kind == Some(Kind::Peer),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made at run time, never written out.
    fn key(n: usize) -> String {
        (0..n).map(|i| char::from(b'a' + (i * 7 % 26) as u8)).collect()
    }

    #[test]
    fn refs() {
        assert_eq!(SecretRef::parse("addr:a1"), Ok(SecretRef::Addr { id: "a1".into() }));
        assert_eq!(
            SecretRef::parse("server:fake-1:API_KEY"),
            Ok(SecretRef::Server { setup: "fake-1".into(), name: "API_KEY".into() })
        );
        assert_eq!(SecretRef::parse("server:fake-1:api_key").unwrap().user(), "server:fake-1:API_KEY");
        assert_eq!(SecretRef::parse("server:s:a.b-c").unwrap().user(), "server:s:A.B-C");
        assert_eq!(SecretRef::parse("addr:a1").unwrap().bound_to(), "a1");
        assert_eq!(SecretRef::parse("server:s:N").unwrap().bound_to(), "s");
        for bad in [
            "",
            "addr:",
            "addr",
            "ADDR:a1",
            "addr:a b",
            "addr:a:b",
            "addr:../x",
            "server:",
            "server:s",
            "server:s:",
            "server::N",
            "server:s:A=B",
            "server:s:A\0",
            "server:s:A\nB",
            "server:s:A:B",
            "server:s:\u{1f80}",
            "server:s:1A",
            "key:a1",
            " addr:a1",
        ] {
            assert_eq!(SecretRef::parse(bad), Err(SecretError::Invalid), "{bad:?}");
        }
        let long = format!("server:s:{}", "N".repeat(MAX_REF - 9));
        assert_eq!(long.len(), MAX_REF);
        assert!(SecretRef::parse(&long).is_ok());
        assert!(SecretRef::parse(&format!("{long}N")).is_err());
    }

    #[test]
    fn values_a_marker_could_complete_are_refused() {
        let ok = key(10);
        for mark in [redact::KEY_MARK, redact::HIDDEN_MARK] {
            assert_eq!(check_value(&format!("{ok}{mark}{ok}")), Err(SecretError::Invalid), "holds {mark}");
            assert_eq!(check_value(&format!("abc{mark}")), Err(SecretError::Invalid), "ends with {mark}");
            assert_eq!(check_value(&format!("{mark}abc")), Err(SecretError::Invalid), "starts with {mark}");
            for k in 1..mark.len() {
                assert_eq!(check_value(&format!("{}{ok}", &mark[mark.len() - k..])), Err(SecretError::Invalid), "starts with the end of {mark}");
                assert_eq!(check_value(&format!("{ok}{}", &mark[..k])), Err(SecretError::Invalid), "ends with the start of {mark}");
            }
        }
        assert_eq!(check_value(redact::HIDDEN_MARK), Err(SecretError::Invalid));
        assert!(check_value(&format!("[{ok}]x")).is_ok(), "brackets inside are fine");
        assert!(check_value(&format!("x[{ok}")).is_ok());
    }

    #[test]
    fn value_rules() {
        assert!(check_value(&key(8)).is_ok());
        assert!(check_value(&key(1024)).is_ok());
        assert!(check_value(&key(7)).is_err());
        assert!(check_value(&key(1025)).is_err());
        assert!(check_value(&"é".repeat(4)).is_ok(), "eight bytes");
        assert!(check_value(&"é".repeat(512)).is_ok());
        assert!(check_value(&"é".repeat(513)).is_err(), "bytes, not characters");
        for c in ['\r', '\n', '\0', '\t', '\u{7f}', '\u{85}'] {
            assert!(check_value(&format!("{}{c}{}", key(4), key(4))).is_err(), "{c:?}");
        }
        assert!(check_value(&format!("{} {}", key(4), key(4))).is_ok(), "a space is fine");
    }

    #[test]
    fn the_blob() {
        let v = key(30);
        let blob = seal("a1", &v).unwrap();
        assert_eq!(String::from_utf8(blob.clone()).unwrap(), format!("{{\"v\":1,\"for\":\"a1\",\"value\":\"{v}\"}}"));
        assert_eq!(open(&blob, "a1"), Some(v.clone()));
        assert_eq!(open(&blob, "a2"), None, "bound to another address");
        assert_eq!(open(b"not json", "a1"), None);
        assert_eq!(open(br#"{"v":2,"for":"a1","value":"abcdefghij"}"#, "a1"), None);
        // The largest value fits, even all quotes, which JSON doubles.
        assert!(seal("x".repeat(64).as_str(), &"\"".repeat(MAX_VALUE)).unwrap().len() <= MAX_BLOB);
        assert!(seal("a1", &"\\".repeat(MAX_VALUE)).is_ok());
        assert_eq!(seal("a1", &key(7)), Err(SecretError::Invalid));
        assert_eq!(seal(&"b".repeat(MAX_BLOB), &key(8)), Err(SecretError::Invalid), "over the blob limit");
    }

    #[test]
    fn the_hint() {
        let long = key(20);
        assert_eq!(hint(&long), Some(format!("…{}", &long[16..])));
        assert_eq!(hint(&key(19)), None);
        assert_eq!(hint(&key(8)), None);
        let wide = format!("{}日本語です", key(16));
        assert_eq!(hint(&wide), Some("…本語です".into()), "characters, not bytes");
    }

    fn h(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn the_swap() {
        let k = key(24);
        let bearer = format!("Bearer {PLACEHOLDER}");
        let got = swap(
            h(&[
                ("authorization", &bearer),
                ("X-Api-Key", PLACEHOLDER),
                ("api-key", PLACEHOLDER),
                ("x-goog-api-key", PLACEHOLDER),
                ("x-other", PLACEHOLDER),
                ("content-type", "application/json"),
            ]),
            Some(&k),
        )
        .unwrap();
        assert!(got.used);
        assert_eq!(
            got.headers,
            h(&[
                ("authorization", &format!("Bearer {k}")),
                ("X-Api-Key", &k),
                ("api-key", &k),
                ("x-goog-api-key", &k),
                ("x-other", PLACEHOLDER),
                ("content-type", "application/json"),
            ])
        );
        // Exact occurrences only: another spelling is left alone.
        let got = swap(h(&[("authorization", "Bearer Familiar-Stored-Key"), ("authorization", "Bearer familiar-stored")]), Some(&k)).unwrap();
        assert!(!got.used);
        assert_eq!(got.headers[0].1, "Bearer Familiar-Stored-Key");
        // No placeholder: nothing used, and no key needed.
        let got = swap(h(&[("authorization", "Bearer local")]), None).unwrap();
        assert_eq!(got, Swapped { headers: h(&[("authorization", "Bearer local")]), used: false });
        // The placeholder where a key goes, with none stored.
        assert_eq!(swap(h(&[("x-api-key", PLACEHOLDER)]), None), Err(SecretError::NoKey));
        // The placeholder outside the swap headers needs no key and gets none.
        assert!(!swap(h(&[("x-other", PLACEHOLDER)]), None).unwrap().used);
    }

    #[test]
    fn who_may_set_what() {
        let addr = SecretRef::parse("addr:a1").unwrap();
        let server = SecretRef::parse("server:s:TOKEN").unwrap();
        for kind in [Kind::Model, Kind::Server, Kind::Peer] {
            assert!(may_set(Caller::Settings, &addr, Some(kind)), "{kind:?}");
            assert_eq!(may_set(Caller::Core, &addr, Some(kind)), kind == Kind::Peer, "{kind:?}");
            assert!(!may_set(Caller::View, &addr, Some(kind)));
        }
        assert!(!may_set(Caller::Settings, &addr, None), "no key for an address that isn't saved");
        assert!(!may_set(Caller::Core, &addr, None));
        assert!(may_set(Caller::Settings, &server, None));
        assert!(!may_set(Caller::Core, &server, None));
        assert!(!may_set(Caller::View, &server, None));
        assert_eq!(Caller::from_label("settings"), Caller::Settings);
        assert_eq!(Caller::from_label("core"), Caller::Core);
        assert_eq!(Caller::from_label("view-chat"), Caller::View);
        assert_eq!(Caller::from_label("Settings"), Caller::View);
    }
}
