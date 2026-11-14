//! The native confirms' text and their one stop. Every shown string has control and
//! bidirectional formatting characters made visible, hosts show in punycode, and labels are cut
//! and come after the fact they describe. The summary is short, the details hold the complete
//! operation. See "The native confirms" in docs/shell-design.md.

use crate::address::{Candidate, Kind, Reach};
use crate::link::Link;
use crate::setup::Canonical;

/// Labels are cut to this many characters, the ellipsis included.
pub const MAX_LABEL_CHARS: usize = 64;
/// Refusals, across every kind of ask, after which asking stops until the person re-enables it.
pub const STOP_AFTER: u32 = 3;

/// Bidirectional formatting characters, shown escaped so text can't be reordered on screen.
pub fn is_bidi(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Control and bidirectional formatting characters replaced with visible `\u{...}` escapes.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_control() || is_bidi(c) {
            out.push_str(&format!("\\u{{{:x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// A label as shown: cut to 64 characters with an ellipsis, then escaped.
pub fn label(s: &str) -> String {
    if s.chars().count() <= MAX_LABEL_CHARS {
        return escape(s);
    }
    let cut: String = s.chars().take(MAX_LABEL_CHARS - 1).collect();
    escape(&format!("{cut}…"))
}

/// One ask, as the dialog shows it. The refusing button is the default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub title: &'static str,
    pub summary: String,
    pub details: String,
    pub approve: &'static str,
    pub refuse: &'static str,
}

fn quoted(arg: &str) -> String {
    format!("\"{}\"", escape(&arg.replace('\\', "\\\\").replace('"', "\\\"")))
}

/// "Start a program?": the resolved program first, then the server's label, the arguments, the
/// folder, each plain setting and each secret's name. The details hold the canonical form, one
/// argument per line.
pub fn start_program(server_label: &str, form: &Canonical) -> Ask {
    let mut s = vec![escape(&form.program)];
    if !server_label.is_empty() {
        s.push(format!("For: {}", label(server_label)));
    }
    if form.args.is_empty() {
        s.push("No arguments".into());
    } else {
        s.push(format!("Arguments: {}", form.args.iter().map(|a| quoted(a)).collect::<Vec<_>>().join(" ")));
    }
    s.push(format!("In: {}", escape(&form.cwd)));
    for (n, v) in &form.env {
        s.push(escape(&format!("{n}={v}")));
    }
    for n in &form.secrets {
        s.push(format!("{} (kept in Credential Manager)", escape(n)));
    }
    s.push("It runs as you, with your files. Only start programs you trust.".into());

    let mut d = vec![format!("program: {}", escape(&form.program))];
    d.extend(form.args.iter().map(|a| format!("argument: {}", quoted(a))));
    d.push(format!("folder: {}", escape(&form.cwd)));
    d.extend(form.env.iter().map(|(n, v)| format!("setting: {}", escape(&format!("{n}={v}")))));
    d.extend(form.secrets.iter().map(|n| format!("secret: {}", escape(n))));
    Ask { title: "Start a program?", summary: s.join("\n"), details: d.join("\n"), approve: "Start it", refuse: "Don't start" }
}

fn ports(p: (u16, u16)) -> String {
    if p.0 == p.1 {
        format!("port {}", p.0)
    } else {
        format!("ports {} to {}", p.0, p.1)
    }
}

/// "Let Familiar send to this address?": the URL, the host on its own line in punycode, what it
/// is, and the label after them. A peer shows its label and range on one line.
pub fn add_address(c: &Candidate, address_label: &str) -> Ask {
    let n = &c.normalized;
    let mut s = vec![escape(&n.url), escape(&n.host)];
    let place = match n.reach {
        Some(Reach::Lan) => " on your own network",
        Some(Reach::Loopback) => " on this PC",
        _ => "",
    };
    match (c.identity.kind, c.identity.ports) {
        (Kind::Peer, Some(p)) => {
            let who = if address_label.is_empty() { "An app".to_string() } else { label(address_label) };
            s.push(format!("{who} on this PC, {}", ports(p)));
        }
        (kind, _) => {
            let what = if kind == Kind::Model { "A model endpoint" } else { "An MCP server" };
            s.push(format!("{what}{place}"));
            if !address_label.is_empty() {
                s.push(format!("Named: {}", label(address_label)));
            }
        }
    }
    let mut d = vec![format!("kind: {}", c.identity.kind.as_str()), format!("url: {}", escape(&n.url))];
    if let Some(p) = c.identity.ports {
        d.push(format!("ports: {} to {}", p.0, p.1));
    }
    d.push(match n.reach {
        Some(r) => format!("reach: {}", r.as_str()),
        None => "reach: found by one lookup, only after you allow it".into(),
    });
    if !address_label.is_empty() {
        d.push(format!("label: {}", escape(address_label)));
    }
    Ask {
        title: "Let Familiar send to this address?",
        summary: s.join("\n"),
        details: d.join("\n"),
        approve: "Allow",
        refuse: "Don't allow",
    }
}

/// "Open this link?": the host on its own line in punycode, the full URL in the details.
pub fn open_link(link: &Link) -> Ask {
    Ask {
        title: "Open this link?",
        summary: format!("{}\nIt opens in your browser.", escape(&link.host)),
        details: escape(&link.url),
        approve: "Open",
        refuse: "Don't open",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// A confirm is already open.
    Busy,
    /// Three refusals since the run started or since the person last re-enabled asking.
    AsksStopped,
}

impl Refused {
    pub fn kind(self) -> &'static str {
        match self {
            Refused::Busy => "busy",
            Refused::AsksStopped => "asks-stopped",
        }
    }
}

/// One at a time, and a stop after three refusals across every kind of ask. Only the exe's
/// own tray item calls `reenable`.
#[derive(Debug, Default)]
pub struct Throttle {
    refusals: u32,
    open: bool,
}

impl Throttle {
    /// Before showing a dialog, and before anything else an ask would do (a lookup included).
    pub fn begin(&mut self) -> Result<(), Refused> {
        if self.stopped() {
            return Err(Refused::AsksStopped);
        }
        if self.open {
            return Err(Refused::Busy);
        }
        self.open = true;
        Ok(())
    }

    /// When the dialog returns. A close or an error counts as a refusal.
    pub fn end(&mut self, approved: bool) {
        self.open = false;
        if !approved {
            self.refusals += 1;
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Whether asking has stopped, and the tray shows "Let Familiar ask again".
    pub fn stopped(&self) -> bool {
        self.refusals >= STOP_AFTER
    }

    pub fn reenable(&mut self) {
        self.refusals = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::address::check_add;
    use crate::setup::Setup;

    #[test]
    fn controls_and_bidi_are_escaped() {
        assert_eq!(escape("plain café 日本"), "plain café 日本");
        assert_eq!(escape("a\nb\tc\rd\0e\u{7f}\u{85}"), "a\\u{a}b\\u{9}c\\u{d}d\\u{0}e\\u{7f}\\u{85}");
        for c in ['\u{200E}', '\u{200F}', '\u{061C}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}'] {
            assert_eq!(escape(&format!("x{c}y")), format!("x\\u{{{:x}}}y", c as u32), "{:x}", c as u32);
        }
        assert_eq!(escape("evil\u{202E}exe.txt"), "evil\\u{202e}exe.txt");
        for c in ['\u{2029}', '\u{2065}', '\u{206A}', '\u{2010}'] {
            assert_eq!(escape(&c.to_string()), c.to_string(), "{:x} isn't on the list", c as u32);
        }
    }

    #[test]
    fn labels_are_cut_then_escaped() {
        assert_eq!(label(&"a".repeat(64)), "a".repeat(64));
        assert_eq!(label(&"a".repeat(65)), format!("{}…", "a".repeat(63)));
        assert_eq!(label(&"日".repeat(100)).chars().count(), 64, "characters, not bytes");
        assert_eq!(label(&format!("{}\u{202E}", "a".repeat(70))), format!("{}…", "a".repeat(63)));
        assert_eq!(label("x\u{202E}y"), "x\\u{202e}y");
    }

    fn form() -> Canonical {
        let setup = Setup {
            id: "s1".into(),
            label: "Fake".into(),
            program: "node".into(),
            args: vec!["main.ts".into(), "two words".into(), "say \"hi\"".into(), "a\u{202E}b".into()],
            cwd: "C:\\work".into(),
            env: vec![("LOG_LEVEL".into(), "debug".into())],
            secrets: vec!["FAKE_SECRET".into()],
        };
        Canonical::new(&setup, "C:\\node\\node.exe")
    }

    #[test]
    fn starting_a_program() {
        let ask = start_program(&format!("Fake server{}", "!".repeat(80)), &form());
        assert_eq!(ask.title, "Start a program?");
        assert_eq!((ask.approve, ask.refuse), ("Start it", "Don't start"));
        let lines: Vec<&str> = ask.summary.lines().collect();
        assert_eq!(lines[0], "C:\\node\\node.exe", "the program comes first, before any label");
        assert!(lines[1].starts_with("For: Fake server!") && lines[1].ends_with('…'));
        assert_eq!(lines[2], "Arguments: \"main.ts\" \"two words\" \"say \\\"hi\\\"\" \"a\\u{202e}b\"");
        assert_eq!(lines[3], "In: C:\\work");
        assert_eq!(lines[4], "LOG_LEVEL=debug");
        assert_eq!(lines[5], "FAKE_SECRET (kept in Credential Manager)");
        assert_eq!(lines[6], "It runs as you, with your files. Only start programs you trust.");
        assert_eq!(
            ask.details,
            [
                "program: C:\\node\\node.exe",
                "argument: \"main.ts\"",
                "argument: \"two words\"",
                "argument: \"say \\\"hi\\\"\"",
                "argument: \"a\\u{202e}b\"",
                "folder: C:\\work",
                "setting: LOG_LEVEL=debug",
                "secret: FAKE_SECRET",
            ]
            .join("\n")
        );
        let mut empty = form();
        empty.args.clear();
        assert!(start_program("", &empty).summary.lines().nth(1) == Some("No arguments"));
    }

    #[test]
    fn arguments_cant_hide_in_the_details() {
        // An argument with a newline is refused by the setup rules, but even so it shows escaped.
        let mut f = form();
        f.args = vec!["a\nprogram: C:\\other.exe".into()];
        let ask = start_program("", &f);
        assert_eq!(ask.details.lines().filter(|l| l.starts_with("program:")).count(), 1);
        assert!(ask.details.contains("\\u{a}program"));
    }

    #[test]
    fn adding_addresses() {
        let c = check_add(Kind::Model, "https://bücher.example/v1", "", None).unwrap();
        let ask = add_address(&c, "My \u{202E}provider");
        assert_eq!(ask.title, "Let Familiar send to this address?");
        assert_eq!((ask.approve, ask.refuse), ("Allow", "Don't allow"));
        assert_eq!(ask.summary, "https://xn--bcher-kva.example/v1\nxn--bcher-kva.example\nA model endpoint\nNamed: My \\u{202e}provider");
        assert_eq!(
            ask.details,
            "kind: model\nurl: https://xn--bcher-kva.example/v1\nreach: found by one lookup, only after you allow it\nlabel: My \\u{202e}provider"
        );
        let lan = check_add(Kind::Server, "http://192.168.1.5:8000/mcp", "", None).unwrap();
        assert_eq!(add_address(&lan, "").summary, "http://192.168.1.5:8000/mcp\n192.168.1.5\nAn MCP server on your own network");
        let lo = check_add(Kind::Model, "http://localhost:11434", "", None).unwrap();
        assert_eq!(add_address(&lo, "").summary.lines().nth(2), Some("A model endpoint on this PC"));
        let peer = check_add(Kind::Peer, "ws://127.0.0.1", "", Some((47110, 47114))).unwrap();
        let ask = add_address(&peer, "Buddies");
        assert_eq!(ask.summary.lines().nth(2), Some("Buddies on this PC, ports 47110 to 47114"));
        assert!(ask.details.contains("ports: 47110 to 47114") && ask.details.contains("reach: loopback"));
        let one = check_add(Kind::Peer, "ws://127.0.0.1", "", Some((47110, 47110))).unwrap();
        assert_eq!(add_address(&one, "").summary.lines().nth(2), Some("An app on this PC, port 47110"));
    }

    #[test]
    fn opening_links() {
        let link = crate::link::check("https://bücher.example/a?b=c").unwrap();
        let ask = open_link(&link);
        assert_eq!(ask.title, "Open this link?");
        assert_eq!((ask.approve, ask.refuse), ("Open", "Don't open"));
        assert_eq!(ask.summary, "xn--bcher-kva.example\nIt opens in your browser.");
        assert_eq!(ask.details, "https://xn--bcher-kva.example/a?b=c");
    }

    #[test]
    fn one_at_a_time_and_a_stop_after_three_refusals() {
        let mut t = Throttle::default();
        assert_eq!(t.begin(), Ok(()));
        assert_eq!(t.begin(), Err(Refused::Busy));
        t.end(true);
        for _ in 0..2 {
            t.begin().unwrap();
            t.end(false);
        }
        assert!(!t.stopped());
        // Approvals don't reset the count.
        t.begin().unwrap();
        t.end(true);
        t.begin().unwrap();
        t.end(false);
        assert!(t.stopped());
        assert_eq!(t.begin(), Err(Refused::AsksStopped));
        assert_eq!(t.begin(), Err(Refused::AsksStopped));
        assert!(!t.is_open());
        t.reenable();
        assert_eq!(t.begin(), Ok(()));
        assert_eq!(Refused::Busy.kind(), "busy");
        assert_eq!(Refused::AsksStopped.kind(), "asks-stopped");
    }
}
