/* What the runner can't show of the process side, pinned in the source. The runner can't sleep,
   so the resume registration is checked here; the dialogs' test file and the save's backup name
   are checked here as well as watched on the runner. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const system = read('src-tauri/src/system.rs');
const files = read('src-tauri/src/files.rs');
const servers = read('src-tauri/src/servers.rs');

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
    expect(files).toMatch(/ReplaceFileW\(&HSTRING::from\(target\), &HSTRING::from\(temp\), PCWSTR::null\(\),/);
    expect(files).toMatch(/MoveFileExW\(&HSTRING::from\(temp\), &HSTRING::from\(target\), MOVEFILE_WRITE_THROUGH\)/);
  });

  it('a save refuses anywhere remote, and refuses all when a protected folder is unknown', () => {
    const refused = files.slice(files.indexOf('fn refused('), files.indexOf('fn local_drive('));
    expect(refused).toMatch(/files::remote\(&target\.display\(\)\.to_string\(\)\) \|\| !local_drive\(dir\)/);
    expect(refused).toMatch(/let Some\(forbidden\) = forbidden\(shell\) else \{ return Ok\(true\) \};/);
  });
});

describe('server starts', () => {
  it('stop never waits on a write, and the slot and the last check are under the runs lock', () => {
    const stop = servers.slice(servers.indexOf('fn stop('), servers.indexOf('pub fn server_stop('));
    expect(stop).toMatch(/let until = Instant::now\(\) \+ Duration::from_millis\(500\);\n\s+lock\(&running\.input\)\.take\(\);/);
    expect(servers).not.toMatch(/stdin: Mutex</);
    expect(servers).toMatch(/lock\(&servers\.state\)\.reserve\(&setup\.id\)/);
    expect(servers).toMatch(/slot\.commit\(&run, running\)/);
    // The exe ends a hard kill's leftovers at each start.
    expect(read('src-tauri/src/main.rs')).toContain('servers::sweep(&app.state::<Shell>());');
  });
});
