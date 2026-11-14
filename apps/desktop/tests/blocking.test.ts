/* A lint, not a proof: it reads the source for the shapes that block an async worker. A sync
   function marked `#[tauri::command(async)]` runs on one, so none is left in these files: every
   such command is an `async fn`, and anything that waits (a dialog, a lookup, a file or credential
   call, a channel, a join, a lock wait, a sleep) runs inside a `blocking(...)` /
   `spawn_blocking(...)` call. It can't see a wait hidden in a helper. The proof is the runner's
   security.exec.responsive, which times the exe's main thread while each kind of flood is held;
   logging never waits at all (shell-core's log queue). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src-tauri', 'src');
const FILES = ['net.rs', 'addresses.rs', 'secrets.rs', 'confirm.rs', 'commands.rs'];

/* What blocks a thread. Inside a command body, outside a blocking(...) call, none may appear. */
const BLOCKING = [
  /\.recv\(\)/, /\.join\(\)/, /\.wait\(/, /\bCondvar\b/, /\bBarrier\b/, /thread::sleep/, /blocking_recv|blocking_lock|block_on/,
  /\.ask\(/, /confirm::(reserve|ask|modal)\(/, /to_socket_addrs/, /\blook_up\(/, /write_atomic|add_durably|remove_durably/,
  /set_secret|get_secret|delete_credential|secrets::delete\(|\bdelete\(&|address_key\(/, /\bproxy_kind\(\)/,
  /window_op\(|pages::open\(|tray::set\(/
];

/* The text from `open` to its matching close, from index `at` (which points at `open`). */
function span(text: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return text.length;
}

/* Every command in a file: its name, whether it's async, and its body with blocking(...), spawn_blocking(...) and blocking_write(...) calls cut out. */
export function commands(text: string): { name: string; attr: string; async: boolean; body: string }[] {
  const out = [];
  for (const m of text.matchAll(/#\[tauri::command(\([^)]*\))?\]\s*(pub\s+)?(async\s+)?fn\s+(\w+)/g)) {
    const start = text.indexOf('{', m.index! + m[0].length);
    let body = text.slice(start, span(text, start, '{', '}'));
    for (;;) {
      const b = /\b(spawn_blocking|blocking|blocking_write)\(/.exec(body);
      if (!b) break;
      const open = b.index + b[0].length - 1;
      body = body.slice(0, b.index) + body.slice(span(body, open, '(', ')'));
    }
    out.push({ name: m[4], attr: m[1] ?? '', async: !!m[3], body });
  }
  return out;
}

describe('lint: no command of the network side blocks an async worker', () => {
  for (const f of FILES) {
    it(f, () => {
      const text = readFileSync(join(SRC, f), 'utf8');
      for (const c of commands(text)) {
        expect(c.attr, `${f} ${c.name}: a sync command on an async worker`).not.toBe('(async)');
        if (!c.async) continue;
        for (const p of BLOCKING) expect(c.body, `${f} ${c.name} waits: ${p}`).not.toMatch(p);
      }
    });
  }

  it('catches a sync command marked async, and a wait outside blocking(...)', () => {
    const bad = commands('#[tauri::command(async)]\npub fn a(x: u8) -> u8 { rx.recv().unwrap() }\n#[tauri::command]\nasync fn b() { blocking(move || t.join()).await; h.join(); }');
    expect(bad.map(c => [c.name, c.attr, c.async])).toEqual([['a', '(async)', false], ['b', '', true]]);
    expect(bad[1].body).not.toContain('t.join');
    expect(bad[1].body).toMatch(/\.join\(\)/);
  });
});
