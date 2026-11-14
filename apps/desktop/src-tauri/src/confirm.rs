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

use crate::shell::Shell;
use shell_core::{
    confirm::{Ask, Refused},
    gate::{Freezable, Gate, Reservation},
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

/// What `ask` refuses with, before or instead of a dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskFail {
    Busy,
    AsksStopped,
    /// The dialog couldn't be shown, or the windows couldn't be frozen. Counted as a refusal, as
    /// a close is.
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

/// The exe's confirm state, managed by Tauri: `shell_core::gate`.
#[derive(Default)]
pub struct Confirms {
    gate: Arc<Gate>,
}

fn gate(app: &AppHandle) -> Option<Arc<Gate>> {
    app.try_state::<Confirms>().map(|c| c.gate.clone())
}

/// True while a dialog is open, or reserved and about to open.
#[allow(dead_code)] // part of the interface other asks use
pub fn busy(app: &AppHandle) -> bool {
    gate(app).is_some_and(|g| g.busy())
}

/// True when three refusals have stopped asking.
pub fn stopped(app: &AppHandle) -> bool {
    gate(app).is_some_and(|g| g.stopped())
}

/// The tray item "Let Familiar ask again". Only the person can pick it.
pub fn reenable(app: &AppHandle) {
    if let Some(g) = gate(app) {
        g.reenable();
    }
    app.state::<Shell>().log.line("confirm: asking again, at the person's word");
    crate::tray::refresh(app);
}

/// Runs one operation that opens, closes, shows, moves or otherwise changes a window, to its
/// real end, unless a confirm is reserved or open (`Err(AskFail::Busy)`). Every such command goes
/// through here: reserving a confirm and freezing the windows wait for an operation in progress,
/// so no window is made or changed behind an open dialog. `f` must not return until its change
/// has happened; `settle` does that for Tauri's queued window calls.
pub fn window_op<T>(app: &AppHandle, f: impl FnOnce() -> T) -> Result<T, AskFail> {
    match gate(app) {
        Some(g) => g.window_op(f).map_err(AskFail::from),
        None => Ok(f()),
    }
}

/// Runs a native file dialog as a confirm runs: it takes the gate like a reservation, so window
/// operations and asks are `busy` meanwhile (one native dialog at a time), freezes every window
/// exactly as a confirm does, runs `f` with the owner's handle, and puts everything back on every
/// way out. It counts no refusal and isn't refused by a stop, since it asks nothing.
pub fn modal<T>(app: &AppHandle, owner: Option<&str>, f: impl FnOnce(Option<isize>) -> T) -> Result<T, AskFail> {
    let g = gate(app).ok_or_else(|| AskFail::Failed("no confirm state".into()))?;
    let hold = g.hold()?;
    let owner_hwnd = owner.and_then(|l| app.get_webview_window(l)).filter(|w| w.is_visible().unwrap_or(false)).and_then(|w| platform::hwnd(&w));
    let windows: Vec<Win> = app.webview_windows().into_values().filter_map(|w| platform::hwnd(&w).map(|h| Win { w, h })).collect();
    let frozen = hold.freeze(windows).map_err(|e| AskFail::Failed(format!("the windows couldn't be frozen: {e}")))?;
    let r = f(owner_hwnd);
    drop(frozen);
    drop(hold);
    Ok(r)
}

/// Waits until a window's queued calls have been carried out: a read is answered only after
/// them.
pub fn settle(w: &WebviewWindow) {
    let _ = w.is_visible();
}

/// The right to show one dialog. While it's held every other ask is `busy`. Dropped without
/// asking, it gives the right back without counting a refusal. Whatever happens once it asks, a
/// panic included, it ends, counting a refusal unless the person approved.
pub struct Ticket {
    app: AppHandle,
    reservation: Reservation,
}

/// Checks the confirm state before anything else an ask would do, and holds it. Waits for a
/// window operation in progress to finish.
pub fn reserve(app: &AppHandle) -> Result<Ticket, AskFail> {
    let g = gate(app).ok_or_else(|| AskFail::Failed("no confirm state".into()))?;
    Ok(Ticket { app: app.clone(), reservation: g.reserve()? })
}

/// One Familiar window, as the freeze sees it.
struct Win {
    w: WebviewWindow,
    h: isize,
}

impl Freezable for Win {
    fn read(&self) -> Result<(bool, bool), String> {
        let on_top = self.w.is_always_on_top().map_err(|e| e.to_string())?;
        Ok((platform::enabled(self.h), on_top))
    }
    fn set(&self, enabled: bool, on_top: bool) -> Result<(), String> {
        // Always-on-top first: changing it rebuilds the window's styles on its own thread, which
        // would undo an enable or disable made before it. `settle` waits for that.
        self.w.set_always_on_top(on_top).map_err(|e| e.to_string())?;
        settle(&self.w);
        platform::enable(self.h, enabled);
        Ok(())
    }
    fn alive(&self) -> bool {
        self.w.app_handle().get_webview_window(self.w.label()).is_some_and(|w| platform::hwnd(&w) == Some(self.h))
    }
}

impl Ticket {
    /// Shows the dialog, owned by the window `owner` if it's showing, else top-most with no
    /// owner. True if the person approved. Blocks until they answer, so it's never called on the
    /// main thread: commands that ask are async.
    pub fn ask(mut self, owner: Option<&str>, ask: Ask) -> Result<bool, AskFail> {
        self.reservation.asking();
        let app = self.app.clone();
        let log = app.state::<Shell>().log.clone();
        let owner_hwnd = owner.and_then(|l| app.get_webview_window(l)).filter(|w| w.is_visible().unwrap_or(false)).and_then(|w| platform::hwnd(&w));
        let windows: Vec<Win> = app.webview_windows().into_values().filter_map(|w| platform::hwnd(&w).map(|h| Win { w, h })).collect();
        let result = match self.reservation.freeze(windows) {
            // The dialog isn't shown on windows that couldn't all be frozen.
            Err(e) => Err(format!("the windows couldn't be frozen: {e}")),
            Ok(frozen) => {
                let r = platform::show(owner_hwnd, &ask, log.clone());
                drop(frozen);
                r
            }
        };
        let approved = matches!(result, Ok(true));
        let Ticket { reservation, .. } = self;
        reservation.finish(approved);
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

/// The whole ask in one call: the confirm state, then the dialog. For server starts and links.
#[allow(dead_code)] // the other kinds of ask call it
pub fn ask(app: &AppHandle, owner: Option<&str>, ask: Ask) -> Result<bool, AskFail> {
    reserve(app)?.ask(owner, ask)
}

#[cfg(windows)]
mod platform {
    use shell_core::{confirm::Ask, log::Log};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
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
                WindowsAndMessaging::{SendMessageW, SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE},
            },
        },
    };

    const APPROVE: i32 = 100;
    const REFUSE: i32 = 101;
    /// The approving button stays disabled this long, so a click meant for another window can't
    /// land on it.
    const APPROVE_AFTER_MS: usize = 1000;
    /// What the dialog's callback knows, through `lpCallbackData`. It lives on the dialog's
    /// thread for as long as the dialog does.
    struct State {
        no_owner: bool,
        log: Arc<Log>,
        enabled: AtomicBool,
    }

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
        let state = unsafe { &*(data as *const State) };
        if msg == TDN_CREATED {
            unsafe {
                SendMessageW(hwnd, TDM_ENABLE_BUTTON.0 as u32, Some(WPARAM(APPROVE as usize)), Some(LPARAM(0)));
                if state.no_owner {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
                }
            }
            // With the wall-clock moment, so the driver can time the approve button's first second.
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
            state.log.line(&format!("confirm: dialog shown at {at}"));
        } else if msg == TDN_TIMER && wparam.0 >= APPROVE_AFTER_MS && !state.enabled.swap(true, Ordering::SeqCst) {
            unsafe { SendMessageW(hwnd, TDM_ENABLE_BUTTON.0 as u32, Some(WPARAM(APPROVE as usize)), Some(LPARAM(1))) };
            state.log.line("confirm: approve enabled");
        }
        S_OK
    }

    /// Shows the dialog on a thread of its own, which runs its message loop, and waits for it.
    pub fn show(owner: Option<isize>, ask: &Ask, log: Arc<Log>) -> Result<bool, String> {
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
            let state = State { no_owner: owner.is_none(), log, enabled: AtomicBool::new(false) };
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
                lpCallbackData: &state as *const State as isize,
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
    pub fn show(_: Option<isize>, _: &Ask, _: std::sync::Arc<shell_core::log::Log>) -> Result<bool, String> {
        Err("not on this system".into())
    }
}
