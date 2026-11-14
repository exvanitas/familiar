//! The log file. With no `--log` it's capped at 1 MB, with one old file kept, because bug reports
//! will come with it. Pages write to it through `log_line`, so a page's line is cut to 4 KiB, can't
//! start a line of its own, and each window gets 100 lines a second.
//!
//! Writing never blocks the caller: `line` stamps the time and hands the line to the log's own
//! thread through a bounded queue. When the queue is full the line is dropped and counted, and the
//! next line written says how many were lost. `flush` waits for the queue to drain, for the
//! moments that can wait: tests, and just before the exe exits.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Lines the queue holds before new ones are dropped.
pub const QUEUE: usize = 4096;

pub const CAP: u64 = 1024 * 1024;
/// The most of one page line that's kept, in bytes.
pub const LINE_MAX: usize = 4096;
/// Lines a second, for each window.
pub const RATE: u32 = 100;

struct Sink {
    file: File,
    path: PathBuf,
    size: u64,
    cap: Option<u64>,
    /// Lines dropped because the file was full and couldn't roll over.
    dropped: u64,
}

/// What the log's thread is handed.
enum Msg {
    /// A line, and how many were dropped just before it.
    Line(String, u64),
    Attach(Sink),
    Flushed(mpsc::Sender<()>),
}

pub struct Log {
    queue: SyncSender<Msg>,
    started: Instant,
    /// Lines dropped because the queue was full.
    busy: std::sync::Arc<AtomicU64>,
    #[cfg(test)]
    sink: std::sync::Arc<Mutex<Option<Sink>>>,
    /// Held by a test to stall the log's thread.
    #[cfg(test)]
    gate: std::sync::Arc<Mutex<()>>,
}

fn open(path: &Path) -> Option<File> {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

impl Sink {
    /// Moves the file to `<name>.old.log` and opens a fresh one. Its size only counts as reset when
    /// both worked: a failed rename leaves the same file, as full as it was.
    fn roll(&self) -> Option<(File, u64)> {
        let old = self.path.with_extension("old.log");
        if let Err(e) = fs::remove_file(&old) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return None;
            }
        }
        fs::rename(&self.path, &old).ok()?;
        let file = open(&self.path)?;
        let size = file.metadata().ok()?.len();
        Some((file, size))
    }
}

impl Log {
    /// A log that writes nowhere yet, with its thread started.
    pub fn new(started: Instant) -> Log {
        Self::with_queue(started, QUEUE)
    }

    fn with_queue(started: Instant, size: usize) -> Log {
        let (queue, rx) = mpsc::sync_channel::<Msg>(size);
        let busy = std::sync::Arc::new(AtomicU64::new(0));
        let sink = std::sync::Arc::new(Mutex::new(None::<Sink>));
        #[cfg(test)]
        let gate = std::sync::Arc::new(Mutex::new(()));
        let s = sink.clone();
        #[cfg(test)]
        let g = gate.clone();
        std::thread::Builder::new()
            .name("log".into())
            .spawn(move || {
                for m in rx {
                    #[cfg(test)]
                    let _held = g.lock();
                    let Ok(mut sink) = s.lock() else { continue };
                    match m {
                        Msg::Attach(new) => *sink = Some(new),
                        Msg::Flushed(done) => {
                            let _ = done.send(());
                        }
                        Msg::Line(text, lost) => {
                            let Some(sink) = sink.as_mut() else { continue };
                            if lost > 0 {
                                let note = format!("{:>8.2} dropped {lost} lines: the log was busy\n", started.elapsed().as_secs_f64());
                                write(sink, &note, started);
                            }
                            write(sink, &text, started);
                        }
                    }
                }
            })
            .expect("the log's thread");
        Log {
            queue,
            started,
            busy,
            #[cfg(test)]
            sink,
            #[cfg(test)]
            gate,
        }
    }

    /// Starts writing to `path`. With a cap, the file rolls over to `<name>.old.log` past it.
    pub fn attach(&self, path: &Path, cap: Option<u64>) {
        let Some(file) = open(path) else { return };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = self.queue.send(Msg::Attach(Sink { file, path: path.to_path_buf(), size, cap, dropped: 0 }));
    }

    /// Queues a line, stamped now. Never waits: a full queue drops it and counts it.
    pub fn line(&self, s: &str) {
        let text = format!("{:>8.2} {s}\n", self.started.elapsed().as_secs_f64());
        let lost = self.busy.swap(0, Ordering::SeqCst);
        if let Err(TrySendError::Full(_)) = self.queue.try_send(Msg::Line(text, lost)) {
            self.busy.fetch_add(lost + 1, Ordering::SeqCst);
        }
    }

    /// Waits until every line queued before this has been written.
    pub fn flush(&self) {
        let (done, wait) = mpsc::channel();
        if self.queue.send(Msg::Flushed(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(5));
        }
    }
}

/// One line to the file, rolling it over at the cap.
fn write(sink: &mut Sink, text: &str, started: Instant) {
    {
        if sink.cap.is_some_and(|cap| sink.size + text.len() as u64 > cap) {
            match sink.roll() {
                Some((file, size)) => {
                    sink.file = file;
                    sink.size = size;
                    if sink.dropped > 0 {
                        let note = format!("{:>8.2} dropped {} lines: the log was full and couldn't roll over\n", started.elapsed().as_secs_f64(), sink.dropped);
                        if sink.file.write_all(note.as_bytes()).is_ok() {
                            sink.size += note.len() as u64;
                        }
                        sink.dropped = 0;
                    }
                }
                // The file stays as big as it is, so nothing past the cap is written.
                None => {
                    sink.dropped += 1;
                    return;
                }
            }
        }
        if sink.file.write_all(text.as_bytes()).is_ok() {
            sink.size += text.len() as u64;
            let _ = sink.file.flush();
        }
    }
}

/// A page's line as the log keeps it: control characters shown as `\u{..}`, so a page can't
/// start a line that looks like the exe's, and cut to `LINE_MAX` bytes on a character boundary.
pub fn page_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len().min(LINE_MAX));
    for c in line.chars() {
        let piece = if c.is_control() { format!("\\u{{{:x}}}", c as u32) } else { c.to_string() };
        if out.len() + piece.len() > LINE_MAX {
            out.push('…');
            break;
        }
        out.push_str(&piece);
    }
    out
}

/// Counts each window's lines in one-second windows. What's over the rate is dropped, and the
/// count of what was dropped is handed back once, when that window's next second starts.
#[derive(Default)]
pub struct Limiter {
    windows: HashMap<String, (Instant, u32, u32)>,
}

pub enum Admit {
    /// Write it. `dropped` lines were lost before it, if any.
    Yes { dropped: u32 },
    No,
}

impl Limiter {
    pub fn admit(&mut self, label: &str, now: Instant) -> Admit {
        let e = self.windows.entry(label.to_string()).or_insert((now, 0, 0));
        let mut dropped = 0;
        if now.saturating_duration_since(e.0) >= Duration::from_secs(1) {
            dropped = e.2;
            *e = (now, 0, 0);
        }
        if e.1 >= RATE {
            e.2 += 1;
            return Admit::No;
        }
        e.1 += 1;
        Admit::Yes { dropped }
    }

    pub fn forget(&mut self, label: &str) {
        self.windows.remove(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shell-core-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_lines_and_makes_its_folder() {
        let d = temp("plain");
        let p = d.join("logs/app.log");
        let l = Log::new(Instant::now());
        l.line("dropped, nothing attached yet");
        l.attach(&p, None);
        l.line("hello");
        l.flush();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.ends_with(" hello\n") && !text.contains("dropped"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rolls_over_at_the_cap_and_keeps_one_old_file() {
        let d = temp("cap");
        let p = d.join("app.log");
        let l = Log::new(Instant::now());
        l.attach(&p, Some(100));
        for i in 0..40 {
            l.line(&format!("line {i}"));
        }
        l.flush();
        assert!(fs::metadata(&p).unwrap().len() <= 100);
        let old = fs::read_to_string(d.join("app.old.log")).unwrap();
        assert!(old.len() <= 100 && old.contains("line"));
        assert_eq!(fs::read_dir(&d).unwrap().count(), 2);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_new_run_counts_what_is_already_there() {
        let d = temp("again");
        let p = d.join("app.log");
        fs::create_dir_all(&d).unwrap();
        fs::write(&p, vec![b'x'; 90]).unwrap();
        let l = Log::new(Instant::now());
        l.attach(&p, Some(100));
        l.line("this one goes over");
        l.flush();
        assert!(d.join("app.old.log").exists());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_rollover_that_fails_keeps_the_cap_and_counts_what_it_dropped() {
        let d = temp("stuck");
        let p = d.join("app.log");
        fs::create_dir_all(d.join("app.old.log")).unwrap(); // a folder where the old file would go
        fs::write(d.join("app.old.log").join("keep"), b"x").unwrap();
        let l = Log::new(Instant::now());
        l.attach(&p, Some(100));
        for i in 0..40 {
            l.line(&format!("line {i}"));
        }
        l.flush();
        assert!(fs::metadata(&p).unwrap().len() <= 100, "the cap held");
        l.flush();
        let dropped = l.sink.lock().unwrap().as_ref().unwrap().dropped;
        assert!(dropped > 30, "dropped {dropped}");
        // Once it can roll over again, it says how many it lost.
        fs::remove_dir_all(d.join("app.old.log")).unwrap();
        l.line("after");
        l.flush();
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.contains(&format!("dropped {dropped} lines")) && text.ends_with(" after\n"), "{text}");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_full_queue_drops_and_counts_and_never_waits() {
        let d = temp("busy");
        let p = d.join("app.log");
        let l = Log::with_queue(Instant::now(), 4);
        l.attach(&p, None);
        l.flush();
        // The log's thread is stalled, as a slow disk would stall it.
        let held = l.gate.lock().unwrap();
        let t = Instant::now();
        for i in 0..200 {
            l.line(&format!("line {i}"));
        }
        assert!(t.elapsed() < Duration::from_millis(200), "line waited: {:?}", t.elapsed());
        drop(held);
        l.flush();
        l.line("after");
        l.flush();
        let text = fs::read_to_string(&p).unwrap();
        // Every line is either written or counted, and each count comes just before the first line
        // kept after the drops, so the order holds.
        let kept: Vec<usize> = text.lines().filter_map(|x| x.trim().split_once("line ").and_then(|(_, n)| n.parse().ok())).collect();
        let lost: u64 = text.lines().filter_map(|x| x.split("dropped ").nth(1).and_then(|r| r.split(' ').next()).and_then(|n| n.parse::<u64>().ok())).sum();
        assert_eq!(kept.len() as u64 + lost, 200, "{text}");
        assert!(lost >= 190, "only {lost} dropped: {text}");
        assert!(kept.windows(2).all(|w| w[0] < w[1]), "{text}");
        assert!(text.ends_with(" after\n"), "{text}");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_page_cannot_start_a_line_of_its_own() {
        assert_eq!(page_line("a\n   1.00 CHECK PASS x"), "a\\u{a}   1.00 CHECK PASS x");
        assert_eq!(page_line("tab\there\r"), "tab\\u{9}here\\u{d}");
        assert_eq!(page_line("plain ü"), "plain ü");
    }

    #[test]
    fn a_page_line_is_cut_on_a_character_boundary() {
        let long = "é".repeat(LINE_MAX);
        let cut = page_line(&long);
        assert!(cut.len() <= LINE_MAX + '…'.len_utf8());
        assert!(cut.ends_with('…'));
        assert_eq!(page_line(&"x".repeat(LINE_MAX)), "x".repeat(LINE_MAX));
    }

    #[test]
    fn each_window_gets_its_own_rate_and_hears_what_it_lost() {
        let t = Instant::now();
        let mut l = Limiter::default();
        for _ in 0..RATE {
            assert!(matches!(l.admit("view-chat", t), Admit::Yes { dropped: 0 }));
        }
        assert!(matches!(l.admit("view-chat", t), Admit::No));
        assert!(matches!(l.admit("view-chat", t + Duration::from_millis(999)), Admit::No));
        assert!(matches!(l.admit("core", t), Admit::Yes { dropped: 0 }), "another window is apart");
        assert!(matches!(l.admit("view-chat", t + Duration::from_secs(1)), Admit::Yes { dropped: 2 }));
        assert!(matches!(l.admit("view-chat", t + Duration::from_secs(1)), Admit::Yes { dropped: 0 }));
        l.forget("view-chat");
        assert!(matches!(l.admit("view-chat", t), Admit::Yes { dropped: 0 }));
    }
}
