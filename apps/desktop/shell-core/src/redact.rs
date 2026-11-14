//! Redaction: every literal copy of a secret a request used, replaced before a page sees it.
//! One matcher serves the fetch's body and fields, server output and WebSocket messages.
//! See "Redaction on every path back" and "The streaming matcher" in docs/shell-design.md, 5a.
//!
//! Every byte that belongs to any occurrence of any secret is covered, so overlapping secrets
//! leave nothing of either. Each run of covered bytes becomes one marker.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use percent_encoding::percent_decode;

/// What a key becomes in what the fetch returns.
pub const KEY_MARK: &str = "[key]";
/// What a secret becomes in a server's output.
pub const HIDDEN_MARK: &str = "[hidden]";

/// An incremental matcher over a fixed set of secrets.
pub struct Redactor {
    ac: Option<AhoCorasick>,
    secrets: Vec<Vec<u8>>,
    mark: Vec<u8>,
    /// Bytes read but not yet released: only a tail that could still start a secret, or a
    /// covered run that reaches into it.
    pending: Vec<u8>,
    /// How many leading bytes of `pending` are already known to be secret bytes.
    covered: usize,
    /// The last released byte was a marker, so covered bytes right after it add no second one.
    in_mark: bool,
}

impl Redactor {
    /// A matcher for `secrets` (empty ones are ignored), replacing each covered run with `mark`.
    pub fn new<S: AsRef<[u8]>>(secrets: &[S], mark: &str) -> Redactor {
        let mut list: Vec<Vec<u8>> = secrets.iter().map(|s| s.as_ref().to_vec()).filter(|s| !s.is_empty()).collect();
        list.sort();
        list.dedup();
        let ac = (!list.is_empty()).then(|| {
            AhoCorasickBuilder::new().match_kind(MatchKind::Standard).build(&list).expect("a handful of short secrets always builds")
        });
        Redactor { ac, secrets: list, mark: mark.as_bytes().to_vec(), pending: Vec::new(), covered: 0, in_mark: false }
    }

    /// Takes the next chunk, and returns everything that can be released now: all of it, except
    /// the longest tail that could still be the start of a secret.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        let Some(ac) = &self.ac else {
            return std::mem::take(&mut self.pending);
        };
        let regions = covered_regions(ac, &self.pending, self.covered);
        let cut = self.open_tail_start();
        // A covered run that reaches past the cut is released up to it. The rest of its bytes
        // stay held, counted as already covered, since the scan next time can't see where the
        // occurrence began.
        let carry = regions.iter().find(|&&(s, e)| s <= cut && e > cut).map_or(0, |&(_, e)| e - cut);
        let out = self.release(&regions, cut);
        self.pending.drain(..cut);
        self.covered = carry;
        out
    }

    /// The real end: releases the held tail, which can't be a whole secret any more.
    pub fn finish(&mut self) -> Vec<u8> {
        let Some(ac) = &self.ac else {
            return std::mem::take(&mut self.pending);
        };
        let regions = covered_regions(ac, &self.pending, self.covered);
        let len = self.pending.len();
        let out = self.release(&regions, len);
        self.pending.clear();
        self.covered = 0;
        self.in_mark = false;
        out
    }

    /// Bytes held back right now.
    pub fn held(&self) -> usize {
        self.pending.len()
    }

    /// Where the longest suffix of `pending` that is a proper prefix of some secret starts.
    fn open_tail_start(&self) -> usize {
        let len = self.pending.len();
        let longest = self.secrets.iter().map(|s| s.len()).max().unwrap_or(0);
        let from = len.saturating_sub(longest.saturating_sub(1));
        (from..len)
            .find(|&p| {
                let tail = &self.pending[p..];
                self.secrets.iter().any(|s| s.len() > tail.len() && s.starts_with(tail))
            })
            .unwrap_or(len)
    }

    /// `pending[..end]` with each covered run replaced by one marker.
    fn release(&mut self, regions: &[(usize, usize)], end: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(end);
        let mut at = 0;
        for &(s, e) in regions {
            if s >= end {
                break;
            }
            if s > at {
                out.extend_from_slice(&self.pending[at..s]);
                self.in_mark = false;
            }
            if !(s == 0 && self.in_mark) {
                out.extend_from_slice(&self.mark);
            }
            self.in_mark = true;
            at = e.min(end);
        }
        if end > at {
            out.extend_from_slice(&self.pending[at..end]);
            self.in_mark = false;
        }
        out
    }
}

/// Every run of bytes covered by an occurrence of a secret, merged when they overlap or touch.
/// The first `known` bytes count as covered.
fn covered_regions(ac: &AhoCorasick, hay: &[u8], known: usize) -> Vec<(usize, usize)> {
    let mut found: Vec<(usize, usize)> = ac.find_overlapping_iter(hay).map(|m| (m.start(), m.end())).collect();
    if known > 0 {
        found.push((0, known.min(hay.len())));
    }
    merge(found)
}

fn merge(mut v: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    v.sort();
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(v.len());
    for (s, e) in v {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

/// A whole value at once, with `mark` for each covered run.
pub fn redact_bytes<S: AsRef<[u8]>>(value: &[u8], secrets: &[S], mark: &str) -> Vec<u8> {
    let mut r = Redactor::new(secrets, mark);
    let mut out = r.feed(value);
    out.extend(r.finish());
    out
}

pub fn redact_str<S: AsRef<[u8]>>(value: &str, secrets: &[S], mark: &str) -> String {
    // Secrets are valid UTF-8, so a covered run starts and ends on character boundaries.
    String::from_utf8_lossy(&redact_bytes(value.as_bytes(), secrets, mark)).into_owned()
}

/// Whether a value holds a secret, raw or percent-decoded once.
pub fn holds_secret<S: AsRef<[u8]>>(value: &str, secrets: &[S]) -> bool {
    let decoded: Vec<u8> = percent_decode(value.as_bytes()).collect();
    secrets.iter().map(|s| s.as_ref()).filter(|s| !s.is_empty()).any(|s| contains(value.as_bytes(), s) || contains(&decoded, s))
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    needle.len() <= hay.len() && hay.windows(needle.len()).any(|w| w == needle)
}

/// A URL, or any text that may carry a secret percent-encoded: each raw occurrence, and each
/// span whose percent-decoding holds one, becomes `[key]`.
pub fn redact_url<S: AsRef<[u8]>>(value: &str, secrets: &[S]) -> String {
    let list: Vec<&[u8]> = secrets.iter().map(|s| s.as_ref()).filter(|s| !s.is_empty()).collect();
    if list.is_empty() {
        return value.to_string();
    }
    let ac = AhoCorasick::new(&list).expect("secrets build");
    let raw = value.as_bytes();
    let mut regions: Vec<(usize, usize)> = ac.find_overlapping_iter(raw).map(|m| (m.start(), m.end())).collect();
    // Decode once, remembering where each decoded byte came from in the raw text.
    let (decoded, from) = decode_mapped(raw);
    for m in ac.find_overlapping_iter(&decoded) {
        regions.push((from[m.start()], from[m.end()]));
    }
    let regions = merge(regions);
    let mut out = Vec::with_capacity(raw.len());
    let mut at = 0;
    for (s, e) in regions {
        out.extend_from_slice(&raw[at..s]);
        out.extend_from_slice(KEY_MARK.as_bytes());
        at = e;
    }
    out.extend_from_slice(&raw[at..]);
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-decodes once. `from[i]` is where decoded byte `i` starts in the raw text, and
/// `from[len]` is the raw length.
fn decode_mapped(raw: &[u8]) -> (Vec<u8>, Vec<usize>) {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let (mut out, mut from) = (Vec::with_capacity(raw.len()), Vec::with_capacity(raw.len() + 1));
    let mut i = 0;
    while i < raw.len() {
        from.push(i);
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let (Some(h), Some(l)) = (hex(raw[i + 1]), hex(raw[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    from.push(raw.len());
    (out, from)
}

/// The head of a response as a page may see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Head {
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub url: String,
}

/// Redacts every field of a response head: the final URL raw and percent-decoded, the status
/// text, and each header value. A header whose name holds a secret, in any case, is dropped.
pub fn redact_head<S: AsRef<[u8]>>(head: Head, secrets: &[S]) -> Head {
    let lower: Vec<String> =
        secrets.iter().map(|s| String::from_utf8_lossy(s.as_ref()).to_lowercase()).filter(|s| !s.is_empty()).collect();
    let headers = head
        .headers
        .into_iter()
        // Header names reach the page lower-cased, so a secret is looked for in any case there.
        .filter(|(name, _)| !holds_secret(&name.to_lowercase(), &lower))
        .map(|(name, value)| (name, redact_url(&value, secrets)))
        .collect();
    Head { status_text: redact_url(&head.status_text, secrets), headers, url: redact_url(&head.url, secrets) }
}

/// One line of a server's output, with every secret of its setup blanked.
pub fn blank_line<S: AsRef<[u8]>>(line: &[u8], secrets: &[S]) -> Vec<u8> {
    redact_bytes(line, secrets, HIDDEN_MARK)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test secrets are made from parts, never written out whole.
    fn fake(tag: &str, n: usize) -> String {
        let mut s = format!("fk{tag}");
        let mut x: u32 = 0x9e37_79b9 ^ tag.bytes().map(u32::from).sum::<u32>();
        while s.len() < n {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            s.push(char::from(b"abcdefghijkmnopqrstuvwxyz23456789"[(x % 33) as usize]));
        }
        s
    }

    fn whole(input: &str, secrets: &[String]) -> String {
        redact_str(input, secrets, KEY_MARK)
    }

    fn streamed(chunks: &[&[u8]], secrets: &[String]) -> String {
        let mut r = Redactor::new(secrets, KEY_MARK);
        let mut out = Vec::new();
        for c in chunks {
            out.extend(r.feed(c));
        }
        out.extend(r.finish());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn whole_values() {
        let k = fake("a", 24);
        assert_eq!(whole(&format!("x{k}y"), std::slice::from_ref(&k)), "x[key]y");
        assert_eq!(whole(&format!("{k}{k}"), std::slice::from_ref(&k)), "[key]", "touching copies are one run");
        assert_eq!(whole(&format!("{k} {k}"), std::slice::from_ref(&k)), "[key] [key]");
        assert_eq!(whole("nothing here", std::slice::from_ref(&k)), "nothing here");
        assert_eq!(whole(&k[..k.len() - 1], std::slice::from_ref(&k)), &k[..k.len() - 1], "a near miss stays");
        assert_eq!(whole("anything", &Vec::<String>::new()), "anything");
    }

    #[test]
    fn every_split_across_two_chunks() {
        let a = fake("two", 20);
        let b = fake("other", 33);
        let secrets = vec![a.clone(), b.clone()];
        for s in &secrets {
            let text = format!("before {s} after");
            let want = whole(&text, &secrets);
            assert_eq!(want, "before [key] after");
            for i in 0..=text.len() {
                let (x, y) = text.as_bytes().split_at(i);
                assert_eq!(streamed(&[x, y], &secrets), want, "split at {i}");
            }
        }
    }

    #[test]
    fn every_split_across_three_chunks() {
        let a = fake("three", 16);
        let b = fake("more", 9);
        let secrets = vec![a.clone(), b.clone()];
        for s in &secrets {
            let text = format!("<{s}>{s}.");
            let want = whole(&text, &secrets);
            assert_eq!(want, "<[key]>[key].");
            let bytes = text.as_bytes();
            for i in 0..=bytes.len() {
                for j in i..=bytes.len() {
                    assert_eq!(streamed(&[&bytes[..i], &bytes[i..j], &bytes[j..]], &secrets), want, "splits at {i}, {j}");
                }
            }
        }
    }

    #[test]
    fn overlapping_secrets_leave_nothing_of_either() {
        // b starts inside a, and c is a prefix of a longer d.
        let a = fake("ov", 16);
        let b = format!("{}{}", &a[8..], fake("tail", 12));
        let c = fake("pre", 10);
        let d = format!("{c}{}", fake("long", 10));
        let secrets = vec![a.clone(), b.clone(), c.clone(), d.clone()];
        let joined = format!("{}{}", &a[..8], b); // a and b overlapping by 8 bytes
        assert!(joined.contains(&a) && joined.contains(&b));
        for text in [format!("x{joined}y"), format!("x{d}y"), format!("x{c}y"), format!("{d}{a}")] {
            let want = whole(&text, &secrets);
            for s in &secrets {
                assert!(!want.contains(s.as_str()), "{want}");
            }
            for i in 0..=text.len() {
                for j in i..=text.len() {
                    let t = text.as_bytes();
                    let got = streamed(&[&t[..i], &t[i..j], &t[j..]], &secrets);
                    assert_eq!(got, want, "{text} at {i}, {j}");
                }
            }
        }
        assert_eq!(whole(&format!("x{joined}y"), &secrets), "x[key]y");
        assert_eq!(whole(&format!("x{d}y"), &secrets), "x[key]y", "the longer secret is covered whole");
    }

    #[test]
    fn a_self_overlapping_secret_in_a_long_run() {
        let s = "a".repeat(8);
        let run = "a".repeat(100);
        assert_eq!(whole(&format!("b{run}b"), std::slice::from_ref(&s)), "b[key]b");
        // Streamed one byte at a time, nothing of the run gets out.
        let text = format!("b{run}b");
        let chunks: Vec<&[u8]> = text.as_bytes().chunks(1).collect();
        assert_eq!(streamed(&chunks, std::slice::from_ref(&s)), "b[key]b");
        let chunks: Vec<&[u8]> = text.as_bytes().chunks(7).collect();
        assert_eq!(streamed(&chunks, &[s]), "b[key]b");
    }

    #[test]
    fn a_long_near_miss_stream() {
        let k = fake("near", 32);
        let miss = &k[..k.len() - 1];
        // The almost-key again and again, then the real one at the end, fed in 5-byte reads.
        let mut text = String::new();
        for _ in 0..200 {
            text.push_str(miss);
            text.push('!');
        }
        text.push_str(&k);
        let want = format!("{}[key]", &text[..text.len() - k.len()]);
        let mut r = Redactor::new(std::slice::from_ref(&k), KEY_MARK);
        let mut out = Vec::new();
        for c in text.as_bytes().chunks(5) {
            out.extend(r.feed(c));
            assert!(r.held() < k.len(), "holds at most a secret's length less one, held {}", r.held());
        }
        out.extend(r.finish());
        assert_eq!(String::from_utf8(out).unwrap(), want);
    }

    #[test]
    fn output_with_no_secret_prefix_at_its_end_is_released_at_once() {
        let k = fake("sse", 40);
        let mut r = Redactor::new(std::slice::from_ref(&k), KEY_MARK);
        let event = b"event: message\ndata: {\"ok\":true}\n\n";
        assert_eq!(r.feed(event), event.to_vec(), "a whole SSE event goes straight through");
        assert_eq!(r.held(), 0);
        // A tail that could start the key waits, and only that tail.
        let start = &k.as_bytes()[..5];
        let mut chunk = b"data: x".to_vec();
        chunk.extend_from_slice(start);
        assert_eq!(r.feed(&chunk), b"data: x".to_vec());
        assert_eq!(r.held(), 5);
        // It wasn't the key after all: released with the next read.
        assert_eq!(r.feed(b"#\n"), [start, b"#\n"].concat());
        assert_eq!(r.held(), 0);
        // At the real end, a held tail is released as it is.
        assert_eq!(r.feed(start), Vec::<u8>::new());
        assert_eq!(r.finish(), start.to_vec());
    }

    #[test]
    fn a_chunk_with_no_output_holds_only_a_prefix() {
        let k = fake("hold", 20);
        let mut r = Redactor::new(std::slice::from_ref(&k), KEY_MARK);
        assert_eq!(r.feed(&k.as_bytes()[..10]), Vec::<u8>::new());
        assert_eq!(r.feed(&k.as_bytes()[10..]), b"[key]".to_vec());
        assert_eq!(r.finish(), Vec::<u8>::new());
    }

    #[test]
    fn urls_raw_and_percent_decoded() {
        let k = fake("url", 20);
        let enc: String = k.bytes().map(|b| format!("%{b:02X}")).collect();
        let half = format!("{}{}", &k[..10], k[10..].bytes().map(|b| format!("%{b:02x}")).collect::<String>());
        assert_eq!(redact_url(&format!("https://h/v1/{k}?a=1"), std::slice::from_ref(&k)), "https://h/v1/[key]?a=1");
        assert_eq!(redact_url(&format!("https://h/v1/{enc}/x"), std::slice::from_ref(&k)), "https://h/v1/[key]/x");
        assert_eq!(redact_url(&format!("https://h/{half}"), std::slice::from_ref(&k)), "https://h/[key]");
        assert_eq!(redact_url("https://h/%zz%4", std::slice::from_ref(&k)), "https://h/%zz%4");
        assert!(holds_secret(&format!("/x/{enc}"), std::slice::from_ref(&k)));
        assert!(holds_secret(&format!("/x/{k}"), std::slice::from_ref(&k)));
        assert!(!holds_secret("/x/y", std::slice::from_ref(&k)));
    }

    #[test]
    fn every_field_of_a_head() {
        let k = fake("head", 24);
        let upper = k.to_uppercase();
        let head = Head {
            status_text: format!("Bad key {k}"),
            headers: vec![
                ("x-echo".into(), format!("Bearer {k}")),
                (format!("x-{}", k.to_lowercase()), "1".into()),
                ("content-type".into(), "text/plain".into()),
                ("location".into(), format!("/v1/{}", k.bytes().map(|b| format!("%{b:02X}")).collect::<String>())),
            ],
            url: format!("https://h/v1/{k}"),
        };
        let got = redact_head(head, &[k.clone(), upper]);
        assert_eq!(got.status_text, "Bad key [key]");
        assert_eq!(got.url, "https://h/v1/[key]");
        assert_eq!(
            got.headers,
            vec![
                ("x-echo".to_string(), "Bearer [key]".to_string()),
                ("content-type".to_string(), "text/plain".to_string()),
                ("location".to_string(), "/v1/[key]".to_string()),
            ]
        );
    }

    #[test]
    fn server_lines_are_blanked() {
        let a = fake("srv", 12);
        let b = fake("srv2", 30);
        assert_eq!(blank_line(format!("the secret is {a}, and {b}").as_bytes(), &[a.clone(), b.clone()]), b"the secret is [hidden], and [hidden]".to_vec());
        assert_eq!(blank_line(b"plain", &[a]), b"plain".to_vec());
    }

    /// The plain way: mark every byte of every occurrence, then one marker per covered run.
    fn reference(text: &[u8], secrets: &[Vec<u8>]) -> Vec<u8> {
        let mut covered = vec![false; text.len()];
        for s in secrets.iter().filter(|s| !s.is_empty()) {
            for i in 0..text.len().saturating_sub(s.len() - 1) {
                if &text[i..i + s.len()] == s.as_slice() {
                    covered[i..i + s.len()].iter_mut().for_each(|c| *c = true);
                }
            }
        }
        let mut out = Vec::new();
        for (i, b) in text.iter().enumerate() {
            if !covered[i] {
                out.push(*b);
            } else if i == 0 || !covered[i - 1] {
                out.extend_from_slice(KEY_MARK.as_bytes());
            }
        }
        out
    }

    #[test]
    fn random_texts_secrets_and_splits_match_the_plain_way() {
        // A two-letter alphabet, so secrets overlap, nest and repeat all the time.
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move |n: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % n
        };
        for _ in 0..3000 {
            let secrets: Vec<Vec<u8>> =
                (0..1 + next(3)).map(|_| (0..2 + next(7)).map(|_| b"ab"[next(2) as usize]).collect()).collect();
            let text: Vec<u8> = (0..next(40)).map(|_| b"abc"[next(3) as usize]).collect();
            let want = reference(&text, &secrets);
            assert_eq!(redact_bytes(&text, &secrets, KEY_MARK), want);
            let mut r = Redactor::new(&secrets, KEY_MARK);
            let mut got = Vec::new();
            let mut at = 0;
            while at < text.len() {
                let n = (1 + next(6) as usize).min(text.len() - at);
                got.extend(r.feed(&text[at..at + n]));
                at += n;
            }
            got.extend(r.finish());
            assert_eq!(got, want, "text {:?} secrets {:?}", String::from_utf8_lossy(&text), secrets);
        }
    }
}
