//! The start records: one file per child, from its spawn until it's in its job, so a child a hard
//! kill left outside any job can be ended at the next start. This is the sweep's rule, with the OS
//! call passed in. See "5b. Starting a local MCP server" in docs/shell-design.md.
//!
//! A record is deleted only after it's been read and its process is ended (terminated, and its
//! handle signalled within a bounded wait) or proven gone. Any
//! other failure keeps it for the next start. One that can't be parsed names nothing that can be
//! ended, but might still be the only trace of a child, so it's renamed aside, never deleted.

use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// What an unparseable record is renamed to: its name and this. The sweep never reads these.
pub const ASIDE: &str = ".unreadable";

/// What the OS side came to for one record's process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Swept {
    /// Terminated, and its handle has signalled.
    Ended,
    Gone,
    Failed,
}

pub fn bytes(pid: u32, created: u64) -> Vec<u8> {
    json!({ "pid": pid, "created": created }).to_string().into_bytes()
}

pub fn parse(b: &[u8]) -> Option<(u32, u64)> {
    let v: Value = serde_json::from_slice(b).ok()?;
    let pid = u32::try_from(v.get("pid")?.as_u64()?).ok()?;
    Some((pid, v.get("created")?.as_u64()?))
}

/// What one record came to, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Its process ended, and the record deleted.
    Ended,
    /// Its process proven gone, and the record deleted.
    Gone,
    /// Kept for the next start: unreadable, or its process neither ended nor proven gone, or the
    /// delete failed. Why.
    Kept(String),
    /// Couldn't be parsed: renamed aside (or, if that failed too, kept).
    Aside { moved: bool },
}

/// Sweeps every record in `dir` with `one`, the OS call. Each record's outcome, by file name.
pub fn sweep(dir: &Path, mut one: impl FnMut(u32, u64) -> Swept) -> Vec<(String, Outcome)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.ends_with(ASIDE) {
            continue;
        }
        out.push((name, sweep_one(&path, &mut one)));
    }
    out
}

fn sweep_one(path: &Path, one: &mut impl FnMut(u32, u64) -> Swept) -> Outcome {
    let b = match fs::read(path) {
        Ok(b) => b,
        Err(e) => return Outcome::Kept(format!("unreadable: {}", kind(&e))),
    };
    let Some((pid, created)) = parse(&b) else {
        let mut aside = path.as_os_str().to_owned();
        aside.push(ASIDE);
        return Outcome::Aside { moved: fs::rename(path, PathBuf::from(aside)).is_ok() };
    };
    let done = match one(pid, created) {
        Swept::Ended => Outcome::Ended,
        Swept::Gone => Outcome::Gone,
        Swept::Failed => return Outcome::Kept(format!("process {pid} neither ended nor proven gone")),
    };
    match fs::remove_file(path) {
        Ok(()) => done,
        Err(e) => Outcome::Kept(format!("the delete failed: {}", kind(&e))),
    }
}

fn kind(e: &io::Error) -> String {
    format!("{:?}", e.kind())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shell-core-records-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_record_round_trips() {
        assert_eq!(parse(&bytes(4242, 133_000_000_000_000_000)), Some((4242, 133_000_000_000_000_000)));
        assert_eq!(parse(br#"{"pid": 4294967296, "created": 1}"#), None, "a pid past u32 is not a record");
        assert_eq!(parse(br#"{"pid": 1}"#), None);
        assert_eq!(parse(b"{\"pid\": 1, \"crea"), None);
    }

    #[test]
    fn only_a_read_record_whose_process_is_ended_or_gone_is_deleted() {
        let d = dir("rule");
        fs::write(d.join("1.json"), bytes(1, 10)).unwrap();
        fs::write(d.join("2.json"), bytes(2, 20)).unwrap();
        fs::write(d.join("3.json"), bytes(3, 30)).unwrap();
        // A partial write a hard kill cut short, and a temp file that never got its name.
        fs::write(d.join("4.json"), b"{\"pid\": 4, \"cre").unwrap();
        fs::write(d.join(".~0123456789abcdef"), bytes(5, 50)).unwrap();
        // One that can't be read at all: a folder where a record should be.
        fs::create_dir(d.join("6.json")).unwrap();
        // One already set aside is never read again.
        fs::write(d.join(format!("7.json{ASIDE}")), b"junk").unwrap();

        let mut asked = Vec::new();
        let out = sweep(&d, |pid, created| {
            asked.push((pid, created));
            match pid {
                1 => Swept::Ended,
                2 | 5 => Swept::Gone,
                _ => Swept::Failed,
            }
        });
        assert_eq!(asked, vec![(5, 50), (1, 10), (2, 20), (3, 30)], "each parsed record's own pid and time");
        let o = |n: &str| out.iter().find(|(name, _)| name == n).map(|(_, o)| o.clone()).unwrap();
        assert_eq!(o("1.json"), Outcome::Ended);
        assert_eq!(o("2.json"), Outcome::Gone);
        assert_eq!(o(".~0123456789abcdef"), Outcome::Gone, "a whole temp file is a record too");
        assert!(matches!(o("3.json"), Outcome::Kept(_)), "a process not proven gone keeps its record");
        assert_eq!(o("4.json"), Outcome::Aside { moved: true });
        assert!(matches!(o("6.json"), Outcome::Kept(_)), "an unreadable record is kept");
        assert!(!out.iter().any(|(n, _)| n.ends_with(ASIDE)));

        let mut left: Vec<String> = fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["3.json".to_string(), format!("4.json{ASIDE}"), "6.json".into(), format!("7.json{ASIDE}")]);
        assert_eq!(fs::read(d.join(format!("4.json{ASIDE}"))).unwrap(), b"{\"pid\": 4, \"cre", "set aside as it was");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn no_folder_is_nothing_to_sweep() {
        let d = dir("none").join("missing");
        assert!(sweep(&d, |_, _| panic!("nothing to ask")).is_empty());
    }
}
