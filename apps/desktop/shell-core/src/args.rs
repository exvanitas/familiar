//! The exe's own flags. Everything else reaches the app untouched, through `shell_info`.

use std::path::PathBuf;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub app_dir: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub log: Option<PathBuf>,
    pub seconds: Option<u64>,
    pub devtools: bool,
    /// Set by the Run entry, so a sign-in start can stay in the tray.
    pub autostart: bool,
    /// Every argument, flags included.
    pub raw: Vec<String>,
}

/// The exe's own flags.
pub const FLAGS: [&str; 6] = ["--app-dir", "--data-dir", "--log", "--seconds", "--devtools", "--autostart"];

impl Args {
    pub fn parse(raw: Vec<String>) -> Args {
        let mut a = Args::default();
        let mut it = raw.iter();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--app-dir" => a.app_dir = it.next().map(PathBuf::from),
                "--data-dir" => a.data_dir = it.next().map(PathBuf::from),
                "--log" => a.log = it.next().map(PathBuf::from),
                "--seconds" => a.seconds = it.next().and_then(|v| v.parse().ok()),
                "--devtools" => a.devtools = true,
                "--autostart" => a.autostart = true,
                _ => {}
            }
        }
        a.raw = raw;
        a
    }

    /// What a second launch puts in the log: a count, and which of the exe's flags were there.
    /// Never a value: arguments can hold paths, text, anything.
    pub fn summary(&self) -> String {
        let flags: Vec<&str> = FLAGS.iter().copied().filter(|f| self.raw.iter().any(|a| a == f)).collect();
        let flags = if flags.is_empty() { "none".to_string() } else { flags.join(" ") };
        format!("args {}, flags {flags}", self.raw.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Args {
        Args::parse(s.split_whitespace().map(String::from).collect())
    }

    #[test]
    fn flags() {
        let a = parse("--app-dir A --data-dir D --log L --seconds 30 --devtools --autostart");
        assert_eq!(a.app_dir, Some("A".into()));
        assert_eq!(a.data_dir, Some("D".into()));
        assert_eq!(a.log, Some("L".into()));
        assert_eq!(a.seconds, Some(30));
        assert!(a.devtools && a.autostart);
    }

    #[test]
    fn nothing_is_on_unless_asked() {
        assert_eq!(parse(""), Args::default());
        assert_eq!(parse("--seconds nope").seconds, None);
        assert_eq!(parse("--seconds").seconds, None);
        assert_eq!(parse("--seconds -5").seconds, None);
    }

    #[test]
    fn the_rest_reaches_the_app() {
        let a = parse("--phase main --seconds 5 extra");
        assert_eq!(a.raw, ["--phase", "main", "--seconds", "5", "extra"]);
    }

    #[test]
    fn a_summary_has_counts_and_flags_never_values() {
        let a = parse("--say {\"x\":\"hidden\"} --data-dir C:\\Users\\x\\private --devtools --seconds 5");
        let s = a.summary();
        assert_eq!(s, "args 7, flags --data-dir --seconds --devtools");
        for v in ["hidden", "Users", "private", "5", "--say"] {
            assert!(!s.contains(v), "{v} leaked into {s:?}");
        }
        assert_eq!(parse("").summary(), "args 0, flags none");
        assert_eq!(parse("--log=x --LOG").summary(), "args 2, flags none", "only exact flags");
    }
}
