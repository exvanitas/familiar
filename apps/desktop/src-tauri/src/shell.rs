//! The shell's state, the one channel to core, and how a run ends.

use serde_json::Value;
use shell_core::{
    args::Args,
    log::{Limiter, Log},
    queue::Pending,
    run::Run,
    sink::Counts,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager};

pub struct Shell {
    pub app_dir: PathBuf,
    pub data_dir: PathBuf,
    pub webview_dir: PathBuf,
    pub log_path: PathBuf,
    pub args: Vec<String>,
    pub autostarted: bool,
    pub devtools: bool,
    pub log: Arc<Log>,
    pub sink_port: u16,
    pub sink: Arc<Counts>,
    run: Mutex<Run>,
    /// Everything the exe tells core goes here. A channel's messages reach only the page that
    /// made it, unlike a Tauri event, which any window's listener can hear.
    core: Mutex<CoreLink>,
    pub limiter: Mutex<Limiter>,
}

/// The channel to core once it's ready, and what waits for it until then.
#[derive(Default)]
struct CoreLink {
    channel: Option<Channel<Value>>,
    pending: Pending<Value>,
}

/// Nothing is held across a panic that needs protecting, so a poisoned lock is still good.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shell {
    #[allow(clippy::too_many_arguments)]
    pub fn new(app_dir: PathBuf, data_dir: PathBuf, webview_dir: PathBuf, log_path: PathBuf, args: &Args, log: Arc<Log>, sink_port: u16, sink: Arc<Counts>) -> Shell {
        Shell {
            app_dir,
            data_dir,
            webview_dir,
            log_path,
            args: args.raw.clone(),
            autostarted: args.autostart,
            devtools: args.devtools,
            log,
            sink_port,
            sink,
            run: Mutex::default(),
            core: Mutex::default(),
            limiter: Mutex::default(),
        }
    }

    pub fn run(&self) -> MutexGuard<'_, Run> {
        lock(&self.run)
    }

    /// Core is ready: what waited for it goes first, in order, under the same lock, so nothing
    /// sent meanwhile can pass it.
    pub fn set_core(&self, channel: Channel<Value>) {
        let mut link = lock(&self.core);
        let (held, dropped) = link.pending.take();
        if dropped > 0 {
            self.log.line(&format!("{dropped} messages for core were dropped before it was ready"));
        }
        for m in held {
            if channel.send(m).is_err() {
                self.log.line("core's channel refused a message");
            }
        }
        link.channel = Some(channel);
    }

    /// Sends one message to core. Before core is ready, it's held (see `shell_core::queue`).
    pub fn tell_core(&self, message: Value) {
        let mut link = lock(&self.core);
        match link.channel.as_ref() {
            Some(ch) => {
                if ch.send(message).is_err() {
                    self.log.line("core's channel refused a message");
                }
            }
            None => link.pending.push(message),
        }
    }
}

/// Tells core, waits for its `quit_ready` (see `shell_core::run`), then ends the run. Nothing here
/// depends on core answering, so it works with core dead.
pub fn quit(app: &AppHandle, why: &str) {
    let shell = app.state::<Shell>();
    if !shell.run().start_quit(Instant::now()) {
        return;
    }
    shell.log.line(&format!("quit: {why}"));
    shell.tell_core(serde_json::json!({ "t": "quitting" }));
    let app = app.clone();
    thread::spawn(move || {
        let shell = app.state::<Shell>();
        let start = Instant::now();
        while !shell.run().quit_done(Instant::now()) {
            thread::sleep(Duration::from_millis(20));
        }
        shell.log.line(&format!("quit: done after {} ms", start.elapsed().as_millis()));
        shell.log.line(&shell.sink.line());
        app.exit(0);
        thread::sleep(Duration::from_secs(3));
        std::process::exit(0);
    });
}
