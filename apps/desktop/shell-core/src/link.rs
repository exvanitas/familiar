//! What `open_url` accepts before it asks: `https` only, up to 2048 characters. See "5d. The
//! rest" in docs/shell-design.md. The browser gets the URL as parsed here, so what the confirm
//! shows is what opens.

use url::Url;

pub const MAX_LINK: usize = 2048;

/// A link the person may be asked about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The URL as the browser will get it, the host in punycode.
    pub url: String,
    /// The host alone, in punycode, for its own line in the confirm.
    pub host: String,
}

/// `https` with a host, no user info (which would put a fake host before the real one), and no
/// control characters or spaces, in at most 2048 characters. Anything else is `invalid`,
/// refused before any dialog.
pub fn check(input: &str) -> Result<Link, &'static str> {
    if input.is_empty() || input.chars().count() > MAX_LINK || input.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("invalid");
    }
    let url = Url::parse(input).map_err(|_| "invalid")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("invalid");
    }
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or("invalid")?.to_string();
    let out = url.to_string();
    if out.chars().count() > MAX_LINK {
        return Err("invalid");
    }
    Ok(Link { url: out, host })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_only() {
        assert_eq!(check("https://example.com/a?b=c#d").unwrap(), Link { url: "https://example.com/a?b=c#d".into(), host: "example.com".into() });
        assert_eq!(check("HTTPS://Example.COM").unwrap().url, "https://example.com/");
        assert_eq!(check("https://bücher.example/x").unwrap().host, "xn--bcher-kva.example");
        assert_eq!(check("https://[::1]:8443/").unwrap().host, "[::1]");
        assert_eq!(check("https://example.com/\u{202e}x").unwrap().url, "https://example.com/%E2%80%AEx", "the browser gets it encoded");
        assert_eq!(check("https:example.com").unwrap().url, "https://example.com/", "read as the browser would, and opened as shown");
        for bad in [
            "http://example.com",
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/html,x",
            "ms-settings:privacy",
            "mailto:a\u{40}example.com",
            "ftp://example.com",
            "https://",
            "//example.com",
            "example.com",
            "https://user\u{40}example.com",
            "https://bank.example\u{40}evil.example/",
            "https://a b.example",
            "https://example.com/\n",
            "",
        ] {
            assert_eq!(check(bad), Err("invalid"), "{bad:?}");
        }
    }

    #[test]
    fn up_to_2048_characters() {
        let base = "https://example.com/";
        let ok = format!("{base}{}", "a".repeat(MAX_LINK - base.len()));
        assert!(check(&ok).is_ok());
        assert_eq!(check(&format!("{ok}a")), Err("invalid"));
        // Characters, not bytes, and the parsed form must fit too.
        let wide = format!("{base}{}", "é".repeat(MAX_LINK - base.len()));
        assert_eq!(check(&wide), Err("invalid"), "percent-encoded it is longer");
    }
}
