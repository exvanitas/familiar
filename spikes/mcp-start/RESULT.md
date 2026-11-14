# Spike: the installed exe starting a local MCP server

**Verdict: yes, with conditions.** A small Rust command on Windows starts a saved setup (node, `npx.cmd`, `uvx.exe`) with a minimal environment and no console window, talks MCP to it over stdio, and a kill-on-close job ends the whole tree, grandchildren included, within 15 ms of the app being killed hard. The conditions are below: resolve the program ourselves, start suspended and join the job before the process runs, and reject arguments with NUL, CR or LF before starting.

Runs on GitHub's `windows-latest` (Node 22.23.4, npm 10.9.9, Python 3.12.10, uv 0.13.5, Rust 1.95.0):

- Run 1: https://github.com/exvanitas/familiar/actions/runs/43572417783 (every case passed. The cleanup control was inconclusive, see e.)
- Run 2: https://github.com/exvanitas/familiar/actions/runs/43572750275 (every case and the fixed control passed)

The code is `src/setup.rs` (saved setup, lookup, environment, start), `src/win.rs` (job, resume, process snapshots), `src/mcp.rs` (the stdio client) and `src/cases.rs`. The workflow is `.github/workflows/spike-mcp-start.yml`.

## How it starts a server

1. The saved setup holds a program (a bare name or a full path), arguments, a working folder and the server's own settings.
2. The program is resolved by the spike, not by std: absolute PATH folders only (never the working folder), trying PATHEXT's kinds in order, and only `.exe`, `.cmd` or `.bat`. On the runner PowerShell's `Get-Command npx` finds `npx.ps1` first. The resolver picks `npx.cmd`, which is the one that works without PowerShell.
3. The environment is cleared, then filled from a 22-name allowlist (`SystemRoot`, `Path`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and the like, see `ENV_ALLOWLIST`), then the setup's own settings on top.
4. `CreateProcess` runs with `CREATE_NO_WINDOW | CREATE_SUSPENDED`. The spike makes a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`, assigns the process, then resumes its thread. Nothing runs before it's in the job, so no grandchild can start outside it. std's `Child` doesn't give the thread handle, so the spike finds the thread in a Toolhelp snapshot.
5. stdout is read line by line on its own thread (4 MiB cap per line), stderr on another, kept as the last 200 lines with the setup's setting values blanked.

## Evidence per case

### a. Node directly, the repo's fake server: pass
- `node` resolved to `C:\hostedtoolcache\windows\node\22.23.4\x64\node.exe`. `initialize` answered in about 300 to 400 ms by `familiar-fake 1.0.0`, protocol `2025-06-18`. `tools/list` gave all 8 tools.
- `echo` returned `"hello from rust"`. `print_secret` returned the `FAKE_SECRET` that was set only in the setup (the parent had none).
- stderr came separately from stdout: `["call print_secret", "the secret is [hidden]"]`. The secret was blanked in the captured log.
- `list_env`: the parent had 147 variables, the server got 23 (the allowlisted ones that exist on the runner, plus `FAKE_SECRET`). `FAMILIAR_SPIKE_PARENT_ONLY`, set on the parent by the workflow, did not reach the server. No name outside the allowlist and the setup appeared.

### b. `npx -y @modelcontextprotocol/server-everything@2026.8.31`: pass
- `npx` resolved to `...\node\22.23.4\x64\npx.cmd`. The first `initialize` took 30 to 35 s (npm download on a fresh runner). It answered as `mcp-servers/everything 2.0.0`, so the date-versioned package reports its own name and version differently.
- `tools/list` gave 13 tools. `echo` with `{"message": "hello through npx"}` returned `Echo: hello through npx`. The server sent one `notifications/tools/list_changed`, with no junk on stdout.
- Version note: the newer 2.x line of this package needs Node 24, so the spike pins the last date-versioned release. Its own dependencies are ranges, so pinning the package doesn't pin what it pulls in.

### c. `uvx --from mcp-server-time==2026.10.28 mcp-server-time`: pass
- `uvx` resolved to `C:\hostedtoolcache\windows\Python\3.12.10\x64\Scripts\uvx.exe`. `initialize` answered in 7 to 8.5 s on a fresh runner, as `mcp-time 2026.10.28`.
- `tools/list` gave `get_current_time, convert_time`. `get_current_time` with `{"timezone": "UTC"}` returned the time as JSON.
- Same note: its dependencies are ranges (`mcp<3,>=2.3` and others).

### d. Quoting through `.cmd`: pass, with three arguments refused
Each argument was sent alone, by three routes, to a script that prints its `argv` as JSON: `node.exe` directly (the control), the spike's own `fixtures/echo-args.cmd` (`@node "%~dp0echo-args\echo-args.js" %*`), and `npx -y --package=<local folder> familiar-spike-echo-args` (through `npx.cmd` and then npm's own shim, the way every npx server runs).

These arrived exactly by all three routes: spaces, `say "hi" now`, a lone `"`, `%PATH%`, `100%`, `%%`, `!PATH!`, `a&b`, `a^b`, `a|b`, `a<b`, `a>b`, `(x)`, `C:\some dir\` (trailing backslash), `a\"b`, the empty string, `café ü 日本`, `--name=two words`, and a tab. All 20 together in one start also arrived exactly by every route.

Refused, before any process exists, as `io::ErrorKind::InvalidInput` from `Command::spawn`:

| Argument | `node.exe` | `.cmd` (own and npx) |
| --- | --- | --- |
| contains LF | passed exactly | `batch file arguments are invalid` |
| contains CR | passed exactly | `batch file arguments are invalid` |
| contains NUL | `nul byte found in provided data` | `nul byte found in provided data` |

The refusal is a plain spawn error with no partial start, so nothing needs cleaning up after it. **Familiar must reject arguments with NUL, CR or LF up front**, for every program and not only `.cmd`, with its own message, so the same setup doesn't work with `node` and fail with `npx`. Nothing else needs rejecting for quoting.

### e. Cleanup when the app is killed hard: pass
`kill-test` starts `mcp-start hold` as a child. `hold` starts three servers, each in its own job: npx server-everything, uvx mcp-server-time, and the fake server through a `.cmd` with a 60 s `slow` call in flight. It waits for `HOLD-READY`, lists the tree, opens a handle to every process in it, then calls `TerminateProcess` on `hold` (std's `Child::kill`), so none of `hold`'s own code runs. Run 2:

```
TREE before: root pid 8944, 14 descendants
  cmd.exe pid=2212                    npx.cmd
    conhost.exe pid=3744
    node.exe pid=1888                 npm
      cmd.exe pid=3412
        node.exe pid=3624             server-everything
  uvx.exe pid=736
    conhost.exe pid=6840
    uv.exe pid=4184
      mcp-server-time.exe pid=5416
        python.exe pid=5352
          python.exe pid=9692         the server
  cmd.exe pid=9360                    fake-server.cmd
    conhost.exe pid=4620
    node.exe pid=1904                 busy in a 60 s call
KILLED hold pid 8944 with TerminateProcess
AFTER 18 ms: 0 of the 14 processes still running
```

A PowerShell `Get-CimInstance Win32_Process` listing in the next step found no `node`, `python`, `uv`, `uvx`, `cmd` or `mcp-start` processes left.

The control (`kill-test --no-job`) is the same without the jobs. Run 1's control had only the two idle servers, and they exited on their own within about 100 ms, because an MCP server exits when its stdin closes. So run 2 added the busy server. Without a job, the idle npx and uvx trees ended within 27 ms and 117 ms by themselves, but the busy server's `cmd.exe`, `conhost.exe` and `node.exe` were still running 5 s after the kill. The job is what ends a server that's busy or stuck. Waits were on process handles opened before the kill, so a reused process id can't fool the check.

### f. A server that exits at once, and junk on stdout: pass
- A missing program: `not found: familiar-no-such-program is not on PATH as .exe, .bat, .cmd`, before anything runs.
- A package that doesn't exist (`npx -y @familiar-spike-nonexistent/no-such-server@0.0.1`): stdout closes, and the client reports `server exited (code Some(1)) before answering` with the last stderr lines, `npm error code E404` and `npm error 404 Not Found - GET https://registry.npmjs.org/...`. It took 2.7 s and 9.1 s in the two runs.
- Junk then valid answers: 5 lines that weren't JSON-RPC (a banner, `{"not":"json-rpc"}`, ANSI colour codes, a log line between replies) were skipped and counted, and `initialize` and `tools/list` worked.
- Junk only: the 5 s time limit caught it, reported as `no answer within 5s (7 non-JSON-RPC stdout lines skipped)` with the first lines kept.

### g. No console window: pass, checked through the console API, not by eye
Each probe calls `GetConsoleWindow` and `IsWindowVisible` and prints the result. It then starts a plain child of itself with no flags, the way npm starts node, and the child prints the same.
- Control with `CREATE_NEW_CONSOLE`: the server and its child both had window `0x30166`, visible. So the runner does make console windows, and the check can tell them apart.
- With `CREATE_NO_WINDOW`: window `0x0` for the server and its child.
- Through `fixtures/run-probe.cmd` with `CREATE_NO_WINDOW`: `0x0` for the grandchild and the great-grandchild under `cmd.exe`.

What this can't show: a flash that a person would see, and a server that asks for its own new console (for example Node's `spawn` with `detached: true`). The spike is a console program. The Tauri app is a GUI program, where a console child without this flag would get a new window, so the flag matters more there. Step 13's check on a real PC should look for it.

## What step 3 (the Tauri shell's server-start command) should do
- Take a saved setup, never a command line string. Resolve the program as `resolve_program` does: absolute PATH folders, PATHEXT order, only `.exe`, `.cmd`, `.bat`, never the working folder. Show the resolved full path in the approval dialog, and store it with the setup so a later PATH change can't swap the program silently.
- Reject arguments with NUL, CR or LF, setting names that are empty or contain `=` or NUL, and setting values with NUL, with Familiar's own message, before calling `spawn`. Map any remaining `InvalidInput` from `spawn` to "this setup can't be started safely" rather than a crash. (The setting checks weren't run here. std would refuse NUL, the rest is ours.)
- `env_clear`, then the allowlist, then the setup's settings. Keep the allowlist in one place and show it in the capability matrix.
- Start with `CREATE_NO_WINDOW | CREATE_SUSPENDED`, put the process in its own job with kill-on-close and die-on-unhandled-exception, then resume. One job per server, so Stop and restart are `TerminateJobObject` on that server alone. Keep the job handle non-inheritable and held only by the app.
- Hand stdout lines and stderr lines to the webview as separate streams, with the setup's secret values blanked before they leave Rust.
- Stop: close stdin first (idle servers exit within about 100 ms), then `TerminateJobObject` after a short wait. The app's own exit or crash needs no code, the job does it.

## What step 7 (the MCP client) should do
- Newline-delimited JSON-RPC. Skip stdout lines that aren't JSON-RPC 2.0, count them and keep a few for the server's log page, rather than failing. Many servers print a banner. Cap a line's length.
- Answer `ping` from the server. Decline other server requests until they're supported.
- Time limits on every request. `initialize` needs a long one the first time a server runs, since npx and uvx download then (30 to 35 s and 7 to 8.5 s on a fresh runner). Show it as "installing" and use a short limit afterwards.
- A server that exits before answering: show the exit code and the last stderr lines. npm's E404 lines say plainly what went wrong.
- Exact versions in `npx` and `uvx` setups pin only the top package. Their dependencies float, which matters for the unpinned flag.

## Not settled
- A flash seen by eye, and servers that open their own console. Only a real PC shows that (step 13).
- Smart App Control on a real PC: the runner has none. Whether it blocks `uvx.exe`, the `mcp-server-time.exe` launcher, or a node binary npm downloads is step 13's question.
- The setting-name and setting-value checks were not run.
- What happens when the app itself runs inside a job that forbids nested jobs or breakaway. Nested jobs work on Windows 8 and later, and nothing on the runner got in the way, but the spike didn't check whether the runner starts steps inside a job of its own.
- `Child::kill` was the only hard kill tried. A crash, or Task Manager's End task, should close the job handle the same way, since the kernel closes it when the process ends, but that wasn't shown.
