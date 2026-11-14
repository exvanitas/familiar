//! The start sequence on Windows, with a real suspended child: each stage after the spawn made to
//! fail in turn, and the child checked gone after each. And the sweep of a child left outside any
//! job by a hard kill. The child is whoami.exe, which never runs while suspended.
#![cfg(windows)]

use std::{cell::Cell, io, os::windows::process::CommandExt, process::Command, sync::Arc};

use shell_win::start::{creation_time, start, sweep_one, Job, RealOs, StartError, StartOs, Swept};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, WaitForSingleObject, CREATE_SUSPENDED, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE},
};

fn whoami() -> Command {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    Command::new(format!("{root}\\System32\\whoami.exe"))
}

/// A handle that outlives the child's own, to see it end.
struct Watch(HANDLE);

impl Watch {
    fn of(pid: u32) -> Watch {
        Watch(unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.expect("open the child"))
    }
    fn gone_within(&self, ms: u32) -> bool {
        (unsafe { WaitForSingleObject(self.0, ms) }) == WAIT_OBJECT_0
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Stage {
    Job,
    Assign,
    Resume,
}

struct FailAt(Stage);

impl StartOs for FailAt {
    fn new_job(&self) -> io::Result<Job> {
        if self.0 == Stage::Job {
            return Err(io::Error::other("no job, on purpose"));
        }
        RealOs.new_job()
    }
    fn assign(&self, job: &Job, child: &std::process::Child) -> io::Result<()> {
        if self.0 == Stage::Assign {
            return Err(io::Error::other("no assign, on purpose"));
        }
        RealOs.assign(job, child)
    }
    fn resume(&self, child: &std::process::Child) -> io::Result<()> {
        if self.0 == Stage::Resume {
            return Err(io::Error::other("no resume, on purpose"));
        }
        RealOs.resume(child)
    }
}

#[test]
fn every_failed_stage_leaves_no_child() {
    for stage in [Stage::Job, Stage::Assign, Stage::Resume] {
        let watch = Cell::new(None);
        let r = start(&FailAt(stage), whoami(), |c| { watch.set(Some(Watch::of(c.id()))); Ok(()) }, |_| Ok::<(), ()>(()));
        let label = format!("{stage:?}");
        match r {
            Err(StartError::Stage(s, _)) => println!("STAGE {label} failed as {s}"),
            other => panic!("{label}: expected a stage failure, got {:?}", other.map(|_| ())),
        }
        let w = watch.take().expect("the child was spawned");
        assert!(w.gone_within(2000), "{label}: the suspended child is still there");
    }
}

#[test]
fn a_refusal_before_resume_leaves_no_child() {
    let watch = Cell::new(None);
    let saw_job = Cell::new(false);
    let r = start(&RealOs, whoami(), |c| { watch.set(Some(Watch::of(c.id()))); Ok(()) }, |job: &Arc<Job>| {
        saw_job.set(Arc::strong_count(job) >= 1);
        Err("forgotten meanwhile")
    });
    assert!(matches!(r, Err(StartError::Refused("forgotten meanwhile"))));
    assert!(saw_job.get());
    assert!(watch.take().unwrap().gone_within(2000), "the refused child is still there");
}

#[test]
fn a_good_start_runs_in_its_job() {
    let mut cmd = whoami();
    cmd.stdout(std::process::Stdio::null());
    let (mut child, job) = start(&RealOs, cmd, |_| Ok(()), |_| Ok::<(), ()>(())).expect("start");
    assert!(child.wait().unwrap().success());
    drop(job);
}

#[test]
fn invalid_arguments_make_no_process() {
    let mut cmd = whoami();
    cmd.arg("a\0b");
    assert!(matches!(start(&RealOs, cmd, |_| panic!("no child for bad arguments"), |_| Ok::<(), ()>(())), Err(StartError::InvalidInput)));
}

#[test]
fn a_record_that_fails_aborts_the_start_and_leaves_no_child() {
    let watch = Cell::new(None);
    let r = start(
        &RealOs,
        whoami(),
        |c| {
            watch.set(Some(Watch::of(c.id())));
            Err(io::Error::other("no record, on purpose"))
        },
        |_| -> Result<(), ()> { panic!("no job step after a failed record") },
    );
    assert!(matches!(r, Err(StartError::Stage("record", _))));
    assert!(watch.take().unwrap().gone_within(2000), "the unrecorded child is still there");
}

#[test]
fn the_sweep_ends_a_child_left_outside_a_job_and_nothing_else() {
    // What a hard kill between the spawn and the assignment would leave: a suspended child in no
    // job of ours.
    let mut cmd = whoami();
    cmd.creation_flags(CREATE_SUSPENDED.0);
    let child = cmd.spawn().unwrap();
    let pid = child.id();
    let watch = Watch::of(pid);
    let created = creation_time(pid).expect("its creation time");
    drop(child);
    assert_eq!(sweep_one(pid, created + 1), Swept::Gone, "another creation time is another process");
    assert!(!watch.gone_within(200), "and it's left alone");
    assert_eq!(sweep_one(pid, created), Swept::Ended);
    assert!(watch.gone_within(2000), "the swept child is still there");
    drop(watch);
    assert_eq!(sweep_one(pid, created), Swept::Gone, "once ended, gone");
}

#[test]
fn the_sweep_keeps_a_record_it_cant_prove_gone() {
    // The System process (id 4) can't be opened by a user: access denied proves nothing about a
    // child of ours, so the record is kept, whatever its creation time.
    assert_eq!(sweep_one(4, 0), Swept::Failed, "access denied is not gone");
    assert_eq!(sweep_one(4, u64::MAX), Swept::Failed, "nor with any creation time");
}
