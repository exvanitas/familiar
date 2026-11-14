//! The plain-names check every path from a page goes through. It works on the string, not on
//! `Path`, so it refuses the same things on every system. From Desktop Buddies' shell-core.

use std::path::{Path, PathBuf};

/// Names Windows keeps for devices, with or without an extension: the classic ones, `COM0`
/// and `LPT0`, the superscript digits Windows also reads as port numbers, and the console and
/// clock devices.
const DEVICES: [&str; 33] = [
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt0",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "com\u{b9}", "com\u{b2}", "com\u{b3}",
    "lpt\u{b9}", "lpt\u{b2}", "lpt\u{b3}", "conin$", "conout$", "clock$",
];

/// One plain file or folder name: nothing Windows would read as something else.
pub fn plain(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.len() > 255 {
        return false;
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return false; // Windows drops these, so two names would mean one file
    }
    if name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) {
        return false; // ':' also covers drive letters and alternate streams
    }
    // Windows also drops spaces before the extension, so `NUL .txt` is the device too.
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ').to_ascii_lowercase();
    !DEVICES.contains(&stem.as_str())
}

/// The names in a relative path, or None if any of them could reach outside its folder.
/// Both slashes separate. An empty path has no names.
pub fn names(path: &str) -> Option<Vec<&str>> {
    if path.is_empty() {
        return Some(vec![]);
    }
    let parts: Vec<&str> = path.split(['/', '\\']).collect();
    parts.iter().all(|p| plain(p)).then_some(parts)
}

/// `root` joined with a checked path.
pub fn inside(root: &Path, path: &str) -> Option<PathBuf> {
    let parts = names(path)?;
    let mut out = root.to_path_buf();
    out.extend(parts);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_pass() {
        assert_eq!(names("core.html"), Some(vec!["core.html"]));
        assert_eq!(names("assets/a.js"), Some(vec!["assets", "a.js"]));
        assert_eq!(names("a\\b.json"), Some(vec!["a", "b.json"]));
        assert_eq!(names(".hidden"), Some(vec![".hidden"]));
        assert_eq!(names("console.json"), Some(vec!["console.json"]));
        assert_eq!(names(""), Some(vec![]));
    }

    #[test]
    fn anything_that_could_leave_is_refused() {
        for bad in [
            "..", "../x", "a/../b", "a/..", ".", "./a", "/etc/passwd", "\\\\server\\share", "C:\\x", "C:/x", "c:x", "a//b",
            "a/", "/", "\\", "a:b", "a.txt:stream", "a\0b", "a\nb", "nul", "NUL.txt", "con", "con.d/x", "aux.json", "com1",
            "lpt9.x", "dots.", "space ", "a?b", "a*b", "a|b", "a<b", "a>b", "a\"b",
        ] {
            assert_eq!(names(bad), None, "{bad:?}");
        }
        assert_eq!(names(&"x".repeat(256)), None);
        for dev in ["COM0", "lpt0", "COM\u{b9}", "com\u{b2}.txt", "COM\u{b3}", "LPT\u{b9}", "lpt\u{b2}", "LPT\u{b3}.log", "CONIN$", "conout$", "Clock$", "CONIN$.x", "nul .txt"] {
            assert_eq!(names(dev), None, "{dev:?}");
            assert_eq!(names(&format!("a/{dev}")), None, "{dev:?}");
        }
        for ok in ["com10", "lpt10", "com", "comb", "conin", "clock", "com\u{b4}"] {
            assert!(names(ok).is_some(), "{ok:?}");
        }
    }

    #[test]
    fn inside_joins_under_the_root() {
        assert_eq!(inside(Path::new("/r"), "a/b"), Some(PathBuf::from("/r/a/b")));
        assert_eq!(inside(Path::new("/r"), ""), Some(PathBuf::from("/r")));
        assert_eq!(inside(Path::new("/r"), "../b"), None);
    }
}
