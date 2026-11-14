//! Spike: can a small Rust command start a local MCP server on Windows, talk to it over stdio,
//! and make sure it dies with the app?
//!
//!   mcp-start cases [a b c d f g]   the cases, from the repo root. Prints PASS or FAIL per check.
//!   mcp-start kill-test [--no-job]  starts `hold` as a child, kills it hard, and checks its whole tree is gone
//!   mcp-start hold [--no-job]       starts the npx and uvx servers, says HOLD-READY, then waits to be killed
//!   mcp-start console-probe [--spawn-child]   prints what this process sees of its console window

#[cfg(windows)]
mod mcp;
#[cfg(windows)]
mod setup;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod cases;

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("cases") => cases::run_cases(&args[1..]),
        Some("kill-test") => cases::kill_test(args.iter().any(|a| a == "--no-job")),
        Some("hold") => cases::hold(args.iter().any(|a| a == "--no-job")),
        Some("console-probe") => cases::console_probe(args.iter().any(|a| a == "--spawn-child")),
        _ => {
            eprintln!("usage: mcp-start cases [a b c d f g] | kill-test [--no-job] | hold [--no-job] | console-probe [--spawn-child]");
            2
        }
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This spike is for Windows.");
    std::process::exit(2);
}
