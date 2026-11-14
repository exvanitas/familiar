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
    runs::{Runs, RunsError, Slot},
    setup::{self, Canonical, Event, Lines, Setup, Stream},
    temp,
};
use std::{
    cell::RefCell,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
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

/// What runs and what is starting, under one lock (see `shell_core::runs`). One job per server:
/// closing its handle ends the whole tree.
#[derive(Default)]
pub struct Servers {
    state: Mutex<Runs<Arc<Running>>>,
    /// Held for each read and write of `servers.json`, so two starts can't lose an approval.
    store: Mutex<()>,
}

pub struct Running {
    job: Arc<os::Job>,
    /// The writer thread's queue. Dropping it closes the server's stdin once a write in flight
    /// ends; it's never held during a write.
    input: Mutex<Option<Input>>,
}

/// One write for the writer thread: the bytes, and where to say whether they went.
type Input = mpsc::Sender<(Vec<u8>, mpsc::Sender<bool>)>;

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
    // A slot first, under the runs lock, so concurrent starts can't pass 16. It goes back on
    // every failure, and it remembers the setup's generation, so a forget meanwhile is seen.
    let slot = SlotGuard { servers: &servers, slot: RefCell::new(Some(lock(&servers.state).reserve(&setup.id).map_err(|e| fail(e.kind(), "16 servers are running or starting"))?)) };
    let launch = walk(&setup.program, &setup.cwd)?;
    let form = Canonical::new(&setup, &launch);
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
        // A forget while the dialog was open wins: the approval isn't stored, nothing starts.
        let _g = lock(&servers.store);
        if slot.revoked() {
            shell.log.line(&format!("server {}: forgotten while asking", setup.id));
            return Err(fail("revoked", "the setup was forgotten while asking"));
        }
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

    let mut cmd = Command::new(&form.program);
    cmd.args(&setup.args).current_dir(&form.cwd).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let run = run_id();
    let record = Records::new(&shell);
    let started = os::start(
        cmd,
        |pid| record.write(pid),
        |job| {
            // The last check, under the runs lock: a forget since the slot was taken refuses the
            // start; otherwise the run is in the list before it resumes, so a forget from now on
            // finds it and stops it.
            let running = Arc::new(Running { job: job.clone(), input: Mutex::new(None) });
            slot.commit(&run, running).map_err(|e| fail(e.kind(), "the setup was forgotten while starting"))
        },
    );
    record.remove();
    let mut child = started.inspect_err(|e| shell.log.line(&format!("server {}: {}", setup.id, e.message)))?;
    drop(slot);
    shell.log.line(&format!("server {} started as run {run}", setup.id));
    let running = lock(&servers.state).get(&run).expect("committed before resume");

    // stdin through a writer thread of its own, so a write that blocks never holds anything stop
    // needs. Closing the input is dropping its sender.
    if let Some(stdin) = child.stdin.take() {
        let (tx, rx) = mpsc::channel::<(Vec<u8>, mpsc::Sender<bool>)>();
        *lock(&running.input) = Some(tx);
        thread::spawn(move || {
            let mut stdin = stdin;
            for (bytes, done) in rx {
                let ok = stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_ok();
                let _ = done.send(ok);
                if !ok {
                    break;
                }
            }
        });
    }
    let (drained_tx, drained) = mpsc::channel::<()>();
    let pumps = [child.stdout.take().map(|s| pump(s, Stream::Stdout, &values, channel.clone(), drained_tx.clone())), child.stderr.take().map(|s| pump(s, Stream::Stderr, &values, channel.clone(), drained_tx.clone()))];
    let pumping = pumps.iter().flatten().count();
    drop(drained_tx);

    // When the program ends: the rest of its tree goes with the job, so no grandchild holding a
    // pipe can keep its output open; then the output drains, for a bounded time; then core hears
    // the exit code.
    let (log, run_end, app2) = (shell.log.clone(), run.clone(), app.clone());
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        running.job.terminate();
        let until = Instant::now() + DRAIN;
        for _ in 0..pumping {
            if drained.recv_timeout(until.saturating_duration_since(Instant::now())).is_err() {
                log.line(&format!("server run {run_end}: its output didn't drain in time"));
                break;
            }
        }
        if let Some(servers) = app2.try_state::<Servers>() {
            lock(&servers.state).remove(&run_end);
        }
        log.line(&format!("server run {run_end} exited with {code:?}"));
        let _ = channel.send(json!({ "t": "exit", "code": code }));
    });
    Ok(Started { run })
}

/// How long the output may take to drain after the program has ended and its job with it.
const DRAIN: Duration = Duration::from_secs(2);

/// A slot, given back on every way out unless the run took its place.
struct SlotGuard<'a> {
    servers: &'a Servers,
    slot: RefCell<Option<Slot>>,
}

impl SlotGuard<'_> {
    fn revoked(&self) -> bool {
        self.slot.borrow().as_ref().is_some_and(|s| lock(&self.servers.state).revoked(s))
    }

    fn commit(&self, run: &str, r: Arc<Running>) -> Result<(), RunsError> {
        let mut slot = self.slot.borrow_mut();
        lock(&self.servers.state).commit(slot.as_mut().expect("a slot"), run, r)
    }
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        if let Some(mut s) = self.slot.get_mut().take() {
            lock(&self.servers.state).release(&mut s);
        }
    }
}

/// Reads one stream to its end, a line at a time, with the setup's secrets blanked before any
/// line leaves Rust, and says when it's done.
fn pump(mut source: impl Read + Send + 'static, stream: Stream, secrets: &[String], channel: Channel<Value>, done: mpsc::Sender<()>) -> thread::JoinHandle<()> {
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
        let _ = done.send(());
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteSpec {
    run: String,
}

/// The body is the bytes for the server's stdin, and the `x-spec` header holds `{ run }`. It
/// waits for the write, which `server_stop` can always cut short by ending the job.
#[tauri::command(async)]
pub fn server_write(request: Request, servers: State<Servers>) -> Res<()> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err(fail("invalid", "expected bytes")) };
    if bytes.len() > setup::MAX_WRITE {
        return Err(fail("too-large", "at most 4 MiB a call"));
    }
    let header = request.headers().get("x-spec").and_then(|v| v.to_str().ok()).ok_or_else(|| fail("invalid", "no spec"))?;
    let spec = percent_encoding::percent_decode_str(header).decode_utf8().map_err(|_| fail("invalid", "bad spec"))?;
    let spec: WriteSpec = serde_json::from_str(&spec).map_err(|_| fail("invalid", "bad spec"))?;
    let running = lock(&servers.state).get(&spec.run).ok_or_else(|| fail("missing", "no such run"))?;
    let input = lock(&running.input).clone().ok_or_else(|| fail("missing", "its input is closed"))?;
    let (done_tx, done) = mpsc::channel();
    input.send((bytes.clone(), done_tx)).map_err(|_| fail("missing", "its input is closed"))?;
    match done.recv() {
        Ok(true) => Ok(()),
        _ => Err(fail("failed", "the server isn't reading")),
    }
}

/// Closes its input, gives it 500 ms from now to exit, then ends its job. Nothing here waits on a
/// write: the input is closed by dropping its sender, and ending the job breaks any write.
fn stop(running: Arc<Running>, servers: &Servers, run: &str) {
    let until = Instant::now() + Duration::from_millis(500);
    lock(&running.input).take();
    while Instant::now() < until && lock(&servers.state).contains(run) {
        thread::sleep(Duration::from_millis(20));
    }
    running.job.terminate();
}

#[tauri::command(async)]
pub fn server_stop(run: String, servers: State<Servers>, shell: State<Shell>) -> Res<()> {
    let running = lock(&servers.state).get(&run).ok_or_else(|| fail("missing", "no such run"))?;
    stop(running, &servers, &run);
    shell.log.line(&format!("server run {run} stopped"));
    Ok(())
}

/// Revokes every start of the setup under way, stops its runs, and removes its approval.
#[tauri::command(async)]
pub fn server_forget(setup_id: String, servers: State<Servers>, shell: State<Shell>) -> Res<()> {
    if !setup::valid_id(&setup_id) {
        return Err(fail("invalid", "not a setup id"));
    }
    let runs = lock(&servers.state).forget(&setup_id);
    for (run, r) in runs {
        stop(r, &servers, &run);
    }
    let _g = lock(&servers.store);
    let mut store = load(&shell);
    if store.forget(&setup_id) {
        save(&shell, &store)?;
    }
    shell.log.line(&format!("server {setup_id} forgotten"));
    Ok(())
}

/* ---------- children recorded between the spawn and the job ---------- */

/// A child is recorded from its spawn until `start` returns, so one a hard kill left outside any
/// job can be ended at the next start (see `shell_win::start`).
struct Records {
    dir: PathBuf,
    path: Mutex<Option<PathBuf>>,
}

impl Records {
    fn new(shell: &Shell) -> Records {
        Records { dir: shell.data_dir.join("shell").join("starting"), path: Mutex::new(None) }
    }

    fn write(&self, pid: u32) {
        let Some(created) = os::creation_time(pid) else { return };
        let path = self.dir.join(format!("{pid}.json"));
        let body = json!({ "pid": pid, "created": created }).to_string();
        if std::fs::create_dir_all(&self.dir).is_ok() && temp::write_atomic(&path, body.as_bytes()).is_ok() {
            *lock(&self.path) = Some(path);
        }
    }

    fn remove(&self) {
        if let Some(p) = lock(&self.path).take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// At each start: ends any child a hard kill left between its spawn and its job, then forgets the
/// records.
pub fn sweep(shell: &Shell) {
    let dir = shell.data_dir.join("shell").join("starting");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let mut records = Vec::new();
    for e in entries.flatten() {
        let v: Option<Value> = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice(&b).ok());
        if let Some((pid, created)) = v.and_then(|v| Some((v.get("pid")?.as_u64()? as u32, v.get("created")?.as_u64()?))) {
            records.push((pid, created));
        }
        let _ = std::fs::remove_file(e.path());
    }
    if !records.is_empty() {
        let ended = os::sweep(&records);
        shell.log.line(&format!("servers: {} start records left by a hard kill, {ended} children ended", records.len()));
    }
}

/* ---------- the OS side, shell-win's start sequence ---------- */

#[cfg(windows)]
mod os {
    use super::{fail, Fail, Res};
    use shell_win::start::{self, RealOs, StartError};
    use std::{
        process::{Child, Command},
        sync::Arc,
    };

    pub use shell_win::start::Job;

    pub fn start(cmd: Command, spawned: impl FnOnce(u32), before_resume: impl FnOnce(&Arc<Job>) -> Result<(), Fail>) -> Res<Child> {
        match start::start(&RealOs, cmd, |c| spawned(c.id()), before_resume) {
            Ok((child, _job)) => Ok(child),
            Err(StartError::InvalidInput) => Err(fail("unsafe-argument", "this setup can't be started safely")),
            Err(StartError::Spawn(e)) => Err(fail("start-failed", format!("the program couldn't start: {e}"))),
            Err(StartError::Stage(stage, e)) => Err(fail("start-failed", format!("the server's {stage} step failed: {e}"))),
            Err(StartError::Refused(f)) => Err(f),
        }
    }

    pub fn creation_time(pid: u32) -> Option<u64> {
        start::creation_time(pid)
    }

    pub fn sweep(records: &[(u32, u64)]) -> usize {
        start::sweep(records)
    }
}

#[cfg(not(windows))]
mod os {
    use super::{fail, Fail, Res};
    use std::{
        process::{Child, Command},
        sync::Arc,
    };

    pub struct Job;

    impl Job {
        pub fn terminate(&self) {}
    }

    pub fn start(_: Command, _: impl FnOnce(u32), _: impl FnOnce(&Arc<Job>) -> Result<(), Fail>) -> Res<Child> {
        Err(fail("start-failed", "servers start on Windows only"))
    }

    pub fn creation_time(_: u32) -> Option<u64> {
        None
    }

    pub fn sweep(_: &[(u32, u64)]) -> usize {
        0
    }
}
