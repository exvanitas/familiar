/* Lints: what the runner can't show of the process side, pinned in the source. A lint reads the
   text, so it isn't proof of behaviour; each says where the proof is. The runner can't sleep, so
   the resume registration is checked here; the dialogs' test file and the save's backup name are
   checked here as well as watched on the runner. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const system = read('src-tauri/src/system.rs');
const files = read('src-tauri/src/files.rs');
const servers = read('src-tauri/src/servers.rs');
const notify = read('src-tauri/src/notify.rs');

/* Each command of a file: its whole text from the attribute to the end of its body. */
function commands(src: string): { name: string; attr: string; text: string }[] {
  const out: { name: string; attr: string; text: string }[] = [];
  const re = /#\[tauri::command(\([^)]*\))?\]\s*pub (async )?fn (\w+)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.indexOf('{', m.index + m[0].length);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push({ name: m[3], attr: m[0], text: src.slice(m.index, i + 1) });
  }
  return out;
}

describe('resume after sleep', () => {
  it('registers for power notifications directly, and checks and logs the result', () => {
    // A message-only window gets no power broadcasts.
    expect(system).not.toContain('HWND_MESSAGE');
    expect(system).not.toContain('WM_POWERBROADCAST');
    const call = system.indexOf('PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK,');
    expect(call).toBeGreaterThan(0);
    const after = system.slice(call, call + 600);
    expect(after).toMatch(/if r == ERROR_SUCCESS && !handle\.is_null\(\) \{/);
    expect(after).toMatch(/log\.line\(&format!\("error resume: PowerRegisterSuspendResumeNotification failed/);
    // The callback hears both resume kinds.
    expect(system).toMatch(/kind == PBT_APMRESUMEAUTOMATIC \|\| kind == PBT_APMRESUMESUSPEND/);
    // And it's started with the log, at every start.
    expect(system).toMatch(/os::on_resume\(log, move \|\| \{/);
  });
});

describe('the file dialogs and the save', () => {
  it('neither dialog makes a test file, and the replace names no backup', () => {
    const save = files.slice(files.indexOf('pub fn save(name'), files.indexOf('pub fn pick('));
    const pick = files.slice(files.indexOf('pub fn pick('), files.indexOf('pub struct OsSwap'));
    expect(save).toContain('FOS_NOTESTFILECREATE');
    expect(pick).toContain('FOS_NOTESTFILECREATE');
    // One rename, replacing and written through, for new and existing targets alike.
    expect(files).not.toContain('ReplaceFileW');
    expect(files).toMatch(/MoveFileExW\(&HSTRING::from\(temp\), &HSTRING::from\(target\), MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH\)/);
  });

  it('both dialogs run inside confirm::modal, and nothing checks busy and then opens outside the gate', () => {
    expect(files).toMatch(/confirm::modal\(&app, None, \|_\| dialogs::save\(/);
    expect(files).toMatch(/confirm::modal\(&app, None, \|_\| dialogs::pick\(/);
    expect(files).not.toContain('confirm::busy(');
    expect(files.match(/dialogs::(save|pick)\(/g)?.length).toBe(2);
  });

  it('a save refuses anywhere remote, and refuses all when a protected folder is unknown', () => {
    const refused = files.slice(files.indexOf('fn refused('), files.indexOf('fn local_drive('));
    expect(refused).toMatch(/files::remote\(&target\.display\(\)\.to_string\(\)\) \|\| !local_drive\(dir\)/);
    expect(refused).toMatch(/let Some\(forbidden\) = forbidden\(shell\) else \{ return Ok\(true\) \};/);
  });
});

describe('server starts: one actor per setup', () => {
  it('the commands only send a message and await the reply', () => {
    for (const c of commands(servers)) {
      expect(c.attr, c.name).toMatch(/pub async fn/);
      expect(c.text, c.name).toMatch(/answer\.await/);
      expect(c.text, c.name).toMatch(/\.send\(&app, &/);
    }
    expect(commands(servers).map(c => c.name).sort()).toEqual(['server_forget', 'server_start', 'server_stop', 'server_write']);
  });

  it('each actor follows the shell-core state machine, with a bounded queue and bounded writes', () => {
    // A lint. The proof of the machine is shell-core's property test, over 5,000 seeded runs.
    expect(servers).toMatch(/use shell_core::\{\s*actor::\{Effect, Gen, Machine, Msg, State, Token\}/);
    expect(servers).toMatch(/mpsc::sync_channel::<Cmd>\(QUEUE\)/);
    expect(servers).toMatch(/const QUEUE: usize = 32;/);
    expect(servers).toMatch(/const MAX_WRITES: usize = 8;/);
    expect(servers).toMatch(/const MAX_WRITE_BYTES: usize = 16 \* 1024 \* 1024;/);
    expect(servers).toMatch(/TrySendError::Full\(_\) => fail\("busy"/);
    // servers.json has one writer.
    expect(servers.match(/temp::write_atomic\(&path, &store\.to_bytes\(\)\)/g)?.length).toBe(1);
    expect(servers).toMatch(/fn spawn_store\(/);
    // A failed record aborts the start; the sweep is shell-core's rule (its test is the proof),
    // and servers.rs deletes nothing itself.
    expect(servers).toMatch(/fn write\(&self, pid: u32\) -> std::io::Result<\(\)>/);
    const sweep = servers.slice(servers.indexOf('pub fn sweep('), servers.indexOf('/* ---------- the OS side'));
    expect(sweep).toMatch(/records::sweep\(&dir, os::sweep_one\)/);
    expect(sweep).not.toMatch(/remove_file\(|fs::rename\(/);
    expect(read('src-tauri/src/main.rs')).toContain('servers::sweep(&app.state::<Shell>());');
  });

  it('a spawn launches the held approved form and nothing else', () => {
    // A lint. The proofs are shell-core's plan test and the runner's security.server.retarget.
    const spawn = servers.slice(servers.indexOf('fn spawn(app: &AppHandle'), servers.indexOf('fn run_id()'));
    expect(spawn).toMatch(/^fn spawn\(app: &AppHandle, setup_id: &str, form: &Canonical, channel: Channel<Value>, /);
    expect(spawn).not.toMatch(/Setup|walk\(|setup\./);
    expect(spawn).toMatch(/let approved = form\.launch\(\);\n\s*server_path::recheck\(&fs\(\), &approved\)/);
    expect(spawn).toMatch(/let plan = Plan::of\(form\);/);
    expect(spawn).toMatch(/Command::new\(&plan\.program\);\n\s*cmd\.args\(&plan\.args\)\.current_dir\(&plan\.cwd\)\.env_clear\(\)\.envs\(env\)/);
    expect(spawn).toMatch(/let env = plan\.environment\(/);
    // The walk once more before resume, against the same held value.
    expect(spawn.match(/server_path::recheck\(&fs\(\), &approved\)/g)?.length).toBe(2);
    expect(servers.match(/Command::new\(/g)?.length).toBe(1);
    // The form is held from the ask on both paths, and the spawn takes it from there.
    expect(servers).toMatch(/return Ok\(\(form, false\)\);/);
    expect(servers).toMatch(/Ok\(\(form, true\)\)\n\}/);
    expect(servers).toMatch(/a\.form = Some\(form\);/);
    expect(servers).toMatch(/spawn\(&app, &id, &form, channel, report\.clone\(\)\)/);
  });

  it('run ids name a generation, and stops and writes carry it', () => {
    // A lint. The proof that nothing for one generation reaches another is the property test.
    expect(servers).toMatch(/runs: Mutex<HashMap<String, \(String, Gen\)>>/);
    expect(servers).toMatch(/Cmd::Stop \{ gen, reply \}/);
    expect(servers).toMatch(/Cmd::Write \{ gen, bytes: bytes\.clone\(\), reply \}/);
    expect(servers).toMatch(/Report\(Gen, Report\)/);
  });
});

/* A lint, not proof: it reads each command's own text, so a blocking call one function down is
   out of its sight. The proof is the runner's server.write-flood, which passes only if shell_info
   answers in under 100 ms while 60 writes are held against a server that never reads. */
describe('no command blocks an async worker (a lint)', () => {
  const mine = { 'servers.rs': servers, 'files.rs': files, 'system.rs': system, 'notify.rs': notify };
  // What waits: channel receives, joins, condition waits, sleeps, and the blocking helpers.
  const waits = [/\.recv\(/, /recv_timeout\(/, /blocking_recv\(/, /\.join\(\)/, /\.wait\(/, /wait_timeout\(/, /thread::sleep\(/];
  const blocking = [/dialogs::/, /confirm::reserve\(/, /confirm::modal\(/, /ticket\.ask\(/, /temp::save\(/, /std::fs::/, /reg::/, /set_autostart\(/];
  it('autostart hands its registry calls to a blocking thread', () => {
    const c = commands(notify).find(c => c.name === 'autostart');
    expect(c?.text).toMatch(/tauri::async_runtime::spawn_blocking\(move \|\| set_autostart\(&app, on\)\)/);
  });
  for (const [file, src] of Object.entries(mine)) {
    it(`${file}: every command is a plain async fn that waits on nothing but its awaits (a lint)`, () => {
      expect(src, file).not.toMatch(/#\[tauri::command\(async\)\]/);
      for (const c of commands(src)) {
        expect(c.attr, `${file} ${c.name}`).toMatch(/pub async fn/);
        for (const w of waits) expect(c.text, `${file} ${c.name}: ${w}`).not.toMatch(w);
        // Blocking work only inside the closure handed to on_thread or spawn_blocking.
        const handed = Math.max(c.text.indexOf('on_thread('), c.text.indexOf('spawn_blocking('));
        for (const b of blocking) {
          const at = c.text.search(b);
          if (at >= 0) expect(handed >= 0 && handed < at, `${file} ${c.name}: ${b} outside on_thread`).toBe(true);
        }
      }
    });
  }
});
