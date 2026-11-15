// The guarded fetch's fake server, run by driver.ps1 on the Windows runner: an HTTP server on
// 127.0.0.1 with every route the fetch and key checks need, the same routes over HTTPS with a
// self-signed certificate the system doesn't trust, and a logging HTTP proxy. Every request is
// written to net-log.jsonl: its path, and a SHA-256 of its authorization header, never the header.
//
//   node net-server.mjs <out dir> <check app dir> <pfx file> <pfx passphrase> [lan ip]
//
// Writes net.json (the ports) into both dirs, and runs until it's killed.
import { createServer } from 'node:http';
import { createServer as createTls } from 'node:https';
import { createServer as createTcp, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const [out, appDir, pfxFile, pfxWord, lanIp] = process.argv.slice(2);
/* The last key a request carried, so a later request without one can be answered with it. */
let lastKey = '';
const logFile = join(out, 'net-log.jsonl');
const sha = s => createHash('sha256').update(s).digest('hex');
const log = e => appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...e }) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let open = 0;

/* The key in the authorization header, without its scheme. */
const keyOf = req => (req.headers.authorization ?? '').replace(/^Bearer /, '');
const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));

async function handle(req, res) {
  const path = (req.url ?? '').split('?')[0];
  log({ path: path.slice(0, 300), method: req.method, auth: req.headers.authorization ? sha(req.headers.authorization) : null });
  const key = keyOf(req);
  if (key) lastKey = key;
  const route = path.replace(/^\/[^/]+/, '');
  open++;
  res.on('close', () => { open--; });
  switch (route) {
    case '/ok': return res.end('ok');
    // The address's key, though this request didn't carry it.
    case '/echo/remembered': return res.end(`remembered ${lastKey}`);
    // A redirect on a connection that then closes, so the next request connects, and resolves,
    // again.
    case '/redir-close': res.writeHead(302, { location: 'ok', connection: 'close' }); return res.end();
    case '/key-hash': return res.end(sha(req.headers.authorization ?? ''));
    case '/echo/header-value': res.setHeader('x-echo', `Bearer ${key}`); return res.end('header');
    case '/echo/header-name': res.setHeader(`x-k-${key.toLowerCase()}`, '1'); return res.end('name');
    case '/echo/status': res.writeHead(200, `OK ${key}`); return res.end('status');
    case '/echo/body200': return res.end(`before ${key} after`);
    case '/echo/body401': res.writeHead(401); return res.end(`denied ${key}`);
    case '/echo/big': {
      const pad = 'x'.repeat(100 * 1024);
      return res.end(`${key}${pad}${key}${pad}${key}${pad}${key}`);
    }
    case '/echo/split': {
      res.write(`a ${key.slice(0, 7)}`);
      await sleep(300);
      return res.end(`${key.slice(7)} b`);
    }
    case '/echo/redirect': {
      res.writeHead(302, { location: `${path.match(/^\/[^/]+/)[0]}/${key}` });
      return res.end();
    }
    case '/stream40': {
      res.writeHead(200, { 'content-type': 'text/plain' });
      for (let i = 0; i < 40 && !res.destroyed; i++) {
        res.write(`chunk-${String(i).padStart(2, '0')}\n`);
        await sleep(50);
      }
      return res.end();
    }
    case '/sse': {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hello\n\n');
      await sleep(40000);
      return res.end();
    }
    case '/slow-head': await sleep(5000); return res.end('late');
    case '/slow-body': res.writeHead(200); res.write('first'); await sleep(5000); return res.end('last');
    case '/big': return res.end(Buffer.alloc(2 * 1024 * 1024, 120));
    case '/gzip-bomb': res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(bomb);
    case '/redir-in': res.writeHead(302, { location: 'ok' }); return res.end();
    case '/redir-path': res.writeHead(302, { location: '/elsewhere/ok' }); return res.end();
    case '/redir-host': res.writeHead(302, { location: `http://localhost:${httpPort}${path.match(/^\/[^/]+/)[0]}/ok` }); return res.end();
    case '/redir-https': res.writeHead(302, { location: `https://127.0.0.1:${tlsPort}${path.match(/^\/[^/]+/)[0]}/ok` }); return res.end();
    default: res.writeHead(404); return res.end('no such route');
  }
}

const http = createServer((q, s) => { handle(q, s).catch(() => s.destroy()); });
const tls = createTls({ pfx: readFileSync(pfxFile), passphrase: pfxWord }, (q, s) => { handle(q, s).catch(() => s.destroy()); });
// A logging proxy: it notes each CONNECT's host and port, and tunnels it.
const proxy = createServer((req, res) => { log({ proxy: 'request', target: (req.url ?? '').slice(0, 200) }); res.writeHead(502); res.end(); });
proxy.on('connect', (req, socket, head) => {
  // A client that goes away mid-CONNECT (a cancelled request) resets the socket: never fatal.
  socket.on('error', () => {});
  log({ proxy: 'connect', target: (req.url ?? '').slice(0, 200) });
  const [host, port] = (req.url ?? '').split(':');
  // The check's own names point nowhere real: logged, never tunnelled.
  if (host.endsWith('.familiar-check.test')) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const up = connect(Number(port) || 443, host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(socket); socket.pipe(up); });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
});
// For the driver: how many requests are open right now.
const control = createTcp(c => { c.on('error', () => {}); c.end(JSON.stringify({ open })); });

const listen = (s, host = '127.0.0.1', port = 0) => new Promise(done => s.listen(port, host, () => done(s.address().port)));
// Every TCP connection to the servers, with where it came in, so a check can say nothing came.
for (const [name, server] of [['http', http], ['tls', tls]]) server.on('connection', c => log({ conn: name, local: `${c.localAddress}:${c.localPort}` }));
const httpPort = await listen(http);
const tlsPort = await listen(tls);
const proxyPort = await listen(proxy);
const controlPort = await listen(control);
writeFileSync(logFile, '');
// A lan fixture on the runner's own private address, and on the same port on 127.0.0.1 a
// listener nothing may reach: a name that moves from one to the other must not get through.
const lan = createServer((q, s) => { handle(q, s).catch(() => s.destroy()); });
lan.on('connection', c => log({ conn: 'lan', local: `${c.localAddress}:${c.localPort}` }));
const lanPort = lanIp ? await listen(lan, lanIp) : 0;
const forbidden = createTcp(c => { c.on('error', () => {}); log({ conn: 'forbidden', local: `${c.localAddress}:${c.localPort}` }); c.destroy(); });
if (lanPort) await listen(forbidden, '127.0.0.1', lanPort);
const config = { http: httpPort, tls: tlsPort, proxy: proxyPort, control: controlPort, lanIp: lanIp ?? '', lan: lanPort };
for (const d of [out, appDir]) writeFileSync(join(d, 'net.json'), JSON.stringify(config));
console.log(`net server up: ${JSON.stringify(config)}`);
