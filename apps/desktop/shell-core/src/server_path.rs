//! Where a server's program and folder may be: plain local paths, on a fixed or removable
//! drive, with no link leading off the local disk. Checked first by syntax, touching nothing,
//! then by a walk that opens one name at a time without following links. And PATH lookup.
//! See "5b. Starting a local MCP server", "Checking, before any filesystem access", in
//! docs/shell-design.md.
//!
//! The walk is written against `Fs`, so the rules are tested here with a fake, and the
//! Windows calls (`GetDriveTypeW`, `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT`,
//! `FSCTL_GET_REPARSE_POINT`) live in shell-win.

use crate::paths::plain;

/// The most links one path may pass through.
pub const MAX_LINKS: u32 = 8;
/// Program kinds Familiar will start, in no order: PATHEXT gives the order.
pub const RUNNABLE: [&str; 3] = [".exe", ".cmd", ".bat"];
/// PATHEXT when the environment has none, as Windows' own default.
pub const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathError {
    UnsafePath,
    NotFound,
}

impl PathError {
    pub fn kind(self) -> &'static str {
        match self {
            PathError::UnsafePath => "unsafe-path",
            PathError::NotFound => "not-found",
        }
    }
}

/// What `GetDriveTypeW` says about a root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveType {
    Fixed,
    Removable,
    Remote,
    CdRom,
    RamDisk,
    Unknown,
    NoRootDir,
}

/// One name, opened without following it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node {
    File,
    Dir,
    Link(Link),
}

/// A reparse point's tag and, for a link, its target as stored (the substitute name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    /// `IO_REPARSE_TAG_SYMLINK`. `relative` is `SYMLINK_FLAG_RELATIVE`.
    Symlink { target: String, relative: bool },
    /// `IO_REPARSE_TAG_MOUNT_POINT`: a junction, or a volume mounted in a folder.
    Junction { target: String },
    /// `IO_REPARSE_TAG_APPEXECLINK`, as Store apps install.
    AppExecLink,
    /// Any other tag: cloud placeholders, dedup, WSL and the rest.
    Other { tag: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsError {
    NotFound,
    /// Anything else: access denied, a sharing violation, unreadable reparse data.
    Failed,
}

/// The file system calls the walk needs, and nothing more.
pub trait Fs {
    /// The type of a drive or volume root, `C:\` or `\\?\Volume{...}\`, touching no share.
    fn drive_type(&self, root: &str) -> DriveType;
    /// Opens one path without following a link at its last name, and says what it is.
    fn open(&self, path: &str) -> Result<Node, FsError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Root {
    /// An upper-case drive letter.
    Drive(char),
    /// `Volume{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`, only ever from a link's target.
    Volume(String),
}

/// A plain local absolute path: a root and plain names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalPath {
    pub root: Root,
    pub names: Vec<String>,
}

impl LocalPath {
    pub fn root_str(&self) -> String {
        match &self.root {
            Root::Drive(d) => format!("{d}:\\"),
            Root::Volume(v) => format!("\\\\?\\{v}\\"),
        }
    }

    /// The root and the first `n` names.
    pub fn prefix(&self, n: usize) -> String {
        let mut s = self.root_str();
        s.push_str(&self.names[..n].join("\\"));
        s
    }

    pub fn to_string_full(&self) -> String {
        self.prefix(self.names.len())
    }
}

/// The syntax check, touching nothing: a drive letter, a colon, a backslash, then plain names
/// separated by single backslashes, with at most one trailing backslash. UNC, `\\.\`, `\\?\`,
/// `\??\`, drive-relative paths, forward slashes, alternate streams, `.` and `..` are refused.
pub fn parse(input: &str) -> Result<LocalPath, PathError> {
    let b = input.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
        return Err(PathError::UnsafePath);
    }
    let drive = (b[0] as char).to_ascii_uppercase();
    let rest = &input[3..];
    Ok(LocalPath { root: Root::Drive(drive), names: names(rest)? })
}

fn names(rest: &str) -> Result<Vec<String>, PathError> {
    // No control or invisible character, so a path always shows as it is in a confirm.
    if rest.contains('/') || rest.chars().any(crate::confirm::hidden) {
        return Err(PathError::UnsafePath);
    }
    if rest.is_empty() {
        return Ok(vec![]);
    }
    let rest = rest.strip_suffix('\\').unwrap_or(rest);
    rest.split('\\').map(|n| if plain(n) { Ok(n.to_string()) } else { Err(PathError::UnsafePath) }).collect()
}

fn is_volume_guid(s: &str) -> bool {
    let Some(g) = s.strip_prefix("Volume{").and_then(|g| g.strip_suffix('}')) else { return false };
    let parts: Vec<&str> = g.split('-').collect();
    parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A link's stored target, as a local path. `\??\C:\x` and `\\?\C:\x` are `C:\x`, and
/// `\??\Volume{guid}\x` is a volume path. A relative symbolic link is resolved against the
/// folder holding it. A share (`\??\UNC\`, `\\`), a device path, a root-relative target and
/// anything else is `unsafe-path`, without touching it.
pub fn link_target(target: &str, relative: bool, holder: &LocalPath) -> Result<LocalPath, PathError> {
    if relative {
        if target.is_empty()
            || target.starts_with('\\')
            || target.contains('/')
            || target.contains(':')
            || target.chars().any(crate::confirm::hidden)
        {
            return Err(PathError::UnsafePath);
        }
        let mut out = holder.names.clone();
        for n in target.split('\\') {
            match n {
                "" | "." => {}
                ".." => {
                    out.pop().ok_or(PathError::UnsafePath)?;
                }
                n if plain(n) => out.push(n.to_string()),
                _ => return Err(PathError::UnsafePath),
            }
        }
        return Ok(LocalPath { root: holder.root.clone(), names: out });
    }
    let bare = target.strip_prefix("\\??\\").or_else(|| target.strip_prefix("\\\\?\\")).unwrap_or(target);
    if bare.len() >= 3 && bare.as_bytes()[1] == b':' {
        return parse(bare);
    }
    if let Some((vol, rest)) = bare.split_once('\\') {
        if is_volume_guid(vol) && bare.len() < target.len() {
            return Ok(LocalPath { root: Root::Volume(vol.to_string()), names: names(rest)? });
        }
    }
    Err(PathError::UnsafePath)
}

/// What the walk is checking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The program: a file, and the only place an app execution alias may be.
    Program,
    /// The working folder.
    Folder,
}

/// Checks a path completely: syntax first, then the drive's type, then one name at a time
/// without following links. Returns where the path really leads.
pub fn check(fs: &dyn Fs, input: &str, role: Role) -> Result<LocalPath, PathError> {
    let path = parse(input)?;
    let mut links = 0;
    walk(fs, path, role, &mut links)
}

fn walk(fs: &dyn Fs, path: LocalPath, role: Role, links: &mut u32) -> Result<LocalPath, PathError> {
    if !matches!(fs.drive_type(&path.root_str()), DriveType::Fixed | DriveType::Removable) {
        return Err(PathError::UnsafePath);
    }
    if path.names.is_empty() {
        return if role == Role::Folder { Ok(path) } else { Err(PathError::NotFound) };
    }
    let last = path.names.len() - 1;
    for i in 0..=last {
        let node = fs.open(&path.prefix(i + 1)).map_err(|e| match e {
            FsError::NotFound => PathError::NotFound,
            FsError::Failed => PathError::UnsafePath,
        })?;
        match node {
            Node::Dir if i < last || role == Role::Folder => {}
            Node::File if i == last && role == Role::Program => {}
            Node::Dir | Node::File => return Err(PathError::NotFound),
            Node::Link(Link::AppExecLink) if i == last && role == Role::Program => return Ok(path),
            Node::Link(Link::Symlink { target, relative }) => {
                return follow(fs, &path, i, &target, relative, role, links);
            }
            Node::Link(Link::Junction { target }) => return follow(fs, &path, i, &target, false, role, links),
            Node::Link(_) => return Err(PathError::UnsafePath),
        }
    }
    Ok(path)
}

/// Continues the walk at a link's target, with the names after the link appended.
fn follow(fs: &dyn Fs, path: &LocalPath, i: usize, target: &str, relative: bool, role: Role, links: &mut u32) -> Result<LocalPath, PathError> {
    *links += 1;
    if *links > MAX_LINKS {
        return Err(PathError::UnsafePath);
    }
    let holder = LocalPath { root: path.root.clone(), names: path.names[..i].to_vec() };
    let mut next = link_target(target, relative, &holder)?;
    next.names.extend(path.names[i + 1..].iter().cloned());
    walk(fs, next, role, links)
}

fn runnable_ext(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    RUNNABLE.iter().any(|e| lower.ends_with(e) && lower.len() > e.len())
}

/// The runnable kinds in PATHEXT's order.
fn kinds(pathext: Option<&str>) -> Vec<String> {
    let pathext = pathext.filter(|p| !p.trim().is_empty()).unwrap_or(DEFAULT_PATHEXT);
    let mut out: Vec<String> = Vec::new();
    for e in pathext.split(';').map(|e| e.trim().to_ascii_lowercase()) {
        if RUNNABLE.contains(&e.as_str()) && !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

fn candidates(base: &str, kinds: &[String]) -> Vec<String> {
    if runnable_ext(base) {
        vec![base.to_string()]
    } else {
        kinds.iter().map(|k| format!("{base}{k}")).collect()
    }
}

/// A program as resolved: the path as named, and where the walk found it really leads. A link
/// can be pointed somewhere else later, so the approval binds the target too.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub program: String,
    /// The walk's final path: the program itself, a link's target, or an app execution alias.
    pub target: String,
}

/// Resolves a setup's program to a full path. A path is checked as it is (trying PATHEXT's
/// runnable kinds when it has none). A bare name is looked for in PATH's absolute local folders
/// only, never the working folder, in PATHEXT order, and only as `.exe`, `.cmd` or `.bat`. A
/// PATH entry that fails the checks is skipped, and one that fails the syntax is never opened.
pub fn resolve(fs: &dyn Fs, program: &str, path_var: &str, pathext: Option<&str>) -> Result<Resolved, PathError> {
    let kinds = kinds(pathext);
    let found = |c: &str, to: LocalPath| Resolved { program: normalize_drive(c), target: to.to_string_full() };
    if program.contains(['\\', '/', ':']) {
        parse(program)?;
        let mut last = PathError::NotFound;
        for c in candidates(program, &kinds) {
            match check(fs, &c, Role::Program) {
                Ok(to) => return Ok(found(&c, to)),
                Err(e) => last = e,
            }
        }
        return Err(last);
    }
    if !plain(program) {
        return Err(PathError::UnsafePath);
    }
    for entry in path_var.split(';') {
        let entry = entry.trim();
        let entry = entry.strip_prefix('"').and_then(|e| e.strip_suffix('"')).unwrap_or(entry);
        if entry.is_empty() || parse(entry).is_err() {
            continue;
        }
        let dir = entry.strip_suffix('\\').unwrap_or(entry);
        if check(fs, dir, Role::Folder).is_err() {
            continue;
        }
        for c in candidates(&format!("{dir}\\{program}"), &kinds) {
            if let Ok(to) = check(fs, &c, Role::Program) {
                return Ok(found(&c, to));
            }
        }
    }
    Err(PathError::NotFound)
}

/// What a start runs: the program and the folder as named, and where each really leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub program_target: String,
    pub cwd: String,
    pub cwd_target: String,
}

/// Resolves the program and checks the folder, before the approval is compared or asked for.
pub fn launch(fs: &dyn Fs, program: &str, cwd: &str, path_var: &str, pathext: Option<&str>) -> Result<Launch, PathError> {
    let r = resolve(fs, program, path_var, pathext)?;
    let to = check(fs, cwd, Role::Folder)?;
    Ok(Launch { program: r.program, program_target: r.target, cwd: normalize_drive(cwd), cwd_target: to.to_string_full() })
}

/// Just before starting: walks both paths again, and refuses (`unsafe-path`) if either now
/// leads anywhere but where it led when the person approved it.
pub fn recheck(fs: &dyn Fs, approved: &Launch) -> Result<(), PathError> {
    let program = check(fs, &approved.program, Role::Program)?.to_string_full();
    let cwd = check(fs, &approved.cwd, Role::Folder)?.to_string_full();
    if program != approved.program_target || cwd != approved.cwd_target {
        return Err(PathError::UnsafePath);
    }
    Ok(())
}

fn normalize_drive(p: &str) -> String {
    let mut s = p.to_string();
    s[..1].make_ascii_uppercase();
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A fake file system that fails the test if anything reaches it that the syntax check
    /// refuses, and records every touch.
    #[derive(Default)]
    struct FakeFs {
        drives: HashMap<String, DriveType>,
        nodes: HashMap<String, Node>,
        touched: RefCell<Vec<String>>,
    }

    fn syntax_ok(p: &str) -> bool {
        if let Some(rest) = p.strip_prefix("\\\\?\\") {
            let (vol, names_part) = rest.split_once('\\').unwrap_or((rest, ""));
            return is_volume_guid(vol) && names(names_part).is_ok();
        }
        parse(p).is_ok()
    }

    impl FakeFs {
        fn new() -> FakeFs {
            let mut f = FakeFs::default();
            f.drives.insert("C:\\".into(), DriveType::Fixed);
            f.drives.insert("E:\\".into(), DriveType::Removable);
            f.drives.insert("Z:\\".into(), DriveType::Remote);
            f.drives.insert("D:\\".into(), DriveType::CdRom);
            f.drives.insert("R:\\".into(), DriveType::RamDisk);
            f.drives.insert("U:\\".into(), DriveType::Unknown);
            f
        }
        fn dir(mut self, p: &str) -> Self {
            self.nodes.insert(p.into(), Node::Dir);
            self
        }
        fn file(mut self, p: &str) -> Self {
            self.nodes.insert(p.into(), Node::File);
            self
        }
        fn link(mut self, p: &str, l: Link) -> Self {
            self.nodes.insert(p.into(), Node::Link(l));
            self
        }
        fn touches(&self) -> Vec<String> {
            self.touched.borrow().clone()
        }
    }

    impl Fs for FakeFs {
        fn drive_type(&self, root: &str) -> DriveType {
            assert!(syntax_ok(root), "the walk asked about a root the syntax check refuses: {root}");
            self.touched.borrow_mut().push(root.to_string());
            *self.drives.get(root).unwrap_or(&DriveType::NoRootDir)
        }
        fn open(&self, path: &str) -> Result<Node, FsError> {
            assert!(syntax_ok(path), "the walk opened a path the syntax check refuses: {path}");
            self.touched.borrow_mut().push(path.to_string());
            self.nodes.get(path).cloned().ok_or(FsError::NotFound)
        }
    }

    fn sym(t: &str) -> Link {
        Link::Symlink { target: t.into(), relative: false }
    }
    fn rel(t: &str) -> Link {
        Link::Symlink { target: t.into(), relative: true }
    }
    fn junction(t: &str) -> Link {
        Link::Junction { target: t.into() }
    }

    const VOL: &str = "Volume{0a1b2c3d-0000-1111-2222-333344445555}";

    #[test]
    fn the_syntax_check() {
        assert_eq!(parse("C:\\").unwrap(), LocalPath { root: Root::Drive('C'), names: vec![] });
        assert_eq!(parse("c:\\Tools\\node.exe").unwrap(), LocalPath { root: Root::Drive('C'), names: vec!["Tools".into(), "node.exe".into()] });
        assert_eq!(parse("C:\\work\\").unwrap().names, vec!["work"]);
        assert_eq!(parse("C:\\Program Files (x86)\\x").unwrap().names, vec!["Program Files (x86)", "x"]);
        assert_eq!(parse("C:\\a\\.hidden\\b").unwrap().names.len(), 3);
        for bad in [
            "\\\\server\\share\\x.exe",
            "\\\\localhost\\C$\\x",
            "\\\\.\\C:\\x",
            "\\\\.\\pipe\\x",
            "\\\\?\\C:\\x",
            "\\\\?\\UNC\\server\\share",
            "\\??\\C:\\x",
            "\\\\?\\Volume{0a1b2c3d-0000-1111-2222-333344445555}\\x",
            "//server/share/x",
            "C:foo",
            "C:",
            "C:/x",
            "C:\\x/y",
            "\\x",
            "x",
            "node",
            "1:\\x",
            "CC:\\x",
            "é:\\x",
            "C:\\a\\..\\b",
            "C:\\a\\..",
            "C:\\a\\.\\b",
            "C:\\a\\\\b",
            "C:\\\\",
            "C:\\a\\file.txt:stream",
            "C:\\a\\file::$DATA",
            "C:\\a\\b.",
            "C:\\a\\b \\c",
            "C:\\con\\x",
            "C:\\x\\NUL.txt",
            "C:\\x\\a?b",
            "C:\\x\\*",
            "C:\\x\\a<b",
            "C:\\x\\a\0b",
            "C:\\x\\a\nb",
            "C:\\tools\\safe\u{200B}.exe",
            "C:\\a\u{202E}exe.txt",
            "C:\\a\u{AD}b",
            "C:\\a\u{FEFF}",
            "C:\\a\u{E0041}",
            "C:\\a\u{3164}",
            "",
        ] {
            assert_eq!(parse(bad), Err(PathError::UnsafePath), "{bad:?}");
        }
    }

    #[test]
    fn refused_forms_touch_nothing() {
        let fs = FakeFs::new();
        for bad in ["\\\\server\\share\\x.exe", "\\\\?\\C:\\x", "\\??\\C:\\x", "C:foo", "C:\\a\\..\\b", "C:\\a:s", "\\\\.\\C:"] {
            for role in [Role::Program, Role::Folder] {
                assert_eq!(check(&fs, bad, role), Err(PathError::UnsafePath), "{bad}");
            }
            assert_eq!(named(&fs, bad, "C:\\bin", None), Err(PathError::UnsafePath), "{bad}");
        }
        assert!(fs.touches().is_empty(), "{:?}", fs.touches());
    }

    #[test]
    fn only_fixed_and_removable_drives() {
        let fs = FakeFs::new().dir("C:\\w").dir("E:\\w").dir("Z:\\w").dir("D:\\w").dir("R:\\w").dir("U:\\w").dir("Q:\\w");
        assert!(check(&fs, "C:\\w", Role::Folder).is_ok());
        assert!(check(&fs, "E:\\w", Role::Folder).is_ok());
        for d in ["Z", "D", "R", "U", "Q"] {
            fs.touched.borrow_mut().clear();
            assert_eq!(check(&fs, &format!("{d}:\\w"), Role::Folder), Err(PathError::UnsafePath), "{d}");
            assert_eq!(fs.touches(), vec![format!("{d}:\\")], "only the drive table is asked, nothing on {d}: is opened");
        }
    }

    #[test]
    fn files_folders_and_missing_names() {
        let fs = FakeFs::new().dir("C:\\t").file("C:\\t\\node.exe").file("C:\\t\\f");
        assert!(check(&fs, "C:\\t\\node.exe", Role::Program).is_ok());
        assert!(check(&fs, "C:\\t", Role::Folder).is_ok());
        assert!(check(&fs, "C:\\", Role::Folder).is_ok());
        assert_eq!(check(&fs, "C:\\", Role::Program), Err(PathError::NotFound));
        assert_eq!(check(&fs, "C:\\t", Role::Program), Err(PathError::NotFound), "a folder isn't a program");
        assert_eq!(check(&fs, "C:\\t\\node.exe", Role::Folder), Err(PathError::NotFound), "a file isn't a folder");
        assert_eq!(check(&fs, "C:\\t\\f\\x", Role::Folder), Err(PathError::NotFound), "a file in the middle");
        assert_eq!(check(&fs, "C:\\nope\\x.exe", Role::Program), Err(PathError::NotFound));
        assert_eq!(fs.touches().iter().filter(|t| t.starts_with("C:\\nope\\")).count(), 0, "the walk stops at the first missing name");
    }

    #[test]
    fn links_must_stay_local() {
        let fs = FakeFs::new()
            .dir("C:\\local")
            .dir("C:\\local\\bin")
            .file("C:\\local\\bin\\node.exe")
            .link("C:\\j-local", junction("\\??\\C:\\local"))
            .link("C:\\s-local", sym("\\??\\C:\\local"))
            .link("C:\\s-rel", rel("local\\bin"))
            .link("C:\\local\\up", rel("..\\local"))
            .link("C:\\j-share", junction("\\??\\UNC\\localhost\\C$\\"))
            .link("C:\\s-share", sym("\\??\\UNC\\localhost\\C$"))
            .link("C:\\s-share2", sym("\\\\localhost\\C$"))
            .link("C:\\s-mapped", sym("\\??\\Z:\\bin"))
            .link("C:\\s-cd", sym("\\??\\D:\\"))
            .link("C:\\s-dev", sym("\\??\\GLOBALROOT\\Device\\Mup\\localhost\\C$"))
            .link("C:\\s-dev2", sym("\\Device\\HarddiskVolume3\\x"))
            .link("C:\\s-rootrel", rel("\\local"))
            .link("C:\\s-above", rel("..\\..\\x"))
            .link("C:\\s-stream", sym("\\??\\C:\\local:ads"))
            .link("C:\\s-dots", sym("\\??\\C:\\local\\..\\x"))
            .link("C:\\vol", junction(&format!("\\??\\{VOL}\\")))
            .link("C:\\vol-remote", junction("\\??\\Volume{ffffffff-0000-1111-2222-333344445555}\\"))
            .link("C:\\cloud", Link::Other { tag: 0x9000_601a })
            .link("C:\\dedup", Link::Other { tag: 0x8000_0013 })
            .dir(&format!("\\\\?\\{VOL}\\data"));
        let mut fs = fs;
        fs.drives.insert(format!("\\\\?\\{VOL}\\"), DriveType::Fixed);
        fs.drives.insert("\\\\?\\Volume{ffffffff-0000-1111-2222-333344445555}\\".into(), DriveType::Remote);

        assert_eq!(check(&fs, "C:\\j-local\\bin\\node.exe", Role::Program).unwrap().to_string_full(), "C:\\local\\bin\\node.exe");
        assert!(check(&fs, "C:\\s-local\\bin", Role::Folder).is_ok());
        assert_eq!(check(&fs, "C:\\s-rel\\node.exe", Role::Program).unwrap().to_string_full(), "C:\\local\\bin\\node.exe");
        assert!(check(&fs, "C:\\local\\up\\bin", Role::Folder).is_ok());
        assert_eq!(check(&fs, "C:\\vol\\data", Role::Folder).unwrap().to_string_full(), format!("\\\\?\\{VOL}\\data"));

        for bad in [
            "C:\\j-share\\Windows",
            "C:\\s-share\\Windows",
            "C:\\s-share2",
            "C:\\s-mapped\\x.exe",
            "C:\\s-cd",
            "C:\\s-dev",
            "C:\\s-dev2",
            "C:\\s-rootrel",
            "C:\\s-above",
            "C:\\s-stream",
            "C:\\s-dots",
            "C:\\vol-remote\\data",
            "C:\\cloud",
            "C:\\cloud\\x",
            "C:\\dedup",
        ] {
            fs.touched.borrow_mut().clear();
            assert_eq!(check(&fs, bad, Role::Folder), Err(PathError::UnsafePath), "{bad}");
            for t in fs.touches() {
                assert!(!t.starts_with("Z:\\") || t == "Z:\\", "{bad} opened {t} on the mapped drive");
                assert!(!t.contains("UNC") && !t.contains("localhost"), "{bad} touched {t}");
            }
        }
    }

    #[test]
    fn at_most_eight_links() {
        let mut fs = FakeFs::new().dir("C:\\end");
        for i in 0..9 {
            let next = if i == 8 { "\\??\\C:\\end".to_string() } else { format!("\\??\\C:\\l{}", i + 1) };
            fs = fs.link(&format!("C:\\l{i}"), sym(&next));
        }
        assert!(check(&fs, "C:\\l1", Role::Folder).is_ok(), "eight links");
        assert_eq!(check(&fs, "C:\\l0", Role::Folder), Err(PathError::UnsafePath), "nine links");
        let fs = FakeFs::new().link("C:\\a", sym("\\??\\C:\\b")).link("C:\\b", sym("\\??\\C:\\a"));
        assert_eq!(check(&fs, "C:\\a", Role::Folder), Err(PathError::UnsafePath), "a loop ends");
    }

    #[test]
    fn app_execution_aliases_only_as_the_program() {
        let fs = FakeFs::new()
            .dir("C:\\apps")
            .link("C:\\apps\\python.exe", Link::AppExecLink)
            .link("C:\\alias-dir", Link::AppExecLink)
            .link("C:\\to-alias.exe", sym("\\??\\C:\\apps\\python.exe"));
        assert!(check(&fs, "C:\\apps\\python.exe", Role::Program).is_ok());
        assert!(check(&fs, "C:\\to-alias.exe", Role::Program).is_ok(), "the alias is still the last name");
        assert_eq!(check(&fs, "C:\\apps\\python.exe", Role::Folder), Err(PathError::UnsafePath));
        assert_eq!(check(&fs, "C:\\alias-dir\\x.exe", Role::Program), Err(PathError::UnsafePath));
    }

    #[test]
    fn a_failed_open_is_refused() {
        struct Denied;
        impl Fs for Denied {
            fn drive_type(&self, _: &str) -> DriveType {
                DriveType::Fixed
            }
            fn open(&self, _: &str) -> Result<Node, FsError> {
                Err(FsError::Failed)
            }
        }
        assert_eq!(check(&Denied, "C:\\x", Role::Folder), Err(PathError::UnsafePath));
    }

    fn named(fs: &FakeFs, program: &str, path: &str, ext: Option<&str>) -> Result<String, PathError> {
        resolve(fs, program, path, ext).map(|r| r.program)
    }

    #[test]
    fn resolution_keeps_where_a_link_leads() {
        let fs = FakeFs::new()
            .dir("C:\\bin")
            .dir("C:\\approved")
            .dir("C:\\other")
            .file("C:\\approved\\tool.exe")
            .file("C:\\other\\tool.exe")
            .file("C:\\bin\\plain.exe")
            .link("C:\\bin\\tool.exe", sym("\\??\\C:\\approved\\tool.exe"))
            .dir("C:\\work-real")
            .link("C:\\work", junction("\\??\\C:\\work-real"));
        assert_eq!(
            resolve(&fs, "tool", "C:\\bin", None),
            Ok(Resolved { program: "C:\\bin\\tool.exe".into(), target: "C:\\approved\\tool.exe".into() })
        );
        assert_eq!(resolve(&fs, "plain", "C:\\bin", None).unwrap().target, "C:\\bin\\plain.exe", "no link, the same path");
        let approved = launch(&fs, "tool", "C:\\work", "C:\\bin", None).unwrap();
        assert_eq!(
            approved,
            Launch {
                program: "C:\\bin\\tool.exe".into(),
                program_target: "C:\\approved\\tool.exe".into(),
                cwd: "C:\\work".into(),
                cwd_target: "C:\\work-real".into(),
            }
        );
        assert_eq!(recheck(&fs, &approved), Ok(()));
        // The link is pointed at another local program after approval: caught before starting.
        let moved = fs.link("C:\\bin\\tool.exe", sym("\\??\\C:\\other\\tool.exe"));
        assert_eq!(resolve(&moved, "tool", "C:\\bin", None).unwrap().target, "C:\\other\\tool.exe");
        assert_eq!(recheck(&moved, &approved), Err(PathError::UnsafePath));
        // And so is a folder junction pointed elsewhere.
        let moved = moved.link("C:\\bin\\tool.exe", sym("\\??\\C:\\approved\\tool.exe")).link("C:\\work", junction("\\??\\C:\\other"));
        assert_eq!(recheck(&moved, &approved), Err(PathError::UnsafePath));
    }

    #[test]
    fn an_alias_is_its_own_target() {
        let fs = FakeFs::new().dir("C:\\apps").link("C:\\apps\\python.exe", Link::AppExecLink);
        assert_eq!(resolve(&fs, "python", "C:\\apps", None).unwrap().target, "C:\\apps\\python.exe");
    }

    fn path_fs() -> FakeFs {
        FakeFs::new()
            .dir("C:\\node")
            .file("C:\\node\\npx.ps1")
            .file("C:\\node\\npx.cmd")
            .file("C:\\node\\npx")
            .file("C:\\node\\node.exe")
            .dir("C:\\py")
            .file("C:\\py\\uvx.exe")
            .file("C:\\py\\tool.bat")
            .file("C:\\py\\tool.cmd")
            .file("C:\\py\\only.com")
            .file("C:\\py\\script.ps1")
            .dir("C:\\early")
            .link("C:\\early\\uvx.exe", sym("\\??\\UNC\\localhost\\C$\\uvx.exe"))
            .dir("Z:\\bin")
            .file("Z:\\bin\\node.exe")
            .link("C:\\linked", junction("\\??\\UNC\\localhost\\C$\\bin"))
            .dir("C:\\work")
            .file("C:\\work\\node.exe")
    }

    #[test]
    fn path_lookup() {
        let fs = path_fs();
        let path = "C:\\node;C:\\py";
        assert_eq!(named(&fs, "npx", path, Some(".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.WSH;.MSC;.PS1")), Ok("C:\\node\\npx.cmd".into()), "npx.cmd, never npx.ps1");
        assert_eq!(named(&fs, "node", path, None), Ok("C:\\node\\node.exe".into()));
        assert_eq!(named(&fs, "uvx", path, None), Ok("C:\\py\\uvx.exe".into()));
        assert_eq!(named(&fs, "tool", path, Some(".EXE;.CMD;.BAT")), Ok("C:\\py\\tool.cmd".into()), "PATHEXT's order");
        assert_eq!(named(&fs, "tool", path, Some(".EXE;.BAT;.CMD")), Ok("C:\\py\\tool.bat".into()));
        assert_eq!(named(&fs, "tool.bat", path, None), Ok("C:\\py\\tool.bat".into()));
        assert_eq!(named(&fs, "only", path, None), Err(PathError::NotFound), ".com is never picked");
        assert_eq!(named(&fs, "script", path, None), Err(PathError::NotFound));
        assert_eq!(named(&fs, "script.ps1", path, None), Err(PathError::NotFound));
        assert_eq!(named(&fs, "npx", path, Some(".PS1;.JS")), Err(PathError::NotFound), "no runnable kind in PATHEXT");
        assert_eq!(named(&fs, "missing", path, None), Err(PathError::NotFound));
        assert_eq!(named(&fs, "con", path, None), Err(PathError::UnsafePath));
        assert_eq!(named(&fs, "a.exe.", path, None), Err(PathError::UnsafePath));
    }

    #[test]
    fn path_entries_that_fail_are_skipped_and_bad_ones_never_opened() {
        let fs = path_fs();
        let path = ".;work;\\\\server\\share\\bin;\\\\?\\C:\\bin;C:node;Z:\\bin;C:\\linked;C:\\early;;\"C:\\py\";C:\\node";
        assert_eq!(named(&fs, "uvx", path, None), Ok("C:\\py\\uvx.exe".into()), "past a link to a share, to the quoted entry");
        assert_eq!(named(&fs, "node", path, None), Ok("C:\\node\\node.exe".into()), "not the mapped drive, not the working folder");
        for t in fs.touches() {
            assert!(!t.starts_with("Z:\\") || t == "Z:\\", "opened {t}");
            assert!(!t.starts_with("C:\\work"), "the working folder was searched: {t}");
        }
    }

    #[test]
    fn full_program_paths() {
        let fs = path_fs();
        assert_eq!(named(&fs, "C:\\node\\node.exe", "", None), Ok("C:\\node\\node.exe".into()));
        assert_eq!(named(&fs, "c:\\node\\node.exe", "", None), Ok("C:\\node\\node.exe".into()));
        assert_eq!(named(&fs, "C:\\node\\npx", "", None), Ok("C:\\node\\npx.cmd".into()), "kinds tried in order, never the bare file");
        assert_eq!(named(&fs, "C:\\py\\script.ps1", "", None), Err(PathError::NotFound));
        assert_eq!(named(&fs, "Z:\\bin\\node.exe", "", None), Err(PathError::UnsafePath));
        assert_eq!(named(&fs, "C:\\early\\uvx.exe", "", None), Err(PathError::UnsafePath));
        assert_eq!(named(&fs, "node\\node.exe", "", None), Err(PathError::UnsafePath), "relative");
        assert_eq!(named(&fs, "C:/node/node.exe", "", None), Err(PathError::UnsafePath));
    }

    #[test]
    fn link_targets() {
        let holder = parse("C:\\a\\b").unwrap();
        assert_eq!(link_target("\\??\\D:\\x", false, &holder).unwrap(), parse("D:\\x").unwrap());
        assert_eq!(link_target("\\\\?\\D:\\x", false, &holder).unwrap(), parse("D:\\x").unwrap());
        assert_eq!(link_target("D:\\x", false, &holder).unwrap(), parse("D:\\x").unwrap());
        assert_eq!(link_target("..\\c", true, &holder).unwrap(), parse("C:\\a\\c").unwrap());
        assert_eq!(link_target(".\\c\\.\\d", true, &holder).unwrap(), parse("C:\\a\\b\\c\\d").unwrap());
        assert_eq!(link_target("..\\..", true, &holder).unwrap(), parse("C:\\").unwrap());
        for (t, r) in [
            ("..\\..\\..", true),
            ("\\x", true),
            ("D:\\x", true),
            ("a/b", true),
            ("", true),
            ("\\??\\UNC\\s\\x", false),
            ("\\\\s\\x", false),
            ("\\??\\Volume{bad}\\", false),
            (&format!("{VOL}\\x"), false),
            ("\\Device\\Mup\\s", false),
            ("\\??\\D:x", false),
            ("\\??\\C:\\a\u{200B}", false),
            ("a\u{2066}", true),
            ("x", false),
        ] {
            assert_eq!(link_target(t, r, &holder), Err(PathError::UnsafePath), "{t}");
        }
        assert!(is_volume_guid(VOL));
        assert!(!is_volume_guid("Volume{0a1b2c3d-0000-1111-2222-33334444555}"));
    }
}
