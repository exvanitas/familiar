//! Writes that land whole, from Desktop Buddies' shell-core. The new bytes go to a temp file beside the target, so the move stays
//! on one volume. A temp file is only ever made new, under a name nobody can guess: a name that's
//! already there, or a link, is never opened. A failure removes only the temp file this write made.

use std::collections::hash_map::RandomState;
use std::fs::{self, OpenOptions};
use std::hash::BuildHasher;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Temp files start with this, and data listings never show them.
pub const PREFIX: &str = ".~";

static NEXT: AtomicU64 = AtomicU64::new(0);

/// `.~` and 16 hex digits from the process's random hashing keys.
pub fn random_name() -> String {
    format!("{PREFIX}{:016x}", RandomState::new().hash_one(NEXT.fetch_add(1, Ordering::Relaxed)))
}

/// Makes a new file in `dir` holding `bytes`, flushed, under the first of `names` that isn't
/// taken. Never opens one that is.
pub fn write_temp_named(dir: &Path, bytes: &[u8], names: impl IntoIterator<Item = String>) -> io::Result<PathBuf> {
    for name in names {
        let p = dir.join(name);
        let mut f = match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let wrote = f.write_all(bytes).and_then(|_| f.sync_all());
        drop(f);
        if let Err(e) = wrote {
            let _ = fs::remove_file(&p);
            return Err(e);
        }
        return Ok(p);
    }
    Err(io::Error::other("no free name for a temp file"))
}

pub fn write_temp(dir: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    write_temp_named(dir, bytes, std::iter::repeat_with(random_name).take(8))
}

/// For the data folder: a temp file, then a rename over the target.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = target.parent().ok_or_else(|| io::Error::other("no folder"))?;
    let temp = write_temp(dir, bytes)?;
    fs::rename(&temp, target).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// How a finished temp file takes its place. The OS's own on Windows.
pub trait Swap {
    /// Moves `temp` over `target`, whether or not the target is there: one rename on one volume,
    /// written through. On a failure the target is untouched.
    fn move_in(&self, temp: &Path, target: &Path) -> io::Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    New,
    File,
}

/// What's at a path a save would write. A link is refused, never written through.
pub fn target(path: &Path) -> Result<Target, String> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err("refused: there's a link at that name, and a save never writes through one".into()),
        Ok(m) if m.is_dir() => Err("refused: there's a folder at that name".into()),
        Ok(_) => Ok(Target::File),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Target::New),
        Err(e) => Err(e.to_string()),
    }
}

/// A file the person chose: a temp file in the same folder, then one rename over the name. On a
/// failure the name still holds what it held, and only then is the temp file deleted. A replaced
/// file's own ACL and alternate streams aren't kept: the new file has its folder's.
pub fn save(path: &Path, bytes: &[u8], swap: &dyn Swap) -> Result<(), String> {
    target(path)?;
    let dir = path.parent().ok_or("no folder")?;
    let temp = write_temp(dir, bytes).map_err(|e| e.to_string())?;
    swap.move_in(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shell-core-temp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    /// A plain rename, which can fail on demand, and a log of what was asked.
    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<&'static str>>,
        fail: bool,
    }
    impl Swap for Fake {
        fn move_in(&self, temp: &Path, target: &Path) -> io::Result<()> {
            self.calls.borrow_mut().push("move");
            if self.fail {
                return Err(io::Error::other("move failed"));
            }
            fs::rename(temp, target)
        }
    }

    #[test]
    fn temp_names_are_hidden_and_unguessable() {
        let (a, b) = (random_name(), random_name());
        assert_ne!(a, b);
        assert!(a.starts_with(PREFIX) && a.len() == 18 && a[2..].bytes().all(|c| c.is_ascii_hexdigit()), "{a}");
    }

    #[test]
    fn temp_names_are_not_a_count() {
        let n: Vec<u64> = (0..64).map(|_| u64::from_str_radix(&random_name()[2..], 16).unwrap()).collect();
        assert!(n.windows(2).all(|w| w[1] != w[0].wrapping_add(1)), "{n:?}");
        assert!(n.iter().filter(|v| **v > 1 << 48).count() > 32, "they use the whole range: {n:?}");
    }

    #[test]
    fn a_temp_never_opens_a_name_that_is_taken() {
        let d = temp("exclusive");
        fs::write(d.join("taken"), "keep me").unwrap();
        let p = write_temp_named(&d, b"new", ["taken".to_string(), "free".to_string()]).unwrap();
        assert_eq!(p, d.join("free"));
        assert_eq!(fs::read(d.join("taken")).unwrap(), b"keep me", "never truncated");
        assert!(write_temp_named(&d, b"x", ["taken".to_string()]).is_err(), "and never reused");
        assert_eq!(fs::read(d.join("taken")).unwrap(), b"keep me");
        fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_temp_never_follows_a_link() {
        let d = temp("link");
        fs::write(d.join("important"), "keep me").unwrap();
        std::os::unix::fs::symlink(d.join("important"), d.join("bait")).unwrap();
        std::os::unix::fs::symlink(d.join("nowhere"), d.join("dangling")).unwrap();
        let p = write_temp_named(&d, b"new", ["bait".to_string(), "dangling".to_string(), "free".to_string()]).unwrap();
        assert_eq!(p, d.join("free"));
        assert_eq!(fs::read(d.join("important")).unwrap(), b"keep me");
        assert!(!d.join("nowhere").exists(), "a dangling link isn't made real");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn an_atomic_write_replaces_whole_and_leaves_nothing() {
        let d = temp("atomic");
        let f = d.join("a.json");
        write_atomic(&f, b"old").unwrap();
        write_atomic(&f, b"new").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"new");
        assert_eq!(names(&d), ["a.json"]);
        fs::create_dir(d.join("dir")).unwrap();
        fs::write(d.join("dir/x"), "x").unwrap();
        assert!(write_atomic(&d.join("dir"), b"over a folder").is_err());
        assert_eq!(names(&d), ["a.json", "dir"], "no temp left");
        assert!(write_atomic(&d.join("missing/a"), b"x").is_err());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_save_over_a_file_replaces_it_and_a_new_one_is_moved_in() {
        let d = temp("save");
        let f = Fake::default();
        save(&d.join("a.txt"), b"one", &f).unwrap();
        save(&d.join("a.txt"), b"two", &f).unwrap();
        assert_eq!(*f.calls.borrow(), ["move", "move"], "one rename, new name or not");
        assert_eq!(fs::read(d.join("a.txt")).unwrap(), b"two");
        assert_eq!(names(&d), ["a.txt"], "nothing else is left");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_failed_move_leaves_the_target_untouched_and_removes_the_temp() {
        let d = temp("fail");
        fs::write(d.join("a.txt"), "old").unwrap();
        assert!(save(&d.join("a.txt"), b"new", &Fake { fail: true, ..Fake::default() }).is_err());
        assert_eq!(fs::read(d.join("a.txt")).unwrap(), b"old");
        assert_eq!(names(&d), ["a.txt"], "the temp file went, after the failure");
        assert!(save(&d.join("b.txt"), b"new", &Fake { fail: true, ..Fake::default() }).is_err());
        assert_eq!(names(&d), ["a.txt"], "a new name stays absent");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_temp_file_is_made_in_the_targets_own_folder() {
        let d = temp("same-folder");
        struct Where(RefCell<Option<PathBuf>>);
        impl Swap for Where {
            fn move_in(&self, temp: &Path, target: &Path) -> io::Result<()> {
                *self.0.borrow_mut() = Some(temp.to_path_buf());
                fs::rename(temp, target)
            }
        }
        let w = Where(RefCell::new(None));
        save(&d.join("a.txt"), b"x", &w).unwrap();
        assert_eq!(w.0.borrow().as_ref().and_then(|p| p.parent().map(Path::to_path_buf)), Some(d.clone()), "one rename on one volume");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_folder_at_the_name_is_refused_with_nothing_written() {
        let d = temp("save-dir");
        fs::create_dir(d.join("a.txt")).unwrap();
        let f = Fake::default();
        assert!(save(&d.join("a.txt"), b"new", &f).unwrap_err().contains("folder"));
        assert!(f.calls.borrow().is_empty());
        assert_eq!(names(&d), ["a.txt"]);
        fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_at_the_name_is_refused_never_written_through() {
        let d = temp("save-link");
        fs::write(d.join("important"), "keep me").unwrap();
        std::os::unix::fs::symlink(d.join("important"), d.join("a.txt")).unwrap();
        std::os::unix::fs::symlink(d.join("nowhere"), d.join("b.txt")).unwrap();
        let f = Fake::default();
        assert!(save(&d.join("a.txt"), b"new", &f).unwrap_err().contains("link"));
        assert!(save(&d.join("b.txt"), b"new", &f).unwrap_err().contains("link"), "a dangling one too");
        assert!(f.calls.borrow().is_empty());
        assert_eq!(fs::read(d.join("important")).unwrap(), b"keep me");
        assert_eq!(names(&d), ["a.txt", "b.txt", "important"]);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn what_a_save_finds_at_a_name() {
        let d = temp("target");
        assert_eq!(target(&d.join("none")), Ok(Target::New));
        fs::write(d.join("f"), "").unwrap();
        assert_eq!(target(&d.join("f")), Ok(Target::File));
        assert!(target(&d).is_err());
        fs::remove_dir_all(d).unwrap();
    }
}
