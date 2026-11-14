// Judges "no lookup before Allow" from three witnesses: the check's own DNS server (every query,
// timed), pktmon's capture (the queries it forwards, on the wire, with TCP reassembled) and the
// DNS Client log. A name core asked to add and the person refused, or that was never asked once
// asking had stopped, must appear in none. The name the person allowed must appear, and only after
// the moment the driver pressed Allow, which proves the witnesses could see it. Canary lookups the
// driver makes just before and just after must both be seen, or the witnesses didn't cover the
// whole window, and nothing is proved.
//
//   node net-analyze.mjs <out dir>
//
// Prints `PASS|FAIL security.fetch.no-lookup-before-allow ...` stamped with this run's id.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePcapng } from './analyze.mjs';

export function judgeLookups({ log, packets, dnsLog, server, run }) {
  const never = [...log.matchAll(/NETLOOKUP never ([a-z0-9]+)/g)].map(m => m[1]);
  const after = [...log.matchAll(/NETLOOKUP after ([a-z0-9]+) (\d+)/g)].map(m => ({ label: m[1], at: Number(m[2]) }));
  const canaries = [...log.matchAll(/NETLOOKUP canary ([a-z0-9]+)/g)].map(m => m[1]);
  const win = /NETLOOKUP window (\d+) (\d+)/.exec(log);
  const flow = log.includes('NETLOOKUP flow ok');
  const onWire = l => packets.filter(p => p.names.some(n => n.split('.')[0] === l)).map(p => p.at);
  const atServer = l => server.filter(q => q.name.split('.')[0] === l).map(q => q.at);
  const inClientLog = l => dnsLog.toLowerCase().includes(`${l}.familiar-check.test`);
  const problems = [];
  if (!flow) problems.push('the page never finished its asks');
  if (!win) problems.push('no window was recorded');
  if (never.length < 3) problems.push(`only ${never.length} refused or stopped names`);
  if (after.length < 1) problems.push('no allowed name');
  // Coverage: one canary before the window and one after, each seen by the server and on the wire.
  if (canaries.length < 2) problems.push('the canaries were not looked up');
  else if (win) {
    const [from, to] = [Number(win[1]), Number(win[2])];
    const [before, last] = [canaries[0], canaries[canaries.length - 1]];
    const wb = onWire(before), wa = onWire(last);
    if (!wb.length || !atServer(before).length) problems.push('the opening canary was not seen');
    if (!wa.length || !atServer(last).length) problems.push('the closing canary was not seen');
    if (wb.length && Math.min(...wb) > from) problems.push('the capture starts after the window');
    if (wa.length && Math.max(...wa) < to) problems.push('the capture ends before the window');
  }
  for (const l of never) {
    const seen = [onWire(l).length && 'wire', atServer(l).length && 'server', inClientLog(l) && 'client log'].filter(Boolean);
    if (seen.length) problems.push(`${l} looked up before any Allow (${seen.join(', ')})`);
  }
  for (const { label, at } of after) {
    const s = atServer(label), w = onWire(label);
    if (!s.length || !w.length) problems.push(`the allowed ${label} was not seen (server ${s.length}, wire ${w.length})`);
    const early = [...s, ...w].filter(t => t < at);
    if (early.length) problems.push(`the allowed ${label} was looked up ${at - Math.min(...early)} ms before Allow`);
  }
  const ok = problems.length === 0;
  const detail = ok
    ? `${never.length} refused or stopped names seen by none of the server, the wire and the DNS Client log; the allowed name first queried ${Math.min(...atServer(after[0].label)) - after[0].at} ms after Allow; canaries before and after seen`
    : problems.join('; ');
  return `${ok ? 'PASS' : 'FAIL'} security.fetch.no-lookup-before-allow ${detail} run=${run}`;
}

if (/(^|[\\/])net-analyze\.mjs$/.test(process.argv[1] ?? '')) {
  const out = process.argv[2];
  const read = (f, d) => (existsSync(join(out, f)) ? readFileSync(join(out, f)) : d);
  const pcap = read('capture.pcapng', null);
  const run = JSON.parse(read('fixtures.json', '{}').toString()).run ?? '';
  const server = read('dns-log.jsonl', '').toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const line = judgeLookups({ log: read('check.log', '').toString(), packets: pcap ? parsePcapng(pcap) : [], dnsLog: read('dns-log.txt', '').toString(), server, run });
  console.log(pcap ? line : line.replace(/^PASS/, 'FAIL') + '; no capture');
}
