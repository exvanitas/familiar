//! Starting a local MCP server: only a setup the person approved natively, exactly as approved,
//! in its own kill-on-close job, with a minimal environment, and with its secrets blanked from
//! everything it prints. The rules are shell-core's (`setup`, `server_path`, `approvals`,
//! `redact`), and the walk's file system calls are shell-win's. The starting sequence is the
//! mcp-start spike's. See "5b. Starting a local MCP server" in docs/shell-design.md.

use crate::{confirm, secrets, shell::Shell};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shell_core::{
    approvals::{self, Load, Store},
    server_path::{self, Launch, PathError},
    setup::{self, Canonical, Event, Lines, Setup, Stream},
    temp,
};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Channel, InvokeBody, Request},
    AppHandle, Manager, State,
};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Fail {
    Fail { kind, message: message.into() }
}

type Res<T> = Result<T, Fail>;

/// What runs, by run id. One job per server: closing its handle ends the whole tree.
#[derive(Default)]
pub struct Servers {
    runs: Mutex<HashMap<String, Arc<Running>>>,
    /// Held for each read and write of `servers.json`, so two starts can't lose an approval.
    store: Mutex<()>,
}

struct Running {
    setup: String,
    job: Job,
    stdin: Mutex<Option<ChildStdin>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn store_path(shell: &Shell) -> PathBuf {
    shell.data_dir.join("shell").join(approvals::FILE)
}

/// The approvals, or none if the file can't be read. An unreadable file is renamed aside and
/// logged, so every setup asks again and the file is never read as approval.
fn load(shell: &Shell) -> Store {
    let path = store_path(shell);
    let bytes = std::fs::read(&path).ok();
    match Store::load(bytes.as_deref()) {
        Load::Empty => Store::new(),
        Load::Read(s) => s,
        Load::Unreadable => {
            let aside = path.with_file_name(approvals::ASIDE);
            let moved = std::fs::rename(&path, &aside).is_ok();
            shell.log.line(&format!("servers.json unreadable: renamed aside {moved}, every setup asks again"));
            Store::new()
        }
    }
}

fn save(shell: &Shell, store: &Store) -> Res<()> {
    let path = store_path(shell);
    std::fs::create_dir_all(path.parent().expect("shell folder")).map_err(|e| fail("failed", e.to_string()))?;
    temp::write_atomic(&path, &store.to_bytes()).map_err(|e| fail("failed", format!("the approval couldn't be saved: {e}")))
}

fn env_var(name: &str) -> String {
    std::env::var_os(name).and_then(|v| v.into_string().ok()).unwrap_or_default()
}

fn walk(program: &str, cwd: &str) -> Res<Launch> {
    let pathext = std::env::var_os("PATHEXT").and_then(|v| v.into_string().ok());
    server_path::launch(&fs(), program, cwd, &env_var("PATH"), pathext.as_deref()).map_err(path_fail)
}

fn path_fail(e: PathError) -> Fail {
    fail(e.kind(), "the program or folder can't be used")
}

#[cfg(windows)]
fn fs() -> shell_win::WinFs {
    shell_win::WinFs
}

#[cfg(not(windows))]
fn fs() -> NoFs {
    NoFs
}

#[cfg(not(windows))]
struct NoFs;

#[cfg(not(windows))]
impl server_path::Fs for NoFs {
    fn drive_type(&self, _: &str) -> server_path::DriveType {
        server_path::DriveType::Unknown
    }
    fn open(&self, _: &str) -> Result<server_path::Node, server_path::FsError> {
        Err(server_path::FsError::Failed)
    }
}

#[derive(Serialize)]
pub struct Started {
    run: String,
}

fn run_id() -> String {
    use std::hash::{BuildHasher, RandomState};
    let a = RandomState::new().hash_one(Instant::now());
    let b = RandomState::new().hash_one(std::process::id());
    format!("{a:016x}{b:016x}")
}

#[tauri::command(async)]
pub fn server_start(app: AppHandle, setup: Setup, owner: Option<String>, channel: Channel<Value>, shell: State<Shell>, servers: State<Servers>) -> Res<Started> {
    // The syntax, then the walk (local only, it can't make network traffic), then the form. An
    // approved form starts with no confirm state involved: the stop and a dialog that's open are
    // about asking, and starting a server opens no window. Only a new or changed form reserves.
    setup::check(&setup).map_err(|e| fail(e.kind(), "the setup was refused"))?;
    let launch = walk(&setup.program, &setup.cwd)?;
    let form = Canonical::new(&setup, &launch);
    if lock(&servers.runs).len() >= setup::MAX_RUNNING {
        return Err(fail("busy", "16 servers are running"));
    }
    let approved = {
        let _g = lock(&servers.store);
        load(&shell).approved(&setup.id, &form)
    };
    if approved {
        shell.log.line(&format!("server {}: approved before, no dialog", setup.id));
    } else {
        let ticket = confirm::reserve(&app).map_err(|e| {
            shell.log.line(&format!("server {}: {}", setup.id, e.kind()));
            fail(e.kind(), "the confirm can't ask now")
        })?;
        shell.log.line(&format!("server {}: asking", setup.id));
        // What runs is `form`, this copy made before asking: nothing a page sends meanwhile
        // changes it.
        let a = shell_core::confirm::start_program(&setup.label, &form);
        let said = ticket.ask(owner.as_deref(), a).map_err(|e| fail(e.kind(), "the confirm failed"))?;
        if !said {
            shell.log.line(&format!("server {}: declined", setup.id));
            return Err(fail("declined", "not started"));
        }
        let _g = lock(&servers.store);
        let mut store = load(&shell);
        store.approve(&setup.id, form.clone());
        save(&shell, &store)?;
        shell.log.line(&format!("server {}: approved", setup.id));
    }
    // Just before starting: the walk again, and the same targets as approved.
    server_path::recheck(&fs(), &form.launch()).map_err(path_fail)?;
    let mut secrets = Vec::new();
    for name in &setup.secrets {
        let v = secrets::server_secret(&setup.id, name).ok_or_else(|| fail("no-key", "a secret of this setup isn't stored"))?;
        secrets.push((name.clone(), v));
    }
    let parent: Vec<(String, String)> = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let env = setup::environment(parent.iter().map(|(k, v)| (k.as_str(), v.as_str())), &setup, &secrets);
    let values: Vec<String> = secrets.into_iter().map(|(_, v)| v).collect();

    if lock(&servers.runs).len() >= setup::MAX_RUNNING {
        return Err(fail("busy", "16 servers are running"));
    }
    let mut cmd = Command::new(&form.program);
    cmd.args(&setup.args).current_dir(&form.cwd).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let (child, job) = start_suspended(cmd).inspect_err(|e| {
        shell.log.line(&format!("server {}: {}", setup.id, e.message));
    })?;
    let run = run_id();
    shell.log.line(&format!("server {} started as run {run}", setup.id));
    let running = Arc::new(Running { setup: setup.id.clone(), job, stdin: Mutex::new(None) });
    let mut child = child;
    *lock(&running.stdin) = child.stdin.take();
    let out = child.stdout.take().map(|s| pump(s, Stream::Stdout, &values, channel.clone()));
    let err = child.stderr.take().map(|s| pump(s, Stream::Stderr, &values, channel.clone()));
    lock(&servers.runs).insert(run.clone(), running.clone());

    // When the program ends: its output drains, the rest of its tree goes with the job, and core
    // hears the exit code.
    let (log, run_end) = (shell.log.clone(), run.clone());
    let app2 = app.clone();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        for t in [out, err].into_iter().flatten() {
            let _ = t.join();
        }
        running.job.terminate();
        if let Some(servers) = app2.try_state::<Servers>() {
            lock(&servers.runs).remove(&run_end);
        }
        log.line(&format!("server run {run_end} exited with {code:?}"));
        let _ = channel.send(json!({ "t": "exit", "code": code }));
    });
    Ok(Started { run })
}

/// Reads one stream to its end, a line at a time, with the setup's secrets blanked before any
/// line leaves Rust.
fn pump(mut source: impl Read + Send + 'static, stream: Stream, secrets: &[String], channel: Channel<Value>) -> thread::JoinHandle<()> {
    let mut lines = Lines::new(stream, secrets);
    thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let send = |events: Vec<Event>| {
            for e in events {
                let m = match e {
                    Event::Out(line) => json!({ "t": "out", "line": line }),
                    Event::Err(line) => json!({ "t": "err", "line": line }),
                };
                let _ = channel.send(m);
            }
        };
        loop {
            match source.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => send(lines.feed(&buf[..n])),
            }
        }
        send(lines.finish());
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteSpec {
    run: String,
}

/// The body is the bytes for the server's stdin, and the `x-spec` header holds `{ run }`.
#[tauri::command(async)]
pub fn server_write(request: Request, servers: State<Servers>) -> Res<()> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err(fail("invalid", "expected bytes")) };
    if bytes.len() > setup::MAX_WRITE {
        return Err(fail("too-large", "at most 4 MiB a call"));
    }
    let header = request.headers().get("x-spec").and_then(|v| v.to_str().ok()).ok_or_else(|| fail("invalid", "no spec"))?;
    let spec = percent_encoding::percent_decode_str(header).decode_utf8().map_err(|_| fail("invalid", "bad spec"))?;
    let spec: WriteSpec = serde_json::from_str(&spec).map_err(|_| fail("invalid", "bad spec"))?;
    let running = lock(&servers.runs).get(&spec.run).cloned().ok_or_else(|| fail("missing", "no such run"))?;
    let mut stdin = lock(&running.stdin);
    let pipe = stdin.as_mut().ok_or_else(|| fail("missing", "its input is closed"))?;
    pipe.write_all(bytes).and_then(|_| pipe.flush()).map_err(|_| fail("failed", "the server isn't reading"))
}

/// Closes its input, gives it 500 ms to exit, then ends its job.
fn stop(running: Arc<Running>, runs: &Mutex<HashMap<String, Arc<Running>>>, run: &str) {
    lock(&running.stdin).take();
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(500) && lock(runs).contains_key(run) {
        thread::sleep(Duration::from_millis(20));
    }
    running.job.terminate();
}

#[tauri::command(async)]
pub fn server_stop(run: String, servers: State<Servers>, shell: State<Shell>) -> Res<()> {
    let running = lock(&servers.runs).get(&run).cloned().ok_or_else(|| fail("missing", "no such run"))?;
    stop(running, &servers.runs, &run);
    shell.log.line(&format!("server run {run} stopped"));
    Ok(())
}

/// Stops every run of the setup, and removes its approval.
#[tauri::command(async)]
pub fn server_forget(setup_id: String, servers: State<Servers>, shell: State<Shell>) -> Res<()> {
    if !setup::valid_id(&setup_id) {
        return Err(fail("invalid", "not a setup id"));
    }
    let runs: Vec<(String, Arc<Running>)> = lock(&servers.runs).iter().filter(|(_, r)| r.setup == setup_id).map(|(k, r)| (k.clone(), r.clone())).collect();
    for (run, r) in runs {
        stop(r, &servers.runs, &run);
    }
    let _g = lock(&servers.store);
    let mut store = load(&shell);
    if store.forget(&setup_id) {
        save(&shell, &store)?;
    }
    shell.log.line(&format!("server {setup_id} forgotten"));
    Ok(())
}

/* ---------- the spike's sequence: suspended, in a job, then resumed ---------- */

#[cfg(windows)]
use win::{start_suspended, Job};

#[cfg(windows)]
mod win {
    use super::{fail, Res};
    use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle, os::windows::process::CommandExt, process::Child, process::Command};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{
                Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32},
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
            },
        },
    };

    /// A job object. When its handle closes (on drop, or when Familiar dies in any way), Windows
    /// ends every process in it, grandchildren included.
    pub struct Job(HANDLE);

    // A kernel object handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        fn new() -> windows::core::Result<Job> {
            // No name and default security: the handle isn't inheritable, so no child holds it.
            let job = Job(unsafe { CreateJobObjectW(None, PCWSTR::null()) }?);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            // No BREAKAWAY_OK: processes in the job can't leave it.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }?;
            Ok(job)
        }

        pub fn terminate(&self) {
            let _ = unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// Resumes the threads of a process made with CREATE_SUSPENDED. std's Child doesn't give the
    /// main thread's handle, so they're found in a snapshot. A new suspended process has one.
    fn resume(pid: u32) -> windows::core::Result<usize> {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }?;
        let mut resumed = 0;
        let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
        let mut more = unsafe { Thread32First(snap, &mut entry) }.is_ok();
        while more {
            if entry.th32OwnerProcessID == pid {
                if let Ok(t) = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) } {
                    if unsafe { ResumeThread(t) } != u32::MAX {
                        resumed += 1;
                    }
                    let _ = unsafe { CloseHandle(t) };
                }
            }
            more = unsafe { Thread32Next(snap, &mut entry) }.is_ok();
        }
        let _ = unsafe { CloseHandle(snap) };
        if resumed == 0 {
            return Err(windows::core::Error::from_thread());
        }
        Ok(resumed)
    }

    /// Starts suspended with no console window, puts the process in a new job, then lets it run.
    /// If anything after the spawn fails, the suspended process is ended and nothing is left.
    pub fn start_suspended(mut cmd: Command) -> Res<(Child, Job)> {
        cmd.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidInput {
                fail("unsafe-argument", "this setup can't be started safely")
            } else {
                fail("start-failed", format!("the program couldn't start: {e}"))
            }
        })?;
        let attach = || -> windows::core::Result<Job> {
            let job = Job::new()?;
            unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }?;
            resume(child.id())?;
            Ok(job)
        };
        match attach() {
            Ok(job) => Ok((child, job)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(fail("start-failed", format!("the server's job couldn't be made: {e}")))
            }
        }
    }
}

#[cfg(not(windows))]
use other::{start_suspended, Job};

#[cfg(not(windows))]
mod other {
    use super::{fail, Res};
    use std::process::{Child, Command};

    pub struct Job;

    impl Job {
        pub fn terminate(&self) {}
    }

    pub fn start_suspended(_: Command) -> Res<(Child, Job)> {
        Err(fail("start-failed", "servers start on Windows only"))
    }
}
