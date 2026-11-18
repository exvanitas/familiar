// What Familiar may put on an MCP server's wire (docs/mcp-design.md 3.2). Every message is one of six
// kinds, built here from a tagged union and nothing else:
//   initialize, notifications/initialized, tools/list, tools/call, a pong (an empty result answering a
//   ping), and, for local servers only, notifications/cancelled for that run's own call.
// The run's era narrows them: a legacy run may build all six; a modern (2026-07-28) run only tools/list,
// tools/call and the local cancel, each with the `_meta` envelope. A tools/call is built only by the
// client's send, from a decision (client.ts); this module never sees one but frames its body.

/** The legacy versions Familiar speaks, as a discrete list: any other string is unsupported. */
export const LEGACY_VERSIONS = ['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const;
export const OFFERED_VERSION = '2025-11-25';
export const MODERN_VERSION = '2026-07-28';
export const CLIENT_INFO = { name: 'familiar', version: '0.1.0' } as const;

export type Era = 'legacy' | 'modern';
export type Where = 'remote' | 'local';
export type RpcId = string | number;

/** Every message but a call. */
export type AdminMessage =
  | { readonly kind: 'initialize'; readonly id: number }
  | { readonly kind: 'initialized' }
  | { readonly kind: 'list'; readonly id: number; readonly cursor?: string }
  | { readonly kind: 'pong'; readonly id: RpcId }
  | { readonly kind: 'cancelled'; readonly requestId: number };

export type MessageKind = AdminMessage['kind'] | 'call';

/** Which kinds an era and a transport allow. */
export function allowed(kind: MessageKind, era: Era, where: Where): boolean {
  if (kind === 'cancelled') return where === 'local';
  if (era === 'legacy') return true;
  return kind === 'list' || kind === 'call';
}

export class FramingRefused extends Error {
  constructor(kind: MessageKind, era: Era, where: Where) {
    super(`A ${era} ${where} run can't send ${kind}.`);
    this.name = 'FramingRefused';
  }
}

const meta = () => ({ 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { ...CLIENT_INFO } });

/** A request's params with the modern envelope added, for a modern run. */
function params(era: Era, p: Record<string, unknown>): Record<string, unknown> {
  return era === 'modern' ? { ...p, _meta: meta() } : p;
}

/** The JSON text of an administrative message, or a throw if the run may not send it. */
export function frame(m: AdminMessage, era: Era, where: Where): string {
  if (!allowed(m.kind, era, where)) throw new FramingRefused(m.kind, era, where);
  switch (m.kind) {
    case 'initialize':
      return JSON.stringify({ jsonrpc: '2.0', id: m.id, method: 'initialize', params: { protocolVersion: OFFERED_VERSION, capabilities: {}, clientInfo: { ...CLIENT_INFO } } });
    case 'initialized':
      return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    case 'list':
      return JSON.stringify({ jsonrpc: '2.0', id: m.id, method: 'tools/list', params: params(era, m.cursor !== undefined ? { cursor: m.cursor } : {}) });
    case 'pong':
      return JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} });
    case 'cancelled':
      return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: params(era, { requestId: m.requestId, reason: 'The person stopped the call, or it timed out.' }) });
  }
}

/** A tools/call's JSON text. Exported for the client's send only, which passes the decision's own name and
    canonical arguments; the module boundary that matters is the decision's (client.ts). */
export function frameCall(id: number, name: string, canonicalArguments: string, era: Era, where: Where): string {
  if (!allowed('call', era, where)) throw new FramingRefused('call', era, where);
  const head = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call' });
  const metaText = era === 'modern' ? `,"_meta":${JSON.stringify(meta())}` : '';
  // The arguments go in as the canonical text the card and its hash used, byte for byte.
  return `${head.slice(0, -1)},"params":{"name":${JSON.stringify(name)},"arguments":${canonicalArguments}${metaText}}}`;
}

/** Whether a version string is one of the legacy versions Familiar speaks. */
export function legacyVersion(v: unknown): v is (typeof LEGACY_VERSIONS)[number] {
  return typeof v === 'string' && (LEGACY_VERSIONS as readonly string[]).includes(v);
}
