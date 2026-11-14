// A DNS server of the check's own, run by driver.ps1 and set as the runner's resolver for the run.
// Names in the plan (dns-plan.json in the out folder, reread on every query) get the answers the
// plan gives for their nth A query, after its delay; every other query is forwarded to the
// resolver the runner had, unchanged, so it still shows on the wire. Every query is written to
// dns-log.jsonl with its time, name, type and what was answered.
//
//   node dns-server.mjs <out dir> <upstream resolver ip>
import { createSocket } from 'node:dgram';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* The question: its name, type, and where it ends in the message. */
export function question(msg) {
  let o = 12;
  const labels = [];
  while (o < msg.length && msg[o] !== 0) {
    labels.push(msg.subarray(o + 1, o + 1 + msg[o]).toString('latin1'));
    o += 1 + msg[o];
  }
  o++;
  return { name: labels.join('.').toLowerCase(), type: msg.readUInt16BE(o), end: o + 4 };
}

/* An answer to `msg` holding `ips` of the asked type, with a TTL of 0 so nothing caches it. */
export function answer(msg, ips) {
  const q = question(msg);
  const want = q.type === 28 ? 6 : 4;
  // Only A and AAAA questions get addresses; any other type is answered with none.
  const fit = q.type === 1 || q.type === 28 ? ips.filter(ip => (want === 4 ? !ip.includes(':') : ip.includes(':'))) : [];
  const head = Buffer.from(msg.subarray(0, q.end));
  head.writeUInt16BE(0x8180, 2); // a response, recursion available, no error
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(fit.length, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);
  const records = fit.map(ip => {
    const data = want === 4 ? Buffer.from(ip.split('.').map(Number)) : v6(ip);
    const r = Buffer.alloc(12);
    r.writeUInt16BE(0xc00c, 0);
    r.writeUInt16BE(want === 4 ? 1 : 28, 2);
    r.writeUInt16BE(1, 4);
    r.writeUInt32BE(0, 6);
    r.writeUInt16BE(data.length, 10);
    return Buffer.concat([r, data]);
  });
  return Buffer.concat([head, ...records]);
}

function v6(ip) {
  const [a, b = ''] = ip.split('::');
  const left = a ? a.split(':') : [], right = b ? b.split(':') : [];
  const parts = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const buf = Buffer.alloc(16);
  parts.forEach((p, i) => buf.writeUInt16BE(parseInt(p, 16), i * 2));
  return buf;
}

if (/(^|[\\/])dns-server\.mjs$/.test(process.argv[1] ?? '')) {
  const [out, upstream] = process.argv.slice(2);
  const logFile = join(out, 'dns-log.jsonl');
  const planFile = join(out, 'dns-plan.json');
  const log = e => appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...e }) + '\n');
  const asked = new Map();
  const sock = createSocket('udp4');
  const pending = new Map();
  const up = createSocket('udp4');
  up.on('message', reply => {
    const id = reply.readUInt16BE(0);
    const back = pending.get(id);
    if (back) { pending.delete(id); sock.send(reply, back.port, back.address); }
  });
  sock.on('message', (msg, rinfo) => {
    let q;
    try { q = question(msg); } catch { return; }
    const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
    const p = plan[q.name];
    if (!p) {
      log({ name: q.name, type: q.type, answered: 'forward' });
      pending.set(msg.readUInt16BE(0), rinfo);
      up.send(msg, 53, upstream);
      return;
    }
    // The plan counts A queries; an AAAA query gets what the current step holds of its type.
    const n = asked.get(q.name) ?? 0;
    if (q.type === 1) asked.set(q.name, n + 1);
    const at = q.type === 1 ? n : Math.max(n - 1, 0);
    const step = p.answers[Math.min(at, p.answers.length - 1)];
    log({ name: q.name, type: q.type, answered: step, n: q.type === 1 ? n + 1 : null });
    const delay = p.delay?.length ? p.delay[Math.min(at, p.delay.length - 1)] : 0;
    setTimeout(() => sock.send(answer(msg, step), rinfo.port, rinfo.address), delay);
  });
  sock.bind(53, '127.0.0.1', () => {
    writeFileSync(logFile, '');
    console.log(`dns server up, forwarding to ${upstream}`);
  });
}
