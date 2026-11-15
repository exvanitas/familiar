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
    actor::{Effect, Gen, Machine, Msg, State, Token},
    approvals::{self, Load, Store},
    records,
    server_path::{self, Launch, PathError},
    setup::{self, Canonical, Event, Lines, Plan, Setup, Stream},
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
    /// Run id to its setup and generation, while the run exists. A run id names one generation
    /// of one setup's actor, so a command for a run that's over can't reach the next one.
    runs: Mutex<HashMap<String, (String, Gen)>>,
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
    Stop { gen: Gen, reply: Reply<()> },
    Forget { reply: Reply<()> },
    Write { gen: Gen, bytes: Vec<u8>, reply: Reply<()> },
    /// What the actor's own threads report, each for the generation it was made for.
    Report(Gen, Report),
}

enum Report {
    /// The approved canonical form, and whether it must be stored (approved just now).
    AskDone(Result<(Box<Canonical>, bool), &'static str>),
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

/// A command waiting for the machine's answer, by its token.
enum Pending {
    Start(Reply<Started>),
    Unit(Reply<()>),
    Write(Vec<u8>, Reply<()>),
}

/// One start attempt and, once it runs, its run. Everything here belongs to one generation.
struct Attempt {
    gen: Gen,
    setup: Box<Setup>,
    owner: Option<String>,
    channel: Channel<Value>,
    /// The approved canonical form, held as a value from the ask: the one thing a spawn launches.
    form: Option<Box<Canonical>>,
    run: Option<String>,
    job: Option<Arc<os::Job>>,
    input: Option<Writer>,
}

/// What an actor holds besides its state.
struct Actor {
    app: AppHandle,
    setup_id: String,
    tx: mpsc::SyncSender<Cmd>,
    machine: Machine,
    next_token: Token,
    pending: HashMap<Token, Pending>,
    /// A start's setup, between its command and the machine's `BeginAsk`.
    incoming: Option<(Box<Setup>, Option<String>, Channel<Value>)>,
    attempt: Option<Attempt>,
    /// Children made and suspended, waiting for the actor's word, by generation.
    waiting: HashMap<Gen, (Arc<os::Job>, mpsc::Sender<bool>)>,
}

fn spawn_actor(app: AppHandle, setup_id: String) -> mpsc::SyncSender<Cmd> {
    let (tx, rx) = mpsc::sync_channel::<Cmd>(QUEUE);
    let mut a = Actor {
        app,
        setup_id,
        tx: tx.clone(),
        machine: Machine::default(),
        next_token: 0,
        pending: HashMap::new(),
        incoming: None,
        attempt: None,
        waiting: HashMap::new(),
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

    /// Reports from a helper thread come back on the actor's own queue, stamped with their
    /// generation. Blocking here is fine: it's the helper's thread.
    fn reporter(&self, gen: Gen) -> impl Fn(Report) + Send + Clone + 'static {
        let tx = self.tx.clone();
        move |r| {
            let _ = tx.send(Cmd::Report(gen, r));
        }
    }

    fn token(&mut self, p: Pending) -> Token {
        let t = self.next_token;
        self.next_token += 1;
        self.pending.insert(t, p);
        t
    }

    /// The attempt, if it's this generation's.
    fn of(&mut self, gen: Gen) -> Option<&mut Attempt> {
        self.attempt.as_mut().filter(|a| a.gen == gen)
    }

    fn handle(&mut self, cmd: Cmd) {
        let mut held = self.machine.holds_slot();
        let before = self.machine.state();
        let msg = match cmd {
            Cmd::Start { setup, owner, channel, reply } => {
                // A start that would begin an attempt takes its slot first; one that retries a
                // failed removal and is refused gives it back below.
                if self.machine.admits_start() {
                    if !self.servers().take_slot() {
                        let _ = reply.send(Err(fail("busy", "16 servers are running or starting")));
                        return;
                    }
                    held = true;
                }
                self.incoming = Some((setup, owner, channel));
                Msg::Start(self.token(Pending::Start(reply)))
            }
            Cmd::Stop { gen, reply } => Msg::Stop(self.token(Pending::Unit(reply)), gen),
            Cmd::Forget { reply } => Msg::Forget(self.token(Pending::Unit(reply))),
            Cmd::Write { gen, bytes, reply } => Msg::Write(self.token(Pending::Write(bytes, reply)), gen),
            Cmd::Report(gen, r) => match r {
                Report::AskDone(r) => {
                    let r = r.map(|(form, store)| {
                        // Held as a value, on both paths: approved before, and approved just now.
                        if let Some(a) = self.of(gen) {
                            a.form = Some(form);
                        }
                        store
                    });
                    Msg::AskDone(gen, r)
                }
                Report::Spawned { job, go } => {
                    self.waiting.insert(gen, (job, go));
                    Msg::Spawned(gen)
                }
                Report::Resumed { input } => {
                    let running = self.machine.state() == State::Running && self.machine.run() == Some(gen);
                    // Stopped before it resumed, or another run's: its input closes at once.
                    if let (true, Some(a)) = (running, self.of(gen)) {
                        a.input = input;
                    }
                    Msg::Resumed(gen)
                }
                Report::SpawnFailed(kind) => Msg::SpawnFailed(gen, kind),
                Report::Exited => Msg::Exited(gen),
                Report::Deadline => Msg::Deadline(gen),
            },
        };
        let fx = self.machine.handle(msg);
        self.apply(fx);
        self.incoming = None;
        let after = self.machine.state();
        if before != after {
            self.log(&format!("{before:?} -> {after:?}"));
        }
        if !self.machine.holds_slot() {
            self.end_attempt();
        }
        if held && !self.machine.holds_slot() {
            self.servers().release_slot();
        }
    }

    /// The attempt's bookkeeping, once the machine holds none: its run id leaves the map.
    fn end_attempt(&mut self) {
        if let Some(a) = self.attempt.take() {
            if let Some(run) = a.run {
                lock(&self.servers().runs).remove(&run);
            }
        }
    }

    fn apply(&mut self, fx: Vec<Effect>) {
        for e in fx {
            match e {
                Effect::BeginAsk(gen) => {
                    let (setup, owner, channel) = self.incoming.take().expect("a start's setup");
                    self.attempt = Some(Attempt { gen, setup, owner, channel, form: None, run: None, job: None, input: None });
                    self.begin_ask(gen);
                }
                Effect::StoreApproval(gen) => {
                    // The held form stays held: the store gets a copy.
                    let form = self.of(gen).and_then(|a| a.form.clone());
                    let id = self.setup_id.clone();
                    let ok = match form {
                        Some(form) => self.servers().store_call(&self.app, |reply| StoreReq::Approve { id, form, reply }).unwrap_or(false),
                        None => false,
                    };
                    self.log(if ok { "approval stored" } else { "the approval couldn't be stored" });
                    let more = self.machine.handle(Msg::Stored(gen, ok));
                    self.apply(more);
                }
                Effect::BeginSpawn(gen) => self.begin_spawn(gen),
                Effect::Go(gen) => {
                    let Some((job, go)) = self.waiting.remove(&gen) else { continue };
                    let run = format!("{}-{gen}", run_id());
                    lock(&self.servers().runs).insert(run.clone(), (self.setup_id.clone(), gen));
                    if let Some(a) = self.of(gen) {
                        a.job = Some(job);
                        a.run = Some(run);
                    }
                    let _ = go.send(true);
                }
                Effect::Abort(gen) => {
                    if let Some((_, go)) = self.waiting.remove(&gen) {
                        let _ = go.send(false);
                    }
                }
                Effect::CloseInput(gen) => {
                    // Dropping the queue closes stdin once a write in flight ends; ending the job
                    // breaks that write.
                    if let Some(a) = self.of(gen) {
                        a.input = None;
                    }
                }
                Effect::ArmDeadline(gen) => {
                    let report = self.reporter(gen);
                    thread::spawn(move || {
                        thread::sleep(STOP_AFTER);
                        report(Report::Deadline);
                    });
                }
                Effect::Terminate(gen) => {
                    if let Some(j) = self.of(gen).and_then(|a| a.job.clone()) {
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
                Effect::Forward(t) => match self.pending.remove(&t) {
                    Some(Pending::Write(bytes, reply)) => self.write(bytes, reply),
                    _ => self.log("a forward with no write waiting"),
                },
                Effect::Reply(t, r) => self.reply(t, r),
            }
        }
    }

    /// Each token is answered once: its reply leaves the map as it's sent.
    fn reply(&mut self, t: Token, r: Result<Option<Gen>, &'static str>) {
        match self.pending.remove(&t) {
            Some(Pending::Start(reply)) => {
                let r = match r {
                    Ok(Some(gen)) => match self.of(gen).and_then(|a| a.run.clone()) {
                        Some(run) => Ok(Started { run }),
                        None => Err(fail("failed", "the run has no id")),
                    },
                    Ok(None) => Err(fail("failed", "the run has no id")),
                    Err(kind) => Err(fail(kind, "not started")),
                };
                let _ = reply.send(r);
            }
            Some(Pending::Unit(reply)) | Some(Pending::Write(_, reply)) => {
                let _ = reply.send(r.map(|_| ()).map_err(|k| fail(k, "not done")));
            }
            None => self.log("a reply with no command waiting"),
        }
    }

    /// Writes are bounded, so a server that stops reading can't fill memory or the queue.
    fn write(&mut self, bytes: Vec<u8>, reply: Reply<()>) {
        let Some(w) = self.attempt.as_ref().and_then(|a| a.input.as_ref()) else {
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
    fn begin_ask(&mut self, gen: Gen) {
        let report = self.reporter(gen);
        let Some(a) = self.of(gen) else { return };
        let (setup, owner) = (a.setup.clone(), a.owner.clone());
        let app = self.app.clone();
        thread::spawn(move || {
            let r = ask(&app, &setup, owner.as_deref());
            report(Report::AskDone(r));
        });
    }

    /// The spawn, on a thread of its own, from the held form and nothing else.
    fn begin_spawn(&mut self, gen: Gen) {
        let report = self.reporter(gen);
        let Some((form, channel)) = self.of(gen).and_then(|a| Some((a.form.clone()?, a.channel.clone()))) else {
            // Never: `BeginSpawn` follows an approval, which held the form. Answered, not assumed.
            let more = self.machine.handle(Msg::SpawnFailed(gen, "failed"));
            self.apply(more);
            return;
        };
        let (app, id) = (self.app.clone(), self.setup_id.clone());
        thread::spawn(move || {
            if let Err(kind) = spawn(&app, &id, &form, channel, report.clone()) {
                report(Report::SpawnFailed(kind));
            }
        });
    }
}

/// The ask: the walk (local only), the form, and the dialog only if the form isn't the one
/// approved. The form either way, and whether it must be stored.
fn ask(app: &AppHandle, setup: &Setup, owner: Option<&str>) -> Result<(Box<Canonical>, bool), &'static str> {
    let shell = app.state::<Shell>();
    let launch = walk(&setup.program, &setup.cwd).map_err(|e| e.kind)?;
    let form = Box::new(Canonical::new(setup, &launch));
    let servers = app.state::<Servers>();
    let id = setup.id.clone();
    let f2 = form.clone();
    if servers.store_call(app, |reply| StoreReq::Approved { id, form: f2, reply }).unwrap_or(false) {
        shell.log.line(&format!("server {}: approved before, no dialog", setup.id));
        return Ok((form, false));
    }
    // Only a new or changed form involves the confirm state; `busy` or `asks-stopped` ends it.
    let ticket = confirm::reserve(app).map_err(|e| e.kind())?;
    let a = shell_core::confirm::start_program(&setup.label, &form);
    if !ticket.ask(owner, a).map_err(|e| e.kind())? {
        return Err("declined");
    }
    Ok((form, true))
}

/// Makes the child from the approved form and lets it run, or reports why not. On the spawn's own
/// thread. Everything launched comes from `Plan::of(form)`: never the setup a page sent, nor a
/// walk made after the approval. The walk again, before the spawn and once more after it (the
/// image mapped, nothing of it run yet), must find exactly the approved targets.
fn spawn(app: &AppHandle, setup_id: &str, form: &Canonical, channel: Channel<Value>, report: impl Fn(Report) + Send + Clone + 'static) -> Result<(), &'static str> {
    let shell = app.state::<Shell>();
    let approved = form.launch();
    server_path::recheck(&fs(), &approved).map_err(|e| e.kind())?;
    let plan = Plan::of(form);
    let mut secrets = Vec::new();
    for name in &plan.secrets {
        secrets.push((name.clone(), secrets::server_secret(setup_id, name).ok_or("no-key")?));
    }
    let parent: Vec<(String, String)> = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let env = plan.environment(parent.iter().map(|(k, v)| (k.as_str(), v.as_str())), &secrets);
    let values: Vec<String> = secrets.into_iter().map(|(_, v)| v).collect();
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args).current_dir(&plan.cwd).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let record = Record::new(&shell);
    let go_report = report.clone();
    let log = shell.log.clone();
    let id = setup_id.to_string();
    let started = os::start(
        cmd,
        |pid| record.write(pid),
        move |job| {
            if let Err(e) = server_path::recheck(&fs(), &approved) {
                log.line(&format!("server {id}: the walk before resume no longer finds the approved targets"));
                return Err(e.kind());
            }
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
    let (mut child, job) = started.inspect_err(|kind| shell.log.line(&format!("server {setup_id}: start failed ({kind})")))?;

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
    let id = setup_id.to_string();
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
    let (setup, gen) = lock(&servers.runs).get(&spec.run).cloned().ok_or_else(|| fail("missing", "no such run"))?;
    let (reply, answer) = oneshot::channel();
    servers.send(&app, &setup, Cmd::Write { gen, bytes: bytes.clone(), reply })?;
    answer.await.map_err(|_| fail("failed", "the server's actor has gone"))?
}

#[tauri::command]
pub async fn server_stop(app: AppHandle, run: String) -> Res<()> {
    let servers = app.state::<Servers>();
    let (setup, gen) = lock(&servers.runs).get(&run).cloned().ok_or_else(|| fail("missing", "no such run"))?;
    let (reply, answer) = oneshot::channel();
    servers.send(&app, &setup, Cmd::Stop { gen, reply })?;
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
        temp::write_atomic(&path, &records::bytes(pid, created))?;
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
/// proven gone, and only then is that record deleted. One that can't be read, or whose process
/// can't be ended or proven gone, stays for the next start; one that can't be parsed is renamed
/// aside. Every record kept or set aside is logged. The rule is `shell_core::records::sweep`.
pub fn sweep(shell: &Shell) {
    let dir = shell.data_dir.join("shell").join("starting");
    let out = records::sweep(&dir, os::sweep_one);
    let (mut ended, mut gone, mut kept, mut aside) = (0, 0, 0, 0);
    for (name, o) in &out {
        match o {
            records::Outcome::Ended => ended += 1,
            records::Outcome::Gone => gone += 1,
            records::Outcome::Kept(why) => {
                kept += 1;
                shell.log.line(&format!("servers: start record {name} kept for the next start: {why}"));
            }
            records::Outcome::Aside { moved } => {
                aside += 1;
                shell.log.line(&format!("servers: start record {name} unreadable: renamed aside {moved}"));
            }
        }
    }
    if !out.is_empty() {
        shell.log.line(&format!("servers: start records left by a hard kill: {ended} children ended, {gone} gone, {kept} kept for the next start, {aside} set aside"));
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

    pub use shell_win::start::Job;
    use shell_core::records::Swept;

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
        match start::sweep_one(pid, created) {
            start::Swept::Ended => Swept::Ended,
            start::Swept::Gone => Swept::Gone,
            start::Swept::Failed => Swept::Failed,
        }
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

    use shell_core::records::Swept;

    pub fn start(_: Command, _: impl FnOnce(u32) -> std::io::Result<()>, _: impl FnOnce(&Arc<Job>) -> Result<(), &'static str>) -> Result<(Child, Arc<Job>), &'static str> {
        Err("start-failed")
    }

    pub fn creation_time(_: u32) -> Option<u64> {
        None
    }

    pub fn sweep_one(_: u32, _: u64) -> Swept {
        Swept::Failed
    }
}
