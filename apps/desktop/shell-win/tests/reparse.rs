//! The reparse walk on a real file system. The share checks run only where the workflow
//! `.github/workflows/shell-win.yml` has made its fixtures and set `FAMILIAR_REPARSE_FIXTURES`:
//! a mapped drive, links to a share and to the mapped drive, and a local junction. The workflow
//! watches for SMB traffic around this test.
#![cfg(windows)]

use std::fmt::Write as _;
use std::path::Path;

use shell_core::server_path::{check, launch, recheck, resolve, DriveType, Fs, Link, Node, PathError, Role};
use shell_win::{make_junction, WinFs};

struct Fixtures {
    dir: String,
    unc: String,
    mapped: String,
}

fn fixtures() -> Option<Fixtures> {
    let dir = std::env::var("FAMILIAR_REPARSE_FIXTURES").ok()?;
    let unc = std::env::var("FAMILIAR_REPARSE_UNC").expect("the workflow sets the share with the fixtures");
    let mapped = std::env::var("FAMILIAR_REPARSE_MAPPED").expect("the workflow sets the mapped drive with the fixtures");
    Some(Fixtures { dir, unc, mapped })
}

fn show(r: &Result<impl std::fmt::Debug, PathError>) -> String {
    match r {
        Ok(p) => format!("ok {p:?}"),
        Err(e) => e.kind().to_string(),
    }
}

/// Run by the workflow's setup, before the SMB counters are read: a junction to the share,
/// which `mklink` and `New-Item` won't write. Writing it touches only this folder.
#[test]
#[ignore]
fn make_the_junction_to_the_share() {
    let fx = fixtures().expect("run by the shell-win workflow");
    let j_share = format!("{}\\j-share", fx.dir);
    std::fs::create_dir_all(&j_share).unwrap();
    let share = fx.unc.trim_start_matches('\\');
    make_junction(&j_share, &format!("\\??\\UNC\\{share}\\"), &format!("{}\\", fx.unc)).expect("write the junction");
    println!("junction {j_share} -> {:?}", WinFs.open(&j_share));
}

#[test]
fn share_reaching_paths_are_refused_and_a_local_junction_passes() {
    let Some(fx) = fixtures() else {
        eprintln!("skipped: FAMILIAR_REPARSE_FIXTURES is not set (the shell-win workflow sets it)");
        return;
    };
    let d = &fx.dir;
    let mut report = String::new();
    // Each link is read without being followed.
    let raw = [
        ("j-share", Some("UNC")),
        ("s-share", Some("UNC")),
        ("s-mapped", Some(&*format!("{}:", fx.mapped))),
        ("j-local", Some("local")),
    ];
    for (name, holds) in raw {
        let node = WinFs.open(&format!("{d}\\{name}"));
        writeln!(report, "READ {name} {node:?}").unwrap();
        let target = match &node {
            Ok(Node::Link(Link::Junction { target })) | Ok(Node::Link(Link::Symlink { target, .. })) => target.clone(),
            other => panic!("{name} should be a link, got {other:?}"),
        };
        if let Some(h) = holds {
            assert!(target.contains(h), "{name}: {target}");
        }
    }
    writeln!(report, "DRIVE C:\\ {:?}", WinFs.drive_type("C:\\")).unwrap();
    writeln!(report, "DRIVE {}:\\ {:?}", fx.mapped, WinFs.drive_type(&format!("{}:\\", fx.mapped))).unwrap();
    assert_eq!(WinFs.drive_type("C:\\"), DriveType::Fixed);
    assert_eq!(WinFs.drive_type(&format!("{}:\\", fx.mapped)), DriveType::Remote);

    let unsafe_cases = [
        ("unc-program", format!("{}\\familiar-fx\\tool.exe", fx.unc), Role::Program),
        ("unc-folder", format!("{}\\familiar-fx", fx.unc), Role::Folder),
        ("mapped-program", format!("{}:\\familiar-fx\\tool.exe", fx.mapped), Role::Program),
        ("mapped-folder", format!("{}:\\familiar-fx", fx.mapped), Role::Folder),
        ("junction-to-share", format!("{d}\\j-share\\familiar-fx"), Role::Folder),
        ("symlink-to-share", format!("{d}\\s-share\\familiar-fx"), Role::Folder),
        ("link-to-mapped-drive", format!("{d}\\s-mapped\\familiar-fx\\tool.exe"), Role::Program),
    ];
    for (name, path, role) in &unsafe_cases {
        let r = check(&WinFs, path, *role);
        writeln!(report, "CASE {name} {}", show(&r)).unwrap();
        assert_eq!(r.err(), Some(PathError::UnsafePath), "{name}: {path}");
    }
    let folder = check(&WinFs, &format!("{d}\\j-local\\bin"), Role::Folder);
    writeln!(report, "CASE local-junction-folder {}", show(&folder)).unwrap();
    let program = check(&WinFs, &format!("{d}\\j-local\\bin\\tool.exe"), Role::Program);
    writeln!(report, "CASE local-junction-program {}", show(&program)).unwrap();
    assert_eq!(folder.unwrap().to_string_full().to_lowercase(), format!("{d}\\local\\bin").to_lowercase());
    assert!(program.is_ok());

    print!("{report}");
    std::fs::write(Path::new(d).join("reparse-results.txt"), report).unwrap();
}

#[test]
fn path_lookup_on_the_real_path() {
    let path = std::env::var("PATH").unwrap_or_default();
    let pathext = std::env::var("PATHEXT").ok();
    let cmd = resolve(&WinFs, "cmd", &path, pathext.as_deref()).expect("cmd is on PATH").program;
    println!("RESOLVE cmd {cmd}");
    assert!(cmd.to_lowercase().ends_with("\\system32\\cmd.exe"), "{cmd}");
    if let Ok(node) = resolve(&WinFs, "node", &path, pathext.as_deref()).map(|r| r.program) {
        println!("RESOLVE node {node}");
        assert!(node.to_lowercase().ends_with("\\node.exe"), "{node}");
    }
    if let Ok(npx) = resolve(&WinFs, "npx", &path, pathext.as_deref()).map(|r| r.program) {
        println!("RESOLVE npx {npx}");
        assert!(npx.to_lowercase().ends_with("\\npx.cmd"), "npx.cmd, never npx.ps1: {npx}");
    }
    assert_eq!(resolve(&WinFs, "familiar-no-such-program", &path, pathext.as_deref()).err(), Some(PathError::NotFound));
}

#[test]
fn app_execution_aliases_where_the_runner_has_one() {
    let Ok(local) = std::env::var("LOCALAPPDATA") else { return };
    let apps = format!("{local}\\Microsoft\\WindowsApps");
    let Ok(entries) = std::fs::read_dir(&apps) else {
        println!("ALIAS none: no {apps}");
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".exe") {
            continue;
        }
        let path = format!("{apps}\\{name}");
        if let Ok(Node::Link(Link::AppExecLink)) = WinFs.open(&path) {
            let r = check(&WinFs, &path, Role::Program);
            println!("ALIAS {name} as the program: {}", show(&r));
            assert!(r.is_ok(), "{path}");
            assert_eq!(check(&WinFs, &format!("{path}\\x"), Role::Folder).err(), Some(PathError::UnsafePath));
            return;
        }
    }
    println!("ALIAS none found in {apps}");
}

#[test]
fn a_retargeted_link_is_caught_before_starting() {
    // A real file symbolic link (the runner is admin), pointed elsewhere after approval.
    let base = std::env::temp_dir().join(format!("familiar-retarget-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    for d in ["approved", "other", "bin"] {
        std::fs::create_dir_all(base.join(d)).unwrap();
    }
    std::fs::write(base.join("approved").join("tool.exe"), "a placeholder, never run").unwrap();
    std::fs::write(base.join("other").join("tool.exe"), "a placeholder, never run").unwrap();
    let link = base.join("bin").join("tool.exe");
    std::os::windows::fs::symlink_file(base.join("approved").join("tool.exe"), &link).expect("make a file symbolic link");
    let base_s = base.to_string_lossy().into_owned();
    let bin = format!("{base_s}\\bin");
    let approved = launch(&WinFs, "tool", &base_s, &bin, None).expect("resolve through the link");
    println!("LAUNCH {approved:?}");
    assert!(approved.program_target.to_lowercase().ends_with("\\approved\\tool.exe"), "{approved:?}");
    assert_eq!(recheck(&WinFs, &approved), Ok(()));
    std::fs::remove_file(&link).unwrap();
    std::os::windows::fs::symlink_file(base.join("other").join("tool.exe"), &link).unwrap();
    assert_eq!(recheck(&WinFs, &approved), Err(PathError::UnsafePath));
    let _ = std::fs::remove_dir_all(&base);
}
