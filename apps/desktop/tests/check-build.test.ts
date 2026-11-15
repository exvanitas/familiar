/* The `check-blocking` feature exists only for one check build, the control that shows
   security.exec.responsive's probe catches blocked async workers. The exe that's uploaded or
   shipped never has it, the feature does nothing but its one sleep, and the control exe is never
   uploaded. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const SRC = join(__dirname, '..', 'src-tauri', 'src');
/* A file's text with Windows line ends made plain, as a checkout on the runner has them. */
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/* A workflow's steps, as their text: each starts at a `- ` item under `steps:`. */
function steps(yml: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of yml.split('\n')) {
    if (/^\s{4,8}- /.test(line) && /^\s*- (name|uses|run|if|working-directory|with|env|id):?/.test(line)) {
      if (cur) out.push(cur.join('\n'));
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}

/* What's wrong with a workflow, as far as the control build goes. */
export function workflowProblems(name: string, yml: string): string[] {
  const problems: string[] = [];
  const all = steps(yml);
  const shippedAt = all.findIndex(s => /Copy-Item\s+\S*target\/release\/familiar\.exe\s+exe\/?\s*$/m.test(s) || /target\/release\/familiar\.exe\s+exe\//.test(s));
  all.forEach((s, i) => {
    if (s.includes('check-blocking')) {
      if (!s.includes('familiar-blocking.exe')) problems.push(`${name}: a step builds with check-blocking and doesn't keep it apart as familiar-blocking.exe`);
      if (shippedAt < 0 || i < shippedAt) problems.push(`${name}: check-blocking is built before the shipped exe was copied out`);
      if (/upload-artifact|release|publish/i.test(s.split('\n')[0])) problems.push(`${name}: check-blocking in a step that uploads or releases`);
    }
    if (/upload-artifact/.test(s)) {
      const path = s.match(/^\s*path:\s*(.*(?:\n\s{12,}.*)*)/m)?.[1] ?? '';
      if (/blocking/.test(path)) problems.push(`${name}: the control exe is uploaded`);
      if (/(^|\s|\/)exe\/?(\*|\s|$)/.test(path) || /\*\.exe/.test(path)) problems.push(`${name}: an upload takes the whole exe folder, control included: ${path.trim()}`);
    }
    if (/cargo (build|tauri build)/.test(s) && /--all-features/.test(s)) problems.push(`${name}: a build enables every feature`);
  });
  return problems;
}

/* What's wrong with the feature itself: it may only add the one sleep before a helper's work. */
export function featureProblems(sources: Record<string, string>, cargo: string): string[] {
  const problems: string[] = [];
  if (!/^check-blocking = \[\]$/m.test(cargo)) problems.push('the feature turns on something else');
  let uses = 0;
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/#\[cfg\(feature = "check-blocking"\)\]\s*\{([^{}]*)\}/g)) {
      uses++;
      const body = m[1].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).join(' ');
      if (body !== 'std::thread::sleep(Duration::from_secs(3)); let _running = h.start().ok_or(FetchError::Cancelled)?; Ok(f())') problems.push(`${file}: the feature does more than its one sleep: ${body}`);
    }
    const all = [...text.matchAll(/feature = "check-blocking"/g)].length;
    const not = [...text.matchAll(/not\(feature = "check-blocking"\)/g)].length;
    if (all - not > 0 && all - not !== [...text.matchAll(/#\[cfg\(feature = "check-blocking"\)\]\s*\{/g)].length) problems.push(`${file}: the feature is used somewhere other than its one block`);
  }
  if (uses !== 1) problems.push(`the feature has ${uses} blocks, not 1`);
  return problems;
}

describe('the check-blocking control build', () => {
  it('no workflow ships, uploads or releases it', () => {
    for (const f of readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f))) {
      expect(workflowProblems(f, read(join(WORKFLOWS, f)))).toEqual([]);
    }
  });

  it('the feature does nothing but its one sleep', () => {
    const sources = Object.fromEntries(readdirSync(SRC).filter(f => f.endsWith('.rs')).map(f => [f, read(join(SRC, f))]));
    expect(featureProblems(sources, read(join(__dirname, '..', 'src-tauri', 'Cargo.toml')))).toEqual([]);
  });

  it('catches each way it could ship', () => {
    const base = read(join(WORKFLOWS, 'shell.yml'));
    const shipped = base.replace('run: cargo build --release --locked\n', 'run: cargo build --release --locked --features check-blocking\n');
    expect(shipped).not.toBe(base);
    expect(workflowProblems('x', shipped).join(' ')).toMatch(/doesn't keep it apart|before the shipped exe/);
    const uploaded = base.replace('path: exe/familiar.exe', 'path: exe/familiar-blocking.exe');
    expect(workflowProblems('x', uploaded).join(' ')).toMatch(/the control exe is uploaded/);
    const folder = base.replace('path: exe/familiar.exe', 'path: exe/');
    expect(workflowProblems('x', folder).join(' ')).toMatch(/whole exe folder/);
    const net = read(join(SRC, 'net.rs'));
    const more = net.replace('Ok(f())\n    }', 'std::fs::write("x", "y").ok();\n        Ok(f())\n    }');
    expect(more).not.toBe(net);
    expect(featureProblems({ 'net.rs': more }, 'check-blocking = []').join(' ')).toMatch(/more than its one sleep/);
    expect(featureProblems({ 'net.rs': net }, 'check-blocking = ["tauri/devtools"]').join(' ')).toMatch(/turns on something else/);
  });
});
