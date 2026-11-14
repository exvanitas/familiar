/* The real app's core page, as far as step 3 goes: it checks the exe is new enough, asks for
   persistent storage, says ready, sets the tray, and opens chat unless this was a sign-in start.
   The agent core joins it in later steps. */
import { createShell, MIN_API, type CoreMessage } from '../shell.ts';

const shell = createShell();

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
  await shell.ready(m => { void onMessage(m); });
  await shell.traySet({ tooltip: 'Familiar', icon: 'tray.png', items: [{ id: 'chat', label: 'Open chat' }, { id: 'settings', label: 'Settings' }] });
  if (!info.autostarted) await openChat();
})();
