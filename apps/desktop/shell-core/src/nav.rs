//! Navigation. Each window is bound to the page it opened with, and may go nowhere else: not
//! another page of the app, not the web, nothing sent on to a browser. A refusal is logged by
//! scheme only, because a URL can carry anything.

/// The host every page is served from. The origin is `crate::identity::ORIGIN`.
pub const HOST: &str = "tauri.localhost";

/// The one URL a window bound to `page` may be at. A fragment is ignored: it never loads anything.
pub fn stays(page: &str, scheme: &str, host: Option<&str>, port: Option<u16>, path: &str, query: Option<&str>) -> bool {
    scheme == "http" && host == Some(HOST) && port.is_none() && query.is_none() && path.strip_prefix('/') == Some(page)
}

/// A URL's scheme as the log may show it: the scheme when it's plain, else `other`.
pub fn scheme_for_log(scheme: &str) -> &str {
    let plain = !scheme.is_empty() && scheme.len() <= 16 && scheme.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b));
    if plain {
        scheme
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_stays_on_its_own_page() {
        assert!(stays("core.html", "http", Some(HOST), None, "/core.html", None));
        assert!(stays("views/x.html", "http", Some(HOST), None, "/views/x.html", None));
    }

    #[test]
    fn everywhere_else_is_refused() {
        let p = "settings.html";
        assert!(!stays(p, "http", Some(HOST), None, "/chat.html", None), "another app page");
        assert!(!stays(p, "https", Some(HOST), None, "/settings.html", None), "https origin is another origin");
        assert!(!stays(p, "http", Some("tauri.localhost.evil"), None, "/settings.html", None));
        assert!(!stays(p, "http", Some(HOST), Some(8080), "/settings.html", None));
        assert!(!stays(p, "http", Some(HOST), None, "/settings.html", Some("x=1")));
        assert!(!stays(p, "http", Some(HOST), None, "/SETTINGS.HTML", None));
        assert!(!stays(p, "http", Some(HOST), None, "/%73ettings.html", None));
        assert!(!stays(p, "http", Some(HOST), None, "/", None));
        assert!(!stays(p, "http", Some("ipc.localhost"), None, "/settings.html", None));
        assert!(!stays(p, "javascript", None, None, "alert(1)", None));
        assert!(!stays(p, "about", None, None, "blank", None));
        assert!(!stays(p, "data", None, None, "text/html,x", None));
    }

    #[test]
    fn only_a_plain_scheme_reaches_the_log() {
        assert_eq!(scheme_for_log("https"), "https");
        assert_eq!(scheme_for_log("ms-settings"), "ms-settings");
        assert_eq!(scheme_for_log("HTTP"), "other");
        assert_eq!(scheme_for_log("a b"), "other");
        assert_eq!(scheme_for_log(""), "other");
        assert_eq!(scheme_for_log(&"x".repeat(17)), "other");
    }
}
