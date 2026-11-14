//! Familiar's native shell. It holds general native building blocks and the gates that must not
//! live in a webview. Everything else is the `app` folder beside it, so app changes never need a
//! new exe. See docs/shell-design.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod addresses;
mod assets;
mod commands;
mod confirm;
mod pages;
mod platform;
mod shell;
mod sink;
mod tray;

use assets::FolderAssets;
use shell::Shell;
use shell_core::{args::Args, folders, identity, log::Log, run::READY_WITHIN, views};
use std::{path::PathBuf, sync::Arc, thread, time::Instant};
use tauri::{AppHandle, Manager, RunEvent};

fn beside_exe() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("app"))).unwrap_or_else(|| "app".into())
}

/// The one thing the exe says by itself: a dead start, with no page to say it.
fn give_up(log: &Log, why: &str, text: &str) -> ! {
    log.line(&format!("error {why}"));
    platform::message_box("Familiar", text);
    std::process::exit(1);
}

/// A second launch hands its arguments here, then exits.
fn second_launch(app: &AppHandle, argv: Vec<String>, _cwd: String) {
    let args = Args::parse(argv.into_iter().skip(1).collect());
    let Some(shell) = app.try_state::<Shell>() else { return };
    shell.log.line(&format!("second launch: {}", args.summary()));
    shell.tell_core(serde_json::json!({ "t": "second-launch", "args": args.raw }));
}

fn start(app: &AppHandle, args: Args, app_dir: PathBuf, log: Arc<Log>) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = match &args.data_dir {
        Some(d) => d.clone(),
        None => identity::data_dir(&app.path().local_data_dir()?),
    };
    let webview_dir = identity::webview_dir(&data_dir);
    let log_path = args.log.clone().unwrap_or_else(|| data_dir.join("logs").join("app.log"));
    log.attach(&log_path, args.log.is_none().then_some(shell_core::log::CAP));
    log.line(&format!("start {} api {} app {} data {}", env!("CARGO_PKG_VERSION"), identity::SHELL_API, app_dir.display(), data_dir.display()));

    if !app_dir.join(views::CORE_PAGE).is_file() {
        give_up(
            &log,
            "app folder missing",
            &format!("The app folder is missing or broken. It should sit beside familiar.exe.\n\nLooked in: {}", app_dir.display()),
        );
    }

    // The app folder is served to pages, so it must not hold a data folder or be inside one.
    // Compared on final paths, so a junction or link can't hide it.
    let real = |p: &PathBuf| std::fs::create_dir_all(p).and_then(|_| std::fs::canonicalize(p));
    match (std::fs::canonicalize(&app_dir), real(&data_dir), real(&webview_dir)) {
        (Ok(app_real), Ok(data_real), Ok(webview_real)) => {
            if folders::overlap(&app_real, &data_real) || folders::overlap(&app_real, &webview_real) {
                give_up(
                    &log,
                    "app folder overlaps the data folder",
                    &format!("The app folder and Familiar's data folder overlap, so Familiar won't start.\n\nApp folder: {}\nData folder: {}", app_dir.display(), data_dir.display()),
                );
            }
        }
        _ => give_up(&log, "folders unreadable", "Familiar couldn't read its app or data folder.\n\nSee the log for details."),
    }

    // Before any window: every window's proxy is this.
    let (sink_port, sink) = match sink::start(log.clone()) {
        Ok(s) => s,
        Err(e) => give_up(&log, &format!("sink: {e}"), "Familiar couldn't start its network guard.\n\nSee the log for details."),
    };
    log.line(&format!("sink listening on 127.0.0.1:{sink_port}"));

    let seconds = args.seconds;
    app.manage(confirm::Confirms::default());
    app.manage(addresses::Addresses::load(&data_dir, log.clone()));
    app.manage(Shell::new(app_dir, data_dir, webview_dir, log_path, &args, log.clone(), sink_port, sink));

    // The tray first, so Quit works whatever the pages do.
    if let Err(e) = tray::create(app) {
        give_up(&log, &format!("tray: {e}"), &format!("Familiar couldn't start.\n\n{e}"));
    }
    if let Err(e) = pages::open_core(app) {
        give_up(
            &log,
            &format!("core window: {e}"),
            "Familiar needs Microsoft Edge WebView2 Runtime, and couldn't open a window with it.\n\nInstall the WebView2 Runtime from Microsoft, then start Familiar again.",
        );
    }
    not_ready_watch(app);
    if let Some(s) = seconds {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_secs(s));
            shell::quit(&app, "time limit reached");
        });
    }
    Ok(())
}

/// Core has `READY_WITHIN` to say it started. If it doesn't, one box says so, the tray stays, and
/// nothing is retried.
fn not_ready_watch(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(READY_WITHIN);
        let shell = app.state::<Shell>();
        if shell.run().is_ready() {
            return;
        }
        shell.log.line("core not ready");
        platform::message_box(
            "Familiar",
            &format!(
                "Familiar's app folder didn't start. It may be broken.\n\nThe log may say why: {}\n\nFamiliar stays in the tray. Quit it from there.",
                shell.log_path.display()
            ),
        );
    });
}

fn main() {
    let started = Instant::now();
    let args = Args::parse(std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect());
    let app_dir = args.app_dir.clone().unwrap_or_else(beside_exe);
    let log = Arc::new(Log::new(started));
    // There's no console, so a crash has to reach the log or it says nothing.
    let last_words = log.clone();
    std::panic::set_hook(Box::new(move |info| last_words.line(&format!("error panic: {info}"))));

    let mut context = tauri::generate_context!();
    let app_final = std::fs::canonicalize(&app_dir).ok();
    context.set_assets(Box::new(FolderAssets { app: app_dir.clone(), app_final }));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(second_launch))
        .invoke_handler(commands::handler())
        .on_window_event(|w, e| {
            if matches!(e, tauri::WindowEvent::Destroyed) {
                pages::forget(w.app_handle(), w.label());
            }
        })
        .setup(move |app| start(app.handle(), args, app_dir, log))
        .build(context)
        .expect("the shell failed to start");

    app.run(|_, event| {
        // Windows can all close while the tray stays. Only Quit ends the run.
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}
