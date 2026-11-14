//! Which windows exist, which page each is bound to, and what may be done to them. Core is opened
//! by the exe alone. Settings is always `settings.html`. A view is `view-<name>` with a plain page
//! of the app folder other than core's or Settings'. See "Windows" in docs/shell-design.md.

pub const CORE: &str = "core";
pub const SETTINGS: &str = "settings";
pub const CORE_PAGE: &str = "core.html";
pub const SETTINGS_PAGE: &str = "settings.html";
const VIEW_PREFIX: &str = "view-";

/// `view-[a-z0-9-]{1,32}`.
pub fn is_view(label: &str) -> bool {
    label.strip_prefix(VIEW_PREFIX).is_some_and(|name| {
        (1..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// A page name with nothing a URL or Windows could read two ways: lower case letters, digits, `-`,
/// `_` and inner dots, in folders split by `/`, ending `.html`. No `%`, so no percent-decoding can
/// turn it into another page, and lower case only, so a case-blind disk can't either.
pub fn plain_page(page: &str) -> bool {
    if page.len() > 128 || !page.ends_with(".html") {
        return false;
    }
    page.split('/').all(|seg| {
        !seg.is_empty()
            && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
            && !seg.starts_with('.')
            && !seg.ends_with('.')
            && !seg.contains("..")
            && crate::paths::plain(seg)
    })
}

/// The page a window opened with `view_open` is bound to, or why it can't be opened.
pub fn bind(label: &str, page: Option<&str>) -> Result<String, String> {
    if label == SETTINGS {
        return match page {
            None | Some(SETTINGS_PAGE) => Ok(SETTINGS_PAGE.into()),
            Some(_) => Err("settings always opens settings.html".into()),
        };
    }
    if !is_view(label) {
        return Err("a window label must be settings or view-[a-z0-9-]{1,32}".into());
    }
    let page = page.ok_or("a view needs a page")?;
    if !plain_page(page) {
        return Err("a view's page must be a plain .html name of the app folder".into());
    }
    if page == SETTINGS_PAGE || page == CORE_PAGE {
        return Err("a view can't load core's or Settings' page".into());
    }
    Ok(page.into())
}

/// Whether core may act on this window through `window_ctl`: Settings and views, never core.
pub fn ctl_target(label: &str) -> Result<(), String> {
    if label == SETTINGS || is_view(label) {
        Ok(())
    } else {
        Err("window_ctl acts on settings and view windows only".into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CtlOp {
    Show,
    Hide,
    Focus,
    Close,
    GetBounds,
    SetBounds,
}

impl CtlOp {
    pub fn parse(op: &str) -> Option<CtlOp> {
        Some(match op {
            "show" => CtlOp::Show,
            "hide" => CtlOp::Hide,
            "focus" => CtlOp::Focus,
            "close" => CtlOp::Close,
            "get-bounds" => CtlOp::GetBounds,
            "set-bounds" => CtlOp::SetBounds,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfOp {
    Drag,
    Minimize,
    ToggleMaximize,
    Close,
}

impl SelfOp {
    pub fn parse(op: &str) -> Option<SelfOp> {
        Some(match op {
            "drag" => SelfOp::Drag,
            "minimize" => SelfOp::Minimize,
            "toggle-maximize" => SelfOp::ToggleMaximize,
            "close" => SelfOp::Close,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_labels() {
        for ok in ["view-chat", "view-a", "view-0-9", &format!("view-{}", "a".repeat(32))] {
            assert!(is_view(ok), "{ok}");
        }
        for bad in ["view-", "view-Chat", "view-a_b", "view-a.b", "core", "settings", "chat", "VIEW-a", " view-a", &format!("view-{}", "a".repeat(33))] {
            assert!(!is_view(bad), "{bad}");
        }
    }

    #[test]
    fn settings_is_always_its_own_page() {
        assert_eq!(bind("settings", None).unwrap(), "settings.html");
        assert_eq!(bind("settings", Some("settings.html")).unwrap(), "settings.html");
        assert!(bind("settings", Some("chat.html")).is_err());
    }

    #[test]
    fn core_cannot_be_made_and_odd_labels_are_refused() {
        for label in ["core", "Core", "main", "", "view-", "settings2"] {
            assert!(bind(label, Some("chat.html")).is_err(), "{label}");
        }
    }

    #[test]
    fn a_view_never_gets_core_or_settings_page_by_any_spelling() {
        for page in [
            "settings.html", "core.html", "Settings.html", "SETTINGS.HTML", "%73ettings.html", "settings%2ehtml", "settin~1.htm",
            "./settings.html", "a/../settings.html", "settings.html.", "settings.html::$DATA", "settings.html/", "/settings.html",
            "\\settings.html", "settings.html?x", "settings.html#x",
        ] {
            assert!(bind("view-x", Some(page)).is_err(), "{page}");
        }
    }

    #[test]
    fn plain_pages_pass_and_the_rest_do_not() {
        assert_eq!(bind("view-chat", Some("chat.html")).unwrap(), "chat.html");
        assert_eq!(bind("view-x", Some("views/x-1_a.b.html")).unwrap(), "views/x-1_a.b.html");
        for bad in ["chat.htm", "chat", "", ".html", "a/.x.html", "a//b.html", "a b.html", "con.html", "a\\b.html", "c:x.html", "x.html.js", "..html"] {
            assert!(bind("view-x", Some(bad)).is_err(), "{bad}");
        }
        assert!(bind("view-x", None).is_err());
        assert!(!plain_page(&format!("{}.html", "a".repeat(124))));
    }

    #[test]
    fn window_ctl_never_reaches_core() {
        assert!(ctl_target("core").is_err());
        assert!(ctl_target("Core").is_err());
        assert!(ctl_target("").is_err());
        assert!(ctl_target("settings").is_ok());
        assert!(ctl_target("view-chat").is_ok());
    }

    #[test]
    fn ops() {
        assert_eq!(CtlOp::parse("get-bounds"), Some(CtlOp::GetBounds));
        assert_eq!(CtlOp::parse("Close"), None);
        assert_eq!(SelfOp::parse("toggle-maximize"), Some(SelfOp::ToggleMaximize));
        assert_eq!(SelfOp::parse("show"), None);
    }
}
