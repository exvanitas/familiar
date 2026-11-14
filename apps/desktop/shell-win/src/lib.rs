//! The OS side of shell-core's `server_path::Fs`: `GetDriveTypeW`, `CreateFileW` with
//! `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, which never follows a link, and
//! `FSCTL_GET_REPARSE_POINT` to read a link's tag and target. Every rule stays in shell-core.
//!
//! The reparse data parser is plain code, so its tests run on any system. The calls are
//! Windows only.

use shell_core::server_path::Link;

pub const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
pub const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
pub const IO_REPARSE_TAG_APPEXECLINK: u32 = 0x8000_001B;
pub const SYMLINK_FLAG_RELATIVE: u32 = 1;
/// `MAXIMUM_REPARSE_DATA_BUFFER_SIZE`.
pub const MAX_REPARSE_DATA: usize = 16 * 1024;
pub const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;
pub const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;

/// Reads a `REPARSE_DATA_BUFFER`. A symbolic link or junction gives its substitute name, the
/// target as the system stores it. Data that doesn't parse is `None`, which the walk refuses.
pub fn parse_reparse(buf: &[u8]) -> Option<Link> {
    let u16_at = |at: usize| buf.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let u32_at = |at: usize| buf.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let tag = u32_at(0)?;
    let data_len = u16_at(4)?;
    if buf.len() < 8 + data_len {
        return None;
    }
    let data = &buf[8..8 + data_len];
    let name = |path_start: usize| -> Option<String> {
        let off = u16_at(8)?;
        let len = u16_at(10)?;
        if off % 2 != 0 || len % 2 != 0 {
            return None;
        }
        let bytes = data.get(path_start + off..path_start + off + len)?;
        let wide: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&wide).ok()
    };
    match tag {
        IO_REPARSE_TAG_SYMLINK => {
            // SubstituteNameOffset, SubstituteNameLength, PrintNameOffset, PrintNameLength, Flags, PathBuffer
            let flags = u32_at(16)?;
            Some(Link::Symlink { target: name(12)?, relative: flags & SYMLINK_FLAG_RELATIVE != 0 })
        }
        // SubstituteNameOffset, SubstituteNameLength, PrintNameOffset, PrintNameLength, PathBuffer
        IO_REPARSE_TAG_MOUNT_POINT => Some(Link::Junction { target: name(8)? }),
        IO_REPARSE_TAG_APPEXECLINK => Some(Link::AppExecLink),
        tag => Some(Link::Other { tag }),
    }
}

/// A mount point's `REPARSE_DATA_BUFFER`, for making junctions in tests with any target,
/// including ones `mklink` won't write.
pub fn junction_data(substitute: &str, print: &str) -> Vec<u8> {
    let sub: Vec<u16> = substitute.encode_utf16().collect();
    let pr: Vec<u16> = print.encode_utf16().collect();
    let (sub_len, pr_len) = (sub.len() * 2, pr.len() * 2);
    let path_bytes = sub_len + 2 + pr_len + 2;
    let mut b = Vec::with_capacity(16 + path_bytes);
    b.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    b.extend(((8 + path_bytes) as u16).to_le_bytes());
    b.extend(0u16.to_le_bytes());
    b.extend(0u16.to_le_bytes());
    b.extend((sub_len as u16).to_le_bytes());
    b.extend(((sub_len + 2) as u16).to_le_bytes());
    b.extend((pr_len as u16).to_le_bytes());
    for w in sub.iter().chain([0u16].iter()).chain(pr.iter()).chain([0u16].iter()) {
        b.extend(w.to_le_bytes());
    }
    b
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    use shell_core::server_path::{DriveType, Fs, FsError, Node};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GENERIC_WRITE, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetDriveTypeW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::IO::DeviceIoControl;

    use super::*;

    /// The real file system, read without following links.
    pub struct WinFs;

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Opens a path itself, never what a link at its last name points to.
    fn open_no_follow(path: &str, access: u32) -> windows::core::Result<Handle> {
        let h = unsafe {
            CreateFileW(
                &HSTRING::from(path),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        }?;
        Ok(Handle(h))
    }

    fn reparse_data(h: &Handle) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; MAX_REPARSE_DATA];
        let mut got = 0u32;
        unsafe {
            DeviceIoControl(
                h.0,
                FSCTL_GET_REPARSE_POINT,
                None,
                0,
                Some(buf.as_mut_ptr() as *mut c_void),
                buf.len() as u32,
                Some(&mut got),
                None,
            )
        }
        .ok()?;
        buf.truncate(got as usize);
        Some(buf)
    }

    impl Fs for WinFs {
        fn drive_type(&self, root: &str) -> DriveType {
            // Reads the drive table. It doesn't open the root or anything on a share.
            match unsafe { GetDriveTypeW(&HSTRING::from(root)) } {
                2 => DriveType::Removable,
                3 => DriveType::Fixed,
                4 => DriveType::Remote,
                5 => DriveType::CdRom,
                6 => DriveType::RamDisk,
                1 => DriveType::NoRootDir,
                _ => DriveType::Unknown,
            }
        }

        fn open(&self, path: &str) -> Result<Node, FsError> {
            let h = open_no_follow(path, FILE_READ_ATTRIBUTES.0).map_err(|e| {
                let code = e.code();
                if code == ERROR_FILE_NOT_FOUND.to_hresult() || code == ERROR_PATH_NOT_FOUND.to_hresult() {
                    FsError::NotFound
                } else {
                    FsError::Failed
                }
            })?;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            unsafe { GetFileInformationByHandle(h.0, &mut info) }.map_err(|_| FsError::Failed)?;
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                let data = reparse_data(&h).ok_or(FsError::Failed)?;
                return parse_reparse(&data).map(Node::Link).ok_or(FsError::Failed);
            }
            Ok(if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 { Node::Dir } else { Node::File })
        }
    }

    /// Turns an empty folder into a junction with any substitute name. For tests: it writes the
    /// reparse point and touches nothing the target names.
    pub fn make_junction(folder: &str, substitute: &str, print: &str) -> windows::core::Result<()> {
        let h = open_no_follow(folder, GENERIC_WRITE.0)?;
        let data = junction_data(substitute, print);
        unsafe {
            DeviceIoControl(h.0, FSCTL_SET_REPARSE_POINT, Some(data.as_ptr() as *const c_void), data.len() as u32, None, 0, None, None)
        }
    }
}

#[cfg(windows)]
pub use win::{make_junction, WinFs};

#[cfg(windows)]
pub mod start;

#[cfg(test)]
mod tests {
    use super::*;

    fn symlink_data(sub: &str, print: &str, flags: u32) -> Vec<u8> {
        let s: Vec<u16> = sub.encode_utf16().collect();
        let p: Vec<u16> = print.encode_utf16().collect();
        let path_bytes = (s.len() + p.len()) * 2;
        let mut b = Vec::new();
        b.extend(IO_REPARSE_TAG_SYMLINK.to_le_bytes());
        b.extend(((12 + path_bytes) as u16).to_le_bytes());
        b.extend(0u16.to_le_bytes());
        // As Windows writes them: the print name first, then the substitute name.
        b.extend(((p.len() * 2) as u16).to_le_bytes());
        b.extend(((s.len() * 2) as u16).to_le_bytes());
        b.extend(0u16.to_le_bytes());
        b.extend(((p.len() * 2) as u16).to_le_bytes());
        b.extend(flags.to_le_bytes());
        for w in p.iter().chain(s.iter()) {
            b.extend(w.to_le_bytes());
        }
        b
    }

    #[test]
    fn symbolic_links() {
        assert_eq!(
            parse_reparse(&symlink_data("\\??\\UNC\\localhost\\C$", "\\\\localhost\\C$", 0)),
            Some(Link::Symlink { target: "\\??\\UNC\\localhost\\C$".into(), relative: false })
        );
        assert_eq!(parse_reparse(&symlink_data("..\\x", "..\\x", 1)), Some(Link::Symlink { target: "..\\x".into(), relative: true }));
        assert_eq!(
            parse_reparse(&symlink_data("\\??\\C:\\café 日本", "C:\\café 日本", 0)),
            Some(Link::Symlink { target: "\\??\\C:\\café 日本".into(), relative: false })
        );
    }

    #[test]
    fn junctions() {
        let d = junction_data("\\??\\C:\\fx\\local\\", "C:\\fx\\local\\");
        assert_eq!(parse_reparse(&d), Some(Link::Junction { target: "\\??\\C:\\fx\\local\\".into() }));
        let d = junction_data("\\??\\UNC\\localhost\\C$\\", "");
        assert_eq!(parse_reparse(&d), Some(Link::Junction { target: "\\??\\UNC\\localhost\\C$\\".into() }));
    }

    #[test]
    fn other_tags_and_bad_data() {
        let mut alias = IO_REPARSE_TAG_APPEXECLINK.to_le_bytes().to_vec();
        alias.extend([4, 0, 0, 0, 3, 0, 0, 0]);
        assert_eq!(parse_reparse(&alias), Some(Link::AppExecLink));
        let mut cloud = 0x9000_601Au32.to_le_bytes().to_vec();
        cloud.extend([0, 0, 0, 0]);
        assert_eq!(parse_reparse(&cloud), Some(Link::Other { tag: 0x9000_601A }));
        assert_eq!(parse_reparse(&[]), None);
        assert_eq!(parse_reparse(&[0x0c, 0, 0, 0xa0]), None);
        let mut short = junction_data("\\??\\C:\\x", "");
        short.truncate(short.len() - 4);
        assert_eq!(parse_reparse(&short), None, "data shorter than it says");
        let mut odd = junction_data("\\??\\C:\\x", "");
        odd[8] = 1;
        assert_eq!(parse_reparse(&odd), None, "an odd offset");
        let mut past = junction_data("\\??\\C:\\x", "");
        past[11] = 0x40;
        assert_eq!(parse_reparse(&past), None, "a name past the end");
    }
}
