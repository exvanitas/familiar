// Judges the egress checks after the run, from what the fixtures and the wire saw:
//   hits.jsonl     every request, packet and connection the listeners on 127.0.0.1 got
//   capture.pcapng pktmon's capture of DNS (53), mDNS (5353), LLMNR (5355) and the LAN address
//   dns-log.txt    the DNS Client operational log's messages
//   marks.json     when each page's hostile run started and ended, and the sink's count then
//   check.log      the exe's log: the pages' EGRESS lines and the sink's counts
//   edge-result.json  what the hostile page saw in the headless Edge control
//
//   node analyze.mjs <out dir>
//
// Writes `PASS|FAIL id detail` lines to <out>/egress.txt for the gate, and a route-by-route table
// to <out>/egress.md. Route labels come from hostile.ts, which Node reads directly.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES, label, lanPort, NAME_SUFFIX } from './hostile.ts';

/* ---------- pcapng ---------- */

function ip4(b, o) { return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`; }
function ip6(b, o) { const p = []; for (let i = 0; i < 16; i += 2) p.push(((b[o + i] << 8) | b[o + i + 1]).toString(16)); return p.join(':'); }

/* The names asked about in a DNS, mDNS or LLMNR message. */
export function dnsNames(p) {
  const names = [];
  if (p.length < 12) return names;
  const qd = (p[4] << 8) | p[5];
  let o = 12;
  for (let q = 0; q < qd && o < p.length; q++) {
    const labels = [];
    for (let hops = 0; o < p.length && hops < 64; hops++) {
      const len = p[o];
      if (len === 0) { o++; break; }
      if ((len & 0xc0) === 0xc0) { o += 2; break; }
      labels.push(Buffer.from(p.subarray(o + 1, o + 1 + len)).toString('latin1'));
      o += 1 + len;
    }
    names.push(labels.join('.').toLowerCase());
    o += 4;
  }
  return names;
}

/* One frame to {proto, src, dst, sport, dport, names}, or null. */
function frame(b, linktype) {
  let o = 0, et;
  if (linktype === 1) {
    et = (b[12] << 8) | b[13];
    o = 14;
    if (et === 0x8100) { et = (b[16] << 8) | b[17]; o = 18; }
  } else if (linktype === 101 || linktype === 228 || linktype === 229) {
    et = (b[0] >> 4) === 6 ? 0x86dd : 0x0800;
  } else return null;
  let proto, src, dst, l4;
  if (et === 0x0800) {
    const ihl = (b[o] & 0x0f) * 4;
    proto = b[o + 9]; src = ip4(b, o + 12); dst = ip4(b, o + 16); l4 = o + ihl;
  } else if (et === 0x86dd) {
    proto = b[o + 6]; src = ip6(b, o + 8); dst = ip6(b, o + 24); l4 = o + 40;
  } else return null;
  if (proto !== 6 && proto !== 17) return { proto: String(proto), src, dst, sport: 0, dport: 0, names: [], raw: b };
  const sport = (b[l4] << 8) | b[l4 + 1], dport = (b[l4 + 2] << 8) | b[l4 + 3];
  let names = [];
  if (proto === 17 && [53, 5353, 5355].some(p => p === sport || p === dport)) names = dnsNames(b.subarray(l4 + 8));
  if (proto === 6 && (sport === 53 || dport === 53)) names = dnsNames(b.subarray(l4 + ((b[l4 + 12] >> 4) * 4) + 2));
  return { proto: proto === 6 ? 'tcp' : 'udp', src, dst, sport, dport, names, raw: b };
}

export function parsePcapng(buf) {
  const out = [];
  const ifaces = [];
  let o = 0, le = true;
  const u32 = at => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  const u16 = at => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  while (o + 12 <= buf.length) {
    if (buf.readUInt32LE(o) === 0x0a0d0d0a) le = buf.readUInt32LE(o + 8) === 0x1a2b3c4d;
    const type = u32(o), len = u32(o + 4);
    if (len < 12 || o + len > buf.length) break;
    if (type === 0x0a0d0d0a) ifaces.length = 0;
    else if (type === 1) {
      let tsres = 6;
      for (let p = o + 16; p + 4 <= o + len - 4;) {
        const code = u16(p), olen = u16(p + 2);
        if (code === 0) break;
        if (code === 9) tsres = buf[p + 4];
        p += 4 + Math.ceil(olen / 4) * 4;
      }
      ifaces.push({ linktype: u16(o + 8), tsres });
    } else if (type === 6) {
      const ifc = ifaces[u32(o + 8)] ?? { linktype: 1, tsres: 6 };
      const ts = u32(o + 12) * 2 ** 32 + u32(o + 16);
      const units = ifc.tsres & 0x80 ? 2 ** (ifc.tsres & 0x7f) : 10 ** ifc.tsres;
      const caplen = u32(o + 20);
      const f = frame(buf.subarray(o + 28, o + 28 + caplen), ifc.linktype);
      if (f) out.push({ ...f, at: Math.round((ts / units) * 1000) });
    } else if (type === 3) {
      const f = frame(buf.subarray(o + 12, o + len - 4), ifaces[0]?.linktype ?? 1);
      if (f) out.push({ ...f, at: 0 });
    }
    o += len;
  }
  return out;
}

/* ---------- judging ---------- */

const FAMILIAR = ['core', 'view', 'bare'];

/* One route's record, as the page wrote it: an object of non-empty strings, one per target. */
const structured = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 &&
  Object.values(v).every(x => typeof x === 'string' && x.length > 0 && x !== 'skipped');

export function judge({ fx, hits, packets, dnsLog, marks, log, edge }) {
  const lines = [], table = [];
  const has = (s, l) => s.includes(l);
  const eg = (ctx, i) => label(fx, ctx, i);
  const dnsWith = l => packets.filter(p => p.names.some(n => n.includes(l)));
  const lanTo = (ctx, i) => packets.filter(p => p.dst === fx.lan && p.dport === lanPort(ctx, i));
  const listenerFor = ctx => new Set([`${ctx}-stun`, `${ctx}-turn`, `${ctx}-turn-tcp`]);
  const egressLines = log.split('\n').filter(l => / EGRESS /.test(l));
  const ipcAfter = ctx => (ctx === 'core' ? log.includes('EGRESS-DONE core') : new RegExp(`INFO egress ${ctx} routes ${ROUTES.length} ipc-after ok`).test(log));
  const recordOf = (ctx, id) => {
    const line = egressLines.find(x => x.includes(` EGRESS ${ctx} ${id} `));
    if (line === undefined) return undefined;
    try { return JSON.parse(line.replace(/^.* EGRESS \S+ \S+ /, '')); } catch { return null; }
  };
  // Evidence: every route must have a record from every page, or nothing about it was proved.
  // A missing or broken record is a failure, never "closed".
  const evidence = ctx => {
    const bad = [];
    for (const r of ROUTES) {
      if (ctx === 'edge' && r.nav) continue;
      const rec = ctx === 'edge' ? (edge && typeof edge === 'object' ? edge[r.id] : undefined) : recordOf(ctx, r.id);
      if (rec === undefined) bad.push(`missing ${r.id}`);
      else if (!structured(rec)) bad.push(`broken ${r.id}`);
    }
    if (ctx !== 'edge' && !(marks[`${ctx}-start`]?.at && marks[`${ctx}-end`]?.at)) bad.push('no time window');
    return bad;
  };
  const inWindow = (h, name, pad = 2000) => {
    const a = marks[`${name}-start`]?.at, b = marks[`${name}-end`]?.at;
    return a != null && b != null && h.at >= a && h.at <= b + pad;
  };

  // Per context: which routes got out, and how.
  const open = {};
  for (const ctx of [...FAMILIAR, 'edge']) {
    open[ctx] = [];
    const udpTcp = hits.filter(h => (h.kind === 'udp' || h.kind === 'tcp') && listenerFor(ctx).has(h.listener));
    for (const [i, r] of ROUTES.entries()) {
      const l = eg(ctx, i);
      const seen = [];
      const http = hits.filter(h => h.label === l).length;
      if (http) seen.push(`listener ${http}`);
      const dns = dnsWith(l).length;
      if (dns) seen.push(`dns ${dns}`);
      const lan = lanTo(ctx, i).length;
      if (lan) seen.push(`lan ${lan}`);
      const logged = dnsLog.split('\n').filter(m => has(m.toLowerCase(), l)).length;
      if (logged) seen.push(`dns-log ${logged}`);
      const page = egressLines.find(x => x.includes(`EGRESS ${ctx} ${r.id} `))?.replace(/^.* EGRESS \S+ \S+ /, '') ?? '';
      if (seen.length) open[ctx].push(`${r.id}(${seen.join(',')})`);
      table.push(`| ${ctx} | ${r.id} | ${seen.length ? 'OPEN ' + seen.join(', ') : 'closed'} | ${page.replace(/\|/g, '/').slice(0, 160)} |`);
    }
    // The loopback STUN and TURN listeners are one set per page, shared by its WebRTC routes.
    if (udpTcp.length) open[ctx].push(`webrtc-loopback(${udpTcp.length})`);
    table.push(`| ${ctx} | webrtc-loopback | ${udpTcp.length ? 'OPEN ' + udpTcp.length + ' packets or connections' : 'closed'} | the page's STUN and TURN listeners on 127.0.0.1 |`);
    if (ctx === 'edge') continue;
    // A bare TCP connection that never sends a request, or UDP (QUIC) to a TCP port, carries no
    // label, so it's counted by the time the page ran.
    const accepts = hits.filter(h => h.kind === 'accept' && inWindow(h, ctx)).length;
    const quic = hits.filter(h => h.kind === 'udp' && /-udp$/.test(h.listener ?? '') && inWindow(h, ctx)).length;
    if (accepts) open[ctx].push(`tcp-accept(${accepts})`);
    if (quic) open[ctx].push(`udp-to-tcp-ports(${quic})`);
    table.push(`| ${ctx} | tcp-accept | ${accepts ? 'OPEN ' + accepts : 'closed'} | any TCP connection to the HTTP listener while the page ran |`);
    table.push(`| ${ctx} | udp-to-tcp-ports | ${quic ? 'OPEN ' + quic : 'closed'} | UDP to a TCP listener's port while the page ran |`);
  }

  // The sink: the count must have moved, and the more so while the pages tried.
  const sinkCounts = [...log.matchAll(/sink refused (\d+) \(connect (\d+), request (\d+), other (\d+)\)/g)].map(m => Number(m[1]));
  const sinkTotal = sinkCounts.length ? Math.max(...sinkCounts) : 0;
  const sinkAt = n => marks[n]?.sink ?? null;
  const during = sinkAt('egress-end') != null && sinkAt('egress-start') != null ? sinkAt('egress-end') - sinkAt('egress-start') : null;

  // Positive controls.
  const c = [];
  const dl = eg('driver', 0), dn = eg('driver', 1);
  const ctl = (ok, what) => c.push(`${ok ? 'ok' : 'MISSING'} ${what}`);
  ctl(hits.some(h => h.label === dl), 'driver http to the listener');
  ctl(hits.some(h => h.kind === 'udp' && h.listener === 'driver-stun' && h.stun), 'driver STUN to the responder');
  ctl(hits.some(h => h.kind === 'udp' && h.listener === 'driver-turn'), 'driver UDP to the TURN port');
  ctl(hits.some(h => h.kind === 'tcp' && h.listener === 'driver-turn-tcp'), 'driver TCP to the TURN port');
  ctl(dnsWith(dn).length > 0, 'driver lookup in the capture');
  ctl(dnsLog.toLowerCase().includes(dn), 'driver lookup in the DNS Client log');
  ctl(packets.some(p => p.dst === fx.lan && p.dport === lanPort('driver', 99)), 'driver UDP to the LAN address in the capture');
  const edgeHttp = hits.filter(h => h.label?.startsWith(fx.run + 'e')).length;
  const edgeDns = packets.filter(p => p.names.some(n => n.startsWith(fx.run + 'e'))).length;
  const edgeLan = packets.filter(p => p.dst === fx.lan && p.dport >= lanPort('edge', 0) && p.dport < lanPort('edge', 100)).length;
  const edgeBad = evidence('edge');
  ctl(edgeBad.length === 0, `Edge recorded every route${edgeBad.length ? ': ' + edgeBad.slice(0, 6).join(', ') : ''}`);
  const inDriver = h => inWindow(h, 'driver', 0);
  ctl(hits.some(h => h.kind === 'accept' && inDriver(h)), 'driver bare TCP connection to the HTTP listener');
  ctl(hits.some(h => h.kind === 'udp' && h.listener === 'http-udp' && inDriver(h)), "driver UDP to the HTTP listener's port");
  for (const name of Object.keys(fx.turnTcp ?? {})) {
    ctl(hits.some(h => h.kind === 'udp' && h.listener === `${name}-turn-tcp-udp` && inDriver(h)), `driver UDP to ${name}'s TCP TURN port`);
  }
  ctl(edgeHttp > 0, `Edge's requests at the listener (${edgeHttp})`);
  ctl(edgeDns > 0, `Edge's lookups in the capture (${edgeDns})`);
  ctl(edgeLan > 0, `Edge's packets to the LAN address in the capture (${edgeLan})`);
  const edgeRtc = hits.filter(h => (h.kind === 'udp' || h.kind === 'tcp') && listenerFor('edge').has(h.listener)).length;
  ctl(edgeRtc > 0, `Edge's WebRTC at the STUN and TURN listeners (${edgeRtc})`);
  ctl(sinkTotal > 0, `sink refusals (${sinkTotal})`);
  const controlsOk = c.every(x => x.startsWith('ok'));
  lines.push(`${controlsOk ? 'PASS' : 'FAIL'} security.egress.controls ${c.join('; ')}`);

  const verdict = (id, ctxs) => {
    const bad = ctxs.flatMap(x => open[x].map(r => `${x}:${r}`));
    const notDone = ctxs.filter(x => !ipcAfter(x));
    const noEvidence = ctxs.flatMap(x => evidence(x).map(e => `${x}:${e}`));
    const ok = controlsOk && bad.length === 0 && notDone.length === 0 && noEvidence.length === 0;
    const why = [
      noEvidence.length ? `no evidence: ${noEvidence.slice(0, 12).join(' ')}${noEvidence.length > 12 ? ` and ${noEvidence.length - 12} more` : ''}` : `every route recorded in ${ctxs.join('+')}`,
      bad.length ? `open: ${bad.join(' ')}` : `${ROUTES.length} routes closed in ${ctxs.join('+')}`,
      notDone.length ? `IPC after the run missing in ${notDone.join(',')}` : 'IPC worked after',
      controlsOk ? 'controls saw' : 'a control saw nothing, so this proves nothing',
      `sink ${sinkTotal} total, ${during ?? '?'} during the pages' runs`
    ];
    lines.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${why.join('; ')}`);
  };
  verdict('security.egress.core', ['core']);
  verdict('security.egress.view', ['view', 'bare']);

  // mDNS and LLMNR can't carry a label, so they're counted while Familiar's pages ran, as a measure.
  const win = n => [marks[`${n}-start`]?.at, marks[`${n}-end`]?.at];
  const quiet = FAMILIAR.map(x => {
    const [a, b] = win(x);
    if (!a || !b) return `${x} ?`;
    const n = packets.filter(p => p.at >= a && p.at <= b + 2000 && (p.dport === 5353 || p.dport === 5355)).length;
    return `${x} ${n}`;
  });
  lines.push(`PASS check.egress.mdns-llmnr packets to 5353/5355 while pages ran: ${quiet.join(', ')}; whole capture ${packets.filter(p => p.dport === 5353 || p.dport === 5355).length}`);
  lines.push(`PASS check.egress.sink total ${sinkTotal}, during the pages' runs ${during ?? '?'}, marks ${JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v.sink])))}`);
  // Each verdict carries this run's id, so one left from another run can't be read as this one's.
  for (let i = 0; i < lines.length; i++) lines[i] += ` run=${fx.run}`;
  const md = ['| page | route | wire | what the page saw |', '| --- | --- | --- | --- |', ...table, '', '**Controls**: ' + c.join('; ')].join('\n');
  return { lines, md, open, controlsOk };
}

/* ---------- the command line ---------- */

if (/(^|[\\/])analyze\.mjs$/.test(process.argv[1] ?? '')) {
  const out = process.argv[2];
  const read = (f, d) => (existsSync(join(out, f)) ? readFileSync(join(out, f)) : d);
  const fx = JSON.parse(read('fixtures.json', '{}').toString());
  const hits = read('hits.jsonl', '').toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const pcap = read('capture.pcapng', null);
  const packets = pcap ? parsePcapng(pcap) : [];
  const dnsLog = read('dns-log.txt', '').toString();
  const marks = JSON.parse(read('marks.json', '{}').toString());
  const log = read('check.log', '').toString();
  const edgeRaw = read('edge-result.json', null);
  const edge = edgeRaw ? JSON.parse(edgeRaw.toString()) : null;
  const r = judge({ fx, hits, packets, dnsLog, marks, log, edge });
  if (!pcap) r.lines = r.lines.map(l => (l.startsWith('PASS security.egress') ? l.replace(/^PASS/, 'FAIL') + '; no capture' : l));
  writeFileSync(join(out, 'egress.txt'), r.lines.join('\n') + '\n');
  writeFileSync(join(out, 'egress.md'), `### Egress, route by route\n\nCapture: ${packets.length} packets, names: ${[...new Set(packets.flatMap(p => p.names))].filter(n => n.endsWith(NAME_SUFFIX)).length} check names\n\n${r.md}\n`);
  for (const l of r.lines) console.log(l);
}
