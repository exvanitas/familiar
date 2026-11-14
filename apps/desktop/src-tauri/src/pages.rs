//! Every window comes through `window()`, because WebView2 windows sharing a data folder must share
//! the same browser arguments, and because each must get the same pins: the data folder, the http
//! origin, no drag and drop, its page binding, every permission denied, and no autofill.

use crate::{platform, shell::Shell};
use serde::Deserialize;
use shell_core::{nav, views, web};
use std::sync::Arc;
use tauri::{
    webview::{NewWindowResponse, PermissionResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

/// Takes WebRTC's interfaces off every frame's global before page script runs.
const NO_WEBRTC: &str = include_str!("no-webrtc.js");

fn window<'a>(app: &'a AppHandle, label: &str, page: &str) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let shell = app.state::<Shell>();
    let (bound, nav_log, new_log) = (page.to_string(), shell.log.clone(), shell.log.clone());
    let who = label.to_string();
    let who_new = label.to_string();
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .data_directory(shell.webview_dir.clone())
        .use_https_scheme(false)
        .disable_drag_drop_handler()
        .additional_browser_args(&web::browser_args(shell.sink_port))
        .devtools(shell.devtools)
        .general_autofill_enabled(false)
        .initialization_script_for_all_frames(NO_WEBRTC)
        .on_navigation(move |url| {
            let stays = nav::stays(&bound, url.scheme(), url.host_str(), url.port(), url.path(), url.query());
            if !stays {
                nav_log.line(&format!("navigation refused in {who}: a {} link", nav::scheme_for_log(url.scheme())));
            }
            stays
        })
        .on_new_window(move |url, _| {
            new_log.line(&format!("new window refused in {who_new}: a {} link", nav::scheme_for_log(url.scheme())));
            NewWindowResponse::Deny
        })
        // Tauri's own handler, so a request is denied from the window's first moment. The exe's
        // handler below, added after it, has the last word.
        .on_permission_request(|_, _| PermissionResponse::Deny)
}

/// What's added once the webview exists: a permission handler registered after Tauri's own, and
/// password saving off. Both through WebView2 itself.
fn harden(w: &WebviewWindow, log: Arc<shell_core::log::Log>) {
    let label = w.label().to_string();
    let log_err = log.clone();
    let label_err = label.clone();
    let r = w.with_webview(move |pw| {
        if let Err(e) = platform::harden_webview(&pw, &label, log.clone()) {
            log.line(&format!("error hardening {label}: {e}"));
        }
    });
    if let Err(e) = r {
        log_err.line(&format!("error hardening {label_err}: {e}"));
    }
}

/// The one page the exe opens by itself, hidden for the whole run, and never focusable, so it never
/// takes the keyboard, at a sign-in start or ever.
pub fn open_core(app: &AppHandle) -> tauri::Result<()> {
    let w = window(app, views::CORE, views::CORE_PAGE).title("Familiar").visible(false).focused(false).focusable(false).skip_taskbar(true).build()?;
    harden(&w, app.state::<Shell>().log.clone());
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
    let mut b = window(app, &spec.label, &page)
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
    harden(&w, shell.log.clone());
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
