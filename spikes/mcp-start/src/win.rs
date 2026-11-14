//! The Win32 parts: a job object that kills its processes when its last handle closes,
//! resuming a process started suspended, and process snapshots for the cleanup check.

use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, ResumeThread, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

/// A job object. When its handle closes (on drop, or when this process dies in any way),
/// Windows ends every process in it, grandchildren included.
pub struct Job(HANDLE);

// The handle is a kernel object handle, usable from any thread.
unsafe impl Send for Job {}

impl Job {
    pub fn new() -> io::Result<Job> {
        // No name, and default security: the handle is not inheritable, so no child holds the job open.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(handle);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        // Kill on close. Die on unhandled exception, so a crashing server never waits on a Windows Error Reporting dialog.
        // No BREAKAWAY_OK: processes in the job can't leave it.
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub fn assign(&self, process: HANDLE) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Ends every process in the job now: the Stop button and restarts.
    pub fn terminate(&self, code: u32) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Resumes every thread of a process created with CREATE_SUSPENDED. std's Child doesn't expose the
/// main thread's handle, so this finds the process's threads in a snapshot. A suspended new process has one.
pub fn resume_process(pid: u32) -> io::Result<usize> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut resumed = 0;
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut more = unsafe { Thread32First(snap, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                if unsafe { ResumeThread(thread) } != u32::MAX {
                    resumed += 1;
                }
                unsafe { CloseHandle(thread) };
            }
        }
        more = unsafe { Thread32Next(snap, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snap) };
    if resumed == 0 {
        return Err(io::Error::other(format!("no thread of process {pid} could be resumed")));
    }
    Ok(resumed)
}

#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: u32,
    pub exe: String,
}

pub fn snapshot_processes() -> io::Result<Vec<ProcInfo>> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut out = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut more = unsafe { Process32FirstW(snap, &mut entry) } != 0;
    while more {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        out.push(ProcInfo {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
        });
        more = unsafe { Process32NextW(snap, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snap) };
    Ok(out)
}

/// Every process descended from `root`, with its depth, in tree order. Parent ids can be stale after a parent
/// exits and its id is reused, so this is a view for the log. The cleanup check waits on handles, not ids.
pub fn descendants(all: &[ProcInfo], root: u32) -> Vec<(usize, ProcInfo)> {
    fn walk(all: &[ProcInfo], pid: u32, depth: usize, out: &mut Vec<(usize, ProcInfo)>) {
        for p in all.iter().filter(|p| p.parent == pid && p.pid != pid && p.pid != 0) {
            if out.iter().any(|(_, q)| q.pid == p.pid) {
                continue;
            }
            out.push((depth, p.clone()));
            walk(all, p.pid, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(all, root, 1, &mut out);
    out
}

/// A handle that can wait for a process to end, opened while it's still running so a reused id can't fool the check.
pub struct ProcHandle(pub HANDLE);
unsafe impl Send for ProcHandle {}

impl ProcHandle {
    pub fn open(pid: u32) -> Option<ProcHandle> {
        let h = unsafe {
            OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid)
        };
        if h.is_null() {
            None
        } else {
            Some(ProcHandle(h))
        }
    }

    /// True if the process has ended within `ms` milliseconds.
    pub fn wait_ms(&self, ms: u32) -> bool {
        unsafe { WaitForSingleObject(self.0, ms) == WAIT_OBJECT_0 }
    }

    pub fn terminate(&self) {
        unsafe { windows_sys::Win32::System::Threading::TerminateProcess(self.0, 1) };
    }
}

impl Drop for ProcHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// What this process sees of its console: the console window's handle (0 when there's no window) and whether it's visible.
pub fn console_window() -> (usize, bool) {
    let hwnd = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
    let visible = !hwnd.is_null() && unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd) } != 0;
    (hwnd as usize, visible)
}
