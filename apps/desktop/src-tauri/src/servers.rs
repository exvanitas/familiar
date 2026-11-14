//! Starting a local MCP server: only a setup the person approved natively, exactly as approved,
//! in its own kill-on-close job, with a minimal environment, and with its secrets blanked from
//! everything it prints. See "5b. Starting a local MCP server" in docs/shell-design.md.
//!
//! **One owner per setup.** The manager (`Servers`) owns the slot count, a map of setup id to its
//! actor, and the one writer of `servers.json`. Each actor is a thread that owns everything about
//! its setup (the run if any, its job, its stdin writer, its sweep record) and handles one message
//! at a time from a bounded queue, following `shell_core::actor`'s states: Idle, Asking,
//! Starting, Running, Stopping, Forgetting. Blocking work (the walk and the dialog, the spawn,
//! pipe writes, waiting on the job) runs on threads of its own, which report back as messages.
//! Commands only send a message and await the reply, so no Tauri worker ever blocks.

use crate::{confirm, secrets, shell::Shell};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shell_core::{
    actor::{Effect, Machine, Msg, State},
    approvals::{self, Load, Store},
    server_path::{self, Launch, PathError},
    setup::{self, Canonical, Event, Lines, Setup, Stream},
    temp,
};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Channel, InvokeBody, Request},
    AppHandle, Manager,
};
use tokio::sync::oneshot;

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Fail {
    Fail { kind, message: message.into() }
}

type Res<T> = Result<T, Fail>;
type Reply<T> = oneshot::Sender<Res<T>>;

/// Messages an actor's queue holds before a command gets `busy`.
const QUEUE: usize = 32;
/// Writes in flight to one server, and their bytes, before a write gets `busy`.
const MAX_WRITES: usize = 8;
const MAX_WRITE_BYTES: usize = 16 * 1024 * 1024;
/// A stop's deadline, from when it began.
const STOP_AFTER: Duration = Duration::from_millis(500);
/// How long the output may take to drain once the program and its job have ended.
const DRAIN: Duration = Duration::from_secs(2);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/* ---------- the manager ---------- */

/// The manager, managed by Tauri.
#[derive(Default)]
pub struct Servers {
    /// Setup id to its actor's queue. Short-held.
    actors: Mutex<HashMap<String, mpsc::SyncSender<Cmd>>>,
    /// Run id to setup id, while a run exists.
    runs: Mutex<HashMap<String, String>>,
    /// Slots held: every setup whose actor isn't idle, at most 16.
    slots: Mutex<usize>,
    /// The one writer of `servers.json`.
    store: Mutex<Option<mpsc::Sender<StoreReq>>>,
}

#[derive(Serialize)]
pub struct Started {
    run: String,
}

impl Servers {
    fn actor(&self, app: &AppHandle, setup: &str) -> mpsc::SyncSender<Cmd> {
        let mut actors = lock(&self.actors);
        actors.entry(setup.to_string()).or_insert_with(|| spawn_actor(app.clone(), setup.to_string())).clone()
    }

    fn send(&self, app: &AppHandle, setup: &str, cmd: Cmd) -> Res<()> {
        self.actor(app, setup).try_send(cmd).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => fail("busy", "too many commands for this server at once"),
            mpsc::TrySendError::Disconnected(_) => fail("failed", "the server's actor has gone"),
        })
    }

    fn take_slot(&self) -> bool {
        let mut s = lock(&self.slots);
        if *s >= setup::MAX_RUNNING {
            return false;
        }
        *s += 1;
        true
    }

    fn release_slot(&self) {
        let mut s = lock(&self.slots);
        *s = s.saturating_sub(1);
    }

    fn store(&self, app: &AppHandle) -> mpsc::Sender<StoreReq> {
        lock(&self.store).get_or_insert_with(|| spawn_store(app.clone())).clone()
    }

    /// Asks the one writer, and waits for its answer. Only from an actor's or a helper's thread.
    fn store_call<T>(&self, app: &AppHandle, make: impl FnOnce(mpsc::Sender<T>) -> StoreReq) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        self.store(app).send(make(tx)).ok()?;
        rx.recv().ok()
    }
}

/* ---------- the approval store: one writer ---------- */

enum StoreReq {
    Approved { id: String, form: Box<Canonical>, reply: mpsc::Sender<bool> },
    Approve { id: String, form: Box<Canonical>, reply: mpsc::Sender<bool> },
    Remove { id: String, reply: mpsc::Sender<bool> },
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

fn save(shell: &Shell, store: &Store) -> bool {
    let path = store_path(shell);
    std::fs::create_dir_all(path.parent().expect("shell folder")).is_ok() && temp::write_atomic(&path, &store.to_bytes()).is_ok()
}

/// Every read and write of `servers.json`, one at a time, each answered once it's durable.
fn spawn_store(app: AppHandle) -> mpsc::Sender<StoreReq> {
    let (tx, rx) = mpsc::channel::<StoreReq>();
    thread::spawn(move || {
        let shell = app.state::<Shell>();
        for req in rx {
            match req {
                StoreReq::Approved { id, form, reply } => {
                    let _ = reply.send(load(&shell).approved(&id, &form));
                }
                StoreReq::Approve { id, form, reply } => {
                    let mut s = load(&shell);
                    s.approve(&id, *form);
                    let _ = reply.send(save(&shell, &s));
                }
                StoreReq::Remove { id, reply } => {
                    let mut s = load(&shell);
                    let ok = !s.forget(&id) || save(&shell, &s);
                    let _ = reply.send(ok);
                }
            }
        }
    });
    tx
}

/* ---------- an actor ---------- */

enum Cmd {
    Start { setup: Box<Setup>, owner: Option<String>, channel: Channel<Value>, reply: Reply<Started> },
    Stop { reply: Reply<()> },
    Forget { reply: Reply<()> },
    Write { bytes: Vec<u8>, reply: Reply<()> },
    /// What the actor's own threads report.
    Report(Report),
}

enum Report {
    AskDone(Result<Option<Box<Canonical>>, &'static str>),
    Spawned { job: Arc<os::Job>, go: mpsc::Sender<bool> },
    Resumed { input: Option<Writer> },
    SpawnFailed(&'static str),
    Exited,
    Deadline,
}

/// A run's stdin: a writer thread's queue, and what's in flight.
struct Writer {
    queue: mpsc::Sender<(Vec<u8>, Reply<()>)>,
    writes: Arc<AtomicUsize>,
    bytes: Arc<AtomicUsize>,
}

/// What an actor holds besides its state.
struct Actor {
    app: AppHandle,
    setup_id: String,
    tx: mpsc::SyncSender<Cmd>,
    machine: Machine,
    setup: Option<Box<Setup>>,
    owner: Option<String>,
    channel: Option<Channel<Value>>,
    form: Option<Box<Canonical>>,
    run: Option<String>,
    job: Option<Arc<os::Job>>,
    go: Option<mpsc::Sender<bool>>,
    input: Option<Writer>,
    start_reply: Option<Reply<Started>>,
    stop_replies: Vec<Reply<()>>,
    forget_replies: Vec<Reply<()>>,
}

fn spawn_actor(app: AppHandle, setup_id: String) -> mpsc::SyncSender<Cmd> {
    let (tx, rx) = mpsc::sync_channel::<Cmd>(QUEUE);
    let mut a = Actor {
        app,
        setup_id,
        tx: tx.clone(),
        machine: Machine::default(),
        setup: None,
        owner: None,
        channel: None,
        form: None,
        run: None,
        job: None,
        go: None,
        input: None,
        start_reply: None,
        stop_replies: Vec::new(),
        forget_replies: Vec::new(),
    };
    thread::spawn(move || {
        for cmd in rx {
            a.handle(cmd);
        }
    });
    tx
}

impl Actor {
    fn log(&self, line: &str) {
        self.app.state::<Shell>().log.line(&format!("server {}: {line}", self.setup_id));
    }

    fn servers(&self) -> tauri::State<'_, Servers> {
        self.app.state::<Servers>()
    }

    /// Reports from a helper thread come back on the actor's own queue. Blocking here is fine:
    /// it's the helper's thread.
    fn reporter(&self) -> impl Fn(Report) + Send + Clone + 'static {
        let tx = self.tx.clone();
        move |r| {
            let _ = tx.send(Cmd::Report(r));
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        let held = self.machine.holds_slot();
        let before = self.machine.state;
        let fx = match cmd {
            Cmd::Start { setup, owner, channel, reply } => {
                if before != State::Idle {
                    // A second start of the same setup, or one during a forget.
                    let kind = self.machine.handle(Msg::Start).into_iter().find_map(|e| if let Effect::ReplyStart(Err(k)) = e { Some(k) } else { None }).unwrap_or("busy");
                    let _ = reply.send(Err(fail(kind, "this server is starting, running or being forgotten")));
                    return;
                }
                if !self.servers().take_slot() {
                    let _ = reply.send(Err(fail("busy", "16 servers are running or starting")));
                    return;
                }
                self.setup = Some(setup);
                self.owner = owner;
                self.channel = Some(channel);
                self.start_reply = Some(reply);
                self.machine.handle(Msg::Start)
            }
            Cmd::Stop { reply } => {
                self.stop_replies.push(reply);
                self.machine.handle(Msg::Stop)
            }
            Cmd::Forget { reply } => {
                self.forget_replies.push(reply);
                let fx = self.machine.handle(Msg::Forget);
                // A forget joining one under way answers with it.
                if fx.is_empty() && self.machine.state == State::Forgetting {
                    self.log("forget joined the one under way");
                }
                fx
            }
            Cmd::Write { bytes, reply } => {
                self.write(bytes, reply);
                return;
            }
            Cmd::Report(r) => match r {
                Report::AskDone(r) => {
                    let msg = match r {
                        Ok(Some(form)) => {
                            self.form = Some(form);
                            Msg::AskDone(Ok(true))
                        }
                        Ok(None) => Msg::AskDone(Ok(false)),
                        Err(kind) => Msg::AskDone(Err(kind)),
                    };
                    self.machine.handle(msg)
                }
                Report::Spawned { job, go } => {
                    self.job = Some(job);
                    self.go = Some(go);
                    self.machine.handle(Msg::Spawned)
                }
                Report::Resumed { input } => {
                    self.input = input;
                    if self.machine.state == State::Stopping {
                        // Stopped before it resumed: its input closes at once.
                        self.input = None;
                    }
                    self.machine.handle(Msg::Resumed)
                }
                Report::SpawnFailed(kind) => {
                    self.job = None;
                    self.machine.handle(Msg::SpawnFailed(kind))
                }
                Report::Exited => self.machine.handle(Msg::Exited),
                Report::Deadline => self.machine.handle(Msg::Deadline),
            },
        };
        self.apply(fx);
        let after = self.machine.state;
        if before != after {
            self.log(&format!("{before:?} -> {after:?}"));
        }
        if !matches!(after, State::Running | State::Stopping) {
            self.end_run();
        }
        if held && !self.machine.holds_slot() {
            self.servers().release_slot();
        }
    }

    /// The run's bookkeeping, once there's no run.
    fn end_run(&mut self) {
        if let Some(run) = self.run.take() {
            lock(&self.servers().runs).remove(&run);
        }
        self.job = None;
        self.input = None;
        self.go = None;
    }

    fn apply(&mut self, fx: Vec<Effect>) {
        for e in fx {
            match e {
                Effect::BeginAsk => self.begin_ask(),
                Effect::StoreApproval => {
                    let form = self.form.take().expect("an approved form");
                    let id = self.setup_id.clone();
                    let ok = self.servers().store_call(&self.app, |reply| StoreReq::Approve { id, form, reply }).unwrap_or(false);
                    self.log(if ok { "approval stored" } else { "the approval couldn't be stored" });
                    let more = self.machine.handle(Msg::Stored(ok));
                    self.apply(more);
                }
                Effect::BeginSpawn => self.begin_spawn(),
                Effect::Go | Effect::Abort => {
                    let go = matches!(e, Effect::Go);
                    if go {
                        let run = run_id();
                        lock(&self.servers().runs).insert(run.clone(), self.setup_id.clone());
                        self.run = Some(run);
                    }
                    if let Some(tx) = self.go.take() {
                        let _ = tx.send(go);
                    }
                }
                Effect::CloseInput => {
                    // Dropping the queue closes stdin once a write in flight ends; ending the job
                    // breaks that write.
                    self.input = None;
                }
                Effect::ArmDeadline => {
                    let report = self.reporter();
                    thread::spawn(move || {
                        thread::sleep(STOP_AFTER);
                        report(Report::Deadline);
                    });
                }
                Effect::Terminate => {
                    if let Some(j) = &self.job {
                        j.terminate();
                    }
                }
                Effect::RemoveApproval => {
                    let id = self.setup_id.clone();
                    let ok = self.servers().store_call(&self.app, |reply| StoreReq::Remove { id, reply }).unwrap_or(false);
                    self.log(if ok { "approval removed" } else { "the approval couldn't be removed" });
                    let more = self.machine.handle(Msg::Removed(ok));
                    self.apply(more);
                }
                Effect::ReplyStart(r) => {
                    if let Some(reply) = self.start_reply.take() {
                        let r = match r {
                            Ok(()) => Ok(Started { run: self.run.clone().unwrap_or_default() }),
                            Err(kind) => Err(fail(kind, "not started")),
                        };
                        let _ = reply.send(r);
                    }
                }
                Effect::ReplyStop(r) => {
                    for reply in self.stop_replies.drain(..) {
                        let _ = reply.send(r.map_err(|k| fail(k, "no such run")));
                    }
                }
                Effect::ReplyForget(r) => {
                    for reply in self.forget_replies.drain(..) {
                        let _ = reply.send(r.map_err(|k| fail(k, "the approval couldn't be removed")));
                    }
                }
            }
        }
    }

    /// Writes are bounded, so a server that stops reading can't fill memory or the queue.
    fn write(&mut self, bytes: Vec<u8>, reply: Reply<()>) {
        let Some(w) = &self.input else {
            let _ = reply.send(Err(fail("missing", "its input is closed")));
            return;
        };
        let n = bytes.len();
        if w.writes.load(Ordering::SeqCst) >= MAX_WRITES || w.bytes.load(Ordering::SeqCst) + n > MAX_WRITE_BYTES {
            let _ = reply.send(Err(fail("busy", "8 writes or 16 MiB are in flight to this server")));
            return;
        }
        w.writes.fetch_add(1, Ordering::SeqCst);
        w.bytes.fetch_add(n, Ordering::SeqCst);
        if let Err(mpsc::SendError((_, reply))) = w.queue.send((bytes, reply)) {
            w.writes.fetch_sub(1, Ordering::SeqCst);
            w.bytes.fetch_sub(n, Ordering::SeqCst);
            let _ = reply.send(Err(fail("missing", "its input is closed")));
        }
    }

    /// The walk, the approval check and, if new or changed, the dialog, on a thread of its own.
    fn begin_ask(&mut self) {
        let setup = self.setup.clone().expect("a setup");
        let owner = self.owner.clone();
        let app = self.app.clone();
        let report = self.reporter();
        thread::spawn(move || {
            let r = ask(&app, &setup, owner.as_deref());
            report(Report::AskDone(r));
        });
    }

    /// The spawn, on a thread of its own: recheck, secrets, environment, then shell-win's start,
    /// whose last step waits for the actor's word.
    fn begin_spawn(&mut self) {
        let setup = self.setup.clone().expect("a setup");
        let channel = self.channel.clone().expect("a channel");
        let app = self.app.clone();
        let report = self.reporter();
        thread::spawn(move || {
            if let Err(kind) = spawn(&app, &setup, channel, report.clone()) {
                report(Report::SpawnFailed(kind));
            }
        });
    }
}

/// The ask: the walk (local only), the form, and the dialog only if the form isn't the one
/// approved. Some(form) when it must be stored, None when it was approved before.
fn ask(app: &AppHandle, setup: &Setup, owner: Option<&str>) -> Result<Option<Box<Canonical>>, &'static str> {
    let shell = app.state::<Shell>();
    let launch = walk(&setup.program, &setup.cwd).map_err(|e| e.kind)?;
    let form = Canonical::new(setup, &launch);
    let servers = app.state::<Servers>();
    let id = setup.id.clone();
    let f2 = Box::new(form.clone());
    if servers.store_call(app, |reply| StoreReq::Approved { id, form: f2, reply }).unwrap_or(false) {
        shell.log.line(&format!("server {}: approved before, no dialog", setup.id));
        return Ok(None);
    }
    // Only a new or changed form involves the confirm state; `busy` or `asks-stopped` ends it.
    let ticket = confirm::reserve(app).map_err(|e| e.kind())?;
    let a = shell_core::confirm::start_program(&setup.label, &form);
    if !ticket.ask(owner, a).map_err(|e| e.kind())? {
        return Err("declined");
    }
    Ok(Some(Box::new(form)))
}

/// Makes the child and lets it run, or reports why not. On the spawn's own thread.
fn spawn(app: &AppHandle, setup: &Setup, channel: Channel<Value>, report: impl Fn(Report) + Send + Clone + 'static) -> Result<(), &'static str> {
    let shell = app.state::<Shell>();
    // Just before starting: the walk again, and the same targets as approved.
    let launch = walk(&setup.program, &setup.cwd).map_err(|e| e.kind)?;
    let form = Canonical::new(setup, &launch);
    server_path::recheck(&fs(), &form.launch()).map_err(|e| e.kind())?;
    let mut secrets = Vec::new();
    for name in &setup.secrets {
        secrets.push((name.clone(), secrets::server_secret(&setup.id, name).ok_or("no-key")?));
    }
    let parent: Vec<(String, String)> = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let env = setup::environment(parent.iter().map(|(k, v)| (k.as_str(), v.as_str())), setup, &secrets);
    let values: Vec<String> = secrets.into_iter().map(|(_, v)| v).collect();
    let mut cmd = Command::new(&form.program);
    cmd.args(&setup.args).current_dir(&form.cwd).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let record = Record::new(&shell);
    let go_report = report.clone();
    let started = os::start(
        cmd,
        |pid| record.write(pid),
        move |job| {
            // The actor's word: go, or abort (a forget came meanwhile).
            let (go_tx, go_rx) = mpsc::channel();
            go_report(Report::Spawned { job: job.clone(), go: go_tx });
            if go_rx.recv().unwrap_or(false) {
                Ok(())
            } else {
                Err("revoked")
            }
        },
    );
    record.remove();
    let (mut child, job) = started.inspect_err(|kind| shell.log.line(&format!("server {}: start failed ({kind})", setup.id)))?;

    // stdin through a writer thread of its own; nothing else ever waits on a write.
    let input = child.stdin.take().map(|mut stdin| {
        let (queue, rx) = mpsc::channel::<(Vec<u8>, Reply<()>)>();
        let (writes, bytes) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (w2, b2) = (writes.clone(), bytes.clone());
        thread::spawn(move || {
            for (buf, reply) in rx {
                let ok = stdin.write_all(&buf).and_then(|_| stdin.flush()).is_ok();
                w2.fetch_sub(1, Ordering::SeqCst);
                b2.fetch_sub(buf.len(), Ordering::SeqCst);
                let _ = reply.send(if ok { Ok(()) } else { Err(fail("failed", "the server isn't reading")) });
            }
        });
        Writer { queue, writes, bytes }
    });
    let (drained_tx, drained) = mpsc::channel::<()>();
    let pumps = [
        child.stdout.take().map(|s| pump(s, Stream::Stdout, &values, channel.clone(), drained_tx.clone())),
        child.stderr.take().map(|s| pump(s, Stream::Stderr, &values, channel.clone(), drained_tx.clone())),
    ];
    let pumping = pumps.iter().flatten().count();
    drop(drained_tx);
    report(Report::Resumed { input });

    // The waiter: when the program ends, its job ends too, so no grandchild holding a pipe can
    // keep the output open; then the output drains, for a bounded time; then core hears the exit
    // and the actor that the run is gone.
    let log = shell.log.clone();
    let id = setup.id.clone();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        job.terminate();
        let until = Instant::now() + DRAIN;
        for _ in 0..pumping {
            if drained.recv_timeout(until.saturating_duration_since(Instant::now())).is_err() {
                log.line(&format!("server {id}: its output didn't drain in time"));
                break;
            }
        }
        log.line(&format!("server {id}: exited with {code:?}"));
        let _ = channel.send(json!({ "t": "exit", "code": code }));
        report(Report::Exited);
    });
    Ok(())
}

fn run_id() -> String {
    use std::hash::{BuildHasher, RandomState};
    let a = RandomState::new().hash_one(Instant::now());
    let b = RandomState::new().hash_one(std::process::id());
    format!("{a:016x}{b:016x}")
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

/* ---------- the commands: a message, then the reply ---------- */

#[tauri::command]
pub async fn server_start(app: AppHandle, setup: Setup, owner: Option<String>, channel: Channel<Value>) -> Res<Started> {
    setup::check(&setup).map_err(|e| fail(e.kind(), "the setup was refused"))?;
    let (reply, answer) = oneshot::channel();
    let id = setup.id.clone();
    app.state::<Servers>().send(&app, &id, Cmd::Start { setup: Box::new(setup), owner, channel, reply })?;
    answer.await.map_err(|_| fail("failed", "the server's actor has gone"))?
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteSpec {
    run: String,
}

/// The body is the bytes for the server's stdin, and the `x-spec` header holds `{ run }`.
#[tauri::command]
pub async fn server_write(app: AppHandle, request: Request<'_>) -> Res<()> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err(fail("invalid", "expected bytes")) };
    if bytes.len() > setup::MAX_WRITE {
        return Err(fail("too-large", "at most 4 MiB a call"));
    }
    let header = request.headers().get("x-spec").and_then(|v| v.to_str().ok()).ok_or_else(|| fail("invalid", "no spec"))?;
    let spec = percent_encoding::percent_decode_str(header).decode_utf8().map_err(|_| fail("invalid", "bad spec"))?;
    let spec: WriteSpec = serde_json::from_str(&spec).map_err(|_| fail("invalid", "bad spec"))?;
    let servers = app.state::<Servers>();
    let setup = lock(&servers.runs).get(&spec.run).cloned().ok_or_else(|| fail("missing", "no such run"))?;
    let (reply, answer) = oneshot::channel();
    servers.send(&app, &setup, Cmd::Write { bytes: bytes.clone(), reply })?;
    answer.await.map_err(|_| fail("failed", "the server's actor has gone"))?
}

#[tauri::command]
pub async fn server_stop(app: AppHandle, run: String) -> Res<()> {
    let servers = app.state::<Servers>();
    let setup = lock(&servers.runs).get(&run).cloned().ok_or_else(|| fail("missing", "no such run"))?;
    let (reply, answer) = oneshot::channel();
    servers.send(&app, &setup, Cmd::Stop { reply })?;
    answer.await.map_err(|_| fail("failed", "the server's actor has gone"))?
}

/// Revokes the setup's start under way, stops its run, and removes its approval; answers once
/// the removal is durable.
#[tauri::command]
pub async fn server_forget(app: AppHandle, setup_id: String) -> Res<()> {
    if !setup::valid_id(&setup_id) {
        return Err(fail("invalid", "not a setup id"));
    }
    let (reply, answer) = oneshot::channel();
    app.state::<Servers>().send(&app, &setup_id, Cmd::Forget { reply })?;
    answer.await.map_err(|_| fail("failed", "the server's actor has gone"))?
}

/* ---------- children recorded between the spawn and the job ---------- */

/// A child is recorded from its spawn until `start` returns, so one a hard kill left outside any
/// job can be ended at the next start (see `shell_win::start`).
struct Record {
    dir: PathBuf,
    path: Mutex<Option<PathBuf>>,
}

impl Record {
    fn new(shell: &Shell) -> Record {
        Record { dir: shell.data_dir.join("shell").join("starting"), path: Mutex::new(None) }
    }

    /// Fails the start if the record can't be written durably.
    fn write(&self, pid: u32) -> std::io::Result<()> {
        let created = os::creation_time(pid).ok_or_else(|| std::io::Error::other("no creation time"))?;
        let path = self.dir.join(format!("{pid}.json"));
        std::fs::create_dir_all(&self.dir)?;
        temp::write_atomic(&path, json!({ "pid": pid, "created": created }).to_string().as_bytes())?;
        *lock(&self.path) = Some(path);
        Ok(())
    }

    fn remove(&self) {
        if let Some(p) = lock(&self.path).take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// At each start, in the manager, before any actor exists: each record's process is ended or
/// found gone, and only then is that record removed. One that can't be ended stays for the next
/// start.
pub fn sweep(shell: &Shell) {
    let dir = shell.data_dir.join("shell").join("starting");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let (mut ended, mut gone, mut kept) = (0, 0, 0);
    for e in entries.flatten() {
        let v: Option<Value> = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let Some((pid, created)) = v.and_then(|v| Some((v.get("pid")?.as_u64()? as u32, v.get("created")?.as_u64()?))) else {
            // Not a record: nothing it names can be ended.
            let _ = std::fs::remove_file(e.path());
            continue;
        };
        match os::sweep_one(pid, created) {
            os::Swept::Ended => ended += 1,
            os::Swept::Gone => gone += 1,
            os::Swept::Failed => {
                kept += 1;
                continue;
            }
        }
        let _ = std::fs::remove_file(e.path());
    }
    if ended + gone + kept > 0 {
        shell.log.line(&format!("servers: start records left by a hard kill: {ended} children ended, {gone} gone, {kept} kept for the next start"));
    }
}

/* ---------- the OS side, shell-win's start sequence ---------- */

#[cfg(windows)]
mod os {
    use shell_win::start::{self, RealOs, StartError};
    use std::{
        process::{Child, Command},
        sync::Arc,
    };

    pub use shell_win::start::{Job, Swept};

    pub fn start(cmd: Command, spawned: impl FnOnce(u32) -> std::io::Result<()>, before_resume: impl FnOnce(&Arc<Job>) -> Result<(), &'static str>) -> Result<(Child, Arc<Job>), &'static str> {
        match start::start(&RealOs, cmd, |c| spawned(c.id()), before_resume) {
            Ok(started) => Ok(started),
            Err(StartError::InvalidInput) => Err("unsafe-argument"),
            Err(StartError::Spawn(_)) | Err(StartError::Stage(..)) => Err("start-failed"),
            Err(StartError::Refused(kind)) => Err(kind),
        }
    }

    pub fn creation_time(pid: u32) -> Option<u64> {
        start::creation_time(pid)
    }

    pub fn sweep_one(pid: u32, created: u64) -> Swept {
        start::sweep_one(pid, created)
    }
}

#[cfg(not(windows))]
mod os {
    use std::{
        process::{Child, Command},
        sync::Arc,
    };

    pub struct Job;

    impl Job {
        pub fn terminate(&self) {}
    }

    pub enum Swept {
        Ended,
        Gone,
        Failed,
    }

    pub fn start(_: Command, _: impl FnOnce(u32) -> std::io::Result<()>, _: impl FnOnce(&Arc<Job>) -> Result<(), &'static str>) -> Result<(Child, Arc<Job>), &'static str> {
        Err("start-failed")
    }

    pub fn creation_time(_: u32) -> Option<u64> {
        None
    }

    pub fn sweep_one(_: u32, _: u64) -> Swept {
        Swept::Gone
    }
}
