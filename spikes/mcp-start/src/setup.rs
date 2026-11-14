//! A saved setup, and starting it: resolve the program, build the minimal environment,
//! start it suspended with no console window, put it in its own job, then let it run.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

use windows_sys::Win32::System::Threading::{CREATE_NEW_CONSOLE, CREATE_NO_WINDOW, CREATE_SUSPENDED};

use crate::win::{resume_process, Job};

/// What the person approved: the program, its arguments, its working folder, and its own settings.
/// Familiar starts only this, never a command line typed as text.
#[derive(Clone, Debug)]
pub struct SavedSetup {
    pub label: String,
    /// A bare name to look up on PATH (`npx`, `uvx`, `node`), or a full path.
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The server's own settings. These are the only variables it gets beyond the allowlist.
    pub env: Vec<(String, String)>,
}

/// The variables a server inherits from the app. Windows itself, the user's folders, and PATH.
/// Everything else in the app's environment stays behind.
pub const ENV_ALLOWLIST: &[&str] = &[
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

/// Program kinds Familiar will start. A `.ps1`, a `.js`, or a file with no extension is never picked.
const RUNNABLE: &[&str] = &[".exe", ".cmd", ".bat"];

#[derive(Debug)]
pub enum StartError {
    NotFound(String),
    /// std refused the spawn, before any process existed (for example, an argument it can't pass to a .cmd safely).
    Refused(io::Error),
    Job(io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NotFound(s) => write!(f, "not found: {s}"),
            StartError::Refused(e) => write!(f, "spawn refused: kind={:?} os_error={:?} message=\"{e}\"", e.kind(), e.raw_os_error()),
            StartError::Job(e) => write!(f, "job object: {e}"),
        }
    }
}

fn get_env_ci(name: &str) -> Option<OsString> {
    std::env::vars_os().find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v)
}

/// The resolved program: a full path to an `.exe`, `.cmd` or `.bat`.
/// Looks only in absolute PATH folders (never the working folder, unlike cmd.exe), trying PATHEXT's runnable kinds in order.
pub fn resolve_program(program: &str) -> Result<PathBuf, StartError> {
    let pathext: Vec<String> = get_env_ci("PATHEXT")
        .map(|v| v.to_string_lossy().split(';').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_else(|| vec![".com".into(), ".exe".into(), ".bat".into(), ".cmd".into()]);
    let exts: Vec<&str> = pathext.iter().map(|s| s.as_str()).filter(|e| RUNNABLE.contains(e)).collect();

    let runnable = |p: &Path| -> bool {
        p.is_file()
            && p.extension()
                .map(|e| RUNNABLE.contains(&format!(".{}", e.to_string_lossy().to_ascii_lowercase()).as_str()))
                .unwrap_or(false)
    };
    let candidates = |base: &Path| -> Vec<PathBuf> {
        let has_runnable_ext = base
            .extension()
            .map(|e| RUNNABLE.contains(&format!(".{}", e.to_string_lossy().to_ascii_lowercase()).as_str()))
            .unwrap_or(false);
        if has_runnable_ext {
            vec![base.to_path_buf()]
        } else {
            exts.iter().map(|e| PathBuf::from(format!("{}{}", base.display(), e))).collect()
        }
    };

    let given = Path::new(program);
    if program.contains('\\') || program.contains('/') {
        if !given.is_absolute() {
            return Err(StartError::NotFound(format!("{program} is a relative path. Saved setups hold full paths.")));
        }
        return candidates(given)
            .into_iter()
            .find(|p| runnable(p))
            .ok_or_else(|| StartError::NotFound(format!("{program} (no runnable .exe, .cmd or .bat there)")));
    }
    let path = get_env_ci("Path").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        if !dir.is_absolute() {
            continue;
        }
        if let Some(found) = candidates(&dir.join(program)).into_iter().find(|p| runnable(p)) {
            return Ok(found);
        }
    }
    Err(StartError::NotFound(format!("{program} is not on PATH as {}", exts.join(", "))))
}

/// The environment a server gets: the allowlist from the app's own environment, then its own settings on top.
pub fn minimal_env(setup: &SavedSetup) -> BTreeMap<String, OsString> {
    let mut env = BTreeMap::new();
    for (k, v) in std::env::vars_os() {
        let k = k.to_string_lossy().into_owned();
        if let Some(name) = ENV_ALLOWLIST.iter().find(|a| a.eq_ignore_ascii_case(&k)) {
            env.insert(name.to_string(), v);
        }
    }
    for (k, v) in &setup.env {
        env.retain(|existing, _| !existing.eq_ignore_ascii_case(k));
        env.insert(k.clone(), OsString::from(v));
    }
    env
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Console {
    /// What Familiar uses: no console window for the server or anything it starts.
    NoWindow,
    /// A control for the console check only: a new, visible console.
    NewConsole,
}

pub struct StartOptions {
    pub console: Console,
    /// False only for the cleanup check's control run.
    pub job: bool,
}

impl Default for StartOptions {
    fn default() -> Self {
        StartOptions { console: Console::NoWindow, job: true }
    }
}

pub enum Out {
    Line(String),
    /// A line longer than the cap. Its start is kept for the report.
    TooLong(String),
    Eof,
}

pub const MAX_LINE: usize = 4 * 1024 * 1024;

pub struct Server {
    pub resolved: PathBuf,
    pub child: Child,
    pub job: Option<Job>,
    pub stdin: Option<ChildStdin>,
    pub stdout: Receiver<Out>,
    /// The last stderr lines, with the setup's own setting values blanked.
    pub stderr: Arc<Mutex<Vec<String>>>,
}

pub fn start(setup: &SavedSetup, opts: &StartOptions) -> Result<Server, StartError> {
    let resolved = resolve_program(&setup.program)?;
    let env = minimal_env(setup);

    let mut cmd = Command::new(&resolved);
    cmd.args(&setup.args)
        .current_dir(&setup.cwd)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let console = match opts.console {
        Console::NoWindow => CREATE_NO_WINDOW,
        Console::NewConsole => CREATE_NEW_CONSOLE,
    };
    // Suspended, so nothing runs (and no grandchild starts) before the process is in its job.
    let suspended = if opts.job { CREATE_SUSPENDED } else { 0 };
    cmd.creation_flags(console | suspended);

    let mut child = cmd.spawn().map_err(StartError::Refused)?;
    let job = if opts.job {
        let attach = || -> io::Result<Job> {
            let job = Job::new()?;
            job.assign(child.as_raw_handle())?;
            Ok(job)
        };
        match attach() {
            Ok(job) => {
                if let Err(e) = resume_process(child.id()) {
                    let _ = child.kill();
                    return Err(StartError::Job(e));
                }
                Some(job)
            }
            Err(e) => {
                let _ = child.kill();
                return Err(StartError::Job(e));
            }
        }
    } else {
        None
    };

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let (tx, rx) = channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut buf = Vec::new();
            match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Out::Eof);
                    return;
                }
                Ok(_) => {
                    if buf.len() > MAX_LINE && buf.last() != Some(&b'\n') {
                        let head = String::from_utf8_lossy(&buf[..200]).into_owned();
                        let _ = tx.send(Out::TooLong(head));
                        let _ = tx.send(Out::Eof);
                        return;
                    }
                    let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                    if tx.send(Out::Line(line)).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let secrets: Vec<String> = setup.env.iter().map(|(_, v)| v.clone()).filter(|v| v.len() >= 4).collect();
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.split(b'\n') {
            let Ok(line) = line else { return };
            let mut text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
            for s in &secrets {
                text = text.replace(s.as_str(), "[hidden]");
            }
            let mut v = sink.lock().unwrap();
            v.push(text);
            if v.len() > 200 {
                v.remove(0);
            }
        }
    });

    Ok(Server { resolved, child, job, stdin, stdout: rx, stderr: lines })
}

impl Server {
    pub fn send_line(&mut self, line: &str) -> io::Result<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| io::Error::other("stdin closed"))?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    pub fn stderr_tail(&self, n: usize) -> Vec<String> {
        let v = self.stderr.lock().unwrap();
        v[v.len().saturating_sub(n)..].to_vec()
    }

    /// Ends the server and everything it started.
    pub fn stop(mut self) {
        self.stdin.take();
        if let Some(job) = &self.job {
            let _ = job.terminate(1);
        } else {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
