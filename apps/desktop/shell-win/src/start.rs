//! Starting a server process the mcp-start spike's way: suspended with no console window, put in
//! a new kill-on-close job, then resumed, with every failure after the spawn ending the child.
//! The OS calls after the spawn are behind `StartOs`, so tests can fail each stage with a real
//! suspended child and check it's gone. See "5b. Starting a local MCP server".
//!
//! Rust 1.95 can't create a process inside a job (`CommandExt::raw_attribute`, for
//! `PROC_THREAD_ATTRIBUTE_JOB_LIST`, is unstable). So a hard kill between the spawn and the
//! assignment could leave a suspended child outside any job. The caller records each child
//! between `spawned` and the end of `start`, and `sweep` ends what such a record names at the next
//! start, matched by process id and creation time so a reused id is never touched.

use std::{
    ffi::c_void,
    io,
    mem::size_of,
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::{Child, Command},
    sync::Arc,
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetProcessTimes, OpenProcess, OpenThread, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
            },
        },
    },
};

/// A job object. When its last handle closes (on drop, or when the exe dies in any way), Windows
/// ends every process in it, grandchildren included.
pub struct Job(HANDLE);

// A kernel object handle, usable from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> io::Result<Job> {
        // No name and default security: the handle isn't inheritable, so no child holds it.
        let job = Job(unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(io::Error::other)?);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // No BREAKAWAY_OK: processes in the job can't leave it.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        unsafe {
            SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const c_void, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        }
        .map_err(io::Error::other)?;
        Ok(job)
    }

    /// Ends every process in the job now. Never waits on anything else.
    pub fn terminate(&self) {
        let _ = unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// The OS calls after the spawn. The defaults are the real ones.
pub trait StartOs {
    fn new_job(&self) -> io::Result<Job> {
        Job::new()
    }
    fn assign(&self, job: &Job, child: &Child) -> io::Result<()> {
        unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }.map_err(io::Error::other)
    }
    fn resume(&self, child: &Child) -> io::Result<()> {
        resume(child.id()).map(|_| ())
    }
}

pub struct RealOs;
impl StartOs for RealOs {}

#[derive(Debug)]
pub enum StartError<E> {
    /// std refused the arguments before any process existed.
    InvalidInput,
    Spawn(io::Error),
    /// A stage after the spawn failed, and the child was ended.
    Stage(&'static str, io::Error),
    /// The caller's last check refused, and the child was ended.
    Refused(E),
}

/// Resumes the threads of a process made with CREATE_SUSPENDED. std's Child doesn't give the
/// main thread's handle, so they're found in a snapshot. A new suspended process has one.
fn resume(pid: u32) -> io::Result<usize> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(io::Error::other)?;
    let mut resumed = 0;
    let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut more = unsafe { Thread32First(snap, &mut entry) }.is_ok();
    while more {
        if entry.th32OwnerProcessID == pid {
            if let Ok(t) = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) } {
                if unsafe { ResumeThread(t) } != u32::MAX {
                    resumed += 1;
                }
                let _ = unsafe { CloseHandle(t) };
            }
        }
        more = unsafe { Thread32Next(snap, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snap) };
    if resumed == 0 {
        return Err(io::Error::other(format!("no thread of process {pid} could be resumed")));
    }
    Ok(resumed)
}

fn end(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Spawns `cmd` suspended with no console window, has `spawned` record it for `sweep` (a failure
/// to record aborts the start), makes a job, assigns the child, runs `before_resume` with the job
/// (the caller's last word), then resumes. On any failure after the spawn the child is ended and
/// waited for, so nothing is left half-started.
pub fn start<E>(
    os: &dyn StartOs,
    mut cmd: Command,
    spawned: impl FnOnce(&Child) -> io::Result<()>,
    before_resume: impl FnOnce(&Arc<Job>) -> Result<(), E>,
) -> Result<(Child, Arc<Job>), StartError<E>> {
    cmd.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    let mut child = cmd.spawn().map_err(|e| if e.kind() == io::ErrorKind::InvalidInput { StartError::InvalidInput } else { StartError::Spawn(e) })?;
    if let Err(e) = spawned(&child) {
        end(&mut child);
        return Err(StartError::Stage("record", e));
    }
    let job = match os.new_job() {
        Ok(j) => Arc::new(j),
        Err(e) => {
            end(&mut child);
            return Err(StartError::Stage("job", e));
        }
    };
    if let Err(e) = os.assign(&job, &child) {
        end(&mut child);
        return Err(StartError::Stage("assign", e));
    }
    if let Err(e) = before_resume(&job) {
        job.terminate();
        end(&mut child);
        return Err(StartError::Refused(e));
    }
    if let Err(e) = os.resume(&child) {
        job.terminate();
        end(&mut child);
        return Err(StartError::Stage("resume", e));
    }
    Ok((child, job))
}

fn u64_of(t: FILETIME) -> u64 {
    (t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64
}

fn times(h: HANDLE) -> Option<u64> {
    let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u) }.ok().map(|_| u64_of(c))
}

/// A process's creation time, as a FILETIME count, or None if it isn't there.
pub fn creation_time(pid: u32) -> Option<u64> {
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let t = times(h);
    let _ = unsafe { CloseHandle(h) };
    t
}

/// What one record's process came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Swept {
    /// It was still the recorded child, and it's ended.
    Ended,
    /// It's gone, or its id now belongs to another process, which is left alone.
    Gone,
    /// It's there and couldn't be ended: keep the record and try again at the next start.
    Failed,
}

/// Ends a recorded child if it's still the same process: the same id and creation time, read from
/// the one handle that ends it, so an id reused meanwhile is never touched.
pub fn sweep_one(pid: u32, created: u64) -> Swept {
    let h = match unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(h) => h,
        // No such process. (Access denied would mean another user's, so not our child either.)
        Err(_) => return Swept::Gone,
    };
    let r = match times(h) {
        Some(t) if t == created => {
            if unsafe { TerminateProcess(h, 1) }.is_ok() {
                Swept::Ended
            } else if unsafe { WaitForSingleObject(h, 0) } == WAIT_OBJECT_0 {
                // It had already ended: only a handle still held it.
                Swept::Gone
            } else {
                Swept::Failed
            }
        }
        Some(_) => Swept::Gone,
        None => Swept::Failed,
    };
    let _ = unsafe { CloseHandle(h) };
    r
}
