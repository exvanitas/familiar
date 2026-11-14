//! The sink proxy. Bound before any window opens, on `127.0.0.1` at a port the system picks, with
//! `SO_EXCLUSIVEADDRUSE` so nothing else can take it. Every window's browser arguments name it as
//! the proxy, so whatever the webview's own network stack tries ends here, refused. The rules and
//! counts are `shell_core::sink`. It never logs what it was asked for, only how many.

use shell_core::{log::Log, sink};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

/// A connection whose reads get the time left before one deadline for the whole first line.
struct Conn<'a>(&'a TcpStream);

impl Read for Conn<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        (&mut &*self.0).read(buf)
    }
}

impl sink::Timed for Conn<'_> {
    fn read_within(&mut self, left: Duration) -> bool {
        self.0.set_read_timeout(Some(left)).is_ok()
    }
}

/// Connections handled at once. Past that, a connection is closed at once, and still counted.
const AT_ONCE: usize = 64;

#[cfg(windows)]
fn exclusive(s: &Socket) -> std::io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use windows::Win32::Networking::WinSock::{setsockopt, SOCKET, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};
    let on = 1i32.to_ne_bytes();
    let r = unsafe { setsockopt(SOCKET(s.as_raw_socket() as usize), SOL_SOCKET, SO_EXCLUSIVEADDRUSE, Some(&on)) };
    if r == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn exclusive(_: &Socket) -> std::io::Result<()> {
    Ok(())
}

fn refuse(mut stream: TcpStream, counts: &sink::Counts) {
    let deadline = Instant::now() + sink::LINE_WITHIN;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let kind = sink::first_line(&mut Conn(&stream), deadline, Instant::now);
    let _ = stream.write_all(sink::RESPONSE);
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
    counts.add(kind);
}

pub fn start(log: Arc<Log>) -> std::io::Result<(u16, Arc<sink::Counts>)> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    exclusive(&socket)?;
    socket.bind(&SocketAddr::from(([127, 0, 0, 1], 0)).into())?;
    socket.listen(128)?;
    let listener: TcpListener = socket.into();
    let port = listener.local_addr()?.port();
    let counts = Arc::new(sink::Counts::default());

    let c = counts.clone();
    let busy = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if busy.load(Ordering::Relaxed) >= AT_ONCE {
                let _ = stream.shutdown(Shutdown::Both);
                c.add(sink::Kind::Other);
                continue;
            }
            busy.fetch_add(1, Ordering::Relaxed);
            let (c, busy) = (c.clone(), busy.clone());
            thread::spawn(move || {
                refuse(stream, &c);
                busy.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });

    // The count goes to the log when it changes, at most once a second, so a check can see the
    // webview really used the sink.
    let c = counts.clone();
    thread::spawn(move || {
        let mut last = 0;
        loop {
            thread::sleep(Duration::from_secs(1));
            let now = c.get().0;
            if now != last {
                last = now;
                log.line(&c.line());
            }
        }
    });
    Ok((port, counts))
}
