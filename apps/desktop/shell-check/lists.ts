/* The calls the refusal checks make, each with arguments that would be valid. */

export type Call = [cmd: string, args: object];

/* App commands only core may call. `quit` is in here on purpose: if the gate let a view through,
   the run would end, and the check would fail by never finishing. */
export const CORE_ONLY: Call[] = [
  ['shell_info', {}],
  ['shell_ready', { channel: '__CHANNEL__:1' }],
  ['quit_ready', {}],
  ['tray_set', { spec: { tooltip: 'x' } }],
  ['view_open', { spec: { label: 'view-intruder', page: 'chat.html' } }],
  ['window_ctl', { label: 'settings', op: 'get-bounds' }],
  ['quit', {}]
];

/* Commands designed for later rounds, which no capability grants yet. A view must be refused them
   now and later; Settings will be granted some of them when they exist. */
export const NOT_YET: Call[] = [
  ['secret_set', { ref: 'addr:x', value: 'not-a-real-key-at-all' }],
  ['secret_status', { ref: 'addr:x' }],
  ['address_list', {}]
];

/* Tauri's own plugin commands. No window holds any of these. */
export const PLUGINS: Call[] = [
  ['plugin:window|close', { label: 'core' }],
  ['plugin:window|hide', { label: 'core' }],
  ['plugin:window|set_focus', { label: 'core' }],
  ['plugin:window|get_all_windows', {}],
  ['plugin:webview|get_all_webviews', {}],
  ['plugin:webview|create_webview_window', { options: { label: 'intruder', url: 'chat.html' } }],
  ['plugin:webview|webview_close', { label: 'core' }],
  ['plugin:event|emit', { event: 'second-launch', payload: { args: [] } }],
  ['plugin:event|emit_to', { target: { kind: 'WebviewWindow', label: 'core' }, event: 'tray-click', payload: null }],
  ['plugin:app|version', {}],
  ['plugin:app|app_hide', {}],
  ['plugin:path|resolve_directory', { directory: 1 }],
  ['plugin:tray|new', { options: {} }],
  ['plugin:menu|new', { kind: 'Menu', options: {} }],
  ['plugin:image|new', { rgba: [0, 0, 0, 0], width: 1, height: 1 }],
  ['plugin:resources|close', { rid: 1 }]
];

/* Settings may not listen to events at all. */
export const EVENTS: Call[] = [
  ['plugin:event|listen', { event: 'tray', target: { kind: 'Any' }, handler: 1 }],
  ['plugin:event|unlisten', { event: 'tray', eventId: 1 }]
];

/* Every name core hears over its channel, and Tauri's own window events, which a forging view
   would listen for. */
export const CORE_EVENT_NAMES = ['tray', 'tray-click', 'second-launch', 'quitting', 'system', 'wake', 'core', 'shell'];
