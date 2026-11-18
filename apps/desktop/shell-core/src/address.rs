//! Saved addresses: the places data may go. A URL is normalized and its literal host classed
//! with no network access, then, only after the person allows it, a name's DNS answers are
//! classed. See "5c. The guarded fetch" in docs/shell-design.md.
//!
//! Parsing is the `url` crate's, the same parser reqwest uses, so the shell and the fetch never
//! read one address two ways. It also turns odd IPv4 forms (`127.1`, `0x7f.1`, `2130706433`)
//! into the address they mean, and hosts into lower-case punycode.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

/// The longest URL an address may have.
pub const MAX_URL: usize = 2048;
/// The longest label, in bytes. The confirm shows at most 64 characters of it.
pub const MAX_LABEL: usize = 256;
/// The most ports one peer address may cover.
pub const MAX_PEER_PORTS: u32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Model,
    Server,
    Peer,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "model" => Some(Kind::Model),
            "server" => Some(Kind::Server),
            "peer" => Some(Kind::Peer),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Model => "model",
            Kind::Server => "server",
            Kind::Peer => "peer",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reach {
    Public,
    Lan,
    Loopback,
}

impl Reach {
    pub fn as_str(self) -> &'static str {
        match self {
            Reach::Public => "public",
            Reach::Lan => "lan",
            Reach::Loopback => "loopback",
        }
    }
}

/// What a literal IP is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpClass {
    Reach(Reach),
    /// Link-local, unspecified, multicast, broadcast, documentation and other reserved ranges.
    /// Never saved, never connected to.
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddrError {
    /// Malformed, or not a form an address may take.
    Invalid,
    /// `http` where `https` is required.
    Insecure,
    /// A refused IP range, or DNS answers that are mixed, empty or refused.
    BlockedAddress,
    /// A URL that isn't under the saved address it names.
    NotSaved,
}

impl AddrError {
    pub fn kind(self) -> &'static str {
        match self {
            AddrError::Invalid => "invalid",
            AddrError::Insecure => "insecure",
            AddrError::BlockedAddress => "blocked-address",
            AddrError::NotSaved => "not-saved",
        }
    }
}

/// An IPv4 address's class.
pub fn class_v4(ip: Ipv4Addr) -> IpClass {
    use IpClass::*;
    match ip.octets() {
        [127, ..] => Reach(self::Reach::Loopback),
        // 0.0.0.0 is unspecified, and the rest of 0/8 means "this network": refused, not public.
        [0, ..] => Refused,
        [10, ..] => Reach(self::Reach::Lan),
        [172, b, ..] if (16..=31).contains(&b) => Reach(self::Reach::Lan),
        [192, 168, ..] => Reach(self::Reach::Lan),
        [100, b, ..] if (64..=127).contains(&b) => Reach(self::Reach::Lan),
        [169, 254, ..] => Refused,
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _] => Refused,
        // Multicast (224/4), and 240/4, which holds the broadcast address and is reserved.
        [a, ..] if a >= 224 => Refused,
        _ => Reach(self::Reach::Public),
    }
}

/// An IPv6 address's class, by allowlist. Loopback (`::1`), lan (`fc00::/7`), a mapped IPv4
/// address as its IPv4, and NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) by the IPv4 address
/// inside, public only if that is. Otherwise public only inside global unicast `2000::/3`,
/// minus its special ranges. Everything else is refused, the IPv4-translated
/// `::ffff:0:0/96` and every range not yet assigned among them.
pub fn class_v6(ip: Ipv6Addr) -> IpClass {
    use IpClass::*;
    if let Some(v4) = ip.to_ipv4_mapped() {
        return class_v4(v4);
    }
    if ip == Ipv6Addr::LOCALHOST {
        return Reach(self::Reach::Loopback);
    }
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return public_or_refused(class_v4(embedded(s[6], s[7])));
    }
    if s[0] & 0xfe00 == 0xfc00 {
        return Reach(self::Reach::Lan);
    }
    if s[0] & 0xe000 != 0x2000 {
        return Refused;
    }
    match s[0] {
        0x2002 => public_or_refused(class_v4(embedded(s[1], s[2]))),
        // 2001::/23, IETF protocol assignments: Teredo (which hides an IPv4 address),
        // benchmarking, ORCHID and the rest.
        0x2001 if s[1] < 0x0200 => Refused,
        0x2001 if s[1] == 0x0db8 => Refused,  // 2001:db8::/32, documentation
        0x3fff if s[1] & 0xf000 == 0 => Refused, // 3fff::/20, documentation
        _ => Reach(self::Reach::Public),
    }
}

fn public_or_refused(c: IpClass) -> IpClass {
    match c {
        IpClass::Reach(Reach::Public) => c,
        _ => IpClass::Refused,
    }
}

pub fn class_ip(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(v4) => class_v4(v4),
        IpAddr::V6(v6) => class_v6(v6),
    }
}

/// A normalized address URL: `scheme://host[:port][/path]`, with no user info, query, fragment
/// or trailing slash, the host in lower-case punycode and a default port dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Normalized {
    pub url: String,
    pub scheme: String,
    /// The host as written in the URL: punycode, or an IP (IPv6 in brackets).
    pub host: String,
    pub port: Option<u16>,
    /// The path with no trailing slash, `""` for the root.
    pub path: String,
    /// Known from the URL alone: a literal IP or `localhost`. `None` for a name, which is
    /// resolved only after the person allows it.
    pub reach: Option<Reach>,
}

/// Normalizes a URL and classes its host, with no network access. Any scheme `url` parses
/// comes through. `check_add` decides which a kind may use.
pub fn normalize(input: &str) -> Result<Normalized, AddrError> {
    if input.is_empty() || input.len() > MAX_URL || input.chars().any(|c| c.is_control() || c == ' ') {
        return Err(AddrError::Invalid);
    }
    let url = Url::parse(input).map_err(|_| AddrError::Invalid)?;
    let scheme = url.scheme().to_string();
    if !matches!(scheme.as_str(), "http" | "https" | "ws") {
        return Err(AddrError::Invalid);
    }
    // User info is a credential in the wrong place, and a query or fragment isn't an address.
    // Refused rather than quietly dropped, so what the person approves is what they typed.
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(AddrError::Invalid);
    }
    let (host, reach) = match url.host() {
        Some(Host::Domain(d)) => {
            // One trailing dot names the same host. Dropped so both spellings are one address.
            let d = d.strip_suffix('.').unwrap_or(d);
            if d.is_empty() || d.ends_with('.') {
                return Err(AddrError::Invalid);
            }
            // `localhost` and every name under it are this PC (RFC 6761), with no lookup. A
            // connection to one still uses only loopback answers.
            let reach = (d == "localhost" || d.ends_with(".localhost")).then_some(Reach::Loopback);
            (d.to_string(), reach)
        }
        // An IP is written as `url` serializes it (IPv6 compressed, in brackets).
        Some(Host::Ipv4(ip)) => (host_str(&url), Some(literal(IpAddr::V4(ip))?)),
        Some(Host::Ipv6(ip)) => (host_str(&url), Some(literal(IpAddr::V6(ip))?)),
        None => return Err(AddrError::Invalid),
    };
    let path = url.path().trim_end_matches('/').to_string();
    if encoded_separator(&path) {
        return Err(AddrError::Invalid);
    }
    let port = url.port();
    let port_part = port.map(|p| format!(":{p}")).unwrap_or_default();
    Ok(Normalized { url: format!("{scheme}://{host}{port_part}{path}"), scheme, host, port, path, reach })
}

fn host_str(url: &Url) -> String {
    url.host_str().unwrap_or_default().to_string()
}

fn literal(ip: IpAddr) -> Result<Reach, AddrError> {
    match class_ip(ip) {
        IpClass::Reach(r) => Ok(r),
        IpClass::Refused => Err(AddrError::BlockedAddress),
    }
}

/// What makes two addresses the same: a peer with another port range is another address,
/// with its own approval, id and key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Identity {
    pub kind: Kind,
    pub url: String,
    pub ports: Option<(u16, u16)>,
}

/// An address that passed every check `address_add` can make before asking.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub identity: Identity,
    pub normalized: Normalized,
}

impl Candidate {
    /// True when the name must be resolved, after Allow, to learn its reach.
    pub fn needs_lookup(&self) -> bool {
        self.normalized.reach.is_none()
    }
}

/// Step 1 of adding an address: the URL's form, with no network access.
pub fn check_add(kind: Kind, url: &str, label: &str, ports: Option<(u16, u16)>) -> Result<Candidate, AddrError> {
    if label.len() > MAX_LABEL {
        return Err(AddrError::Invalid);
    }
    let n = normalize(url)?;
    match kind {
        Kind::Peer => {
            // Exactly ws://127.0.0.1: no name, no port, no path. The port is the range's.
            if n.scheme != "ws" || n.host != "127.0.0.1" || n.port.is_some() || !n.path.is_empty() {
                return Err(AddrError::Invalid);
            }
            let (first, last) = ports.ok_or(AddrError::Invalid)?;
            if first == 0 || last < first || (last - first) as u32 + 1 > MAX_PEER_PORTS {
                return Err(AddrError::Invalid);
            }
        }
        Kind::Model | Kind::Server => {
            if ports.is_some() || !matches!(n.scheme.as_str(), "http" | "https") {
                return Err(AddrError::Invalid);
            }
            if n.scheme == "http" && n.reach == Some(Reach::Public) {
                return Err(AddrError::Insecure);
            }
        }
    }
    Ok(Candidate { identity: Identity { kind, url: n.url.clone(), ports }, normalized: n })
}

/// Step 5, after Allow: the reach of a name from its DNS answers. All loopback, all private or
/// all public. Mixed or empty answers, any refused answer, and `http` on a public name are refused.
pub fn class_answers(scheme: &str, answers: &[IpAddr]) -> Result<Reach, AddrError> {
    let mut reach = None;
    for ip in answers {
        let r = literal(*ip)?;
        if reach.is_some_and(|seen| seen != r) {
            return Err(AddrError::BlockedAddress);
        }
        reach = Some(r);
    }
    match reach {
        None => Err(AddrError::BlockedAddress),
        Some(Reach::Public) if scheme != "https" => Err(AddrError::Insecure),
        Some(r) => Ok(r),
    }
}

/// For the fetch's resolver: the answers a connection to an address of `reach` may use.
pub fn keep_answers(reach: Reach, answers: &[IpAddr]) -> Vec<IpAddr> {
    answers.iter().copied().filter(|ip| class_ip(*ip) == IpClass::Reach(reach)).collect()
}

/// Whether a request URL is under a saved address: the same scheme, host and port, and a path
/// under the saved path at a segment boundary. The parsed URL is returned for the request.
pub fn under(saved: &Normalized, url: &str) -> Result<Url, AddrError> {
    if url.len() > 64 * 1024 || url.chars().any(|c| c.is_control() || c == ' ') {
        return Err(AddrError::NotSaved);
    }
    let target = Url::parse(url).map_err(|_| AddrError::NotSaved)?;
    if !under_parsed(saved, &target) {
        return Err(AddrError::NotSaved);
    }
    Ok(target)
}

/// `under` for an already parsed URL, such as a redirect's target.
pub fn under_parsed(saved: &Normalized, target: &Url) -> bool {
    if target.scheme() != saved.scheme || !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    let host = match target.host() {
        Some(Host::Domain(d)) => d.strip_suffix('.').unwrap_or(d).to_string(),
        Some(_) => host_str(target),
        None => return false,
    };
    if host != saved.host || target.port() != saved.port {
        return false;
    }
    let path = target.path();
    if encoded_separator(path) {
        return false;
    }
    saved.path.is_empty()
        || path == saved.path
        || path.strip_prefix(saved.path.as_str()).is_some_and(|rest| rest.starts_with('/'))
}

/// An encoded dot, slash or backslash in a path. A backend that decodes before it removes dot
/// segments would read `/v1/%2e%2e%2fadmin` as `/admin`, so such a path is never under a saved
/// address, and a saved address can't have one.
pub fn encoded_separator(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    ["%2e", "%2f", "%5c"].iter().any(|e| lower.contains(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> String {
        normalize(s).unwrap_or_else(|e| panic!("{s}: {e:?}")).url
    }

    #[test]
    fn urls_are_normalized() {
        for (input, want) in [
            ("HTTPS://API.Example.COM/", "https://api.example.com"),
            ("https://api.example.com:443/v1/", "https://api.example.com/v1"),
            ("http://localhost:80", "http://localhost"),
            ("http://localhost:11434/", "http://localhost:11434"),
            ("https://example.com/v1//", "https://example.com/v1"),
            ("https://example.com./v1", "https://example.com/v1"),
            ("https://bücher.example/", "https://xn--bcher-kva.example"),
            ("https://BÜCHER.example", "https://xn--bcher-kva.example"),
            ("https://example.com/a/../b", "https://example.com/b"),
            ("https://example.com/a/%2e%2e/b", "https://example.com/b"),
            ("https://example.com\\v1\\", "https://example.com/v1"),
            ("http://[::1]:8080/", "http://[::1]:8080"),
            ("http://[0:0:0:0:0:0:0:1]", "http://[::1]"),
            ("ws://127.0.0.1", "ws://127.0.0.1"),
            ("ws://127.0.0.1:80", "ws://127.0.0.1"),
        ] {
            assert_eq!(norm(input), want, "{input}");
        }
    }

    /// The corpus core's `addressIdentity` runs too (apps/desktop/tests/mcp.test.ts): a rule changed
    /// here alone, or there alone, fails one of the two.
    #[test]
    fn the_shared_identity_corpus() {
        let text = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/address-identity.json"));
        let corpus: serde_json::Value = serde_json::from_str(text).expect("the corpus is JSON");
        let accept = corpus["accept"].as_array().expect("an accept list");
        let refuse = corpus["refuse"].as_array().expect("a refuse list");
        assert!(accept.len() > 10 && refuse.len() > 10);
        for pair in accept {
            let input = pair[0].as_str().expect("an input");
            let want = pair[1].as_str().expect("an identity");
            assert_eq!(normalize(input).map(|n| n.url), Ok(want.to_string()), "{input:?}");
        }
        for input in refuse {
            let input = input.as_str().expect("an input");
            assert!(normalize(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn the_normal_form_is_a_fixed_point() {
        for s in ["https://xn--bcher-kva.example/v1", "http://[::1]:8080", "http://10.0.0.5:1234/a/b", "https://example.com"] {
            assert_eq!(norm(&norm(s)), norm(s));
        }
    }

    #[test]
    fn user_info_query_fragment_and_junk_are_refused() {
        for bad in [
            "https://user\u{40}example.com",
            "https://user:pw\u{40}example.com",
            "https://:pw\u{40}example.com",
            "https://example.com/?",
            "https://example.com/?a=b",
            "https://example.com/#x",
            "https://example.com/#",
            "",
            "example.com",
            "/v1",
            "ftp://example.com",
            "file:///C:/x",
            "javascript:alert(1)",
            "data:text/plain,x",
            "wss://127.0.0.1",
            "https://exa mple.com",
            "https://example.com/\n",
            "https://",
            "https://.",
            "https://a..",
        ] {
            assert!(normalize(bad).is_err(), "{bad:?}");
        }
        assert_eq!(normalize(&format!("https://example.com/{}", "a".repeat(MAX_URL))), Err(AddrError::Invalid));
    }

    #[test]
    fn odd_ipv4_forms_are_normalized_then_classed() {
        for (input, host) in [
            ("http://127.1/", "127.0.0.1"),
            ("http://0x7f.1/", "127.0.0.1"),
            ("http://0x7f000001/", "127.0.0.1"),
            ("http://2130706433/", "127.0.0.1"),
            ("http://017700000001/", "127.0.0.1"),
            ("http://0177.0.0.1/", "127.0.0.1"),
            ("http://%31%32%37.0.0.1/", "127.0.0.1"),
            ("http://10.1/", "10.0.0.1"),
            ("http://0xa9.0xfe.0xa9.0xfe/", "169.254.169.254"),
        ] {
            match normalize(input) {
                Ok(n) => {
                    assert_eq!(n.host, host, "{input}");
                    assert_eq!(n.reach, Some(if host.starts_with("127.") { Reach::Loopback } else { Reach::Lan }), "{input}");
                }
                Err(e) => {
                    assert_eq!(host, "169.254.169.254", "{input}");
                    assert_eq!(e, AddrError::BlockedAddress);
                }
            }
        }
    }

    #[test]
    fn literal_ipv4_classes() {
        let c = |s: &str| class_v4(s.parse().unwrap());
        use IpClass::Refused;
        let (lo, lan, public) = (IpClass::Reach(Reach::Loopback), IpClass::Reach(Reach::Lan), IpClass::Reach(Reach::Public));
        for (ip, want) in [
            ("127.0.0.1", lo),
            ("127.255.255.254", lo),
            ("10.0.0.1", lan),
            ("10.255.255.255", lan),
            ("172.16.0.1", lan),
            ("172.31.255.255", lan),
            ("172.15.255.255", public),
            ("172.32.0.0", public),
            ("192.168.1.1", lan),
            ("192.169.0.1", public),
            ("100.64.0.1", lan),
            ("100.127.255.255", lan),
            ("100.63.255.255", public),
            ("100.128.0.0", public),
            ("169.254.169.254", Refused),
            ("169.254.0.1", Refused),
            ("0.0.0.0", Refused),
            ("0.1.2.3", Refused),
            ("224.0.0.1", Refused),
            ("239.255.255.250", Refused),
            ("255.255.255.255", Refused),
            ("240.0.0.1", Refused),
            ("192.0.2.1", Refused),
            ("198.51.100.7", Refused),
            ("203.0.113.9", Refused),
            ("8.8.8.8", public),
            ("1.1.1.1", public),
            ("223.255.255.255", public),
        ] {
            assert_eq!(c(ip), want, "{ip}");
        }
    }

    #[test]
    fn literal_ipv6_classes() {
        let c = |s: &str| class_v6(s.parse().unwrap());
        use IpClass::Refused;
        let (lo, lan, public) = (IpClass::Reach(Reach::Loopback), IpClass::Reach(Reach::Lan), IpClass::Reach(Reach::Public));
        for (ip, want) in [
            ("::1", lo),
            ("::", Refused),
            ("::ffff:127.0.0.1", lo),
            ("::ffff:7f00:1", lo),
            ("::ffff:10.0.0.5", lan),
            ("::ffff:169.254.169.254", Refused),
            ("::ffff:8.8.8.8", public),
            ("::127.0.0.1", Refused),
            ("fc00::1", lan),
            ("fd12:3456::1", lan),
            ("fe80::1", Refused),
            ("febf::1", Refused),
            ("fec0::1", Refused),
            ("ff02::1", Refused),
            ("ff05::2", Refused),
            ("2001:db8::1", Refused),
            ("3fff::1", Refused),
            ("3fff:fff::1", Refused),
            ("3fff:1000::1", public),
            ("64:ff9b::7f00:1", Refused),
            ("64:ff9b::a00:1", Refused),
            ("64:ff9b::808:808", public),
            ("64:ff9b:1::1", Refused),
            ("2002:7f00:1::1", Refused),
            ("2002:808:808::1", public),
            ("2606:4700::1111", public),
            ("::ffff:0:169.254.169.254", Refused),
            ("::ffff:0:8.8.8.8", Refused),
            ("::ffff:0:127.0.0.1", Refused),
            ("100::1", Refused),
            ("1::1", Refused),
            ("4000::1", Refused),
            ("e000::1", Refused),
            ("2001::1", Refused),
            ("2001:2::1", Refused),
            ("2001:1ff::1", Refused),
            ("2001:200::1", public),
            ("2c0f:f248::1", public),
            ("2001:4860:4860::8888", public),
        ] {
            assert_eq!(c(ip), want, "{ip}");
        }
    }

    #[test]
    fn literal_hosts_in_urls() {
        assert_eq!(normalize("http://[::ffff:127.0.0.1]:9000").unwrap().reach, Some(Reach::Loopback));
        assert_eq!(normalize("http://[::ffff:127.0.0.1]:9000").unwrap().host, "[::ffff:7f00:1]");
        assert_eq!(normalize("http://[fd00::5]").unwrap().reach, Some(Reach::Lan));
        assert_eq!(normalize("http://192.168.1.20:1234").unwrap().reach, Some(Reach::Lan));
        assert_eq!(normalize("https://8.8.8.8").unwrap().reach, Some(Reach::Public));
        assert_eq!(normalize("https://[::ffff:0:169.254.169.254]"), Err(AddrError::BlockedAddress));
        for bad in ["http://169.254.169.254", "http://[fe80::1]", "http://[::]", "http://0.0.0.0:80", "http://224.0.0.1", "https://192.0.2.1"] {
            assert_eq!(normalize(bad), Err(AddrError::BlockedAddress), "{bad}");
        }
        assert_eq!(normalize("http://LOCALHOST:11434").unwrap().reach, Some(Reach::Loopback));
        assert_eq!(normalize("http://localhost.").unwrap().reach, Some(Reach::Loopback));
        assert_eq!(normalize("http://localhost.example.com").unwrap().reach, None);
        assert_eq!(normalize("http://foo.localhost").unwrap().reach, Some(Reach::Loopback), "a name under localhost is this PC too");
        assert_eq!(normalize("http://a.b.LOCALHOST.:8080").unwrap().reach, Some(Reach::Loopback));
        assert_eq!(normalize("http://notlocalhost").unwrap().reach, None);
        assert!(!check_add(Kind::Model, "http://ollama.localhost:11434", "", None).unwrap().needs_lookup());
        assert_eq!(normalize("https://api.example.com").unwrap().reach, None);
    }

    #[test]
    fn https_is_required_unless_lan_or_loopback() {
        assert_eq!(check_add(Kind::Model, "http://8.8.8.8", "", None), Err(AddrError::Insecure));
        assert_eq!(check_add(Kind::Model, "http://[::ffff:8.8.8.8]", "", None), Err(AddrError::Insecure));
        assert!(check_add(Kind::Model, "https://8.8.8.8", "", None).is_ok());
        assert!(check_add(Kind::Model, "http://127.0.0.1:1234", "", None).is_ok());
        assert!(check_add(Kind::Server, "http://10.0.0.5:8000/mcp", "", None).is_ok());
        assert!(check_add(Kind::Model, "http://localhost:11434", "", None).is_ok());
        // A name's reach is known only after the lookup, which class_answers judges.
        let named = check_add(Kind::Model, "http://lmstudio.lan:1234", "", None).unwrap();
        assert!(named.needs_lookup());
        assert_eq!(class_answers("http", &["192.168.1.9".parse().unwrap()]), Ok(Reach::Lan));
        assert_eq!(class_answers("http", &["93.184.216.34".parse().unwrap()]), Err(AddrError::Insecure));
    }

    #[test]
    fn kinds_take_their_own_schemes() {
        assert_eq!(check_add(Kind::Model, "ws://127.0.0.1", "", None), Err(AddrError::Invalid));
        assert_eq!(check_add(Kind::Server, "ws://127.0.0.1", "", Some((1, 2))), Err(AddrError::Invalid));
        assert_eq!(check_add(Kind::Peer, "https://127.0.0.1", "", Some((1, 2))), Err(AddrError::Invalid));
        assert_eq!(check_add(Kind::Model, "https://example.com", "", Some((1, 2))), Err(AddrError::Invalid), "ports are a peer's");
        assert_eq!(check_add(Kind::Model, "https://example.com", &"x".repeat(MAX_LABEL + 1), None), Err(AddrError::Invalid));
    }

    #[test]
    fn peers_are_ws_loopback_with_a_short_range() {
        let ok = check_add(Kind::Peer, "ws://127.0.0.1", "Buddies", Some((47110, 47114))).unwrap();
        assert_eq!(ok.identity, Identity { kind: Kind::Peer, url: "ws://127.0.0.1".into(), ports: Some((47110, 47114)) });
        assert!(!ok.needs_lookup());
        assert!(check_add(Kind::Peer, "ws://127.0.0.1/", "", Some((5, 5))).is_ok());
        assert!(check_add(Kind::Peer, "ws://127.1", "", Some((1, 16))).is_ok());
        assert!(check_add(Kind::Peer, "ws://127.0.0.1", "", Some((65520, 65535))).is_ok());
        for (url, ports) in [
            ("ws://127.0.0.1", None),
            ("ws://127.0.0.1", Some((0, 3))),
            ("ws://127.0.0.1", Some((10, 9))),
            ("ws://127.0.0.1", Some((1, 17))),
            ("ws://127.0.0.1:47110", Some((47110, 47110))),
            ("ws://127.0.0.1/path", Some((1, 2))),
            ("ws://127.0.0.2", Some((1, 2))),
            ("ws://localhost", Some((1, 2))),
            ("ws://[::1]", Some((1, 2))),
            ("ws://10.0.0.1", Some((1, 2))),
            ("ws://example.com", Some((1, 2))),
        ] {
            assert!(check_add(Kind::Peer, url, "", ports).is_err(), "{url} {ports:?}");
        }
    }

    #[test]
    fn identity_is_kind_url_and_the_whole_range() {
        let id = |k, u, p| check_add(k, u, "", p).unwrap().identity;
        assert_eq!(id(Kind::Model, "HTTPS://Example.com/v1/", None), id(Kind::Model, "https://example.com:443/v1", None));
        assert_ne!(id(Kind::Model, "https://example.com/v1", None), id(Kind::Server, "https://example.com/v1", None));
        assert_ne!(id(Kind::Model, "https://example.com/v1", None), id(Kind::Model, "https://example.com/v2", None));
        assert_ne!(id(Kind::Peer, "ws://127.0.0.1", Some((47110, 47114))), id(Kind::Peer, "ws://127.0.0.1", Some((47110, 47115))));
        assert_eq!(id(Kind::Peer, "ws://127.0.0.1", Some((47110, 47114))), id(Kind::Peer, "ws://127.1/", Some((47110, 47114))));
    }

    #[test]
    fn dns_answers_after_approval() {
        let ips = |v: &[&str]| v.iter().map(|s| s.parse().unwrap()).collect::<Vec<IpAddr>>();
        assert_eq!(class_answers("http", &ips(&["127.0.0.1", "::1"])), Ok(Reach::Loopback));
        assert_eq!(class_answers("http", &ips(&["10.0.0.5", "fd00::5"])), Ok(Reach::Lan));
        assert_eq!(class_answers("https", &ips(&["93.184.216.34", "2606:2800::1"])), Ok(Reach::Public));
        assert_eq!(class_answers("https", &ips(&["93.184.216.34", "10.0.0.1"])), Err(AddrError::BlockedAddress));
        assert_eq!(class_answers("https", &ips(&["127.0.0.1", "10.0.0.1"])), Err(AddrError::BlockedAddress));
        assert_eq!(class_answers("https", &ips(&[])), Err(AddrError::BlockedAddress));
        assert_eq!(class_answers("https", &ips(&["93.184.216.34", "169.254.169.254"])), Err(AddrError::BlockedAddress));
        assert_eq!(class_answers("https", &ips(&["0.0.0.0"])), Err(AddrError::BlockedAddress));
        assert_eq!(class_answers("http", &ips(&["93.184.216.34"])), Err(AddrError::Insecure));
        assert_eq!(class_answers("https", &ips(&["::ffff:127.0.0.1"])), Ok(Reach::Loopback));
    }

    #[test]
    fn the_resolver_keeps_only_answers_of_the_reach() {
        let ips: Vec<IpAddr> = ["93.184.216.34", "127.0.0.1", "10.0.0.5", "169.254.169.254", "::ffff:10.0.0.6"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(keep_answers(Reach::Public, &ips), vec![ips[0]]);
        assert_eq!(keep_answers(Reach::Loopback, &ips), vec![ips[1]]);
        assert_eq!(keep_answers(Reach::Lan, &ips), vec![ips[2], ips[4]]);
    }

    #[test]
    fn encoded_separators_never_pass() {
        let saved = normalize("https://api.example.com/v1").unwrap();
        for bad in [
            "https://api.example.com/v1/%2e%2e%2fadmin",
            "https://api.example.com/v1/%2E%2E%2Fadmin",
            "https://api.example.com/v1/..%2fadmin",
            "https://api.example.com/v1/x%2Fy",
            "https://api.example.com/v1/a%5cb",
            "https://api.example.com/v1/a%5C..%5Cb",
            "https://api.example.com/v1/a%2eb",
        ] {
            assert_eq!(under(&saved, bad).err(), Some(AddrError::NotSaved), "{bad}");
        }
        for bad in ["https://api.example.com/v1%2fx", "https://api.example.com/a%2E/b", "http://localhost/%5c"] {
            assert_eq!(normalize(bad), Err(AddrError::Invalid), "{bad}");
        }
        assert!(under(&saved, "https://api.example.com/v1/a%20b?q=%2f").is_ok(), "other escapes, and the query, are fine");
    }

    #[test]
    fn the_under_address_rule() {
        let saved = normalize("https://api.example.com/v1").unwrap();
        for ok in [
            "https://api.example.com/v1",
            "https://api.example.com/v1/",
            "https://api.example.com/v1/chat/completions",
            "https://API.example.com:443/v1/models?x=1",
            "https://api.example.com./v1/models",
            "https://api.example.com/v1/a#frag",
        ] {
            assert!(under(&saved, ok).is_ok(), "{ok}");
        }
        for bad in [
            "https://api.example.com/v10",
            "https://api.example.com/v1x/y",
            "https://api.example.com/",
            "https://api.example.com/v2/x",
            "https://api.example.com/v1/../admin",
            "https://api.example.com/v1/%2e%2e/admin",
            "https://api.example.com/V1/x",
            "http://api.example.com/v1",
            "https://api.example.com:8443/v1",
            "https://evil.example.com/v1",
            "https://api.example.com.evil.com/v1",
            "https://user\u{40}api.example.com/v1",
            "https://api.example.com\u{40}evil.com/v1",
            "//api.example.com/v1",
            "/v1/x",
            "not a url",
        ] {
            assert_eq!(under(&saved, bad).err(), Some(AddrError::NotSaved), "{bad}");
        }
        let root = normalize("http://localhost:11434").unwrap();
        assert!(under(&root, "http://localhost:11434/api/chat").is_ok());
        assert!(under(&root, "http://localhost:11434").is_ok());
        assert!(under(&root, "http://127.0.0.1:11434/api/chat").is_err(), "a name and its IP are different origins");
        assert!(under(&root, "http://localhost:11435/api/chat").is_err());
        let v6 = normalize("http://[::1]:8080/mcp").unwrap();
        assert!(under(&v6, "http://[0::1]:8080/mcp/x").is_ok());
        assert!(under(&v6, "http://[::2]:8080/mcp/x").is_err());
    }
}
