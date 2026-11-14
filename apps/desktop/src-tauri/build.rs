//! The command gate. Tauri checks app commands against the capabilities only when the app has an
//! app manifest, so every command is listed here. A command that no capability grants to the
//! calling window is then refused with "Command <name> not allowed by ACL". `COMMANDS`, the
//! capability files, the handler list in `src/commands.rs` and `src/shell.ts` are one inventory,
//! and `apps/desktop/tests/capabilities.test.ts` fails if they disagree.

const COMMANDS: &[&str] = &[
    "shell_info",
    "shell_ready",
    "log_line",
    "quit",
    "quit_ready",
    "tray_set",
    "view_open",
    "window_ctl",
    "window_self",
    "address_list",
    "address_add",
    "address_remove",
];

fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    println!("cargo:rerun-if-env-changed=SHELL_CHECK_ONLY");
    // A type check from Linux can't compile Windows resources, and that step panics. Everything
    // the check needs is done by then. Real builds never take this path.
    if std::env::var_os("SHELL_CHECK_ONLY").is_some() {
        let _ = std::panic::catch_unwind(|| tauri_build::try_build(attributes));
        return;
    }
    tauri_build::try_build(attributes).expect("tauri-build failed");
}
