//! Every command a page can call. Which window may call which is in `capabilities/`, enforced by
//! Tauri because `build.rs` declares an app manifest. Errors are `{ kind, message }` with fixed
//! kinds, and never carry what a page sent. Anything that touches windows is async, because plain
//! commands run on the main thread.

use crate::{
    pages::{self, ViewSpec},
    shell::{self, Shell},
    tray::{self, TraySpec},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shell_core::{
    identity,
    log::{page_line, Admit},
    views::{self, CtlOp, SelfOp},
};
use std::time::Instant;
use tauri::{ipc::Channel, ipc::Invoke, AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, Wry};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Fail {
    Fail { kind, message: message.into() }
}

type Res<T> = Result<T, Fail>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    api: u32,
    version: &'static str,
    args: Vec<String>,
    data_dir: String,
    webview_dir: String,
    origin: &'static str,
    autostarted: bool,
}

#[tauri::command]
fn shell_info(shell: State<Shell>) -> Info {
    Info {
        api: identity::SHELL_API,
        version: env!("CARGO_PKG_VERSION"),
        args: shell.args.clone(),
        data_dir: shell.data_dir.display().to_string(),
        webview_dir: shell.webview_dir.display().to_string(),
        origin: identity::ORIGIN,
        autostarted: shell.autostarted,
    }
}

/// Core is up, and hands over the one channel for everything the exe tells it. Once a run.
#[tauri::command]
fn shell_ready(channel: Channel<Value>, shell: State<Shell>) -> Res<()> {
    shell.run().ready().map_err(|e| fail("refused", e))?;
    shell.set_core(channel);
    shell.log.line("core ready");
    Ok(())
}

#[tauri::command]
fn log_line(line: String, window: WebviewWindow, shell: State<Shell>) {
    let label = window.label();
    let admitted = shell::lock(&shell.limiter).admit(label, Instant::now());
    if let Admit::Yes { dropped } = admitted {
        if dropped > 0 {
            shell.log.line(&format!("[{label}] dropped {dropped} lines over the rate"));
        }
        shell.log.line(&format!("[{label}] {}", page_line(&line)));
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    shell::quit(&app, "page");
}

/// Core has finished its last writes. Only after `quitting`.
#[tauri::command]
fn quit_ready(shell: State<Shell>) -> Res<()> {
    shell.run().quit_ready().map_err(|e| fail("refused", e))
}

#[tauri::command(async)]
fn tray_set(app: AppHandle, spec: TraySpec) -> Res<()> {
    tray::set(&app, spec).map_err(|e| fail("invalid", e))
}

#[tauri::command(async)]
fn view_open(app: AppHandle, spec: ViewSpec) -> Res<()> {
    // Built and hardened to the end inside the window gate, so a confirm can't freeze the windows
    // part-way through.
    window_op(&app, || pages::open(&app, spec).map_err(|e| fail("refused", e)))
}

/// A window operation through the confirm gate: `busy` while a confirm is reserved or open.
fn window_op<T>(app: &AppHandle, f: impl FnOnce() -> Res<T>) -> Res<T> {
    crate::confirm::window_op(app, f).map_err(|e| fail(e.kind(), "a confirm is open"))?
}

/// Destroys a window and waits until it has gone.
fn destroyed(w: &WebviewWindow) -> Res<()> {
    w.destroy().map_err(|e| fail("failed", e.to_string()))?;
    for _ in 0..100 {
        if w.app_handle().get_webview_window(w.label()).is_none() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err(fail("failed", "the window didn't close"))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Show, hide, focus, close, and get or set bounds, on Settings or a view. Never core.
#[tauri::command(async)]
fn window_ctl(app: AppHandle, label: String, op: String, bounds: Option<Bounds>) -> Res<Option<Bounds>> {
    window_op(&app, || window_ctl_now(&app, label, op, bounds))
}

fn window_ctl_now(app: &AppHandle, label: String, op: String, bounds: Option<Bounds>) -> Res<Option<Bounds>> {
    views::ctl_target(&label).map_err(|e| fail("refused", e))?;
    let op = CtlOp::parse(&op).ok_or_else(|| fail("invalid", "unknown op"))?;
    let w = app.get_webview_window(&label).ok_or_else(|| fail("missing", "no such window"))?;
    let err = |e: tauri::Error| fail("failed", e.to_string());
    match op {
        CtlOp::Show => w.show().map_err(err)?,
        CtlOp::Hide => w.hide().map_err(err)?,
        CtlOp::Focus => {
            if w.is_minimized().map_err(err)? {
                w.unminimize().map_err(err)?;
            }
            w.show().map_err(err)?;
            w.set_focus().map_err(err)?;
        }
        // Destroy, not close: a page listening for close requests can't hold its window open.
        CtlOp::Close => return destroyed(&w).map(|()| None),
        CtlOp::GetBounds => {
            // Where the window is, and how big its content is: what set-bounds takes.
            let (p, s) = (w.outer_position().map_err(err)?, w.inner_size().map_err(err)?);
            return Ok(Some(Bounds { x: p.x, y: p.y, width: s.width, height: s.height }));
        }
        CtlOp::SetBounds => {
            let b = bounds.ok_or_else(|| fail("invalid", "set-bounds needs bounds"))?;
            if !(1..=20000).contains(&b.width) || !(1..=20000).contains(&b.height) {
                return Err(fail("invalid", "bounds out of range"));
            }
            w.set_position(PhysicalPosition::new(b.x, b.y)).map_err(err)?;
            w.set_size(PhysicalSize::new(b.width, b.height)).map_err(err)?;
        }
    }
    crate::confirm::settle(&w);
    Ok(None)
}

/// Drag, minimize, toggle maximize or close, on the calling window. The label is the caller's,
/// read from the request, never from what the page sent.
#[tauri::command(async)]
fn window_self(window: WebviewWindow, op: String) -> Res<()> {
    let app = window.app_handle().clone();
    window_op(&app, || window_self_now(&window, op))
}

fn window_self_now(window: &WebviewWindow, op: String) -> Res<()> {
    if window.label() == views::CORE {
        return Err(fail("refused", "core has no window to act on"));
    }
    let op = SelfOp::parse(&op).ok_or_else(|| fail("invalid", "unknown op"))?;
    let err = |e: tauri::Error| fail("failed", e.to_string());
    match op {
        SelfOp::Drag => window.start_dragging().map_err(err)?,
        SelfOp::Minimize => window.minimize().map_err(err)?,
        SelfOp::ToggleMaximize => {
            if window.is_maximized().map_err(err)? {
                window.unmaximize().map_err(err)?
            } else {
                window.maximize().map_err(err)?
            }
        }
        SelfOp::Close => return destroyed(window),
    }
    crate::confirm::settle(window);
    Ok(())
}

pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        shell_info,
        shell_ready,
        log_line,
        quit,
        quit_ready,
        tray_set,
        view_open,
        window_ctl,
        window_self,
        crate::addresses::address_list,
        crate::addresses::address_add,
        crate::addresses::address_remove,
        crate::net::net_fetch,
        crate::net::net_read,
        crate::net::net_cancel,
        crate::net::net_proxy,
        crate::secrets::secret_set,
        crate::secrets::secret_status,
        crate::secrets::secret_delete,
    ]
}
