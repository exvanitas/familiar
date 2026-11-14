/* The runner's security gate and the egress analysis, tested here so the runner only runs them. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judge } from '../shell-check/gate.mjs';
import { dnsNames, judge as egress, parsePcapng } from '../shell-check/analyze.mjs';
import { label, lanPort, ROUTES } from '../shell-check/hostile.ts';

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

  it('the real lists are well formed and apart', () => {
    const inv = JSON.parse(readFileSync(new URL('../shell-check/security-inventory.json', import.meta.url), 'utf8')).ids as string[];
    const chk = JSON.parse(readFileSync(new URL('../shell-check/checks.json', import.meta.url), 'utf8')).ids as string[];
    expect(new Set(inv).size).toBe(inv.length);
    expect(new Set(chk).size).toBe(chk.length);
    expect(inv.length).toBe(18);
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
  const fx = { run: 'r1x2y3z4', tcp: 5000, lan: '192.168.250.250', udp: {}, turnTcp: {} };

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

  it('a route is open when the listener, the capture or the DNS log saw its label, and the controls must see', () => {
    const coreFetch = label(fx, 'core', 0);
    const hits = [
      { kind: 'http', label: label(fx, 'driver', 0) }, { kind: 'udp', listener: 'driver-stun', stun: true }, { kind: 'udp', listener: 'driver-turn' },
      { kind: 'tcp', listener: 'driver-turn-tcp' }, { kind: 'http', label: label(fx, 'edge', 0) }, { kind: 'udp', listener: 'edge-stun', stun: true }
    ];
    const packets = [
      { proto: 'udp', dst: '168.63.129.16', dport: 53, names: [`${label(fx, 'driver', 1)}.familiar-check.test`], at: 1 },
      { proto: 'udp', dst: fx.lan, dport: lanPort('driver', 99), names: [], at: 1 },
      { proto: 'udp', dst: '168.63.129.16', dport: 53, names: [`${label(fx, 'edge', 3)}.familiar-check.test`], at: 1 },
      { proto: 'udp', dst: fx.lan, dport: lanPort('edge', 3), names: [], at: 1 }
    ];
    const log = 'x sink refused 4 (connect 4, request 0, other 0)\n [core] EGRESS-DONE core\n [core] INFO egress view routes 42 ipc-after ok\n [core] INFO egress bare routes 42 ipc-after ok\n';
    const base = { fx, hits, packets, dnsLog: `QueryName ${label(fx, 'driver', 1)}.familiar-check.test`, marks: {}, log, edge: {} };
    const clean = egress(base);
    expect(clean.lines.find((l: string) => l.includes('egress.controls'))).toMatch(/^PASS/);
    expect(clean.lines.find((l: string) => l.includes('egress.core'))).toMatch(/^PASS/);
    expect(clean.lines.find((l: string) => l.includes('egress.view'))).toMatch(/^PASS/);

    const leaky = egress({ ...base, packets: [...packets, { proto: 'udp', dst: '168.63.129.16', dport: 53, names: [`${coreFetch}.familiar-check.test`], at: 1 }] });
    expect(leaky.lines.find((l: string) => l.includes('egress.core'))).toMatch(/^FAIL .*core:fetch\(dns 1\)/);

    const rtc = egress({ ...base, hits: [...hits, { kind: 'udp', listener: 'view-stun', stun: true }] });
    expect(rtc.lines.find((l: string) => l.includes('egress.view'))).toMatch(/^FAIL .*view:webrtc-loopback\(1\)/);
    expect(rtc.lines.find((l: string) => l.includes('egress.core'))).toMatch(/^PASS/);

    const blind = egress({ ...base, hits: hits.slice(1) });
    expect(blind.lines.find((l: string) => l.includes('egress.controls'))).toMatch(/^FAIL .*MISSING driver http/);
    expect(blind.lines.find((l: string) => l.includes('egress.core'))).toMatch(/^FAIL .*proves nothing/);

    const noSink = egress({ ...base, log: log.replace('sink refused 4', 'sink refused 0') });
    expect(noSink.lines.find((l: string) => l.includes('egress.controls'))).toMatch(/^FAIL .*MISSING sink refusals/);
    expect(ROUTES.length).toBeGreaterThan(30);
  });
});
