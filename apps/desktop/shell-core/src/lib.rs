//! The parts of Familiar's native shell that are plain logic. Tauri and OS calls stay out of here,
//! so `cargo test` runs on any machine. `docs/shell-design.md` is the design.

pub mod identity;
pub mod paths;
pub mod address;
pub mod redact;
pub mod setup;
pub mod secret;
pub mod fetch;
pub mod server_path;
pub mod link;
pub mod confirm;
