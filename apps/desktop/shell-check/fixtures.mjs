// The egress check's listeners, run by driver.ps1 on the Windows runner. One HTTP server on
// 127.0.0.1 (it also takes WebSocket upgrades), and for each page context a UDP STUN responder, a
// UDP TURN port and a raw TCP TURN port. Every request, packet and connection is written to
// hits.jsonl as it arrives: which listener, and the route label from the path when there is one.
// Never a body.
//
//   node fixtures.mjs <out dir> <check app dir> [<more dirs for fixtures.json>...]
//
// It writes fixtures.json (the run id and ports) into each dir given, serves the Edge control page
// from the check app dir, and runs until it's killed.
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { createSocket } from 'node:dgram';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const [out, appDir, ...more] = process.argv.slice(2);
if (!out || !appDir) throw new Error('usage: node fixtures.mjs <out dir> <check app dir> [<dirs>...]');
const hitsFile = join(out, 'hits.jsonl');
const CONTEXTS = ['core', 'view', 'bare', 'edge', 'driver', 'probe'];
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const run = Array.from(randomBytes(8), b => alphabet[b % 36]).join('');
// Never in use on the runner's network, so a packet to it can only be seen on the wire.
const LAN = '192.168.250.250';

const hit = h => appendFileSync(hitsFile, JSON.stringify({ at: Date.now(), ...h }) + '\n');
const labelOf = path => /^\/h\/([a-z0-9]+)\//.exec(path ?? '')?.[1] ?? null;

const SERVED = { '/edge.html': 'text/html', '/edge.js': 'text/javascript' };
const http = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/fixtures.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(config));
  }
  if (SERVED[path]) {
    res.writeHead(200, { 'content-type': SERVED[path] });
    return res.end(readFileSync(join(appDir, path.slice(1))));
  }
  if (path === '/edge-result' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { writeFileSync(join(out, 'edge-result.json'), body); res.end('ok'); });
    return;
  }
  hit({ kind: 'http', method: req.method, path: path.slice(0, 200), label: labelOf(path) });
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('seen');
});
// Every TCP connection, whether or not a request follows: a preconnect sends none.
http.on('connection', () => hit({ kind: 'accept', listener: 'http' }));
http.on('upgrade', (req, socket) => {
  hit({ kind: 'upgrade', path: (req.url ?? '').slice(0, 200), label: labelOf(req.url) });
  socket.destroy();
});
http.on('connect', (req, socket) => {
  hit({ kind: 'connect', label: null });
  socket.destroy();
});

// STUN: answer a binding request with the sender's address, so a browser would count it as a
// working server.
function stunAnswer(msg, rinfo) {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return null;
  const res = Buffer.alloc(32);
  res.writeUInt16BE(0x0101, 0);
  res.writeUInt16BE(12, 2);
  msg.copy(res, 4, 4, 20);
  res.writeUInt16BE(0x0020, 20);
  res.writeUInt16BE(8, 22);
  res.writeUInt8(0, 24);
  res.writeUInt8(1, 25);
  res.writeUInt16BE(rinfo.port ^ 0x2112, 26);
  const ip = rinfo.address.split('.').map(Number);
  res.writeInt32BE(((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) ^ 0x2112a442, 28);
  return res;
}

function udp(name, port = 0) {
  return new Promise(done => {
    const s = createSocket('udp4');
    s.on('message', (msg, rinfo) => {
      const stun = msg.length >= 8 && msg.readUInt32BE(4) === 0x2112a442;
      hit({ kind: 'udp', listener: name, bytes: msg.length, stun });
      const a = stunAnswer(msg, rinfo);
      if (a) s.send(a, rinfo.port, rinfo.address);
    });
    s.bind(port, '127.0.0.1', () => done(s.address().port));
  });
}

function tcp(name) {
  return new Promise(done => {
    const s = createTcp(c => { hit({ kind: 'tcp', listener: name }); c.destroy(); });
    s.listen(0, '127.0.0.1', () => done(s.address().port));
  });
}

const config = { run, tcp: 0, lan: LAN, udp: {}, turnTcp: {} };
await new Promise(done => http.listen(0, '127.0.0.1', done));
config.tcp = http.address().port;
for (const ctx of CONTEXTS) {
  config.udp[`${ctx}-stun`] = await udp(`${ctx}-stun`);
  config.udp[`${ctx}-turn`] = await udp(`${ctx}-turn`);
  config.turnTcp[ctx] = await tcp(`${ctx}-turn-tcp`);
}
// UDP on every TCP port too, so QUIC (WebTransport, HTTP/3) to a TCP listener is seen.
await udp('http-udp', config.tcp);
for (const ctx of CONTEXTS) await udp(`${ctx}-turn-tcp-udp`, config.turnTcp[ctx]);
writeFileSync(hitsFile, '');
for (const dir of [out, appDir, ...more]) writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(config));
console.log(`fixtures up: run ${run}, http ${config.tcp}`);
