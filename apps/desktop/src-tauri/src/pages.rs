//! Every window comes through `window()`, because WebView2 windows sharing a data folder must share
//! the same browser arguments, and because each must get the same pins: the data folder, the http
//! origin, no drag and drop, its page binding, every permission denied but persistent storage, no
//! downloads, and no autofill. A window starts on `about:blank` and loads its page only once its
//! WebView2 is hardened, so no page script runs without the pins. If hardening fails, the window is
//! destroyed: core's failure ends the run with a message box, a view's fails `view_open`.

use crate::{platform, shell::Shell};
use serde::Deserialize;
use shell_core::{identity, nav, views, web};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PermissionResponse},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

/// Takes WebRTC's interfaces off every frame's global before page script runs.
const NO_WEBRTC: &str = include_str!("no-webrtc.js");
const BLANK: &str = "about:blank";

/// The builder, and the switch that lets the window leave `about:blank` for its page.
fn window<'a>(app: &'a AppHandle, label: &str, page: &str) -> (WebviewWindowBuilder<'a, Wry, AppHandle>, Arc<AtomicBool>) {
    let shell = app.state::<Shell>();
    let (bound, nav_log, new_log) = (page.to_string(), shell.log.clone(), shell.log.clone());
    let who = label.to_string();
    let who_new = label.to_string();
    let hardened = Arc::new(AtomicBool::new(false));
    let armed = hardened.clone();
    let blank = Url::parse(BLANK).expect("about:blank is a URL");
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .data_directory(shell.webview_dir.clone())
        .use_https_scheme(false)
        .disable_drag_drop_handler()
        .additional_browser_args(&web::browser_args(shell.sink_port))
        .devtools(shell.devtools)
        .general_autofill_enabled(false)
        .initialization_script_for_all_frames(NO_WEBRTC)
        .on_navigation(move |url| {
            // Before hardening, only the empty start page; after it, only the window's own page.
            let stays = if armed.load(Ordering::SeqCst) {
                nav::stays(&bound, url.scheme(), url.host_str(), url.port(), url.path(), url.query())
            } else {
                url.as_str() == BLANK
            };
            if !stays {
                nav_log.line(&format!("navigation refused in {who}: a {} link", nav::scheme_for_log(url.scheme())));
            }
            stays
        })
        .on_new_window(move |url, _| {
            new_log.line(&format!("new window refused in {who_new}: a {} link", nav::scheme_for_log(url.scheme())));
            NewWindowResponse::Deny
        })
        // Tauri's own handlers, so a request is refused from the window's first moment. The exe's
        // handlers, added after them by `harden`, have the last word.
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_download(|_, e| !matches!(e, DownloadEvent::Requested { .. }));
    (b, hardened)
}

/// Hardens the window's WebView2, then loads its page. On any failure the window goes. `done`
/// hears the outcome.
fn harden(w: &WebviewWindow, page: &str, armed: Arc<AtomicBool>, done: impl FnOnce(Result<(), String>) + Send + 'static) {
    let log = w.app_handle().state::<Shell>().log.clone();
    let label = w.label().to_string();
    let url = format!("{}/{page}", identity::ORIGIN);
    let window = w.clone();
    let done = Arc::new(std::sync::Mutex::new(Some(done)));
    let finish = {
        let done = done.clone();
        let (log, label, window) = (log.clone(), label.clone(), window.clone());
        move |r: Result<(), String>| {
            match &r {
                Ok(()) => {}
                Err(e) => {
                    log.line(&format!("error hardening {label}: {e}"));
                    let _ = window.destroy();
                }
            }
            if let Some(f) = done.lock().ok().and_then(|mut d| d.take()) {
                f(r);
            }
        }
    };
    let on_main = finish.clone();
    let r = w.with_webview(move |pw| {
        let r = platform::harden_webview(&pw, &label, log.clone()).map_err(|e| e.to_string()).and_then(|()| {
            log.line(&format!("hardened {label}"));
            armed.store(true, Ordering::SeqCst);
            platform::navigate(&pw, &url).map_err(|e| e.to_string())
        });
        on_main(r);
    });
    if let Err(e) = r {
        finish(Err(e.to_string()));
    }
}

/// The one page the exe opens by itself, hidden for the whole run, and never focusable, so it never
/// takes the keyboard, at a sign-in start or ever.
pub fn open_core(app: &AppHandle) -> tauri::Result<()> {
    let (b, armed) = window(app, views::CORE, views::CORE_PAGE);
    let w = b.title("Familiar").visible(false).focused(false).focusable(false).skip_taskbar(true).build()?;
    harden(&w, views::CORE_PAGE, armed, |r| {
        if r.is_err() {
            platform::message_box("Familiar", "Familiar couldn't make its window safe to use, so it won't run.\n\nThe log says why.");
            std::process::exit(1);
        }
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewSpec {
    pub label: String,
    pub page: Option<String>,
    pub title: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub decorations: Option<bool>,
    pub transparent: Option<bool>,
    pub always_on_top: Option<bool>,
    pub skip_taskbar: Option<bool>,
    pub visible: Option<bool>,
    pub focused: Option<bool>,
    pub focusable: Option<bool>,
}

/// Opens a view, or Settings, bound to its page. Core can't be made this way.
pub fn open(app: &AppHandle, spec: ViewSpec) -> Result<(), String> {
    let page = views::bind(&spec.label, spec.page.as_deref())?;
    let shell = app.state::<Shell>();
    if !shell_core::paths::inside(&shell.app_dir, &page).is_some_and(|p| p.is_file()) {
        return Err("no such page in the app folder".into());
    }
    if app.get_webview_window(&spec.label).is_some() {
        return Err("that window is already open".into());
    }
    let (b, armed) = window(app, &spec.label, &page);
    let mut b = b
        .title(spec.title.as_deref().unwrap_or("Familiar"))
        .decorations(spec.decorations.unwrap_or(true))
        .transparent(spec.transparent.unwrap_or(false))
        .always_on_top(spec.always_on_top.unwrap_or(false))
        .skip_taskbar(spec.skip_taskbar.unwrap_or(false))
        .visible(spec.visible.unwrap_or(true));
    if let Some(f) = spec.focused {
        b = b.focused(f);
    }
    if let Some(f) = spec.focusable {
        b = b.focusable(f);
    }
    if let (Some(w), Some(h)) = (spec.width, spec.height) {
        if !(w.is_finite() && h.is_finite() && (100.0..=10000.0).contains(&w) && (100.0..=10000.0).contains(&h)) {
            return Err("width and height must be 100 to 10000".into());
        }
        b = b.inner_size(w, h);
    }
    let w = b.build().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel();
    harden(&w, &page, armed, move |r| {
        let _ = tx.send(r);
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(format!("the window couldn't be made safe: {e}")),
        Err(_) => {
            let _ = w.destroy();
            return Err("the window couldn't be made safe in time".into());
        }
    }
    shell.log.line(&format!("opened {} with {page}", spec.label));
    Ok(())
}

/// A window went, however it closed.
pub fn forget(app: &AppHandle, label: &str) {
    if let Some(shell) = app.try_state::<Shell>() {
        crate::shell::lock(&shell.limiter).forget(label);
        shell.log.line(&format!("closed {label}"));
    }
}
