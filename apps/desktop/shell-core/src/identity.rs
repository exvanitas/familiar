//! Familiar's pinned identity. Changing any of these empties every person's Familiar: the
//! conversations, memory and settings live in WebView2's IndexedDB, under this origin, in this
//! folder. See "Origin and data folder, pinned" in docs/shell-design.md.

use std::path::{Path, PathBuf};

/// The page origin every Familiar window uses.
pub const ORIGIN: &str = "http://tauri.localhost";

/// The app identifier. Both data folders are named after it.
pub const IDENTIFIER: &str = "dev.exvanitas.familiar";

/// The shell API version `shell_info` reports.
pub const SHELL_API: u32 = 1;

/// The native data folder, given `%LOCALAPPDATA%`.
pub fn data_dir(local_app_data: &Path) -> PathBuf {
    local_app_data.join(IDENTIFIER)
}

/// The WebView2 user data folder inside a data folder.
pub fn webview_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("webview")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pins_never_move() {
        // If this fails, someone changed a pin. Every person's data would be left behind.
        assert_eq!(ORIGIN, "http://tauri.localhost");
        assert_eq!(IDENTIFIER, "dev.exvanitas.familiar");
        let local = Path::new("L");
        assert_eq!(data_dir(local), Path::new("L").join("dev.exvanitas.familiar"));
        assert_eq!(webview_dir(&data_dir(local)), Path::new("L").join("dev.exvanitas.familiar").join("webview"));
    }
}
