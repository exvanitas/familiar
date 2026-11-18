/* The MCP client's ports in the app, over familiar.exe. Local servers start through the exe's server
   commands, which ask the person natively for a new or changed setup, run each server in its own job,
   and blank the setup's secrets from every line before core sees it. Remote servers go through the
   guarded fetch for their saved address. Secrets are written only by the Settings window; core may only
   delete them. See docs/mcp-design.md and 5b in docs/shell-design.md. */
import type { McpClientOptions, NetPort, ProcessPort } from '@familiar/core';
import { createShell, type Shell } from './shell.ts';

/* The process port over server_start, server_write, server_stop and server_forget. */
export function desktopProcessPort(shell: Shell = createShell()): ProcessPort {
  return {
    start: (setup, onEvent) => shell.serverStart({ ...setup, args: [...setup.args], env: setup.env.map(([k, v]) => [k, v]), secrets: [...setup.secrets] }, onEvent),
    write: (run, bytes) => shell.serverWrite(run, bytes),
    stop: run => shell.serverStop(run),
    forget: setupId => shell.serverForget(setupId)
  };
}

/* A quiet event stream is normal for a server, so its reads may idle up to the exe's cap. */
export const SERVER_IDLE_MS = 15 * 60_000;

/* The exe's net_fetch, net_read and net_cancel, as core's client uses them: one request per id, ended
   by net_cancel, which resolves once the exe has ended it (the client's cleanup barrier waits on it). */
export function desktopNetPort(shell: Shell = createShell()): NetPort {
  return {
    fetch: (spec, body) => shell.netFetch({ ...spec, headers: spec.headers.map(([k, v]) => [k, v] as [string, string]) }, body),
    read: id => shell.netRead(id),
    cancel: id => shell.netCancel(id)
  };
}

/* Everything the client needs from the exe. The store and clock come from the caller. */
export function desktopMcpPorts(shell: Shell = createShell()): Pick<McpClientOptions, 'processes' | 'net' | 'addresses' | 'secrets'> {
  return {
    processes: desktopProcessPort(shell),
    net: desktopNetPort(shell),
    addresses: {
      add: async ({ url, label }) => ({ id: (await shell.addressAdd({ kind: 'server', url, label })).id }),
      remove: id => shell.addressRemove(id)
    },
    secrets: { delete: ref => shell.secretDelete(ref) }
  };
}
