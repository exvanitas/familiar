//! The sink proxy's rules. Every window is told to use it as its proxy, so any request the
//! webview's own network stack makes lands here and fails, whatever started it. It reads only up
//! to the end of the first line, answers 403 and closes. It counts what it refused by kind, and
//! keeps nothing else: no host, no path, no bytes.

use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// The whole answer.
pub const RESPONSE: &[u8] = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
/// The most it reads looking for the end of the first line.
pub const FIRST_LINE_MAX: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `CONNECT`: a tunnel, which is how https, WebSocket over TLS and TURN over TCP ask.
    Connect,
    /// Any other method: a plain http request sent to the proxy.
    Request,
    /// Nothing that looks like http, or nothing at all.
    Other,
}

/// The whole first line must arrive within this, however slowly it trickles in.
pub const LINE_WITHIN: Duration = Duration::from_secs(2);

/// A connection whose next read can be given a time limit.
pub trait Timed: Read {
    /// False if the limit couldn't be set, and then nothing more is read.
    fn read_within(&mut self, left: Duration) -> bool;
}

/// Reads one byte at a time up to the first `\n`, the cap, the end, an error or `deadline`, so
/// nothing past the first line is ever read and no client holds the sink past the deadline. Each
/// read's limit is the time left. Only the method decides the kind.
pub fn first_line<R: Timed>(r: &mut R, deadline: Instant, now: impl Fn() -> Instant) -> Kind {
    let mut line = Vec::with_capacity(64);
    let mut b = [0u8; 1];
    while line.len() < FIRST_LINE_MAX {
        let left = deadline.saturating_duration_since(now());
        if left.is_zero() || !r.read_within(left) {
            break;
        }
        match r.read(&mut b) {
            Ok(1) if b[0] == b'\n' => break,
            Ok(1) => line.push(b[0]),
            _ => break,
        }
    }
    classify(&line)
}

pub fn classify(line: &[u8]) -> Kind {
    let method = line.split(|b| *b == b' ').next().unwrap_or_default();
    if method == b"CONNECT" {
        Kind::Connect
    } else if !method.is_empty() && method.len() <= 16 && method.iter().all(u8::is_ascii_uppercase) && line.ends_with(b"\r") && line.windows(5).any(|w| w == b"HTTP/") {
        Kind::Request
    } else {
        Kind::Other
    }
}

#[derive(Default)]
pub struct Counts {
    connect: AtomicU64,
    request: AtomicU64,
    other: AtomicU64,
}

impl Counts {
    pub fn add(&self, k: Kind) {
        let c = match k {
            Kind::Connect => &self.connect,
            Kind::Request => &self.request,
            Kind::Other => &self.other,
        };
        c.fetch_add(1, Ordering::Relaxed);
    }

    /// (all, connect, request, other)
    pub fn get(&self) -> (u64, u64, u64, u64) {
        let (c, r, o) = (self.connect.load(Ordering::Relaxed), self.request.load(Ordering::Relaxed), self.other.load(Ordering::Relaxed));
        (c + r + o, c, r, o)
    }

    /// The log line. Counts only.
    pub fn line(&self) -> String {
        let (all, c, r, o) = self.get();
        format!("sink refused {all} (connect {c}, request {r}, other {o})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Cursor;

    /// A connection that always takes its limit: reads never time out here.
    struct Fast<R>(R);
    impl<R: Read> Read for Fast<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
    }
    impl<R: Read> Timed for Fast<R> {
        fn read_within(&mut self, _: Duration) -> bool {
            true
        }
    }
    fn first(data: &[u8]) -> Kind {
        first_line(&mut Fast(Cursor::new(data.to_vec())), Instant::now() + LINE_WITHIN, Instant::now)
    }

    /// One byte a second, never a newline, on a clock the test moves.
    struct Trickle<'a> {
        clock: &'a Cell<Duration>,
        reads: u32,
        limits: Vec<Duration>,
        settable: bool,
    }
    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            self.clock.set(self.clock.get() + Duration::from_secs(1));
            buf[0] = b'A';
            Ok(1)
        }
    }
    impl Timed for Trickle<'_> {
        fn read_within(&mut self, left: Duration) -> bool {
            self.limits.push(left);
            self.settable
        }
    }

    /// A reader that fails the test if anything past the first line is read.
    struct Strict<'a> {
        data: &'a [u8],
        at: usize,
        stop: usize,
    }
    impl Read for Strict<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            assert!(self.at < self.stop, "read past the first line");
            let n = buf.len().min(self.stop - self.at).min(self.data.len() - self.at);
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    #[test]
    fn kinds() {
        assert_eq!(first(b"CONNECT a.test:443 HTTP/1.1\r\nHost: a\r\n\r\n"), Kind::Connect);
        assert_eq!(first(b"GET http://a.test/x HTTP/1.1\r\nHost: a\r\n\r\n"), Kind::Request);
        assert_eq!(first(b"POST http://a.test/ HTTP/1.1\r\n"), Kind::Request);
        assert_eq!(first(b"\x16\x03\x01junk"), Kind::Other);
        assert_eq!(first(b""), Kind::Other);
        assert_eq!(first(b"get http://a/ HTTP/1.1\r\n"), Kind::Other);
    }

    #[test]
    fn nothing_past_the_first_line_is_read() {
        let data = b"GET http://a.test/ HTTP/1.1\r\nCookie: never-read\r\n\r\nbody";
        let stop = data.iter().position(|b| *b == b'\n').unwrap() + 1;
        assert_eq!(first_line(&mut Fast(Strict { data, at: 0, stop }), Instant::now() + LINE_WITHIN, Instant::now), Kind::Request);
    }

    #[test]
    fn a_line_with_no_end_is_cut_at_the_cap() {
        let data = vec![b'A'; FIRST_LINE_MAX * 4];
        assert_eq!(first_line(&mut Fast(Strict { data: &data, at: 0, stop: FIRST_LINE_MAX }), Instant::now() + LINE_WITHIN, Instant::now), Kind::Other);
    }

    #[test]
    fn a_client_that_trickles_is_cut_off_at_one_deadline() {
        let start = Instant::now();
        let clock = Cell::new(Duration::ZERO);
        let mut t = Trickle { clock: &clock, reads: 0, limits: vec![], settable: true };
        assert_eq!(first_line(&mut t, start + LINE_WITHIN, || start + clock.get()), Kind::Other);
        assert_eq!(t.reads, 2, "one byte a second, two seconds");
        assert_eq!(t.limits, [Duration::from_secs(2), Duration::from_secs(1)], "each read gets only the time left");
    }

    #[test]
    fn a_connection_whose_limit_cant_be_set_is_not_read() {
        let start = Instant::now();
        let clock = Cell::new(Duration::ZERO);
        let mut t = Trickle { clock: &clock, reads: 0, limits: vec![], settable: false };
        assert_eq!(first_line(&mut t, start + LINE_WITHIN, || start + clock.get()), Kind::Other);
        assert_eq!(t.reads, 0);
    }

    #[test]
    fn counts_and_the_line_hold_numbers_only() {
        let c = Counts::default();
        c.add(Kind::Connect);
        c.add(Kind::Connect);
        c.add(Kind::Request);
        c.add(Kind::Other);
        assert_eq!(c.get(), (4, 2, 1, 1));
        assert_eq!(c.line(), "sink refused 4 (connect 2, request 1, other 1)");
    }

    #[test]
    fn the_answer_is_a_bare_403() {
        assert!(RESPONSE.starts_with(b"HTTP/1.1 403 "));
        assert!(RESPONSE.ends_with(b"\r\n\r\n"));
    }
}
