//! The one call point for the native confirms that start a program and open a link.
//!
//! STAND-IN until the confirm module is merged: a Windows Yes/No message box, No the default,
//! with the summary and the full details, under shell-core's one-at-a-time throttle. The real
//! module (TaskDialogIndirect, the delayed approve button, the frozen windows, the tray re-entry)
//! replaces the body of `ask` and nothing else.

use shell_core::confirm::{Ask, Refused, Throttle};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static THROTTLE: Mutex<Option<Throttle>> = Mutex::new(None);

fn throttle<T>(f: impl FnOnce(&mut Throttle) -> T) -> T {
    let mut t = THROTTLE.lock().unwrap_or_else(|e| e.into_inner());
    f(t.get_or_insert_with(Throttle::default))
}

/// Why an ask didn't approve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum No {
    Declined,
    Busy,
    AsksStopped,
}

impl No {
    pub fn kind(self) -> &'static str {
        match self {
            No::Declined => "declined",
            No::Busy => "busy",
            No::AsksStopped => "asks-stopped",
        }
    }
}

/// Asks the person, natively. The owner is a window's label: the dialog belongs to it if it's
/// showing.
pub fn ask(app: &AppHandle, ask: &Ask, owner: Option<&str>) -> Result<(), No> {
    throttle(|t| t.begin()).map_err(|r| match r {
        Refused::Busy => No::Busy,
        Refused::AsksStopped => No::AsksStopped,
    })?;
    let owner = owner
        .and_then(|l| app.get_webview_window(l))
        .filter(|w| w.is_visible().unwrap_or(false))
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize);
    let text = format!("{}\n\n{}", ask.summary, ask.details);
    let yes = yes_no(ask.title, &text, owner);
    throttle(|t| t.end(yes));
    if yes {
        Ok(())
    } else {
        Err(No::Declined)
    }
}

/// Yes or No, with No the default, so a stray Enter refuses.
#[cfg(windows)]
fn yes_no(title: &str, text: &str, owner: Option<isize>) -> bool {
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO},
        },
    };
    let owner = owner.map(|h| HWND(h as *mut _));
    let flags = MB_YESNO | MB_DEFBUTTON2 | MB_ICONWARNING | MB_SETFOREGROUND | if owner.is_none() { MB_TOPMOST } else { Default::default() };
    unsafe { MessageBoxW(owner, &HSTRING::from(text), &HSTRING::from(title), flags) == IDYES }
}

#[cfg(not(windows))]
fn yes_no(_: &str, _: &str, _: Option<isize>) -> bool {
    false
}
