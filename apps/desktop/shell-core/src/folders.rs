//! The app folder must never reach the data folders. Pages are served from the app folder, so if
//! the data folder or WebView2's folder were inside it (or it inside them), a page could fetch the
//! log or the database files. Compared on final paths, the ones links resolve to, name by name and
//! ignoring case, as Windows does.

use std::path::{Component, Path};

fn names(p: &Path) -> Vec<String> {
    p.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// Whether `inner` is `outer` or inside it.
pub fn within(inner: &Path, outer: &Path) -> bool {
    let (i, o) = (names(inner), names(outer));
    !o.is_empty() && i.len() >= o.len() && i[..o.len()] == o[..]
}

/// Whether either folder holds the other.
pub fn overlap(a: &Path, b: &Path) -> bool {
    within(a, b) || within(b, a)
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
    fn inside_either_way_overlaps() {
        assert!(overlap(&p(&["x"]), &p(&["x", "data"])));
        assert!(overlap(&p(&["x", "data"]), &p(&["x"])));
        assert!(overlap(&p(&["x"]), &p(&["x"])));
        assert!(overlap(&p(&["Programs", "Familiar", "app"]), &p(&["programs", "familiar", "APP", "data"])), "case is ignored");
    }

    #[test]
    fn siblings_and_prefixes_of_a_name_dont() {
        assert!(!overlap(&p(&["local", "Programs", "Familiar", "app"]), &p(&["local", "dev.exvanitas.familiar"])));
        assert!(!overlap(&p(&["x", "app"]), &p(&["x", "app2"])), "a name that only starts the same");
        assert!(within(&p(&["x", "app", "a.html"]), &p(&["x", "app"])));
        assert!(!within(&p(&["x", "other.html"]), &p(&["x", "app"])));
        assert!(!within(&p(&["x"]), Path::new("")), "an empty folder holds nothing");
    }
}
