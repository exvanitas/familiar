/* The real app's core page, as far as step 7 goes: it checks the exe is new enough, asks for
   persistent storage, says ready, sets the tray, opens chat unless this was a sign-in start, and starts
   the enabled MCP servers. The rest of the agent core joins it in later steps. */
import { McpClient, openSettingsStore, systemClock } from '@familiar/core';
import { desktopMcpPorts } from '../mcp.ts';
import { boot } from './boot.ts';
import { createShell, MIN_API, reason, type CoreMessage } from '../shell.ts';

const shell = createShell();

/* The saved servers: repaired (this is a fresh exe), then the enabled ones started, one admitted start at
   a time. An approved setup starts with no dialog. */
async function startServers(): Promise<McpClient | undefined> {
  try {
    const client = await McpClient.open({ store: await openSettingsStore(indexedDB), ...desktopMcpPorts(shell), clock: systemClock });
    const repaired = await client.repair();
    if (!repaired.ok) await shell.log(`mcp: repair did not finish: ${repaired.words}`);
    void client.startEnabled();
    return client;
  } catch (e) {
    await shell.log(`mcp: the saved servers could not be loaded: ${reason(e)}`);
    return undefined;
  }
}

async function openChat() {
  await shell.viewOpen({ label: 'view-chat', page: 'chat.html', title: 'Familiar', width: 480, height: 640 }).catch(() => shell.windowCtl('view-chat', 'focus'));
}

async function onMessage(m: CoreMessage) {
  if (m.t === 'quitting') {
    await shell.quitReady();
  } else if (m.t === 'second-launch' || m.t === 'tray-click' || (m.t === 'tray' && m.id === 'chat')) {
    await openChat();
  } else if (m.t === 'tray' && m.id === 'settings') {
    await shell.viewOpen({ label: 'settings', title: 'Familiar settings', width: 520, height: 560 }).catch(() => shell.windowCtl('settings', 'focus'));
  }
}

(async () => {
  const info = await shell.info();
  if (info.api < MIN_API) {
    await shell.log(`app needs shell api ${MIN_API}, the exe has ${info.api}`);
    return;
  }
  const persisted = await navigator.storage.persisted();
  const granted = persisted || await navigator.storage.persist();
  const { quota, usage } = await navigator.storage.estimate();
  await shell.log(`persist granted=${granted} persisted=${persisted} quota=${quota} usage=${usage}`);
  // Ready first: a refused ready (a reload in a running exe) builds nothing at all.
  await boot(
    () => shell.ready(m => { void onMessage(m); }),
    async () => {
      await shell.traySet({ tooltip: 'Familiar', icon: 'tray.png', items: [{ id: 'chat', label: 'Open chat' }, { id: 'settings', label: 'Settings' }] });
      if (!info.autostarted) await openChat();
      await startServers();
    },
    words => shell.log(`core: shell_ready refused, restart-only: ${words}`)
  );
})();
