//! Files and links: the native save and pick dialogs, `open_url` through the confirm, and the two
//! folders `open_folder` shows. Rules are shell-core's (`files`, `link`, `temp`). The dialog and
//! replace code is Desktop Buddies'. See "5d. The rest" in docs/shell-design.md.

use crate::{confirm, shell::Shell};
use serde::{Deserialize, Serialize};
use shell_core::{
    files::{self, Filter, Pick},
    link, temp,
};
use std::path::{Path, PathBuf};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State, WebviewWindow,
};

#[derive(Debug, Serialize)]
pub struct Fail {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Fail {
    Fail { kind, message: message.into() }
}

type Res<T> = Result<T, Fail>;

/// The dialog's owner: the window named if it's open and showing, or else the one that asked if
/// that's showing, or none.
fn owner(app: &AppHandle, asked: &WebviewWindow, label: Option<&str>) -> Option<isize> {
    let showing = |w: &WebviewWindow| w.is_visible().ok().filter(|v| *v).and_then(|_| w.hwnd().ok()).map(|h| h.0 as isize);
    label.and_then(|l| app.get_webview_window(l)).and_then(|w| showing(&w)).or_else(|| showing(asked))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveSpec {
    name: String,
    #[serde(default)]
    filters: Vec<Filter>,
    owner: Option<String>,
}

/// The folders no save may land in, as final paths: the native data folder, the WebView2
/// folder, and the folders holding the exe and the app folder. If any can't be resolved, none is
/// returned, and every save is refused: fail closed.
fn forbidden(shell: &Shell) -> Option<Vec<PathBuf>> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [shell.data_dir.clone(), shell.webview_dir.clone(), exe_dir, shell.app_dir.clone()].into_iter().map(|p| std::fs::canonicalize(p).ok()).collect()
}

/// Whether a save to this file is refused: anywhere remote (a UNC path, or a drive that isn't
/// fixed or removable, which a share alias of a protected folder could be), or inside a
/// protected folder, judged on final paths.
fn refused(shell: &Shell, target: &Path) -> Result<bool, Fail> {
    let dir = target.parent().ok_or_else(|| fail("invalid", "no folder"))?;
    if files::remote(&target.display().to_string()) || !local_drive(dir) {
        return Ok(true);
    }
    let dir = std::fs::canonicalize(dir).map_err(|_| fail("failed", "the folder can't be read"))?;
    if files::remote(&dir.display().to_string()) {
        return Ok(true);
    }
    let Some(forbidden) = forbidden(shell) else { return Ok(true) };
    let refs: Vec<&Path> = forbidden.iter().map(PathBuf::as_path).collect();
    Ok(files::save_refused(&dir, &refs))
}

/// Whether a path's drive is fixed or removable, from the drive table.
#[cfg(windows)]
fn local_drive(dir: &Path) -> bool {
    use shell_core::server_path::{DriveType, Fs};
    let s = dir.display().to_string();
    let b = s.as_bytes();
    if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
        return false;
    }
    matches!(shell_win::WinFs.drive_type(&format!("{}:\\", &s[..1])), DriveType::Fixed | DriveType::Removable)
}

#[cfg(not(windows))]
fn local_drive(_: &Path) -> bool {
    false
}

fn spec_header(request: &Request) -> Res<String> {
    let header = request.headers().get("x-spec").and_then(|v| v.to_str().ok()).ok_or_else(|| fail("invalid", "no spec"))?;
    percent_encoding::percent_decode_str(header).decode_utf8().map(|s| s.into_owned()).map_err(|_| fail("invalid", "bad spec"))
}

/// The body is the file's bytes, and the `x-spec` header holds `{ name, filters, owner? }`. The
/// file is written beside its target and swapped in, so a full disk can't leave a cut-off file.
/// Returns whether it saved.
#[tauri::command(async)]
pub fn save_as(request: Request, window: WebviewWindow, app: AppHandle, shell: State<Shell>) -> Res<bool> {
    // A dialog that opens windows waits for no confirm: while one is open, nothing new opens.
    let InvokeBody::Raw(bytes) = request.body() else { return Err(fail("invalid", "expected bytes")) };
    if bytes.len() > files::MAX_SAVE {
        return Err(fail("too-large", "at most 256 MiB"));
    }
    let spec: SaveSpec = serde_json::from_str(&spec_header(&request)?).map_err(|_| fail("invalid", "bad spec"))?;
    files::check_name(&spec.name).map_err(|e| fail("invalid", e))?;
    files::check_filters(&spec.filters).map_err(|e| fail("invalid", e))?;
    let owner = owner(&app, &window, spec.owner.as_deref());
    // The dialog runs as a confirm does: the gate held (nothing else opens or moves meanwhile:
    // one native dialog at a time), every window frozen, all put back after.
    let chosen = confirm::modal(&app, None, |_| dialogs::save(&spec.name, &spec.filters, owner)).map_err(|e| fail(e.kind(), "a confirm or another dialog is open"))?;
    let Some(path) = chosen.map_err(|e| fail("failed", e))? else { return Ok(false) };
    if refused(&shell, &path)? {
        shell.log.line("save_as refused: the folder is Familiar's own");
        return Err(fail("refused", "Familiar doesn't save into its own folders"));
    }
    temp::save(&path, bytes, &dialogs::OsSwap).map_err(|e| fail("failed", e))?;
    shell.log.line("save_as saved a file");
    Ok(true)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PickSpec {
    kind: String,
    #[serde(default)]
    filters: Vec<Filter>,
    owner: Option<String>,
}

/// The native open dialog. A full path, or null if the person cancelled.
#[tauri::command(async)]
pub fn pick_path(spec: PickSpec, window: WebviewWindow, app: AppHandle) -> Res<Option<String>> {
    let kind = Pick::parse(&spec.kind).ok_or_else(|| fail("invalid", "kind is file or folder"))?;
    files::check_filters(&spec.filters).map_err(|e| fail("invalid", e))?;
    let owner = owner(&app, &window, spec.owner.as_deref());
    let path = confirm::modal(&app, None, |_| dialogs::pick(kind, &spec.filters, owner)).map_err(|e| fail(e.kind(), "a confirm or another dialog is open"))?.map_err(|e| fail("failed", e))?;
    Ok(path.map(|p| p.display().to_string()))
}

/// The confirm, then the default browser. `https` only, refused before any dialog otherwise.
#[tauri::command(async)]
pub fn open_url(url: String, owner: Option<String>, app: AppHandle, shell: State<Shell>) -> Res<()> {
    let link = link::check(&url).map_err(|_| fail("invalid", "only an https link of up to 2048 characters"))?;
    let ticket = confirm::reserve(&app).map_err(|e| fail(e.kind(), "the confirm can't ask now"))?;
    // What opens is `link`, this copy made before asking.
    if !ticket.ask(owner.as_deref(), shell_core::confirm::open_link(&link)).map_err(|e| fail(e.kind(), "the confirm failed"))? {
        return Err(fail("declined", "not opened"));
    }
    dialogs::shell_open(&link.url).map_err(|e| fail("failed", e))?;
    shell.log.line("open_url opened a link");
    Ok(())
}

/// Explorer at `backups` or `logs`, inside the data folder.
#[tauri::command(async)]
pub fn open_folder(which: String, shell: State<Shell>) -> Res<()> {
    let name = files::named_folder(&which).ok_or_else(|| fail("invalid", "backups or logs"))?;
    let dir = shell.data_dir.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| fail("failed", e.to_string()))?;
    dialogs::shell_open(&dir.display().to_string()).map_err(|e| fail("failed", e))
}

#[cfg(windows)]
mod dialogs {
    use shell_core::{
        files::{Filter, Pick},
        temp::Swap,
    };
    use std::{io, path::Path, path::PathBuf, thread};
    use windows::{
        core::{Interface, HSTRING, PCWSTR, PWSTR},
        Win32::{
            Foundation::{ERROR_CANCELLED, HWND},
            Storage::FileSystem::{MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACE_FILE_FLAGS},
            System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
            UI::{
                Shell::{
                Common::COMDLG_FILTERSPEC, FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog, ShellExecuteW, FOS_FORCEFILESYSTEM,
                FOS_NOTESTFILECREATE, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
            },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };

    /// This thread's COM apartment. Held longer than any interface made in it.
    struct Apartment;

    impl Apartment {
        fn enter() -> windows::core::Result<Apartment> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;
            Ok(Apartment)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn hwnd(h: isize) -> HWND {
        HWND(h as *mut _)
    }

    /// Filters, the dialog's result, and running it on a thread of its own with an apartment.
    fn show(d: &IFileDialog, filters: &[Filter], owner: Option<isize>) -> windows::core::Result<Option<PathBuf>> {
        unsafe {
            let names: Vec<HSTRING> = filters.iter().map(|f| HSTRING::from(&f.name)).collect();
            let specs: Vec<HSTRING> = filters.iter().map(|f| HSTRING::from(f.extensions.iter().map(|e| format!("*.{e}")).collect::<Vec<_>>().join(";"))).collect();
            let types: Vec<COMDLG_FILTERSPEC> = names.iter().zip(&specs).map(|(n, s)| COMDLG_FILTERSPEC { pszName: PCWSTR(n.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) }).collect();
            if !types.is_empty() {
                d.SetFileTypes(&types)?;
            }
            if let Err(e) = d.Show(owner.map(hwnd)) {
                if e.code() == ERROR_CANCELLED.to_hresult() {
                    return Ok(None);
                }
                return Err(e);
            }
            let raw: PWSTR = d.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = raw.to_string().map(PathBuf::from);
            CoTaskMemFree(Some(raw.0 as *const _));
            Ok(path.ok())
        }
    }

    fn on_own_thread(f: impl FnOnce() -> windows::core::Result<Option<PathBuf>> + Send + 'static) -> Result<Option<PathBuf>, String> {
        thread::spawn(move || {
            let _apartment = Apartment::enter()?;
            f()
        })
        .join()
        .map_err(|_| "the dialog crashed".to_string())?
        .map_err(|e| e.to_string())
    }

    /// Blocks until the person answers. None if they cancelled.
    pub fn save(name: &str, filters: &[Filter], owner: Option<isize>) -> Result<Option<PathBuf>, String> {
        let (name, filters) = (name.to_string(), filters.to_vec());
        on_own_thread(move || unsafe {
            let d: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
            d.SetFileName(&HSTRING::from(name))?;
            // No test file: without this the dialog creates and deletes one at the chosen name
            // inside Show, before the exe has judged the folder.
            d.SetOptions(d.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_NOTESTFILECREATE)?;
            show(&d.cast()?, &filters, owner)
        })
    }

    pub fn pick(kind: Pick, filters: &[Filter], owner: Option<isize>) -> Result<Option<PathBuf>, String> {
        let filters = filters.to_vec();
        on_own_thread(move || unsafe {
            let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            let mut opts = d.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_NOTESTFILECREATE;
            if kind == Pick::Folder {
                opts |= FOS_PICKFOLDERS;
            }
            d.SetOptions(opts)?;
            show(&d.cast()?, if kind == Pick::Folder { &[] } else { &filters }, owner)
        })
    }

    /// The OS's own replace keeps the old file's permissions, encryption and attributes. A file
    /// that wasn't there is moved in, written through, never over one that appeared meanwhile.
    pub struct OsSwap;

    impl Swap for OsSwap {
        fn replace(&self, target: &Path, temp: &Path) -> io::Result<()> {
            // No backup name: a failure then leaves the target as it was or holding the new file.
            unsafe { ReplaceFileW(&HSTRING::from(target), &HSTRING::from(temp), PCWSTR::null(), REPLACE_FILE_FLAGS(0), None, None) }.map_err(io::Error::from)
        }

        fn place(&self, temp: &Path, target: &Path) -> io::Result<()> {
            unsafe { MoveFileExW(&HSTRING::from(temp), &HSTRING::from(target), MOVEFILE_WRITE_THROUGH) }.map_err(io::Error::from)
        }
    }

    /// The default handler: the browser for an https link, Explorer for a folder.
    pub fn shell_open(target: &str) -> Result<(), String> {
        let r = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        // Values above 32 mean it worked.
        if r.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecute failed: {}", r.0 as isize))
        }
    }
}

#[cfg(not(windows))]
mod dialogs {
    use shell_core::{
        files::{Filter, Pick},
        temp::Swap,
    };
    use std::{io, path::Path, path::PathBuf};

    pub fn save(_: &str, _: &[Filter], _: Option<isize>) -> Result<Option<PathBuf>, String> {
        Err("Windows only".into())
    }
    pub fn pick(_: Pick, _: &[Filter], _: Option<isize>) -> Result<Option<PathBuf>, String> {
        Err("Windows only".into())
    }
    pub struct OsSwap;
    impl Swap for OsSwap {
        fn replace(&self, _: &Path, _: &Path) -> io::Result<()> {
            Err(io::Error::other("Windows only"))
        }
        fn place(&self, _: &Path, _: &Path) -> io::Result<()> {
            Err(io::Error::other("Windows only"))
        }
    }
    pub fn shell_open(_: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
}
