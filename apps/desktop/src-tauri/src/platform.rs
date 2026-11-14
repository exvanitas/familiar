//! Every OS call lives here. Only Windows is real. The stubs keep other systems compiling.

use shell_core::log::Log;
use std::sync::Arc;

#[cfg(windows)]
pub use win::*;

#[cfg(not(windows))]
pub use stub::*;

#[cfg(windows)]
mod win {
    use super::*;
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, os::windows::io::AsRawHandle, path::PathBuf};
    use webview2_com::{
        DownloadStartingEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Settings4, ICoreWebView2_4, COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
        PermissionRequestedEventHandler,
    };
    use windows::{
        core::{Interface, HSTRING},
        Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{GetFinalPathNameByHandleW, GETFINALPATHNAMEBYHANDLE_FLAGS},
            UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND},
        },
    };

    /// The kind `navigator.storage.persist()` raises. The SDK in webview2-com 0.39 has no name for
    /// it; the runner showed it arrives with every `persist()` call. A grant gives a page no data
    /// and no reach, and it keeps WebView2 from evicting Familiar's IndexedDB.
    const PERSISTENT_STORAGE: i32 = 13;

    pub fn message_box(title: &str, text: &str) {
        unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | MB_ICONERROR | MB_SETFOREGROUND) };
    }

    /// The path an open file really is, after every link: what `GetFinalPathNameByHandleW` says
    /// about this handle, in the `\\?\C:\...` form `std::fs::canonicalize` gives too.
    pub fn final_path(f: &std::fs::File) -> Option<PathBuf> {
        let h = HANDLE(f.as_raw_handle());
        let mut buf = vec![0u16; 1024];
        loop {
            let n = unsafe { GetFinalPathNameByHandleW(h, &mut buf, GETFINALPATHNAMEBYHANDLE_FLAGS(0)) } as usize;
            if n == 0 {
                return None;
            }
            if n < buf.len() {
                return Some(PathBuf::from(OsString::from_wide(&buf[..n])));
            }
            if n > 32768 {
                return None;
            }
            buf = vec![0u16; n + 1];
        }
    }

    fn kind_name(k: COREWEBVIEW2_PERMISSION_KIND) -> &'static str {
        match k.0 {
            1 => "microphone",
            2 => "camera",
            3 => "geolocation",
            4 => "notifications",
            5 => "sensors",
            6 => "clipboard-read",
            7 => "automatic-downloads",
            8 => "file-read-write",
            9 => "autoplay",
            10 => "local-fonts",
            11 => "midi-sysex",
            12 => "window-management",
            PERSISTENT_STORAGE => "persistent-storage",
            _ => "other",
        }
    }

    /// Denies every web permission, whatever the kind, including kinds added later, except
    /// persistent storage, which it allows. Cancels every download. Turns off general autofill and
    /// password saving. Registered after Tauri's own handlers, so it answers last. Logs the kind
    /// only. Any failure is returned, and the window is then not used.
    pub fn harden_webview(pw: &tauri::webview::PlatformWebview, label: &str, log: Arc<Log>) -> windows::core::Result<()> {
        let (perm_label, perm_log) = (label.to_string(), log.clone());
        let (dl_label, dl_log) = (label.to_string(), log);
        unsafe {
            let core = pw.controller().CoreWebView2()?;
            let mut token = 0i64;
            core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    let allow = kind.0 == PERSISTENT_STORAGE;
                    args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
                    let said = if allow { "allowed" } else { "denied" };
                    perm_log.line(&format!("permission {said} in {perm_label}: {} ({})", kind_name(kind), kind.0));
                    Ok(())
                })),
                &mut token,
            )?;
            let mut token = 0i64;
            core.cast::<ICoreWebView2_4>()?.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    args.SetCancel(true)?;
                    args.SetHandled(true)?;
                    dl_log.line(&format!("download refused in {dl_label}"));
                    Ok(())
                })),
                &mut token,
            )?;
            let settings = core.Settings()?.cast::<ICoreWebView2Settings4>()?;
            settings.SetIsGeneralAutofillEnabled(false)?;
            settings.SetIsPasswordAutosaveEnabled(false)?;
        }
        Ok(())
    }

    /// Loads the window's page, once it's hardened.
    pub fn navigate(pw: &tauri::webview::PlatformWebview, url: &str) -> windows::core::Result<()> {
        unsafe { pw.controller().CoreWebView2()?.Navigate(&HSTRING::from(url)) }
    }
}

#[cfg(not(windows))]
mod stub {
    use super::*;
    use std::path::PathBuf;

    pub fn message_box(title: &str, text: &str) {
        eprintln!("{title}: {text}");
    }

    pub fn final_path(_: &std::fs::File) -> Option<PathBuf> {
        None
    }

    pub fn harden_webview(_: &tauri::webview::PlatformWebview, _: &str, _: Arc<Log>) -> Result<(), String> {
        Err("not on this system".into())
    }

    pub fn navigate(_: &tauri::webview::PlatformWebview, _: &str) -> Result<(), String> {
        Err("not on this system".into())
    }
}
