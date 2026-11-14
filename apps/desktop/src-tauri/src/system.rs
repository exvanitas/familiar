//! System state and the native deadline: `system()`, a `system` message to core when the user
//! state changes (looked at every 5 s) and on resume after sleep (a power notification), and
//! `wake_at`, one pending deadline that fires within a second, also late after a resume. The rules
//! are shell-core's `system`. See "5d. The rest" and "6." in docs/shell-design.md.

use crate::shell::Shell;
use serde::Serialize;
use serde_json::json;
use shell_core::system::{self, System, Wake};
use std::{
    sync::{Condvar, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

#[derive(Default)]
pub struct Clock {
    wake: Mutex<Wake>,
    changed: Condvar,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command(async)]
pub fn system() -> System {
    os::read()
}

/// One deadline, in Unix milliseconds. Each call replaces the one before.
#[tauri::command(async)]
pub fn wake_at(at: u64, clock: State<Clock>) -> Result<(), Fail> {
    clock.wake.lock().unwrap_or_else(|e| e.into_inner()).set(at).map_err(|e| Fail { kind: "invalid", message: e.into() })?;
    clock.changed.notify_all();
    Ok(())
}

/// The watchers: user state, resume, and the deadline. Started once, before core is ready, so
/// what they say waits for it.
pub fn start(app: &AppHandle) {
    let a = app.clone();
    thread::spawn(move || {
        let mut last = os::read().user_state;
        loop {
            thread::sleep(system::POLL);
            let now = os::read();
            if now.user_state != last {
                last = now.user_state;
                tell(&a, json!({ "t": "system", "userState": now.user_state, "idleMs": now.idle_ms }));
            }
        }
    });
    let a = app.clone();
    let log = app.state::<Shell>().log.clone();
    os::on_resume(log, move || {
        let now = os::read();
        tell(&a, json!({ "t": "system", "resumed": true, "userState": now.user_state, "idleMs": now.idle_ms }));
        if let Some(clock) = a.try_state::<Clock>() {
            clock.changed.notify_all();
        }
    });
    let a = app.clone();
    thread::spawn(move || {
        let clock = a.state::<Clock>();
        let mut wake = clock.wake.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(at) = wake.due(now_ms()) {
                tell(&a, json!({ "t": "wake", "at": at, "now": now_ms() }));
            }
            let wait = wake.wait(now_ms());
            wake = clock.changed.wait_timeout(wake, wait).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
    });
}

fn tell(app: &AppHandle, m: serde_json::Value) {
    if let Some(shell) = app.try_state::<Shell>() {
        shell.tell_core(m);
    }
}

#[cfg(windows)]
mod os {
    use shell_core::log::Log;
    use shell_core::system::{idle_ms, user_state, System};
    use std::{ffi::c_void, sync::Arc, sync::OnceLock};
    use windows::Win32::{
        Foundation::{ERROR_SUCCESS, HANDLE},
        System::{
            Power::{PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS},
            SystemInformation::GetTickCount,
        },
        UI::{
            Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
            Shell::SHQueryUserNotificationState,
            WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND},
        },
    };

    pub fn read() -> System {
        let quns = unsafe { SHQueryUserNotificationState() }.map_or(0, |q| q.0);
        let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        let idle = if unsafe { GetLastInputInfo(&mut li) }.as_bool() { idle_ms(unsafe { GetTickCount() }, li.dwTime) } else { 0 };
        System { user_state: user_state(quns), idle_ms: idle }
    }

    static RESUMED: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    /// The resume callback. A message-only window gets no power broadcasts, so the exe registers
    /// for suspend and resume directly.
    unsafe extern "system" fn power(_context: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
        if kind == PBT_APMRESUMEAUTOMATIC || kind == PBT_APMRESUMESUSPEND {
            if let Some(f) = RESUMED.get() {
                f();
            }
        }
        0
    }

    /// Registers for suspend and resume with `PowerRegisterSuspendResumeNotification` and a
    /// callback. Every failure is logged: then the exe can't tell core about a resume, and says so.
    pub fn on_resume(log: Arc<Log>, f: impl Fn() + Send + Sync + 'static) {
        if RESUMED.set(Box::new(f)).is_err() {
            log.line("resume: already registered");
            return;
        }
        // Kept for the whole run: Windows calls through it.
        let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(power), Context: std::ptr::null_mut() }));
        let mut handle: *mut c_void = std::ptr::null_mut();
        let r = unsafe { PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK, HANDLE(params as *mut _ as *mut c_void), &mut handle) };
        if r == ERROR_SUCCESS && !handle.is_null() {
            log.line("resume: registered for power notifications");
        } else {
            log.line(&format!("error resume: PowerRegisterSuspendResumeNotification failed ({}), a resume won't be told to core", r.0));
        }
    }
}

#[cfg(not(windows))]
mod os {
    use shell_core::system::System;

    pub fn read() -> System {
        System { user_state: "normal", idle_ms: 0 }
    }

    pub fn on_resume(_: std::sync::Arc<shell_core::log::Log>, _: impl Fn() + Send + Sync + 'static) {}
}
