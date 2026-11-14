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
