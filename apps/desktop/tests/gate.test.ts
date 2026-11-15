/* The runner's security gate and the egress analysis, tested here so the runner only runs them. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judge } from '../shell-check/gate.mjs';
import { dnsNames, judge as egress, parsePcapng, reassembleDns } from '../shell-check/analyze.mjs';
import { answer, question } from '../shell-check/dns-server.mjs';
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
    expect(inv.length).toBe(70);
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
  // Canaries at 100 and 900, the window 200 to 800, ddd's dialog returned at 500 by the exe's log.
  const log = [
    'NETLOOKUP canary cfirst', 'NETLOOKUP tcp-canary ctcp', 'NETLOOKUP never aaa', 'NETLOOKUP never bbb', 'NETLOOKUP never ccc',
    'confirm: dialog answered at 300', 'confirm: dialog answered at 500', 'NETLOOKUP after ddd', 'NETLOOKUP window 200 800', 'NETLOOKUP canary clast', 'NETLOOKUP flow ok'
  ].map(l => `x ${l}`).join('\n');
  const q = (n: string, at: number, proto = 'udp') => ({ proto, dst: '1.1.1.1', dport: 53, names: [`${n}.familiar-check.test`], at });
  const sq = (n: string, at: number, tcp = false) => ({ name: `${n}.familiar-check.test`, type: 1, tcp, at });
  const packets = [q('cfirst', 100), q('ctcp', 150, 'tcp-dns'), q('ddd', 520), q('clast', 900)];
  const server = [sq('cfirst', 99), sq('ctcp', 149, true), sq('ddd', 510), sq('clast', 899)];
  const judged = (o: object) => judgeLookups({ log, packets, dnsLog: '', server, run: 'r', ...o });
  it('passes when only the allowed name was looked up, after the exe\'s dialog returned, inside seen canaries', () => {
    expect(judged({})).toMatch(/^PASS .*first queried 10 ms after the exe's dialog returned.* run=r$/);
  });
  it('fails on a refused name at the server, on the wire or in the client log', () => {
    expect(judged({ packets: [...packets, q('bbb', 300)] })).toMatch(/^FAIL .*bbb looked up before any Allow \(wire\)/);
    expect(judged({ server: [...server, sq('aaa', 300)] })).toMatch(/^FAIL .*aaa looked up before any Allow \(server\)/);
    expect(judged({ dnsLog: 'QueryName ccc.familiar-check.test' })).toMatch(/^FAIL .*ccc .*client log/);
  });
  it('fails when the allowed name was looked up before the dialog returned, or never', () => {
    // 450 is after the driver could have clicked but before the exe's dialog returned.
    expect(judged({ server: [...server, sq('ddd', 450)] })).toMatch(/^FAIL .*50 ms before its dialog returned/);
    expect(judged({ packets: packets.filter(p => !p.names[0].startsWith('ddd')) })).toMatch(/^FAIL .*allowed ddd was not seen/);
    expect(judged({ log: log.replace(/x confirm: dialog answered at \d+\n/g, '') })).toMatch(/^FAIL .*no dialog answer in the exe's log before ddd/);
  });
  it('fails when the witnesses did not cover the window', () => {
    expect(judged({ packets: packets.filter(p => !p.names[0].startsWith('cfirst')) })).toMatch(/^FAIL .*opening canary was not seen/);
    expect(judged({ server: server.filter(p => !p.name.startsWith('clast')) })).toMatch(/^FAIL .*closing canary was not seen/);
    expect(judged({ packets: [q('cfirst', 300), q('ctcp', 150, 'tcp-dns'), q('ddd', 520), q('clast', 900)] })).toMatch(/^FAIL .*capture starts after the window/);
    expect(judged({ log: log.replace(/x NETLOOKUP window.*\n/, '') })).toMatch(/^FAIL .*no window/);
    expect(judged({ log: log.replace('NETLOOKUP flow ok', '') })).toMatch(/^FAIL .*never finished/);
  });
  it('fails when the TCP canary was not seen reassembled, or any TCP DNS was seen only in part', () => {
    expect(judged({ packets: packets.filter(p => p.proto !== 'tcp-dns') })).toMatch(/^FAIL .*TCP canary was not seen \(wire 0/);
    expect(judged({ server: server.map(x => ({ ...x, tcp: false })) })).toMatch(/^FAIL .*TCP canary was not seen \(wire 1, server 0/);
    expect(judged({ log: log.replace('x NETLOOKUP tcp-canary ctcp\n', '') })).toMatch(/^FAIL .*no canary was looked up over TCP/);
    expect(judged({ packets: [...packets, { ...q('zzz', 400, 'tcp-dns'), incomplete: 'a>b: a gap at byte 10' }] })).toMatch(/^FAIL .*TCP DNS seen only in part \(a>b: a gap at byte 10\)/);
  });
});

describe('DNS over TCP and the check\'s DNS server', () => {
  const query = (name: string, type = 1) => {
    const labels = name.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
    const tail = Buffer.alloc(5);
    tail.writeUInt16BE(type, 1);
    tail.writeUInt16BE(1, 3);
    return Buffer.concat([Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, tail]);
  };
  const framed = (name: string) => { const m = query(name); return Buffer.concat([Buffer.from([m.length >> 8, m.length & 0xff]), m]); };
  const SYN = 0x02, FIN = 0x01, RST = 0x04, ACK = 0x10;
  /* A segment of `stream` from byte `from` to `to`, on a connection whose SYN had `isn`. */
  const seg = (stream: Buffer, isn: number, from: number, to: number, at: number, flags = ACK, sport = 5000) =>
    ({ proto: 'tcp', src: 'a', dst: 'b', sport, dport: 53, names: [], seq: (isn + 1 + from) >>> 0, flags, payload: stream.subarray(from, to), at });
  const syn = (isn: number, at: number, sport = 5000) => ({ proto: 'tcp', src: 'a', dst: 'b', sport, dport: 53, names: [], seq: isn, flags: SYN, payload: Buffer.alloc(0), at });
  it('reads a query split across segments, out of order and resent', () => {
    const stream = framed('split.familiar-check.test');
    const got = reassembleDns([syn(1000, 0), seg(stream, 1000, 10, stream.length, 2), seg(stream, 1000, 0, 10, 1), seg(stream, 1000, 0, 10, 3), seg(stream, 1000, 5, 15, 4)]);
    expect(got).toHaveLength(1);
    expect(got[0].names).toEqual(['split.familiar-check.test']);
    expect(got[0].incomplete).toBeUndefined();
    expect(got[0].at).toBe(0);
  });
  it('a hole, a missing SYN, a cut-off message or resent bytes that differ are incomplete evidence', () => {
    const stream = framed('hole.familiar-check.test');
    expect(reassembleDns([syn(7, 0), seg(stream, 7, 0, 10, 1), seg(stream, 7, 20, stream.length, 2)])[0].incomplete).toMatch(/a gap at byte 10/);
    expect(reassembleDns([seg(stream, 7, 0, stream.length, 1)])[0].incomplete).toMatch(/no SYN seen/);
    expect(reassembleDns([syn(7, 0), seg(stream, 7, 0, stream.length - 3, 1)])[0].incomplete).toMatch(/ends part-way through a message/);
    const other = Buffer.from(stream);
    other[12] ^= 0xff;
    expect(reassembleDns([syn(7, 0), seg(stream, 7, 0, stream.length, 1), seg(other, 7, 0, 20, 2)])[0].incomplete).toMatch(/differ/);
  });
  it('a missing tail is incomplete, though what was captured ends on a message boundary', () => {
    const benign = framed('benign.familiar-check.test'), hidden = framed('hidden.familiar-check.test');
    const stream = Buffer.concat([benign, hidden]);
    // SYN, the first message whole, the second lost, then a FIN whose sequence is past it.
    const fin = { ...seg(stream, 7, stream.length, stream.length, 3), flags: FIN | ACK };
    const got = reassembleDns([syn(7, 0), seg(stream, 7, 0, benign.length, 1), fin]);
    expect(got[0].names).toEqual(['benign.familiar-check.test']);
    expect(got[0].incomplete).toMatch(new RegExp(`bytes missing before the end at byte ${stream.length}, ${hidden.length} of them`));
    // The same, known from the server's ACK instead of a FIN.
    const ackBack = { proto: 'tcp', src: 'b', dst: 'a', sport: 53, dport: 5000, names: [], seq: 1, ack: (7 + 1 + stream.length) >>> 0, flags: ACK, payload: Buffer.alloc(0), at: 4 };
    expect(reassembleDns([syn(7, 0), seg(stream, 7, 0, benign.length, 1), ackBack])[0].incomplete).toMatch(/bytes missing before the end/);
    // An RST past the captured bytes says the same.
    const rst = { ...seg(stream, 7, stream.length, stream.length, 3), flags: RST };
    expect(reassembleDns([syn(7, 0), seg(stream, 7, 0, benign.length, 1), rst])[0].incomplete).toMatch(/bytes missing before the end/);
    // A FIN acked by the other side, with everything captured, is whole.
    const finAck = { ...ackBack, ack: (7 + 1 + stream.length + 1) >>> 0 };
    const whole = reassembleDns([syn(7, 0), seg(stream, 7, 0, stream.length, 1), fin, finAck]);
    expect(whole[0].incomplete).toBeUndefined();
    // A connection whose every data segment was lost is incomplete too.
    expect(reassembleDns([syn(7, 0), fin])[0].incomplete).toMatch(/bytes missing/);
  });

  it('a reused tuple whose new SYN was lost, with a lower sequence, is incomplete, never dropped', () => {
    const benign = framed('benign.familiar-check.test'), hidden = framed('hidden.familiar-check.test');
    const fin = { ...seg(benign, 50000, benign.length, benign.length, 2), flags: FIN | ACK };
    // The same ports again, a new connection starting at 100; its SYN wasn't captured.
    const got = reassembleDns([syn(50000, 0), seg(benign, 50000, 0, benign.length, 1), fin, seg(hidden, 100, 0, hidden.length, 4)]);
    expect(got).toHaveLength(1);
    expect(got[0].names).toEqual(['benign.familiar-check.test']);
    expect(got[0].incomplete).toMatch(/outside the connection's window/);
    expect(got[0].incomplete).toMatch(/traffic after the close that isn't a resend/);
    // A resend of what came before the close is fine.
    const resent = reassembleDns([syn(50000, 0), seg(benign, 50000, 0, benign.length, 1), fin, seg(benign, 50000, 0, benign.length, 3)]);
    expect(resent[0].incomplete).toBeUndefined();
  });

  it('two connections on one reused tuple stay apart', () => {
    const one = framed('first.familiar-check.test'), two = framed('second.familiar-check.test');
    const got = reassembleDns([syn(100, 0), seg(one, 100, 0, one.length, 1), { ...seg(one, 100, one.length, one.length, 2), flags: FIN | ACK }, syn(900000, 3), seg(two, 900000, 0, two.length, 4)]);
    expect(got.map(g => g.names)).toEqual([['first.familiar-check.test'], ['second.familiar-check.test']]);
    expect(got.every(g => !g.incomplete)).toBe(true);
  });
  it('a sequence number that wraps past 2^32 reads straight on', () => {
    const stream = framed('wrap.familiar-check.test');
    const isn = 2 ** 32 - 6;
    const got = reassembleDns([syn(isn, 0), seg(stream, isn, 8, stream.length, 2), seg(stream, isn, 0, 8, 1)]);
    expect(got[0].names).toEqual(['wrap.familiar-check.test']);
    expect(got[0].incomplete).toBeUndefined();
  });
  it('answers with the planned addresses of the asked type, at TTL 0', () => {
    const m = query('plan.familiar-check.test');
    expect(question(m)).toMatchObject({ name: 'plan.familiar-check.test', type: 1 });
    const r = answer(m, ['192.168.1.5', '127.0.0.1', '::1']);
    expect(r.readUInt16BE(6)).toBe(2);
    expect([...r.subarray(r.length - 4)]).toEqual([127, 0, 0, 1]);
    expect(r.readUInt32BE(r.length - 4 - 2 - 4)).toBe(0);
    const six = answer(query('plan.familiar-check.test', 28), ['192.168.1.5', '::1']);
    expect(six.readUInt16BE(6)).toBe(1);
    expect(six[six.length - 1]).toBe(1);
  });
});
