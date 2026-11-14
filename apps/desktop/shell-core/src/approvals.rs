//! The approved server setups, `shell\servers.json`, which only the exe writes. A setup starts
//! with no dialog only when its canonical form equals the stored one. If the file can't be read,
//! nothing counts as approved. See "The approval" in "5b. Starting a local MCP server".

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::setup::Canonical;

pub const FILE: &str = "servers.json";
/// What an unreadable file is renamed to, beside it, so it is kept but never read.
pub const ASIDE: &str = "servers.json.unreadable";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Store {
    pub v: u32,
    /// Setup id to the canonical form the person approved.
    pub servers: BTreeMap<String, Canonical>,
}

/// What reading the file found.
#[derive(Debug, PartialEq, Eq)]
pub enum Load {
    /// No file: nothing approved yet.
    Empty,
    Read(Store),
    /// A file that isn't a store: rename it aside, log it, and treat every setup as new.
    Unreadable,
}

impl Store {
    pub fn load(bytes: Option<&[u8]>) -> Load {
        let Some(bytes) = bytes else { return Load::Empty };
        match serde_json::from_slice::<Store>(bytes) {
            Ok(s) if s.v == 1 && s.servers.keys().all(|k| crate::setup::valid_id(k)) => Load::Read(s),
            _ => Load::Unreadable,
        }
    }

    pub fn new() -> Store {
        Store { v: 1, servers: BTreeMap::new() }
    }

    /// Whether this exact form is approved for this setup.
    pub fn approved(&self, id: &str, form: &Canonical) -> bool {
        self.servers.get(id) == Some(form)
    }

    pub fn approve(&mut self, id: &str, form: Canonical) {
        self.servers.insert(id.to_string(), form);
    }

    /// Whether there was an approval to remove.
    pub fn forget(&mut self, id: &str) -> bool {
        self.servers.remove(id).is_some()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).expect("plain strings serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(arg: &str) -> Canonical {
        Canonical {
            program: "C:\\n\\node.exe".into(),
            program_target: "C:\\n\\node.exe".into(),
            args: vec![arg.into()],
            cwd: "C:\\w".into(),
            cwd_target: "C:\\w".into(),
            env: vec![("A".into(), "1".into())],
            secrets: vec!["S".into()],
        }
    }

    #[test]
    fn round_trip_and_exact_match() {
        let mut s = Store::new();
        assert!(!s.approved("s1", &form("a")));
        s.approve("s1", form("a"));
        assert!(s.approved("s1", &form("a")));
        assert!(!s.approved("s1", &form("b")), "a changed argument asks again");
        assert!(!s.approved("s2", &form("a")), "approval is per setup id");
        let back = Store::load(Some(&s.to_bytes()));
        assert_eq!(back, Load::Read(s.clone()));
        assert!(s.forget("s1"));
        assert!(!s.forget("s1"));
    }

    #[test]
    fn anything_unreadable_approves_nothing() {
        assert_eq!(Store::load(None), Load::Empty);
        for bad in [&b"garbage"[..], b"", b"{}", b"{\"v\":2,\"servers\":{}}", b"{\"v\":1,\"servers\":{\"a b\":null}}", b"[1,2]", b"{\"v\":1,\"servers\":{\"s\":{\"program\":1}}}"] {
            assert_eq!(Store::load(Some(bad)), Load::Unreadable, "{}", String::from_utf8_lossy(bad));
        }
        assert_eq!(Store::load(Some(b"{\"v\":1,\"servers\":{}}")), Load::Read(Store::new()));
    }
}
