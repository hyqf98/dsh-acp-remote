/**
 * Smoke test for dsh-acp-remote src/host/index.js (no dsh needed).
 * Uses /bin/cat as the child: whatever the client sends must come back
 * byte-for-byte, exercising the stdin/stdout line-buffering paths.
 *
 * Run: node test/smoke.mjs
 * Exits 0 when all cases pass.
 */
import { WebSocket } from 'ws';

const PLUGIN_URL = 'ws://127.0.0.1:9421';
const PLUGIN_URL_TOKEN = 'ws://127.0.0.1:9422';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Minimal fake cordis context: runs effect bodies, collects their disposers. */
function fakeCtx() {
  return {
    logger: console,
    disposers: [],
    effect(fn) { this.disposers.push(fn()); },
  };
}

/** Promise resolving {socket, messages} after the server accepts a client. */
function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const messages = [];
    socket.on('open', () => resolve({ socket, messages }));
    socket.on('error', reject);
    socket.on('message', (data) => messages.push(data.toString('utf8')));
  });
}

function nextClose(socket) {
  return new Promise((resolve) => {
    socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.on('error', () => { /* treated as close */ });
  });
}

const plugin = await import('../src/host/index.js');
const { apply } = plugin;

// --- server A: no auth, /bin/cat child --------------------------------------
const ctxA = fakeCtx();
await apply(ctxA, {
  enabled: true, port: 9421, host: '127.0.0.1', token: '',
  command: '/bin/cat', args: [], maxConnections: 0, heartbeatMs: 0,
});

// --- server B: token auth + /bin/cat child (Bearer echo test) ---------------
const ctxB = fakeCtx();
await apply(ctxB, {
  enabled: true, port: 9422, host: '127.0.0.1', token: 'secret-token',
  command: '/bin/cat', args: [], maxConnections: 0, heartbeatMs: 0,
});

// --- server C: token auth + ENOENT child -------------------------------------
const ctxC = fakeCtx();
await apply(ctxC, {
  enabled: true, port: 9423, host: '127.0.0.1', token: 'secret-token',
  command: '/nonexistent/dsh-acp-remote-enoent', args: [], maxConnections: 0, heartbeatMs: 0,
});

// 1. basic echo + line reassembly across split frames
{
  const { socket, messages } = await connect(PLUGIN_URL);
  const line1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  // send one logical line split across three frames
  socket.send(line1.slice(0, 10));
  socket.send(line1.slice(10, 25));
  socket.send(line1.slice(25) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  check('split-frame line reassembled and echoed', messages.join('') === line1 + '\n', `got ${JSON.stringify(messages.join(''))}`);
  socket.close();
}

// 2. large line (8 MiB) survives backpressure without data loss
{
  const { socket, messages } = await connect(PLUGIN_URL);
  const payload = 'x'.repeat(8 * 1024 * 1024);
  const bigLine = `{"pad":"${payload}"}`;
  socket.send(bigLine + '\n');
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (messages.join('').length >= bigLine.length + 1) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(); }, 15_000).unref();
  });
  const echoed = messages.join('');
  check('8MiB line echoed byte-for-byte', echoed === bigLine + '\n', `sent ${bigLine.length + 1}B, got ${echoed.length}B`);
  socket.close();
}

// 3. child spawn failure -> 1011 close, no uncaught exception
{
  const { socket } = await connect('ws://127.0.0.1:9423?token=secret-token');
  const closed = await nextClose(socket);
  check('ENOENT child closes with 1011', closed.code === 1011, `code=${closed.code} reason=${closed.reason}`);
}
// 4. wrong token -> 4001
{
  const socket = new WebSocket(`${PLUGIN_URL_TOKEN}?token=wrong`);
  const closed = await nextClose(socket);
  check('wrong token rejected with 4001', closed.code === 4001, `code=${closed.code}`);
}

// 5. bearer header accepted
{
  const { socket, messages } = await connect(PLUGIN_URL_TOKEN, { authorization: 'Bearer secret-token' });
  socket.send('ping\n');
  await new Promise((r) => setTimeout(r, 300));
  check('bearer auth accepted and echo works', messages.join('') === 'ping\n');
  socket.close();
}

// 6. binary frame ignored
{
  const { socket, messages } = await connect(PLUGIN_URL);
  socket.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
  socket.send('after-binary\n');
  await new Promise((r) => setTimeout(r, 300));
  check('binary frame ignored, subsequent text works', messages.join('') === 'after-binary\n');
  socket.close();
}

// 7. plugin dispose kills server and children
{
  for (const dispose of ctxA.disposers) await dispose();
  await new Promise((r) => setTimeout(r, 300));
  let refused = false;
  try { await connect(PLUGIN_URL); } catch { refused = true; }
  check('dispose closes the listener', refused);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
