/* The runner's security gate and the egress analysis, tested here so the runner only runs them. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judge } from '../shell-check/gate.mjs';
import { dnsNames, judge as egress, parsePcapng } from '../shell-check/analyze.mjs';
import { label, lanPort, ROUTES } from '../shell-check/hostile.ts';
import { judgeLookups } from '../shell-check/net-analyze.mjs';

const inventory = ['a.one', 'a.two'];
const checks = ['m.x'];

describe('the gate', () => {
  it('passes when every security id passes and checks pass or skip', () => {
    const r = judge(['PASS security.a.one ok', 'PASS security.a.two ok', 'SKIP check.m.x no desktop', 'noise line'], inventory, checks);
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it('a security SKIP, FAIL or missing id fails it', () => {
    expect(judge(['PASS security.a.one', 'SKIP security.a.two why'], inventory, checks).ok).toBe(false);
    expect(judge(['PASS security.a.one', 'FAIL security.a.two why'], inventory, checks).ok).toBe(false);
    const missing = judge(['PASS security.a.one'], inventory, checks);
    expect(missing.problems).toEqual(['security.a.two: never reported']);
  });

  it('an id reported twice must pass both times', () => {
    expect(judge(['PASS security.a.one', 'PASS security.a.two', 'FAIL security.a.two again'], inventory, checks).ok).toBe(false);
  });

  it('a check FAIL fails it, and so does any id in neither list', () => {
    expect(judge(['PASS security.a.one', 'PASS security.a.two', 'FAIL check.m.x'], inventory, checks).ok).toBe(false);
    expect(judge(['PASS security.a.one', 'PASS security.a.two', 'PASS check.renamed'], inventory, checks).problems).toEqual(['check.renamed: not in checks.json']);
    expect(judge(['PASS security.a.one', 'PASS security.a.two', 'PASS security.new'], inventory, checks).ok).toBe(false);
    expect(judge(['PASS security.a.one', 'PASS security.a.two', 'PASS bare.id'], inventory, checks).ok).toBe(false);
  });

  it('an egress verdict must carry the run id of this run', () => {
    const inv = ['egress.core'];
    expect(judge(['RUN abc', 'PASS security.egress.core closed run=abc'], inv, []).ok).toBe(true);
    expect(judge(['RUN abc', 'PASS security.egress.core closed run=old'], inv, []).problems).toEqual(["security.egress.core: not from this run's analysis"]);
    expect(judge(['PASS security.egress.core closed run=abc'], inv, []).ok).toBe(false);
    expect(judge(['RUN abc', 'RUN def', 'PASS security.egress.core closed run=abc'], inv, []).ok).toBe(false);
    expect(judge(['RUN abc', 'PASS security.egress.core closed'], inv, []).ok).toBe(false);
  });

  it('the real lists are well formed and apart', () => {
    const inv = JSON.parse(readFileSync(new URL('../shell-check/security-inventory.json', import.meta.url), 'utf8')).ids as string[];
    const chk = JSON.parse(readFileSync(new URL('../shell-check/checks.json', import.meta.url), 'utf8')).ids as string[];
    expect(new Set(inv).size).toBe(inv.length);
    expect(new Set(chk).size).toBe(chk.length);
    expect(inv.length).toBe(53);
    for (const id of [...inv, ...chk]) expect(id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$|^[a-z0-9-]+$/);
  });
});

/* ---------- a synthetic capture ---------- */

function block(type: number, body: Buffer): Buffer {
  const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
  const len = 12 + body.length + pad.length;
  const b = Buffer.alloc(len);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(len, 4);
  Buffer.concat([body, pad]).copy(b, 8);
  b.writeUInt32LE(len, len - 4);
  return b;
}
function dnsQuery(name: string): Buffer {
  const q = Buffer.concat([Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...name.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 1, 0, 1])]);
  return q;
}
function udpFrame(dst: number[], dport: number, payload: Buffer): Buffer {
  const eth = Buffer.alloc(14); eth.writeUInt16BE(0x0800, 12);
  const ip = Buffer.alloc(20); ip[0] = 0x45; ip[9] = 17; Buffer.from([10, 1, 0, 4]).copy(ip, 12); Buffer.from(dst).copy(ip, 16);
  const udp = Buffer.alloc(8); udp.writeUInt16BE(50000, 0); udp.writeUInt16BE(dport, 2); udp.writeUInt16BE(8 + payload.length, 4);
  return Buffer.concat([eth, ip, udp, payload]);
}
function pcapng(frames: { at: number; data: Buffer }[]): Buffer {
  const shb = Buffer.alloc(16); shb.writeUInt32LE(0x1a2b3c4d, 0); shb.writeUInt16LE(1, 4); shb.writeBigInt64LE(-1n, 8);
  const idb = Buffer.alloc(8); idb.writeUInt16LE(1, 0); idb.writeUInt32LE(0, 4);
  const epbs = frames.map(f => {
    const us = BigInt(f.at) * 1000n;
    const h = Buffer.alloc(20);
    h.writeUInt32LE(0, 0); h.writeUInt32LE(Number(us >> 32n), 4); h.writeUInt32LE(Number(us & 0xffffffffn), 8);
    h.writeUInt32LE(f.data.length, 12); h.writeUInt32LE(f.data.length, 16);
    return block(6, Buffer.concat([h, f.data]));
  });
  return Buffer.concat([block(0x0a0d0d0a, shb), block(1, idb), ...epbs]);
}

describe('the egress analysis', () => {
  const fx = { run: 'r1x2y3z4', tcp: 5000, lan: '192.168.250.250', udp: {}, turnTcp: { core: 1, view: 2, bare: 3, edge: 4, driver: 5, probe: 6 } };

  it('reads DNS names and ports out of a pcapng capture', () => {
    const buf = pcapng([
      { at: 1_700_000_000_000, data: udpFrame([168, 63, 129, 16], 53, dnsQuery('abc.familiar-check.test')) },
      { at: 1_700_000_000_500, data: udpFrame([192, 168, 250, 250], 20305, Buffer.from('x')) }
    ]);
    const p = parsePcapng(buf);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ proto: 'udp', dst: '168.63.129.16', dport: 53, names: ['abc.familiar-check.test'], at: 1_700_000_000_000 });
    expect(p[1]).toMatchObject({ dst: '192.168.250.250', dport: 20305 });
    expect(dnsNames(dnsQuery('a.b'))).toEqual(['a.b']);
  });

  /* A run where every page recorded every route and every control saw its traffic. */
  function evidence() {
    const T = { driver: [100, 200], core: [300, 400], view: [500, 600], bare: [700, 800] };
    const marks: Record<string, { at: number; sink: number }> = {};
    for (const [k, [a, b]] of Object.entries(T)) { marks[`${k}-start`] = { at: a, sink: 0 }; marks[`${k}-end`] = { at: b, sink: 4 }; }
    marks['egress-start'] = { at: 300, sink: 0 };
    marks['egress-end'] = { at: 800, sink: 4 };
    const hits: Record<string, unknown>[] = [
      { kind: 'http', label: label(fx, 'driver', 0), at: 150 }, { kind: 'udp', listener: 'driver-stun', stun: true, at: 150 },
      { kind: 'udp', listener: 'driver-turn', at: 150 }, { kind: 'tcp', listener: 'driver-turn-tcp', at: 150 },
      { kind: 'accept', listener: 'http', at: 150 }, { kind: 'udp', listener: 'http-udp', at: 150 },
      ...Object.keys(fx.turnTcp).map(n => ({ kind: 'udp', listener: `${n}-turn-tcp-udp`, at: 150 })),
      { kind: 'accept', listener: 'http', at: 5000 }, { kind: 'http', label: label(fx, 'edge', 0), at: 5000 }, { kind: 'udp', listener: 'edge-stun', stun: true, at: 5000 }
    ];
    const packets = [
      { proto: 'udp', dst: '168.63.129.16', dport: 53, names: [`${label(fx, 'driver', 1)}.familiar-check.test`], at: 150 },
      { proto: 'udp', dst: fx.lan, dport: lanPort('driver', 99), names: [], at: 150 },
      { proto: 'udp', dst: '168.63.129.16', dport: 53, names: [`${label(fx, 'edge', 3)}.familiar-check.test`], at: 5000 },
      { proto: 'udp', dst: fx.lan, dport: lanPort('edge', 3), names: [], at: 5000 }
    ];
    const rec = JSON.stringify({ loop: 'rejected:TypeError', lan: 'rejected:TypeError', name: 'rejected:TypeError' });
    const lines = ['x sink refused 4 (connect 4, request 0, other 0)'];
    for (const ctx of ['core', 'view', 'bare']) for (const r of ROUTES) lines.push(`   1.00 [core] EGRESS ${ctx} ${r.id} ${rec}`);
    lines.push(' [core] EGRESS-DONE core', ` [core] INFO egress view routes ${ROUTES.length} ipc-after ok`, ` [core] INFO egress bare routes ${ROUTES.length} ipc-after ok`);
    const edge = Object.fromEntries(ROUTES.filter(r => !r.nav).map(r => [r.id, { loop: 'gathered:host', lan: 'error', name: 'error' }]));
    return { fx, hits, packets, dnsLog: `QueryName ${label(fx, 'driver', 1)}.familiar-check.test`, marks, log: lines.join('\n') + '\n', edge };
  }
  const line = (r: { lines: string[] }, id: string) => r.lines.find(l => l.includes(`security.egress.${id} `)) ?? '';

  it('passes only with every record, every control, and this run stamped on it', () => {
    const r = egress(evidence());
    for (const id of ['controls', 'core', 'view']) expect(line(r, id)).toMatch(new RegExp(`^PASS .* run=${fx.run}$`));
  });

  it('a route is open when the listener, the capture or the DNS log saw its label', () => {
    const base = evidence();
    const leaky = egress({ ...base, packets: [...base.packets, { proto: 'udp', dst: '168.63.129.16', dport: 53, names: [`${label(fx, 'core', 0)}.familiar-check.test`], at: 350 }] });
    expect(line(leaky, 'core')).toMatch(/^FAIL .*core:fetch\(dns 1\)/);
    const rtc = egress({ ...base, hits: [...base.hits, { kind: 'udp', listener: 'view-stun', stun: true, at: 550 }] });
    expect(line(rtc, 'view')).toMatch(/^FAIL .*view:webrtc-loopback\(1\)/);
    expect(line(rtc, 'core')).toMatch(/^PASS/);
  });

  it('a bare TCP connection or UDP to a TCP port while a page runs is open', () => {
    const base = evidence();
    const tcp = egress({ ...base, hits: [...base.hits, { kind: 'accept', listener: 'http', at: 320 }] });
    expect(line(tcp, 'core')).toMatch(/^FAIL .*core:tcp-accept\(1\)/);
    const quic = egress({ ...base, hits: [...base.hits, { kind: 'udp', listener: 'core-turn-tcp-udp', at: 720 }] });
    expect(line(quic, 'view')).toMatch(/^FAIL .*bare:udp-to-tcp-ports\(1\)/);
  });

  it('missing evidence fails, never counts as closed', () => {
    const base = evidence();
    // No records at all: the case that used to pass.
    const bare = base.log.split('\n').filter(l => !/ EGRESS (core|view|bare) /.test(l)).join('\n');
    const none = egress({ ...base, log: bare.replace(/routes \d+/g, 'routes 0') });
    expect(line(none, 'core')).toMatch(/^FAIL .*no evidence: core:missing fetch/);
    expect(line(none, 'view')).toMatch(/^FAIL .*no evidence/);
    // One record missing, one broken, one skipped.
    const one = egress({ ...base, log: base.log.replace(/.* EGRESS view img .*\n/, '') });
    expect(line(one, 'view')).toMatch(/^FAIL .*view:missing img/);
    const broken = egress({ ...base, log: base.log.replace(/( EGRESS core xhr ).*/, '$1{"loop":') });
    expect(line(broken, 'core')).toMatch(/^FAIL .*core:broken xhr/);
    const skipped = egress({ ...base, log: base.log.replace(/( EGRESS bare css-url ).*/, '$1{"loop":"skipped"}') });
    expect(line(skipped, 'view')).toMatch(/^FAIL .*bare:broken css-url/);
    const empty = egress({ ...base, log: base.log.replace(/( EGRESS core beacon ).*/, '$1{}') });
    expect(line(empty, 'core')).toMatch(/^FAIL .*core:broken beacon/);
    // A page that ran fewer routes than there are.
    const short = egress({ ...base, log: base.log.replace(`view routes ${ROUTES.length}`, 'view routes 3') });
    expect(line(short, 'view')).toMatch(/^FAIL .*IPC after the run missing in view/);
    // No time window for a page: its bare TCP and UDP can't be judged.
    const { 'core-start': _gone, ...rest } = base.marks;
    expect(line(egress({ ...base, marks: rest }), 'core')).toMatch(/^FAIL .*core:no time window/);
    // Edge with an empty or partial record proves nothing.
    expect(line(egress({ ...base, edge: {} }), 'controls')).toMatch(/^FAIL .*MISSING Edge recorded every route: missing fetch/);
    expect(line(egress({ ...base, edge: null }), 'core')).toMatch(/^FAIL .*proves nothing/);
  });

  it('a control that sees nothing fails every egress id', () => {
    const base = evidence();
    const blind = egress({ ...base, hits: base.hits.slice(1) });
    expect(line(blind, 'controls')).toMatch(/^FAIL .*MISSING driver http/);
    expect(line(blind, 'core')).toMatch(/^FAIL .*proves nothing/);
    const noAccept = egress({ ...base, hits: base.hits.filter(h => !(h.kind === 'accept' && h.at === 150)) });
    expect(line(noAccept, 'controls')).toMatch(/^FAIL .*MISSING driver bare TCP connection/);
    const noQuic = egress({ ...base, hits: base.hits.filter(h => h.listener !== 'core-turn-tcp-udp') });
    expect(line(noQuic, 'controls')).toMatch(/^FAIL .*MISSING driver UDP to core's TCP TURN port/);
    const noEdgeRtc = egress({ ...base, hits: base.hits.filter(h => h.listener !== 'edge-stun') });
    expect(line(noEdgeRtc, 'controls')).toMatch(/^FAIL .*MISSING Edge's WebRTC/);
    const noSink = egress({ ...base, log: base.log.replace('sink refused 4', 'sink refused 0') });
    expect(line(noSink, 'controls')).toMatch(/^FAIL .*MISSING sink refusals/);
    expect(ROUTES.length).toBeGreaterThan(40);
  });
});

describe('no lookup before Allow', () => {
  const log = 'x NETLOOKUP never aaa\n NETLOOKUP never bbb\n NETLOOKUP never ccc\n NETLOOKUP after ddd\n NETLOOKUP flow ok\n';
  const q = (n: string) => ({ proto: 'udp', dst: '1.1.1.1', dport: 53, names: [`${n}.familiar-check.test`], at: 1 });
  it('passes when only the allowed name was looked up', () => {
    expect(judgeLookups({ log, packets: [q('ddd')], dnsLog: '', run: 'r' })).toMatch(/^PASS .* run=r$/);
  });
  it('fails on a refused name on the wire or in the log, or an allowed one seen nowhere', () => {
    expect(judgeLookups({ log, packets: [q('ddd'), q('bbb')], dnsLog: '', run: 'r' })).toMatch(/^FAIL .*looked up: bbb/);
    expect(judgeLookups({ log, packets: [q('ddd')], dnsLog: 'QueryName aaa.familiar-check.test', run: 'r' })).toMatch(/^FAIL/);
    expect(judgeLookups({ log, packets: [], dnsLog: '', run: 'r' })).toMatch(/^FAIL .*0 seen/);
    expect(judgeLookups({ log: log.replace('NETLOOKUP flow ok', ''), packets: [q('ddd')], dnsLog: '', run: 'r' })).toMatch(/^FAIL .*never finished/);
  });
});
