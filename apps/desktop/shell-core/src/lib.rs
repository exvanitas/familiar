//! The parts of Familiar's native shell that are plain logic. Tauri and OS calls stay out of here,
//! so `cargo test` runs on any machine. `docs/shell-design.md` is the design.

pub mod args;
pub mod identity;
pub mod log;
pub mod menu;
pub mod nav;
pub mod paths;
pub mod run;
pub mod sink;
pub mod views;
pub mod web;
pub mod queue;
pub mod folders;
pub mod address;
pub mod redact;
pub mod setup;
pub mod secret;
pub mod fetch;
pub mod server_path;
pub mod link;
pub mod confirm;
pub mod temp;
pub mod system;
pub mod approvals;
pub mod files;
