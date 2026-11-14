//! A local MCP server's setup: its shape and limits, the setting rules, the form an approval
//! binds, the environment it starts with, and how its output becomes lines. See "5b. Starting a
//! local MCP server" in docs/shell-design.md. Paths and program lookup are in `server_path`.

use serde::{Deserialize, Serialize};

use crate::redact;

pub const MAX_ARGS: usize = 64;
pub const MAX_SETTINGS: usize = 32;
pub const MAX_SECRETS: usize = 32;
/// The whole setup, measured as its JSON.
pub const MAX_SETUP_BYTES: usize = 8 * 1024;
/// A setup id: the part of `server:<setupId>:<NAME>` before the name.
pub const MAX_ID: usize = 64;
/// A stdout line longer than this is dropped, with an `err` event saying so.
pub const MAX_STDOUT_LINE: usize = 4 * 1024 * 1024;
/// A stderr line is cut to this.
pub const MAX_STDERR_LINE: usize = 8 * 1024;
/// Most bytes one `server_write` may send to stdin.
pub const MAX_WRITE: usize = 4 * 1024 * 1024;
/// Servers running at once.
pub const MAX_RUNNING: usize = 16;

/// The variables a server inherits from Familiar, from the mcp-start spike. Nothing else of
/// Familiar's environment reaches it.
pub const ENV_ALLOWLIST: [&str; 22] = [
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "Path",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USERNAME",
];

/// Settings that change what runs, which can't be secrets (defence in depth, never complete).
/// As plain settings they're allowed, and their values are in the approval.
pub const UNSAFE_SECRETS: [&str; 24] = [
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXEC_PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "DOTNET_STARTUP_HOOKS",
];

/// Prefixes of names that can't be secrets either.
pub const UNSAFE_SECRET_PREFIXES: [&str; 5] = ["NPM_CONFIG_", "UV_", "PIP_", "COR_", "CORECLR_"];

/// What a page sends to `server_start`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setup {
    pub id: String,
    pub label: String,
    /// A bare name to look up on PATH, or a full local path.
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Plain settings, with their values.
    pub env: Vec<(String, String)>,
    /// Names of settings whose values live in Credential Manager as `server:<id>:<NAME>`.
    pub secrets: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupError {
    Invalid,
    TooLarge,
    UnsafeArgument,
    DuplicateSetting,
    UnsafeSecret,
}

impl SetupError {
    pub fn kind(self) -> &'static str {
        match self {
            SetupError::Invalid => "invalid",
            SetupError::TooLarge => "too-large",
            SetupError::UnsafeArgument => "unsafe-argument",
            SetupError::DuplicateSetting => "duplicate-setting",
            SetupError::UnsafeSecret => "unsafe-secret",
        }
    }
}

/// A plain id: what setup ids and address ids may hold, so a ref splits one way only.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A setting name as Windows compares them: each character upper-cased on its own, as
/// Windows' simple case mapping does, so `node_options` and `NODE_OPTIONS` are one name.
pub fn fold(name: &str) -> String {
    name.chars()
        .map(|c| {
            let mut up = c.to_uppercase();
            match (up.next(), up.next()) {
                (Some(u), None) => u,
                _ => c, // a character that upper-cases to more than one keeps itself
            }
        })
        .collect()
}

/// A setting name: not empty, no `=`, no NUL, and no other control character.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && !name.contains('=') && !name.chars().any(char::is_control)
}

/// Whether a name may not be a secret.
pub fn unsafe_secret(name: &str) -> bool {
    let up = fold(name);
    UNSAFE_SECRETS.contains(&up.as_str()) || UNSAFE_SECRET_PREFIXES.iter().any(|p| up.starts_with(p))
}

/// Every rule a setup must meet before anything else looks at it. Paths are checked apart,
/// by `server_path`, before any file is touched.
pub fn check(setup: &Setup) -> Result<(), SetupError> {
    if !valid_id(&setup.id) {
        return Err(SetupError::Invalid);
    }
    if setup.args.len() > MAX_ARGS || setup.env.len() > MAX_SETTINGS || setup.secrets.len() > MAX_SECRETS {
        return Err(SetupError::TooLarge);
    }
    if serde_json::to_vec(setup).map_or(usize::MAX, |v| v.len()) > MAX_SETUP_BYTES {
        return Err(SetupError::TooLarge);
    }
    if setup.program.is_empty() || setup.cwd.is_empty() || setup.label.chars().any(|c| c == '\0') {
        return Err(SetupError::Invalid);
    }
    // std refuses these only for .cmd and .bat. Refused for every program, so one setup
    // doesn't work with node and fail with npx.
    if setup.args.iter().any(|a| a.contains(['\0', '\r', '\n'])) {
        return Err(SetupError::UnsafeArgument);
    }
    let mut seen: Vec<String> = Vec::new();
    for (name, value) in &setup.env {
        if !valid_name(name) || value.contains('\0') {
            return Err(SetupError::Invalid);
        }
        seen.push(fold(name));
    }
    for name in &setup.secrets {
        if !valid_name(name) {
            return Err(SetupError::Invalid);
        }
        seen.push(fold(name));
    }
    let mut sorted = seen.clone();
    sorted.sort();
    if sorted.windows(2).any(|w| w[0] == w[1]) {
        return Err(SetupError::DuplicateSetting);
    }
    if setup.secrets.iter().any(|n| unsafe_secret(n)) {
        return Err(SetupError::UnsafeSecret);
    }
    Ok(())
}

/// What an approval binds: the resolved program, the arguments, the folder, the plain settings
/// with their values, and the secret names. Never a secret's value, so a renewed token doesn't
/// ask again. Settings and secret names are sorted, so their order doesn't matter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Canonical {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub secrets: Vec<String>,
}

impl Canonical {
    pub fn new(setup: &Setup, resolved_program: &str) -> Canonical {
        let mut env = setup.env.clone();
        env.sort_by(|a, b| fold(&a.0).cmp(&fold(&b.0)).then(a.0.cmp(&b.0)));
        let mut secrets = setup.secrets.clone();
        secrets.sort_by(|a, b| fold(a).cmp(&fold(b)).then(a.cmp(b)));
        Canonical { program: resolved_program.to_string(), args: setup.args.clone(), cwd: setup.cwd.clone(), env, secrets }
    }

    /// The form stored in `servers.json` and compared at each start.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("plain strings serialize")
    }
}

/// The environment a server starts with, in order: the allowlisted names Familiar's own
/// environment has (in the allowlist's spelling), then the plain settings, then the secrets.
/// A later name replaces an earlier one that differs only in case.
pub fn environment<'a>(
    parent: impl IntoIterator<Item = (&'a str, &'a str)>,
    setup: &Setup,
    secret_values: &[(String, String)],
) -> Vec<(String, String)> {
    let parent: Vec<(&str, &str)> = parent.into_iter().collect();
    let mut env: Vec<(String, String)> = Vec::new();
    let mut put = |name: &str, value: &str| {
        let key = fold(name);
        env.retain(|(n, _)| fold(n) != key);
        env.push((name.to_string(), value.to_string()));
    };
    for allowed in ENV_ALLOWLIST {
        if let Some((_, v)) = parent.iter().find(|(k, _)| fold(k) == fold(allowed)) {
            put(allowed, v);
        }
    }
    for (k, v) in &setup.env {
        put(k, v);
    }
    for name in &setup.secrets {
        if let Some((_, v)) = secret_values.iter().find(|(n, _)| fold(n) == fold(name)) {
            put(name, v);
        }
    }
    env
}

/// One thing a server printed, as it goes to core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Out(String),
    Err(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Turns a stream's bytes into lines with every secret of the setup blanked, before anything
/// leaves Rust. stdout: a line over 4 MiB is dropped and an `err` event says so. stderr: a line
/// is cut at 8 KiB, after blanking, so a secret across the cut isn't left half shown.
pub struct Lines {
    stream: Stream,
    secrets: Vec<Vec<u8>>,
    buf: Vec<u8>,
    /// Bytes kept of the current line before it is blanked.
    keep: usize,
    /// The current line went past what is kept: dropped (stdout) or cut (stderr).
    over: bool,
}

impl Lines {
    pub fn new<S: AsRef<[u8]>>(stream: Stream, secrets: &[S]) -> Lines {
        let secrets: Vec<Vec<u8>> = secrets.iter().map(|s| s.as_ref().to_vec()).collect();
        let longest = secrets.iter().map(Vec::len).max().unwrap_or(0);
        let keep = match stream {
            Stream::Stdout => MAX_STDOUT_LINE,
            Stream::Stderr => MAX_STDERR_LINE + longest,
        };
        Lines { stream, secrets, buf: Vec::new(), keep, over: false }
    }

    pub fn feed(&mut self, mut bytes: &[u8]) -> Vec<Event> {
        let mut out = Vec::new();
        while !bytes.is_empty() {
            match bytes.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    self.take(&bytes[..i]);
                    out.extend(self.end_line());
                    bytes = &bytes[i + 1..];
                }
                None => {
                    self.take(bytes);
                    bytes = &[];
                }
            }
        }
        out
    }

    /// The stream closed: a last line with no newline still counts.
    pub fn finish(&mut self) -> Vec<Event> {
        if self.buf.is_empty() && !self.over {
            return Vec::new();
        }
        self.end_line().into_iter().collect()
    }

    fn take(&mut self, part: &[u8]) {
        let room = self.keep.saturating_sub(self.buf.len());
        if part.len() > room {
            self.over = true;
        }
        self.buf.extend_from_slice(&part[..part.len().min(room)]);
    }

    fn end_line(&mut self) -> Option<Event> {
        let mut line = std::mem::take(&mut self.buf);
        let over = std::mem::replace(&mut self.over, false);
        if line.last() == Some(&b'\r') && !over {
            line.pop();
        }
        match self.stream {
            Stream::Stdout if over => Some(Event::Err(format!("a stdout line over {} MiB was dropped", MAX_STDOUT_LINE >> 20))),
            Stream::Stdout => Some(Event::Out(text(&redact::blank_line(&line, &self.secrets)))),
            Stream::Stderr => {
                let blanked = redact::blank_line(&line, &self.secrets);
                let cut = blanked.len() > MAX_STDERR_LINE || over;
                let mut t = text(&blanked[..blanked.len().min(MAX_STDERR_LINE)]);
                if cut {
                    t = t.trim_end_matches('\u{FFFD}').to_string();
                    t.push('…');
                }
                Some(Event::Err(t))
            }
        }
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Setup {
        Setup {
            id: "fake-1".into(),
            label: "Fake server".into(),
            program: "node".into(),
            args: vec!["main.ts".into(), "--variant".into(), "a".into()],
            cwd: "C:\\work".into(),
            env: vec![("LOG_LEVEL".into(), "debug".into())],
            secrets: vec!["FAKE_SECRET".into()],
        }
    }

    fn val(tag: &str) -> String {
        format!("v{}{}", tag, "-x".repeat(6))
    }

    #[test]
    fn a_plain_setup_passes() {
        assert_eq!(check(&setup()), Ok(()));
    }

    #[test]
    fn limits() {
        let mut s = setup();
        s.args = vec!["a".into(); MAX_ARGS];
        assert_eq!(check(&s), Ok(()));
        s.args.push("a".into());
        assert_eq!(check(&s), Err(SetupError::TooLarge));
        let mut s = setup();
        s.secrets.clear();
        s.env = (0..MAX_SETTINGS).map(|i| (format!("N{i}"), "v".into())).collect();
        assert_eq!(check(&s), Ok(()));
        s.env.push(("MORE".into(), "v".into()));
        assert_eq!(check(&s), Err(SetupError::TooLarge));
        let mut s = setup();
        s.secrets = (0..MAX_SECRETS).map(|i| format!("S{i}")).collect();
        assert_eq!(check(&s), Ok(()));
        s.secrets.push("ONE_MORE".into());
        assert_eq!(check(&s), Err(SetupError::TooLarge));
        let mut s = setup();
        s.args = vec!["x".repeat(4000), "y".repeat(4000)];
        assert_eq!(check(&s), Ok(()));
        s.args.push("z".repeat(200));
        assert_eq!(check(&s), Err(SetupError::TooLarge), "8 KiB for the whole setup");
    }

    #[test]
    fn nul_cr_and_lf_in_arguments_are_refused_for_every_program() {
        for program in ["node", "npx", "C:\\tools\\x.exe", "C:\\tools\\x.cmd", "run.bat"] {
            for bad in ["a\nb", "a\rb", "a\0b", "\n", "trailing\r\n"] {
                let mut s = setup();
                s.program = program.into();
                s.args.push(bad.into());
                assert_eq!(check(&s), Err(SetupError::UnsafeArgument), "{program} {bad:?}");
            }
        }
        // The spike's tricky arguments are fine.
        let mut s = setup();
        s.args = ["say \"hi\" now", "\"", "%PATH%", "100%", "!PATH!", "a&b", "a^b", "a|b", "a<b", "(x)", "C:\\some dir\\", "", "café ü 日本", "\t"]
            .map(String::from)
            .to_vec();
        assert_eq!(check(&s), Ok(()));
    }

    #[test]
    fn setting_names_are_case_insensitive() {
        let mut s = setup();
        s.env = vec![("node_options".into(), "a".into()), ("NODE_OPTIONS".into(), "b".into())];
        assert_eq!(check(&s), Err(SetupError::DuplicateSetting));
        let mut s = setup();
        s.secrets = vec!["fake_secret".into()];
        s.env = vec![("FAKE_SECRET".into(), "plain".into())];
        assert_eq!(check(&s), Err(SetupError::DuplicateSetting), "a name can't be plain and secret");
        let mut s = setup();
        s.secrets = vec!["Token".into(), "TOKEN".into()];
        assert_eq!(check(&s), Err(SetupError::DuplicateSetting));
        let mut s = setup();
        s.env = vec![("ÄPFEL".into(), "a".into()), ("äpfel".into(), "b".into())];
        assert_eq!(check(&s), Err(SetupError::DuplicateSetting), "beyond ASCII too");
        assert_eq!(fold("straße"), "STRAßE", "a character that upper-cases to two keeps itself");
    }

    #[test]
    fn bad_names_and_values() {
        for name in ["", "A=B", "=C:", "A\0", "A\nB", "A\tB"] {
            let mut s = setup();
            s.env = vec![(name.into(), "v".into())];
            assert_eq!(check(&s), Err(SetupError::Invalid), "setting {name:?}");
            let mut s = setup();
            s.secrets = vec![name.into()];
            assert_eq!(check(&s), Err(SetupError::Invalid), "secret {name:?}");
        }
        let mut s = setup();
        s.env = vec![("A".into(), "x\0y".into())];
        assert_eq!(check(&s), Err(SetupError::Invalid));
        let mut s = setup();
        s.env = vec![("A".into(), "line\nbreak and = sign".into())];
        assert_eq!(check(&s), Ok(()), "only NUL is refused in a value");
        for id in ["", "a:b", "a b", "a/b", &"x".repeat(MAX_ID + 1)] {
            let mut s = setup();
            s.id = id.to_string();
            assert_eq!(check(&s), Err(SetupError::Invalid), "id {id:?}");
        }
        let mut s = setup();
        s.program.clear();
        assert_eq!(check(&s), Err(SetupError::Invalid));
    }

    #[test]
    fn the_unsafe_secret_list() {
        for name in UNSAFE_SECRETS {
            assert!(unsafe_secret(name), "{name}");
            assert!(unsafe_secret(&name.to_lowercase()), "{name}");
            let mut s = setup();
            s.secrets = vec![name.to_string()];
            assert_eq!(check(&s), Err(SetupError::UnsafeSecret), "{name}");
            // As a plain setting it's allowed.
            let mut s = setup();
            s.env = vec![(name.to_string(), "v".into())];
            assert_eq!(check(&s), Ok(()), "{name} as a plain setting");
        }
        for name in ["npm_config_registry", "NPM_CONFIG_", "UV_INDEX_URL", "PIP_INDEX_URL", "COR_PROFILER", "CORECLR_PROFILER_PATH", "Path", "comspec"] {
            assert!(unsafe_secret(name), "{name}");
        }
        for name in ["API_KEY", "TOKEN", "NODE", "PATHS", "UV", "PIPX_HOME", "CORE_DIR", "MY_PATH", "GITHUB_TOKEN", "NODE_ENV"] {
            assert!(!unsafe_secret(name), "{name}");
        }
        assert_eq!(UNSAFE_SECRETS.len(), 24);
    }

    #[test]
    fn the_canonical_form() {
        let base = setup();
        let form = |s: &Setup| Canonical::new(s, "C:\\node\\node.exe").to_json();
        let b = form(&base);
        assert!(b.contains("C:\\\\node\\\\node.exe") && b.contains("LOG_LEVEL") && b.contains("FAKE_SECRET"));
        assert_ne!(Canonical::new(&base, "C:\\other\\node.exe").to_json(), b, "the program");
        let changes: [fn(&mut Setup); 7] = [
            |s| s.args[2] = "b".into(),
            |s| s.args.push("--more".into()),
            |s| s.args.swap(0, 1),
            |s| s.cwd = "C:\\elsewhere".into(),
            |s| s.env[0].1 = "info".into(),
            |s| s.env.push(("NODE_OPTIONS".into(), "--require x".into())),
            |s| s.secrets[0] = "OTHER_SECRET".into(),
        ];
        for (i, change) in changes.iter().enumerate() {
            let mut s = setup();
            change(&mut s);
            assert_ne!(form(&s), b, "change {i}");
        }
        // Not part of it: the label, the order of settings, and every secret value.
        let mut s = setup();
        s.label = "Renamed".into();
        s.env = vec![("B".into(), "2".into()), ("A".into(), "1".into())];
        s.secrets = vec!["Y".into(), "X".into()];
        let mut t = setup();
        t.env = vec![("A".into(), "1".into()), ("B".into(), "2".into())];
        t.secrets = vec!["X".into(), "Y".into()];
        assert_eq!(form(&s), form(&t));
        assert!(!form(&s).contains("Renamed"));
    }

    #[test]
    fn the_environment_is_built_in_order() {
        let parent = [
            ("SYSTEMROOT", "C:\\Windows"),
            ("Path", "C:\\bin"),
            ("PATHEXT", ".EXE;.CMD"),
            ("SECRET_OF_FAMILIAR", "no"),
            ("TEMP", "C:\\t"),
            ("NODE_OPTIONS", "--inherited"),
        ];
        let mut s = setup();
        s.env = vec![("path".into(), "C:\\mine".into()), ("LOG_LEVEL".into(), "debug".into())];
        let secret = val("s");
        let env = environment(parent.iter().copied(), &s, &[("fake_secret".into(), secret.clone())]);
        assert_eq!(
            env,
            vec![
                ("SystemRoot".to_string(), "C:\\Windows".to_string()),
                ("PATHEXT".into(), ".EXE;.CMD".into()),
                ("TEMP".into(), "C:\\t".into()),
                ("path".into(), "C:\\mine".into()),
                ("LOG_LEVEL".into(), "debug".into()),
                ("FAKE_SECRET".into(), secret),
            ]
        );
        assert_eq!(ENV_ALLOWLIST.len(), 22);
    }

    #[test]
    fn stdout_lines() {
        let secret = val("out");
        let mut l = Lines::new(Stream::Stdout, std::slice::from_ref(&secret));
        let mut ev = l.feed(b"{\"a\":1}\r\n{\"b\":");
        ev.extend(l.feed(format!("\"{secret}\"}}\npartial").as_bytes()));
        ev.extend(l.finish());
        assert_eq!(
            ev,
            vec![Event::Out("{\"a\":1}".into()), Event::Out("{\"b\":\"[hidden]\"}".into()), Event::Out("partial".into())]
        );
        let mut l = Lines::new(Stream::Stdout, &[secret]);
        let big = vec![b'x'; MAX_STDOUT_LINE + 1];
        let mut ev = l.feed(&big[..1000]);
        ev.extend(l.feed(&big[1000..]));
        ev.extend(l.feed(b"\nnext\n"));
        assert_eq!(ev, vec![Event::Err("a stdout line over 4 MiB was dropped".into()), Event::Out("next".into())]);
        let mut l = Lines::new(Stream::Stdout, &[] as &[&str]);
        let exact = vec![b'y'; MAX_STDOUT_LINE];
        let ev = l.feed(&[exact.as_slice(), b"\n"].concat());
        assert_eq!(ev, vec![Event::Out(String::from_utf8(exact).unwrap())], "exactly 4 MiB passes");
    }

    #[test]
    fn stderr_lines_are_cut_after_blanking() {
        let secret = val("err");
        let mut l = Lines::new(Stream::Stderr, std::slice::from_ref(&secret));
        assert_eq!(l.feed(format!("the secret is {secret}\n").as_bytes()), vec![Event::Err("the secret is [hidden]".into())]);
        // A secret that starts just before the cut is blanked whole, not left half shown.
        let pad = "p".repeat(MAX_STDERR_LINE - 3);
        let ev = l.feed(format!("{pad}{secret}{}\n", "q".repeat(5000)).as_bytes());
        let Event::Err(line) = &ev[0] else { panic!() };
        assert_eq!(&line[pad.len()..], "[hi…", "the cut falls inside the marker, not the secret");
        assert!(line.len() <= MAX_STDERR_LINE + '…'.len_utf8());
        // Exactly 8 KiB passes whole.
        let ok = "e".repeat(MAX_STDERR_LINE);
        assert_eq!(l.feed(format!("{ok}\n").as_bytes()), vec![Event::Err(ok)]);
        assert_eq!(l.finish(), vec![]);
    }
}
