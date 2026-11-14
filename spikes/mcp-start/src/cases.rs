//! The spike's cases. Each check prints one line that starts with PASS, FAIL or INFO.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::mcp::Client;
use crate::setup::{start, Console, Out, SavedSetup, StartError, StartOptions, ENV_ALLOWLIST};
use crate::win;

pub const EVERYTHING: &str = "@modelcontextprotocol/server-everything@2026.8.31";
pub const TIME_FROM: &str = "mcp-server-time==2026.10.28";
pub const BAD_PACKAGE: &str = "@familiar-spike-nonexistent/no-such-server@0.0.1";
const SECRET: &str = "s3cret-only-in-the-setup";
const PARENT_ONLY: &str = "FAMILIAR_SPIKE_PARENT_ONLY";

static FAILS: AtomicUsize = AtomicUsize::new(0);

fn pass(case: &str, what: &str) {
    println!("PASS {case}: {what}");
}
fn fail(case: &str, what: &str) {
    FAILS.fetch_add(1, Ordering::SeqCst);
    println!("FAIL {case}: {what}");
}
fn check(case: &str, ok: bool, what: &str) {
    if ok {
        pass(case, what)
    } else {
        fail(case, what)
    }
}
fn info(case: &str, what: &str) {
    println!("INFO {case}: {what}");
}

fn repo_root() -> PathBuf {
    let cwd = std::env::current_dir().expect("cwd");
    if !cwd.join("tools/fake-mcp-server/src/main.ts").is_file() {
        eprintln!("Run this from the repo root.");
        std::process::exit(2);
    }
    cwd
}

fn spike_dir() -> PathBuf {
    repo_root().join("spikes").join("mcp-start")
}

/// A working folder outside the repo, so npx doesn't see the pnpm workspace.
fn scratch_cwd() -> PathBuf {
    let d = std::env::temp_dir().join("familiar-spike-cwd");
    std::fs::create_dir_all(&d).expect("scratch dir");
    d
}

fn setup(label: &str, program: &str, args: &[&str], cwd: &Path, env: &[(&str, &str)]) -> SavedSetup {
    SavedSetup {
        label: label.into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: cwd.to_path_buf(),
        env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

const SLOW: Duration = Duration::from_secs(240);
const QUICK: Duration = Duration::from_secs(30);

pub fn run_cases(which: &[String]) -> i32 {
    let want = |c: &str| which.is_empty() || which.iter().any(|w| w == c);
    if want("a") {
        case_a();
    }
    if want("b") {
        case_b();
    }
    if want("c") {
        case_c();
    }
    if want("d") {
        case_d();
    }
    if want("f") {
        case_f();
    }
    if want("g") {
        case_g();
    }
    let fails = FAILS.load(Ordering::SeqCst);
    println!("SUMMARY: {fails} failed");
    if fails == 0 {
        0
    } else {
        1
    }
}

/// Start, initialize, list. Prints what it resolved to and how long it took.
fn open(case: &str, s: &SavedSetup, timeout: Duration) -> Option<(Client, Vec<String>)> {
    let t0 = Instant::now();
    let server = match start(s, &StartOptions::default()) {
        Ok(server) => server,
        Err(e) => {
            fail(case, &format!("{} did not start: {e}", s.label));
            return None;
        }
    };
    info(case, &format!("{} resolved {:?} to {}, pid {}", s.label, s.program, server.resolved.display(), server.child.id()));
    let mut client = Client::new(server);
    match client.initialize(timeout) {
        Ok(name) => pass(case, &format!("{} initialize answered by {name} in {} ms", s.label, t0.elapsed().as_millis())),
        Err(e) => {
            fail(case, &format!("{} initialize: {e}", s.label));
            client.server.stop();
            return None;
        }
    }
    match client.list_tools(QUICK) {
        Ok(tools) => {
            pass(case, &format!("{} tools/list: {}", s.label, tools.join(", ")));
            Some((client, tools))
        }
        Err(e) => {
            fail(case, &format!("{} tools/list: {e}", s.label));
            client.server.stop();
            None
        }
    }
}

fn case_a() {
    let root = repo_root();
    let main_ts = root.join("tools/fake-mcp-server/src/main.ts");
    let main_ts = main_ts.to_string_lossy();
    check("a", std::env::var_os(PARENT_ONLY).is_some(), &format!("the parent has {PARENT_ONLY} set, for the leak check"));
    check("a", std::env::var_os("FAKE_SECRET").is_none(), "the parent has no FAKE_SECRET of its own");
    let s = setup("node fake server", "node", &[&main_ts], &root, &[("FAKE_SECRET", SECRET)]);
    let Some((mut client, _)) = open("a", &s, QUICK) else { return };

    match client.call("echo", json!({ "text": "hello from rust" }), QUICK) {
        Ok((text, err)) => check("a", text == "hello from rust" && !err, &format!("echo answered {text:?}")),
        Err(e) => fail("a", &format!("echo: {e}")),
    }
    match client.call("print_secret", json!({}), QUICK) {
        Ok((text, _)) => check("a", text.contains(SECRET), &format!("print_secret got the setup's FAKE_SECRET ({} chars of answer)", text.len())),
        Err(e) => fail("a", &format!("print_secret: {e}")),
    }
    std::thread::sleep(Duration::from_millis(300));
    let tail = client.server.stderr_tail(20);
    check(
        "a",
        tail.iter().any(|l| l.contains("the secret is [hidden]")) && !tail.iter().any(|l| l.contains(SECRET)),
        &format!("stderr is captured apart from stdout, with the secret blanked: {:?}", tail.iter().filter(|l| l.contains("secret")).collect::<Vec<_>>()),
    );
    match client.call("list_env", json!({}), QUICK) {
        Ok((text, _)) => {
            let names: Vec<&str> = text.lines().collect();
            info("a", &format!("the server's environment names: {}", names.join(" ")));
            check("a", !names.iter().any(|n| n.eq_ignore_ascii_case(PARENT_ONLY)), &format!("{PARENT_ONLY} from the parent did not reach the server"));
            check("a", names.contains(&"FAKE_SECRET"), "FAKE_SECRET from the setup reached the server");
            let extra: Vec<&&str> = names
                .iter()
                .filter(|n| **n != "FAKE_SECRET" && !ENV_ALLOWLIST.iter().any(|a| a.eq_ignore_ascii_case(n)))
                .collect();
            check("a", extra.is_empty(), &format!("every name is on the allowlist or the setup's own (extras: {extra:?})"));
            let parent_count = std::env::vars_os().count();
            info("a", &format!("the parent had {parent_count} variables, the server got {}", names.len()));
        }
        Err(e) => fail("a", &format!("list_env: {e}")),
    }
    client.server.stop();
}

fn case_b() {
    let cwd = scratch_cwd();
    let s = setup("npx server-everything", "npx", &["-y", EVERYTHING], &cwd, &[]);
    let Some((mut client, tools)) = open("b", &s, SLOW) else { return };
    let ok = tools.iter().any(|t| t == "echo");
    check("b", ok, "server-everything lists echo");
    match client.call("echo", json!({ "message": "hello through npx" }), QUICK) {
        Ok((text, err)) => check("b", text.contains("hello through npx") && !err, &format!("echo answered {text:?}")),
        Err(e) => fail("b", &format!("echo: {e}")),
    }
    info("b", &format!("notifications seen: {:?}, junk lines: {}", client.notifications, client.junk.len()));
    client.server.stop();
}

fn case_c() {
    let cwd = scratch_cwd();
    let s = setup("uvx mcp-server-time", "uvx", &["--from", TIME_FROM, "mcp-server-time"], &cwd, &[]);
    let Some((mut client, tools)) = open("c", &s, SLOW) else { return };
    check("c", tools.iter().any(|t| t == "get_current_time"), "mcp-server-time lists get_current_time");
    match client.call("get_current_time", json!({ "timezone": "UTC" }), QUICK) {
        Ok((text, err)) => check("c", text.contains("UTC") && !err, &format!("get_current_time answered {}", text.replace('\n', " "))),
        Err(e) => fail("c", &format!("get_current_time: {e}")),
    }
    client.server.stop();
}

/// The arguments for the quoting check, with a short name for each.
fn quoting_args() -> Vec<(&'static str, String)> {
    vec![
        ("plain", "plain".into()),
        ("spaces", "two words here".into()),
        ("double quotes inside", r#"say "hi" now"#.into()),
        ("lone double quote", "\"".into()),
        ("percent PATH", "%PATH%".into()),
        ("percent alone", "100%".into()),
        ("double percent", "%%".into()),
        ("bang PATH", "!PATH!".into()),
        ("ampersand", "a&b".into()),
        ("caret", "a^b".into()),
        ("pipe", "a|b".into()),
        ("less than", "a<b".into()),
        ("greater than", "a>b".into()),
        ("parens", "(x)".into()),
        ("trailing backslash", r"C:\some dir\".into()),
        ("backslash then quote", r#"a\"b"#.into()),
        ("empty", "".into()),
        ("unicode", "café ü 日本".into()),
        ("flag with space", "--name=two words".into()),
        ("newline", "line1\nline2".into()),
        ("carriage return", "a\rb".into()),
        ("tab", "a\tb".into()),
        ("nul", "a\0b".into()),
    ]
}

enum Echo {
    Exact,
    Different(Vec<String>),
    Refused(String),
    NoOutput(String),
}

/// Starts a setup whose program prints its arguments as one JSON line, and compares them with what was sent.
fn echo_round(s: &SavedSetup, sent: &[String]) -> Echo {
    let mut server = match start(s, &StartOptions::default()) {
        Ok(server) => server,
        Err(StartError::Refused(e)) => return Echo::Refused(format!("kind={:?} message=\"{e}\"", e.kind())),
        Err(e) => return Echo::Refused(e.to_string()),
    };
    server.stdin.take();
    let deadline = Instant::now() + SLOW;
    let result = loop {
        match server.stdout.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Out::Line(line)) => {
                if let Ok(Value::Array(a)) = serde_json::from_str::<Value>(&line) {
                    let got: Vec<String> = a.iter().map(|v| v.as_str().unwrap_or("<not a string>").to_string()).collect();
                    break if got == sent { Echo::Exact } else { Echo::Different(got) };
                }
            }
            Ok(Out::TooLong(_)) | Ok(Out::Eof) | Err(RecvTimeoutError::Disconnected) => {
                let _ = server.child.wait();
                std::thread::sleep(Duration::from_millis(200));
                break Echo::NoOutput(format!("exit {:?}, stderr {:?}", server.child.try_wait().ok().flatten().and_then(|s| s.code()), server.stderr_tail(4)));
            }
            Err(RecvTimeoutError::Timeout) => break Echo::NoOutput("timed out".into()),
        }
    };
    server.stop();
    result
}

fn shorten(s: &str) -> String {
    let s = format!("{s:?}");
    if s.chars().count() > 80 {
        format!("{}...(cut)", s.chars().take(80).collect::<String>())
    } else {
        s
    }
}

fn case_d() {
    let dir = spike_dir();
    let js = dir.join("fixtures/echo-args/echo-args.js").to_string_lossy().into_owned();
    let cmd = dir.join("fixtures/echo-args.cmd").to_string_lossy().into_owned();
    let pkg = format!("--package={}", dir.join("fixtures/echo-args").display());
    let cwd = scratch_cwd();

    // Warm npx's cache for the local package, so each round below is quick.
    let warm = setup("npx warm", "npx", &["-y", &pkg, "familiar-spike-echo-args", "warm"], &cwd, &[]);
    match echo_round(&warm, &["warm".into()]) {
        Echo::Exact => info("d", "npx runs the local echo-args package"),
        Echo::Different(g) => info("d", &format!("npx warm-up got {g:?}")),
        Echo::Refused(e) | Echo::NoOutput(e) => info("d", &format!("npx warm-up failed: {e}")),
    }

    struct Route {
        name: &'static str,
        program: String,
        prefix: Vec<String>,
    }
    let routes = [
        Route { name: "node.exe direct", program: "node".into(), prefix: vec![js.clone()] },
        Route { name: "own .cmd", program: cmd.clone(), prefix: vec![] },
        Route { name: "npx.cmd", program: "npx".into(), prefix: vec!["-y".into(), pkg.clone(), "familiar-spike-echo-args".into()] },
    ];

    let args = quoting_args();
    for route in &routes {
        let mut exact = Vec::new();
        for (name, arg) in &args {
            let mut all: Vec<String> = route.prefix.clone();
            all.push(arg.clone());
            let s = SavedSetup {
                label: route.name.into(),
                program: route.program.clone(),
                args: all,
                cwd: cwd.clone(),
                env: vec![],
            };
            let sent = vec![arg.clone()];
            let line = match echo_round(&s, &sent) {
                Echo::Exact => {
                    exact.push(*name);
                    format!("exact     {name:<22} {}", shorten(arg))
                }
                Echo::Different(got) => format!("DIFFERENT {name:<22} sent {} got {}", shorten(arg), shorten(&format!("{got:?}"))),
                Echo::Refused(e) => format!("REFUSED   {name:<22} sent {} : {e}", shorten(arg)),
                Echo::NoOutput(e) => format!("NO OUTPUT {name:<22} sent {} : {e}", shorten(arg)),
            };
            println!("QUOTE [{}] {line}", route.name);
        }
        info("d", &format!("[{}] {} of {} arguments arrived exactly", route.name, exact.len(), args.len()));
    }

    // All the arguments that need no refusal, at once, as a real setup would pass several.
    let together: Vec<String> = args
        .iter()
        .filter(|(n, _)| !matches!(*n, "newline" | "carriage return" | "nul"))
        .map(|(_, a)| a.clone())
        .collect();
    for route in &routes {
        let mut all = route.prefix.clone();
        all.extend(together.iter().cloned());
        let s = SavedSetup { label: route.name.into(), program: route.program.clone(), args: all, cwd: cwd.clone(), env: vec![] };
        match echo_round(&s, &together) {
            Echo::Exact => pass("d", &format!("[{}] all {} other arguments together arrived exactly", route.name, together.len())),
            Echo::Different(got) => fail("d", &format!("[{}] together: got {}", route.name, shorten(&format!("{got:?}")))),
            Echo::Refused(e) => fail("d", &format!("[{}] together: refused {e}", route.name)),
            Echo::NoOutput(e) => fail("d", &format!("[{}] together: {e}", route.name)),
        }
    }
}

fn case_f() {
    let dir = spike_dir();
    let cwd = scratch_cwd();

    // A program that isn't there.
    let s = setup("missing program", "familiar-no-such-program", &[], &cwd, &[]);
    match start(&s, &StartOptions::default()) {
        Err(e @ StartError::NotFound(_)) => pass("f", &format!("a missing program is reported before anything runs: {e}")),
        Err(e) => fail("f", &format!("missing program: unexpected {e}")),
        Ok(server) => {
            fail("f", "a missing program started");
            server.stop();
        }
    }

    // A package that doesn't exist: npx exits at once.
    let s = setup("npx bad package", "npx", &["-y", BAD_PACKAGE], &cwd, &[]);
    let t0 = Instant::now();
    match start(&s, &StartOptions::default()) {
        Ok(server) => {
            let mut client = Client::new(server);
            match client.initialize(SLOW) {
                Err(e @ crate::mcp::McpError::Exited { .. }) => {
                    pass("f", &format!("a bad package is reported as an exit after {} ms: {e}", t0.elapsed().as_millis()))
                }
                Err(e) => fail("f", &format!("bad package: unexpected {e}")),
                Ok(_) => fail("f", "bad package answered initialize"),
            }
            client.server.stop();
        }
        Err(e) => fail("f", &format!("bad package did not start: {e}")),
    }

    // Junk on stdout, then proper answers.
    let junk = dir.join("fixtures/junk-stdout.js").to_string_lossy().into_owned();
    let s = setup("junk then valid", "node", &[&junk, "then-valid"], &cwd, &[]);
    if let Ok(server) = start(&s, &StartOptions::default()) {
        let mut client = Client::new(server);
        let init = client.initialize(QUICK);
        let list = client.list_tools(QUICK);
        check(
            "f",
            init.is_ok() && list.is_ok(),
            &format!(
                "junk then valid: initialize {}, tools/list {}, {} junk lines skipped: {:?}",
                if init.is_ok() { "ok" } else { "failed" },
                if list.is_ok() { "ok" } else { "failed" },
                client.junk.len(),
                client.junk
            ),
        );
        client.server.stop();
    } else {
        fail("f", "junk then valid did not start");
    }

    // Junk only: the time limit catches it.
    let s = setup("junk only", "node", &[&junk, "junk-only"], &cwd, &[]);
    if let Ok(server) = start(&s, &StartOptions::default()) {
        let mut client = Client::new(server);
        match client.initialize(Duration::from_secs(5)) {
            Err(e @ crate::mcp::McpError::Timeout { .. }) => pass("f", &format!("junk only is reported as a time-out: {e}. First lines: {:?}", &client.junk[..client.junk.len().min(3)])),
            Err(e) => fail("f", &format!("junk only: unexpected {e}")),
            Ok(_) => fail("f", "junk only answered initialize"),
        }
        client.server.stop();
    } else {
        fail("f", "junk only did not start");
    }
}

/// Prints `PROBE` lines: this process's console window, and with --spawn-child, a plain child's too.
pub fn console_probe(spawn_child: bool) -> i32 {
    let (hwnd, visible) = win::console_window();
    let me = std::path::Path::new(&std::env::current_exe().unwrap_or_default()).to_path_buf();
    println!("PROBE pid={} depth={} console_hwnd={:#x} visible={}", std::process::id(), if spawn_child { "server" } else { "child" }, hwnd, visible);
    if spawn_child {
        // A child started the ordinary way, as npx starts node: no flags. It shares its parent's console.
        let _ = Command::new(me).arg("console-probe").status();
    }
    0
}

fn probe_round(label: &str, s: &SavedSetup, console: Console) -> Vec<(usize, bool)> {
    let opts = StartOptions { console, job: true };
    let mut server = match start(s, &opts) {
        Ok(server) => server,
        Err(e) => {
            fail("g", &format!("{label}: did not start: {e}"));
            return vec![];
        }
    };
    server.stdin.take();
    let mut out = Vec::new();
    let deadline = Instant::now() + QUICK;
    while let Ok(Out::Line(line)) = server.stdout.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        info("g", &format!("{label}: {line}"));
        let hwnd = line.split("console_hwnd=0x").nth(1).and_then(|r| usize::from_str_radix(r.split(' ').next().unwrap_or(""), 16).ok());
        let visible = line.contains("visible=true");
        if let Some(h) = hwnd {
            out.push((h, visible));
        }
    }
    server.stop();
    out
}

fn case_g() {
    let me = std::env::current_exe().expect("exe").to_string_lossy().into_owned();
    let (hwnd, visible) = win::console_window();
    info("g", &format!("the spike itself (started by the runner's shell): console_hwnd={hwnd:#x} visible={visible}"));
    let cwd = scratch_cwd();
    let direct = setup("probe", &me, &["console-probe", "--spawn-child"], &cwd, &[]);

    let control = probe_round("control, CREATE_NEW_CONSOLE", &direct, Console::NewConsole);
    let control_has_window = control.first().map(|(h, _)| *h != 0).unwrap_or(false);
    info("g", &format!("control shows a console window: {control_has_window}, visible: {:?}", control.first().map(|c| c.1)));

    let quiet = probe_round("CREATE_NO_WINDOW", &direct, Console::NoWindow);
    check("g", quiet.len() == 2 && quiet.iter().all(|(h, _)| *h == 0), "with CREATE_NO_WINDOW the server and its child have no console window");

    let cmd = spike_dir().join("fixtures/run-probe.cmd").to_string_lossy().into_owned();
    let via_cmd = setup("probe via .cmd", &cmd, &[&me], &cwd, &[]);
    let quiet_cmd = probe_round("CREATE_NO_WINDOW via .cmd", &via_cmd, Console::NoWindow);
    check("g", quiet_cmd.len() == 2 && quiet_cmd.iter().all(|(h, _)| *h == 0), "through cmd.exe, the grandchild and great-grandchild have no console window either");
    if !control_has_window {
        info("g", "the control got no window either, so this runner can't tell the two apart");
    }
}

// ---- e: cleanup when the app dies hard ----

pub fn hold(no_job: bool) -> i32 {
    let cwd = scratch_cwd();
    let opts = StartOptions { console: Console::NoWindow, job: !no_job };
    let setups = [
        setup("npx server-everything", "npx", &["-y", EVERYTHING], &cwd, &[]),
        setup("uvx mcp-server-time", "uvx", &["--from", TIME_FROM, "mcp-server-time"], &cwd, &[]),
    ];
    let mut clients = Vec::new();
    for s in &setups {
        let server = match start(s, &opts) {
            Ok(server) => server,
            Err(e) => {
                eprintln!("hold: {} did not start: {e}", s.label);
                return 1;
            }
        };
        let mut client = Client::new(server);
        if let Err(e) = client.initialize(SLOW).and_then(|_| client.list_tools(QUICK)) {
            eprintln!("hold: {}: {e}", s.label);
            return 1;
        }
        println!("HOLD-SERVER {} pid={} in_job={}", s.label, client.server.child.id(), client.server.job.is_some());
        clients.push(client);
    }
    // A server busy in a call when the app dies. MCP servers exit when stdin closes, but not while a call is running.
    // Through a .cmd, so cmd.exe sits between the app and node, as with npx.
    let fake_cmd = spike_dir().join("fixtures/fake-server.cmd").to_string_lossy().into_owned();
    let busy = setup("busy fake server via .cmd", &fake_cmd, &[], &repo_root(), &[]);
    match start(&busy, &opts) {
        Ok(server) => {
            let mut client = Client::new(server);
            if let Err(e) = client.initialize(QUICK) {
                eprintln!("hold: busy server: {e}");
                return 1;
            }
            let call = json!({ "jsonrpc": "2.0", "id": 900, "method": "tools/call", "params": { "name": "slow", "arguments": { "ms": 60000 } } });
            if let Err(e) = client.server.send_line(&call.to_string()) {
                eprintln!("hold: busy server: {e}");
                return 1;
            }
            println!("HOLD-SERVER {} pid={} in_job={} (a 60 s call in flight)", busy.label, client.server.child.id(), client.server.job.is_some());
            clients.push(client);
        }
        Err(e) => {
            eprintln!("hold: busy server did not start: {e}");
            return 1;
        }
    }
    println!("HOLD-READY");
    std::thread::sleep(Duration::from_secs(600));
    drop(clients);
    0
}

fn print_tree(label: &str, root: u32, procs: &[(usize, win::ProcInfo)]) {
    println!("TREE {label}: root pid {root}, {} descendants", procs.len());
    for (depth, p) in procs {
        println!("TREE {label}: {}{} pid={} parent={}", "  ".repeat(*depth), p.exe, p.pid, p.parent);
    }
}

pub fn kill_test(no_job: bool) -> i32 {
    let case = if no_job { "e-control" } else { "e" };
    let me = std::env::current_exe().expect("exe");
    let mut cmd = Command::new(&me);
    cmd.arg("hold").stdout(Stdio::piped()).stderr(Stdio::inherit());
    if no_job {
        cmd.arg("--no-job");
    }
    let mut hold = cmd.spawn().expect("start hold");
    let hold_pid = hold.id();
    let mut reader = BufReader::new(hold.stdout.take().unwrap());
    let ready_by = Instant::now() + Duration::from_secs(400);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || Instant::now() > ready_by {
            fail(case, "hold never said HOLD-READY");
            let _ = hold.kill();
            return 1;
        }
        print!("{line}");
        if line.trim() == "HOLD-READY" {
            break;
        }
    }
    // Let both servers' trees settle.
    std::thread::sleep(Duration::from_secs(2));

    let before = win::snapshot_processes().expect("snapshot");
    let tree = win::descendants(&before, hold_pid);
    print_tree("before", hold_pid, &tree);
    let handles: Vec<(win::ProcInfo, Option<win::ProcHandle>)> =
        tree.iter().map(|(_, p)| (p.clone(), win::ProcHandle::open(p.pid))).collect();
    let unopened: Vec<String> = handles.iter().filter(|(_, h)| h.is_none()).map(|(p, _)| format!("{} {}", p.exe, p.pid)).collect();
    if !unopened.is_empty() {
        info(case, &format!("could not open (already gone?): {unopened:?}"));
    }
    let names: Vec<String> = tree.iter().map(|(_, p)| p.exe.to_ascii_lowercase()).collect();
    check(case, names.iter().any(|n| n == "node.exe") && names.iter().any(|n| n == "python.exe"), "the tree holds node and python grandchildren");

    // The hard kill: std's Child::kill is TerminateProcess. No cleanup code in `hold` runs.
    let t0 = Instant::now();
    hold.kill().expect("TerminateProcess");
    let _ = hold.wait();
    println!("KILLED hold pid {hold_pid} with TerminateProcess");

    let limit = Duration::from_secs(5);
    let mut survivors = Vec::new();
    let mut last_exit = Duration::ZERO;
    for (p, h) in &handles {
        let Some(h) = h else { continue };
        let left = limit.saturating_sub(t0.elapsed());
        if h.wait_ms(left.as_millis() as u32) {
            last_exit = last_exit.max(t0.elapsed());
            println!("EXITED {} pid={} by {} ms", p.exe, p.pid, t0.elapsed().as_millis());
        } else {
            survivors.push(p.clone());
        }
    }
    let after = win::snapshot_processes().expect("snapshot");
    let alive: Vec<&win::ProcInfo> = after.iter().filter(|p| tree.iter().any(|(_, q)| q.pid == p.pid && q.exe == p.exe)).collect();
    println!("AFTER {} ms: {} of the {} processes still running", t0.elapsed().as_millis(), survivors.len(), handles.len());
    for p in &alive {
        println!("AFTER still listed: {} pid={} parent={}", p.exe, p.pid, p.parent);
    }

    if no_job {
        info(case, &format!("without a job, {} of {} processes outlived the app: {:?}", survivors.len(), handles.len(), survivors.iter().map(|p| &p.exe).collect::<Vec<_>>()));
        check(
            case,
            survivors.iter().any(|p| p.exe.eq_ignore_ascii_case("node.exe")),
            "the control shows the job is what ends a busy server: without it, node outlives the app",
        );
        for (p, h) in &handles {
            if let Some(h) = h {
                if survivors.iter().any(|s| s.pid == p.pid) {
                    h.terminate();
                }
            }
        }
    } else {
        check(
            case,
            survivors.is_empty() && handles.iter().filter(|(_, h)| h.is_some()).count() > 0,
            &format!("every process in the tree ended within {} ms of the hard kill (limit {} ms)", last_exit.as_millis(), limit.as_millis()),
        );
    }
    if FAILS.load(Ordering::SeqCst) == 0 {
        0
    } else {
        1
    }
}
