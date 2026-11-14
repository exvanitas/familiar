//! The native confirms: the one dialog module every kind of ask goes through. See "The native
//! confirms" in docs/shell-design.md. The text is `shell_core::confirm`'s; this file shows it.
//!
//! For another kind of ask, the whole interface is:
//!
//! ```ignore
//! let ask: shell_core::confirm::Ask = shell_core::confirm::open_link(&link);   // or start_program, add_address
//! match confirm::ask(&app, owner_label, ask) {
//!     Ok(true) => { /* approved: act on your own copy of the operation, made before asking */ }
//!     Ok(false) => { /* refused or closed: `declined` */ }
//!     Err(e) => { /* e.kind(): "busy", "asks-stopped" or "failed" */ }
//! }
//! ```
//!
//! An ask that must check the confirm state before doing anything else (adding an address checks
//! it before any lookup) takes a `Ticket` with `reserve` first, then calls `Ticket::ask`.
//!
//! While a dialog is open, nothing changes behind it: `busy()` is true, and `view_open`,
//! `window_ctl`, `window_self` and any new ask are refused with `busy`. Every Familiar window is
//! disabled and drops always-on-top, and each one's state is put back by a guard on every way out.
//! The refusing button is the default, and the approving one is enabled only after a second.
//! Three refusals or closes, across every kind of ask, stop asking until the person picks the
//! exe's own tray item "Let Familiar ask again".

use crate::shell::{lock, Shell};
use shell_core::confirm::{Ask, Refused, Throttle};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// What `ask` refuses with, before or instead of a dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskFail {
    Busy,
    AsksStopped,
    /// The dialog couldn't be shown. Counted as a refusal, as a close is.
    Failed(String),
}

impl AskFail {
    pub fn kind(&self) -> &'static str {
        match self {
            AskFail::Busy => "busy",
            AskFail::AsksStopped => "asks-stopped",
            AskFail::Failed(_) => "failed",
        }
    }
}

impl From<Refused> for AskFail {
    fn from(r: Refused) -> AskFail {
        match r {
            Refused::Busy => AskFail::Busy,
            Refused::AsksStopped => AskFail::AsksStopped,
        }
    }
}

/// The exe's confirm state, managed by Tauri.
#[derive(Default)]
pub struct Confirms {
    throttle: Mutex<Throttle>,
}

/// True while a dialog is open, or reserved and about to open.
pub fn busy(app: &AppHandle) -> bool {
    app.try_state::<Confirms>().is_some_and(|c| lock(&c.throttle).is_open())
}

/// True when three refusals have stopped asking.
pub fn stopped(app: &AppHandle) -> bool {
    app.try_state::<Confirms>().is_some_and(|c| lock(&c.throttle).stopped())
}

/// The tray item "Let Familiar ask again". Only the person can pick it.
pub fn reenable(app: &AppHandle) {
    if let Some(c) = app.try_state::<Confirms>() {
        lock(&c.throttle).reenable();
    }
    app.state::<Shell>().log.line("confirm: asking again, at the person's word");
    crate::tray::refresh(app);
}

/// The right to show one dialog. While it's held every other ask is `busy`. Dropped without
/// asking, it gives the right back without counting a refusal.
pub struct Ticket {
    app: AppHandle,
    used: bool,
}

/// Checks the confirm state before anything else an ask would do, and holds it.
pub fn reserve(app: &AppHandle) -> Result<Ticket, AskFail> {
    let c = app.state::<Confirms>();
    lock(&c.throttle).begin()?;
    Ok(Ticket { app: app.clone(), used: false })
}

impl Ticket {
    /// Shows the dialog, owned by the window `owner` if it's showing, else top-most with no
    /// owner. True if the person approved. Blocks until they answer, so it's never called on the
    /// main thread: commands that ask are async.
    pub fn ask(mut self, owner: Option<&str>, ask: Ask) -> Result<bool, AskFail> {
        self.used = true;
        let app = self.app.clone();
        let log = app.state::<Shell>().log.clone();
        let owner_hwnd = owner.and_then(|l| app.get_webview_window(l)).filter(|w| w.is_visible().unwrap_or(false)).map(|w| platform::hwnd(&w));
        let result = {
            let _frozen = Freeze::new(&app);
            platform::show(owner_hwnd.flatten(), &ask)
        };
        let approved = matches!(result, Ok(true));
        lock(&app.state::<Confirms>().throttle).end(approved);
        log.line(&format!(
            "confirm: {} {}",
            ask.title,
            match &result {
                Ok(true) => "approved",
                Ok(false) => "refused",
                Err(_) => "failed",
            }
        ));
        if stopped(&app) {
            log.line("confirm: three refusals, asking stopped until the tray item");
            crate::tray::refresh(&app);
        }
        result.map_err(AskFail::Failed)
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.used {
            // Released, not refused.
            lock(&self.app.state::<Confirms>().throttle).end(true);
        }
    }
}

/// The whole ask in one call: the confirm state, then the dialog. For server starts and links.
#[allow(dead_code)] // the other kinds of ask call it
pub fn ask(app: &AppHandle, owner: Option<&str>, ask: Ask) -> Result<bool, AskFail> {
    reserve(app)?.ask(owner, ask)
}

/// Every Familiar window's enabled and always-on-top state, recorded before the dialog and put
/// back when this goes, whatever the dialog returned. A window that went meanwhile is skipped.
struct Freeze {
    app: AppHandle,
    saved: Vec<(String, isize, bool, bool)>,
}

impl Freeze {
    fn new(app: &AppHandle) -> Freeze {
        let mut saved = vec![];
        for (label, w) in app.webview_windows() {
            let Some(h) = platform::hwnd(&w) else { continue };
            let on_top = w.is_always_on_top().unwrap_or(false);
            let enabled = platform::enabled(h);
            saved.push((label, h, enabled, on_top));
            if on_top {
                let _ = w.set_always_on_top(false);
            }
            platform::enable(h, false);
        }
        Freeze { app: app.clone(), saved }
    }
}

impl Drop for Freeze {
    fn drop(&mut self) {
        for (label, h, enabled, on_top) in &self.saved {
            let Some(w) = self.app.get_webview_window(label) else { continue };
            if platform::hwnd(&w) != Some(*h) {
                continue;
            }
            platform::enable(*h, *enabled);
            if *on_top {
                let _ = w.set_always_on_top(true);
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use shell_core::confirm::Ask;
    use std::sync::mpsc;
    use windows::{
        core::{HRESULT, HSTRING, PCWSTR},
        Win32::{
            Foundation::{HWND, LPARAM, S_OK, WPARAM},
            UI::{
                Controls::{
                    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS, TDF_ALLOW_DIALOG_CANCELLATION,
                    TDF_CALLBACK_TIMER, TDM_ENABLE_BUTTON, TDN_CREATED, TDN_TIMER,
                },
                Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled},
                WindowsAndMessaging::{SendMessageW, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE},
            },
        },
    };

    const APPROVE: i32 = 100;
    const REFUSE: i32 = 101;
    /// The approving button stays disabled this long, so a click meant for another window can't
    /// land on it.
    const APPROVE_AFTER_MS: usize = 1000;
    /// Set in `lpCallbackData` when the dialog has no owner: it goes top-most.
    const NO_OWNER: isize = 1;

    pub fn hwnd(w: &tauri::WebviewWindow) -> Option<isize> {
        w.hwnd().ok().map(|h| h.0 as isize)
    }

    pub fn enabled(h: isize) -> bool {
        unsafe { IsWindowEnabled(HWND(h as _)) }.as_bool()
    }

    pub fn enable(h: isize, on: bool) {
        unsafe {
            let _ = EnableWindow(HWND(h as _), on);
        }
    }

    unsafe extern "system" fn callback(hwnd: HWND, msg: TASKDIALOG_NOTIFICATIONS, wparam: WPARAM, _: LPARAM, data: isize) -> HRESULT {
        if msg == TDN_CREATED {
            unsafe {
                SendMessageW(hwnd, TDM_ENABLE_BUTTON.0 as u32, Some(WPARAM(APPROVE as usize)), Some(LPARAM(0)));
                if data == NO_OWNER {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                }
            }
        } else if msg == TDN_TIMER && wparam.0 >= APPROVE_AFTER_MS {
            unsafe { SendMessageW(hwnd, TDM_ENABLE_BUTTON.0 as u32, Some(WPARAM(APPROVE as usize)), Some(LPARAM(1))) };
        }
        S_OK
    }

    /// Shows the dialog on a thread of its own, which runs its message loop, and waits for it.
    pub fn show(owner: Option<isize>, ask: &Ask) -> Result<bool, String> {
        let ask = ask.clone();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let title = HSTRING::from("Familiar");
            let main = HSTRING::from(ask.title);
            let content = HSTRING::from(ask.summary.as_str());
            let details = HSTRING::from(ask.details.as_str());
            let (when_open, when_closed) = (HSTRING::from("Hide details"), HSTRING::from("Show details"));
            let (approve, refuse) = (HSTRING::from(ask.approve), HSTRING::from(ask.refuse));
            let buttons = [
                TASKDIALOG_BUTTON { nButtonID: APPROVE, pszButtonText: PCWSTR(approve.as_ptr()) },
                TASKDIALOG_BUTTON { nButtonID: REFUSE, pszButtonText: PCWSTR(refuse.as_ptr()) },
            ];
            let config = TASKDIALOGCONFIG {
                cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
                hwndParent: HWND(owner.unwrap_or(0) as _),
                dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER,
                pszWindowTitle: PCWSTR(title.as_ptr()),
                pszMainInstruction: PCWSTR(main.as_ptr()),
                pszContent: PCWSTR(content.as_ptr()),
                cButtons: buttons.len() as u32,
                pButtons: buttons.as_ptr(),
                // The refusing button is the default, so a stray Enter refuses.
                nDefaultButton: REFUSE,
                pszExpandedInformation: PCWSTR(details.as_ptr()),
                pszExpandedControlText: PCWSTR(when_open.as_ptr()),
                pszCollapsedControlText: PCWSTR(when_closed.as_ptr()),
                pfCallback: Some(callback),
                lpCallbackData: if owner.is_none() { NO_OWNER } else { 0 },
                ..Default::default()
            };
            let mut pressed = 0i32;
            let r = unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) };
            let _ = tx.send(r.map(|()| pressed == APPROVE).map_err(|e| e.to_string()));
        });
        rx.recv().map_err(|_| "the dialog's thread ended without an answer".to_string())?
    }
}

#[cfg(not(windows))]
mod platform {
    use shell_core::confirm::Ask;

    pub fn hwnd(_: &tauri::WebviewWindow) -> Option<isize> {
        None
    }
    pub fn enabled(_: isize) -> bool {
        true
    }
    pub fn enable(_: isize, _: bool) {}
    pub fn show(_: Option<isize>, _: &Ask) -> Result<bool, String> {
        Err("not on this system".into())
    }
}
