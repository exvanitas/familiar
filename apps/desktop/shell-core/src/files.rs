//! The rules of `save_as`, `pick_path` and `open_folder`. See "5d. The rest" in
//! docs/shell-design.md.

use std::path::Path;

use serde::Deserialize;

use crate::folders::within;
use crate::paths::plain;

/// The most `save_as` writes.
pub const MAX_SAVE: usize = 256 * 1024 * 1024;
pub const MAX_FILTERS: usize = 16;

/// A file type in a dialog: a name and its extensions, without dots.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Filters a dialog may show: a few, each named, with short plain extensions.
pub fn check_filters(filters: &[Filter]) -> Result<(), &'static str> {
    if filters.len() > MAX_FILTERS {
        return Err("too many filters");
    }
    for f in filters {
        let name_ok = !f.name.is_empty() && f.name.chars().count() <= 64 && !f.name.chars().any(char::is_control);
        let exts_ok = !f.extensions.is_empty()
            && f.extensions.len() <= 16
            && f.extensions.iter().all(|e| !e.is_empty() && e.len() <= 16 && e.bytes().all(|b| b.is_ascii_alphanumeric()));
        if !name_ok || !exts_ok {
            return Err("a filter needs a name and plain extensions");
        }
    }
    Ok(())
}

/// The name a save dialog suggests: one plain name.
pub fn check_name(name: &str) -> Result<(), &'static str> {
    if plain(name) && !name.contains(['/', '\\']) {
        Ok(())
    } else {
        Err("the name must be one plain file name")
    }
}

/// Whether a save into this folder is refused: the native data folder, the WebView2 folder, and
/// the folder holding the exe and the app folder, or anything inside them. Every path is a final
/// path, after links.
pub fn save_refused(folder: &Path, forbidden: &[&Path]) -> bool {
    forbidden.iter().any(|f| within(folder, f))
}

/// Whether a path names somewhere remote by its form: a UNC path (`\\server\share`), a
/// `\\?\UNC\` path, or any other `\\` form but a local `\\?\C:\`. Remote drives are told by the
/// drive table, not by their form.
pub fn remote(path: &str) -> bool {
    let p = path.replace('/', "\\");
    if let Some(rest) = p.strip_prefix("\\\\?\\").or_else(|| p.strip_prefix("\\\\.\\")) {
        let b = rest.as_bytes();
        return !(b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':');
    }
    p.starts_with("\\\\")
}

/// The two folders `open_folder` opens, by name, inside the data folder.
pub fn named_folder(which: &str) -> Option<&'static str> {
    match which {
        "backups" => Some("backups"),
        "logs" => Some("logs"),
        _ => None,
    }
}

/// What `pick_path` picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    File,
    Folder,
}

impl Pick {
    pub fn parse(kind: &str) -> Option<Pick> {
        match kind {
            "file" => Some(Pick::File),
            "folder" => Some(Pick::Folder),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p(parts: &[&str]) -> PathBuf {
        let mut b = PathBuf::from("/");
        b.extend(parts);
        b
    }

    #[test]
    fn saves_into_familiars_own_folders_are_refused() {
        let data = p(&["local", "dev.exvanitas.familiar"]);
        let webview = p(&["local", "dev.exvanitas.familiar", "webview"]);
        let install = p(&["local", "Programs", "Familiar"]);
        let forbidden = [data.as_path(), webview.as_path(), install.as_path()];
        for bad in [&data, &webview, &install, &p(&["local", "dev.exvanitas.familiar", "logs"]), &p(&["LOCAL", "programs", "familiar", "app"])] {
            assert!(save_refused(bad, &forbidden), "{bad:?}");
        }
        for good in [p(&["users", "me", "Documents"]), p(&["local"]), p(&["local", "Programs"]), p(&["local", "dev.exvanitas.familiar2"])] {
            assert!(!save_refused(&good, &forbidden), "{good:?}");
        }
    }

    #[test]
    fn remote_by_form() {
        for r in ["\\\\localhost\\share\\shell", "\\\\server\\C$", "//server/share", "\\\\?\\UNC\\server\\share\\x", "\\\\?\\Volume{x}\\a", "\\\\.\\pipe\\x"] {
            assert!(remote(r), "{r}");
        }
        for l in ["C:\\data\\x", "\\\\?\\C:\\data\\x", "c:/x", "\\\\.\\C:\\x"] {
            assert!(!remote(l), "{l}");
        }
    }

    #[test]
    fn names_filters_and_folders() {
        assert!(check_name("familiar-export.json").is_ok());
        for bad in ["", "a/b", "..\\x", "con.txt", "a:b", "x."] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
        let f = |n: &str, e: &[&str]| Filter { name: n.into(), extensions: e.iter().map(|s| s.to_string()).collect() };
        assert!(check_filters(&[f("Familiar export", &["json"])]).is_ok());
        assert!(check_filters(&[]).is_ok());
        for bad in [vec![f("", &["json"])], vec![f("x", &[])], vec![f("x", &["*.json"])], vec![f("x", &["j.s"])], vec![f("a\nb", &["x"])]] {
            assert!(check_filters(&bad).is_err(), "{bad:?}");
        }
        assert!(check_filters(&vec![f("x", &["a"]); MAX_FILTERS + 1]).is_err());
        assert_eq!(named_folder("logs"), Some("logs"));
        assert_eq!(named_folder("backups"), Some("backups"));
        for bad in ["", "shell", "..", "Logs", "webview"] {
            assert_eq!(named_folder(bad), None);
        }
        assert_eq!(Pick::parse("file"), Some(Pick::File));
        assert_eq!(Pick::parse("folder"), Some(Pick::Folder));
        assert_eq!(Pick::parse("dir"), None);
    }
}
