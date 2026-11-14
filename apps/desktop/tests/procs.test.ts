/* What the runner can't show of the process side, pinned in the source. The runner can't sleep,
   so the resume registration is checked here; the dialogs' test file and the save's backup name
   are checked here as well as watched on the runner. */
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
    expect(servers).toMatch(/use shell_core::\{\s*actor::\{Effect, Machine, Msg, State\}/);
    expect(servers).toMatch(/mpsc::sync_channel::<Cmd>\(QUEUE\)/);
    expect(servers).toMatch(/const QUEUE: usize = 32;/);
    expect(servers).toMatch(/const MAX_WRITES: usize = 8;/);
    expect(servers).toMatch(/const MAX_WRITE_BYTES: usize = 16 \* 1024 \* 1024;/);
    expect(servers).toMatch(/TrySendError::Full\(_\) => fail\("busy"/);
    // servers.json has one writer.
    expect(servers.match(/temp::write_atomic\(&path, &store\.to_bytes\(\)\)/g)?.length).toBe(1);
    expect(servers).toMatch(/fn spawn_store\(/);
    // A failed record aborts the start; the sweep removes a record only once its process is
    // ended or gone.
    expect(servers).toMatch(/fn write\(&self, pid: u32\) -> std::io::Result<\(\)>/);
    const sweep = servers.slice(servers.indexOf('pub fn sweep('), servers.indexOf('/* ---------- the OS side'));
    expect(sweep).toMatch(/os::Swept::Failed => \{\s*kept \+= 1;\s*continue;/);
    expect(read('src-tauri/src/main.rs')).toContain('servers::sweep(&app.state::<Shell>());');
  });
});

describe('no command blocks an async worker', () => {
  const mine = { 'servers.rs': servers, 'files.rs': files, 'system.rs': system, 'notify.rs': notify };
  // What waits: channel receives, joins, condition waits, sleeps, and the blocking helpers.
  const waits = [/\.recv\(/, /recv_timeout\(/, /blocking_recv\(/, /\.join\(\)/, /\.wait\(/, /wait_timeout\(/, /thread::sleep\(/];
  const blocking = [/dialogs::/, /confirm::reserve\(/, /confirm::modal\(/, /ticket\.ask\(/, /temp::save\(/, /std::fs::/];
  for (const [file, src] of Object.entries(mine)) {
    it(`${file}: every command is a plain async fn that waits on nothing but its awaits`, () => {
      expect(src, file).not.toMatch(/#\[tauri::command\(async\)\]/);
      for (const c of commands(src)) {
        expect(c.attr, `${file} ${c.name}`).toMatch(/pub async fn/);
        for (const w of waits) expect(c.text, `${file} ${c.name}: ${w}`).not.toMatch(w);
        // Blocking work only inside the closure handed to on_thread.
        const handed = c.text.indexOf('on_thread(');
        for (const b of blocking) {
          const at = c.text.search(b);
          if (at >= 0) expect(handed >= 0 && handed < at, `${file} ${c.name}: ${b} outside on_thread`).toBe(true);
        }
      }
    });
  }
});
