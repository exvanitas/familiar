//! The toast app id Windows needs to show Familiar's notifications, and autostart's Run entry.
//! Current user only. See "4. Plugins" and "6." in docs/shell-design.md, and Desktop Buddies'
//! `set_autostart`, which this follows.

use crate::shell::Shell;
use serde::Serialize;
use shell_core::identity::IDENTIFIER;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

/// The Run entry's name, and the flag it adds.
const RUN_VALUE: &str = "Familiar";
const ICON: &[u8] = include_bytes!("../icons/icon.png");

fn exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.display().to_string()).map_err(|e| e.to_string())
}

/// What the Run entry holds: the exe, quoted, then `--autostart`.
fn run_command() -> Result<String, String> {
    Ok(format!("\"{}\" --autostart", exe()?))
}

/// `HKCU\Software\Classes\AppUserModelId\dev.exvanitas.familiar`, with its name and icon, at
/// each start, so Windows knows the toasts' app id for a zip run as for an install.
pub fn register_app_id(shell: &Shell) {
    let icon = shell.data_dir.join("shell").join("icon.png");
    let wrote = std::fs::create_dir_all(icon.parent().expect("shell folder")).and_then(|_| std::fs::write(&icon, ICON));
    let key = format!("Software\\Classes\\AppUserModelId\\{IDENTIFIER}");
    let r = reg::set(&key, "DisplayName", "Familiar").and_then(|_| if wrote.is_ok() { reg::set(&key, "IconUri", &icon.display().to_string()) } else { Ok(()) });
    shell.log.line(&format!("toast app id registered: {}", r.is_ok()));
}

/// Reads, or sets then reads, whether Familiar starts at sign-in.
#[tauri::command(async)]
pub fn autostart(on: Option<bool>, shell: State<Shell>) -> Result<bool, Fail> {
    let err = |e: String| Fail { kind: "failed", message: e };
    let key = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    match on {
        Some(true) => reg::set(key, RUN_VALUE, &run_command().map_err(err)?).map_err(err)?,
        Some(false) => reg::delete(key, RUN_VALUE).map_err(err)?,
        None => {}
    }
    if on.is_some() {
        shell.log.line(&format!("autostart set {}", on == Some(true)));
    }
    Ok(reg::get(key, RUN_VALUE) == Some(run_command().map_err(err)?))
}

#[cfg(windows)]
mod reg {
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR},
            System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ},
        },
    };

    fn ok(e: WIN32_ERROR) -> Result<(), String> {
        if e == ERROR_SUCCESS || e == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("registry error {}", e.0))
        }
    }

    pub fn get(key: &str, value: &str) -> Option<String> {
        let (key, value) = (HSTRING::from(key), HSTRING::from(value));
        let mut buf = vec![0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let e = unsafe { RegGetValueW(HKEY_CURRENT_USER, &key, &value, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
        if e != ERROR_SUCCESS {
            return None;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    pub fn set(key: &str, value: &str, data: &str) -> Result<(), String> {
        let wide: Vec<u16> = data.encode_utf16().chain([0]).collect();
        ok(unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(value), REG_SZ.0, Some(wide.as_ptr().cast()), (wide.len() * 2) as u32) })
    }

    pub fn delete(key: &str, value: &str) -> Result<(), String> {
        ok(unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(value)) })
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn get(_: &str, _: &str) -> Option<String> {
        None
    }
    pub fn set(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
}
