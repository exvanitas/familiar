// Judges "no lookup before Allow" from the wire: the names core asked to add and the person
// refused (or that were never asked, once asking had stopped) must not appear in pktmon's capture
// or the DNS Client log; the name the person allowed must, which proves the capture could see it.
//
//   node net-analyze.mjs <out dir>
//
// Prints `PASS|FAIL security.fetch.no-lookup-before-allow ...` stamped with this run's id.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePcapng } from './analyze.mjs';

export function judgeLookups({ log, packets, dnsLog, run }) {
  const never = [...log.matchAll(/NETLOOKUP never ([a-z0-9]+)/g)].map(m => m[1]);
  const after = [...log.matchAll(/NETLOOKUP after ([a-z0-9]+)/g)].map(m => m[1]);
  const flow = log.includes('NETLOOKUP flow ok');
  const seen = l => packets.some(p => p.names.some(n => n.includes(l))) || dnsLog.toLowerCase().includes(l);
  const leaked = never.filter(seen);
  const missed = after.filter(l => !seen(l));
  const ok = flow && never.length >= 3 && after.length >= 1 && leaked.length === 0 && missed.length === 0;
  const why = [
    flow ? 'the asks went as planned' : 'the page never finished its asks',
    `${never.length} refused or stopped names, ${leaked.length} looked up${leaked.length ? ': ' + leaked.join(' ') : ''}`,
    `${after.length} allowed name, ${after.length - missed.length} seen on the wire or in the log`
  ];
  return `${ok ? 'PASS' : 'FAIL'} security.fetch.no-lookup-before-allow ${why.join('; ')} run=${run}`;
}

if (process.argv[1]?.endsWith('net-analyze.mjs')) {
  const out = process.argv[2];
  const read = (f, d) => (existsSync(join(out, f)) ? readFileSync(join(out, f)) : d);
  const pcap = read('capture.pcapng', null);
  const run = JSON.parse(read('fixtures.json', '{}').toString()).run ?? '';
  const line = judgeLookups({ log: read('check.log', '').toString(), packets: pcap ? parsePcapng(pcap) : [], dnsLog: read('dns-log.txt', '').toString(), run });
  console.log(pcap ? line : line.replace(/^PASS/, 'FAIL') + '; no capture');
}
