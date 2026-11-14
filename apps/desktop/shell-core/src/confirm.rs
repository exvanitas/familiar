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

/// Characters that show as nothing, or reorder or hide what's next to them: soft hyphens,
/// joiners, fillers, variation selectors, bidirectional formatting, line and paragraph
/// separators, tag characters and the rest. Each is shown as a visible `\u{...}` escape, as is
/// every control character.
pub const INVISIBLE: [(char, char); 16] = [
    ('\u{00AD}', '\u{00AD}'),
    ('\u{034F}', '\u{034F}'),
    ('\u{061C}', '\u{061C}'),
    ('\u{115F}', '\u{1160}'),
    ('\u{17B4}', '\u{17B5}'),
    ('\u{180B}', '\u{180F}'),
    ('\u{200B}', '\u{200F}'),
    ('\u{2028}', '\u{202E}'),
    ('\u{2060}', '\u{206F}'),
    ('\u{3164}', '\u{3164}'),
    ('\u{FE00}', '\u{FE0F}'),
    ('\u{FEFF}', '\u{FEFF}'),
    ('\u{FFA0}', '\u{FFA0}'),
    ('\u{FFF9}', '\u{FFFB}'),
    ('\u{1D173}', '\u{1D17A}'),
    ('\u{E0000}', '\u{E0FFF}'),
];

/// A character the confirms never show as it is: a control character or one in `INVISIBLE`.
pub fn hidden(c: char) -> bool {
    c.is_control() || INVISIBLE.iter().any(|&(lo, hi)| (lo..=hi).contains(&c))
}

/// Free text as shown: arguments, setting values, labels, hosts and URLs. A literal backslash is
/// doubled, then each hidden character becomes a `\u{...}` escape, so the shown text reads back
/// one way only. Paths and names never need it: server paths refuse hidden characters, and
/// setting names are plain ASCII, so they show as they are.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' {
            out.push_str("\\\\");
        } else if hidden(c) {
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

/// An argument in quotes. After `escape` every literal backslash is doubled, so `\"` can only
/// be a quote from the argument.
fn quoted(arg: &str) -> String {
    format!("\"{}\"", escape(arg).replace('"', "\\\""))
}

/// "Start a program?": the resolved program first, then the server's label, the arguments, the
/// folder, each plain setting and each secret's name. The details hold the canonical form, one
/// argument per line.
pub fn start_program(server_label: &str, form: &Canonical) -> Ask {
    // The program and the folder passed the path checks, which refuse every hidden character,
    // and names are plain ASCII: all of them show as they are.
    let mut s = vec![form.program.clone()];
    if !server_label.is_empty() {
        s.push(format!("For: {}", label(server_label)));
    }
    if form.args.is_empty() {
        s.push("No arguments".into());
    } else {
        s.push(format!("Arguments: {}", form.args.iter().map(|a| quoted(a)).collect::<Vec<_>>().join(" ")));
    }
    s.push(format!("In: {}", form.cwd));
    for (n, v) in &form.env {
        s.push(format!("{n}={}", escape(v)));
    }
    for n in &form.secrets {
        s.push(format!("{n} (kept in Credential Manager)"));
    }
    s.push("It runs as you, with your files. Only start programs you trust.".into());

    let mut d = vec![format!("program: {}", form.program)];
    d.extend(form.args.iter().map(|a| format!("argument: {}", quoted(a))));
    d.push(format!("folder: {}", form.cwd));
    d.extend(form.env.iter().map(|(n, v)| format!("setting: {n}={}", escape(v))));
    d.extend(form.secrets.iter().map(|n| format!("secret: {n}")));
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
        for c in ['\u{2010}', '\u{2027}', '\u{2070}', '\u{1D172}', '\u{1D17B}', '\u{E1000}', '\u{FFFC}', 'é'] {
            assert_eq!(escape(&c.to_string()), c.to_string(), "{:x} isn't on the list", c as u32);
        }
        // Every range, at both ends, and the review's zero-width space in a program path.
        for &(lo, hi) in INVISIBLE.iter() {
            for c in [lo, hi] {
                assert_eq!(escape(&format!("a{c}b")), format!("a\\u{{{:x}}}b", c as u32));
            }
        }
        assert_eq!(escape("safe\u{200B}.exe"), "safe\\u{200b}.exe");
        for c in ['\u{00AD}', '\u{034F}', '\u{115F}', '\u{1160}', '\u{17B4}', '\u{180E}', '\u{2028}', '\u{2029}', '\u{2060}', '\u{2064}', '\u{206F}', '\u{3164}', '\u{FE0F}', '\u{FEFF}', '\u{FFA0}', '\u{FFFA}', '\u{1D175}', '\u{E0001}', '\u{E007F}'] {
            assert!(hidden(c), "{:x}", c as u32);
        }
    }

    #[test]
    fn backslashes_are_doubled_so_escapes_read_back_one_way() {
        assert_eq!(escape("x\ny"), "x\\u{a}y");
        assert_eq!(escape("x\\u{a}y"), "x\\\\u{a}y", "a typed escape isn't an escape");
        assert_ne!(escape("x\ny"), escape("x\\u{a}y"));
        assert_eq!(escape("C:\\x"), "C:\\\\x");
        assert_eq!(quoted("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    /// The details, read back: every literal backslash doubled, quotes in arguments as `\"`,
    /// and every hidden character as `\u{...}`. If this gives back the operation, no two
    /// operations can show the same details.
    fn read_back(details: &str) -> Canonical {
        fn unescape(t: &str) -> String {
            let mut out = String::new();
            let mut it = t.chars().peekable();
            while let Some(c) = it.next() {
                if c != '\\' {
                    out.push(c);
                    continue;
                }
                match it.next() {
                    Some('\\') => out.push('\\'),
                    Some('"') => out.push('"'),
                    Some('u') => {
                        assert_eq!(it.next(), Some('{'));
                        let hex: String = it.by_ref().take_while(|&c| c != '}').collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
                    }
                    other => panic!("a lone backslash before {other:?} in {t:?}"),
                }
            }
            out
        }
        let mut f = Canonical { program: String::new(), args: vec![], cwd: String::new(), env: vec![], secrets: vec![] };
        for line in details.split('\n') {
            let (k, v) = line.split_once(": ").unwrap();
            match k {
                "program" => f.program = v.to_string(),
                "folder" => f.cwd = v.to_string(),
                "argument" => f.args.push(unescape(&v[1..v.len() - 1])),
                "setting" => {
                    let (n, val) = v.split_once('=').unwrap();
                    f.env.push((n.to_string(), unescape(val)));
                }
                "secret" => f.secrets.push(v.to_string()),
                _ => panic!("{line}"),
            }
        }
        f
    }

    #[test]
    fn no_two_operations_show_the_same_details() {
        fn next(x: &mut u64, n: u64) -> u64 {
            *x ^= *x << 13;
            *x ^= *x >> 7;
            *x ^= *x << 17;
            *x % n
        }
        let alphabet = ['a', '\\', '"', 'u', '{', '}', '\n', '=', ' ', ':', '\u{200b}', '0', '\u{202e}'];
        let text = |x: &mut u64| -> String {
            let n = next(x, 5);
            (0..n).map(|_| alphabet[next(x, alphabet.len() as u64) as usize]).collect()
        };
        let mut x: u64 = 0x1234_5678_9abc_def1;
        let mut seen = std::collections::HashMap::new();
        for _ in 0..20_000 {
            let program = ["C:\\a\\x.exe", "C:\\b\\x.exe"][next(&mut x, 2) as usize].to_string();
            let args = (0..next(&mut x, 3)).map(|_| text(&mut x)).collect();
            let cwd = ["C:\\w", "C:\\w\\v"][next(&mut x, 2) as usize].to_string();
            let env = (0..next(&mut x, 3)).map(|i| (["A", "B", "A_B"][i as usize].to_string(), text(&mut x))).collect();
            let secrets = (0..next(&mut x, 2)).map(|_| "S".to_string()).collect();
            let f = Canonical { program, args, cwd, env, secrets };
            let details = start_program("", &f).details;
            assert_eq!(read_back(&details), f, "{details}");
            if let Some(other) = seen.insert(details.clone(), f.clone()) {
                assert_eq!(other, f, "two operations show {details:?}");
            }
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
