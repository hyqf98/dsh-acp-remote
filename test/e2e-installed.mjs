/**
 * E2E round 2: plugin installed INTO a real dsh profile via `dsh plugin add`.
 * Boots `dsh --profile acptest` (plugin starts the WS gateway on boot), then a
 * separate WS client talks ACP through it.
 *
 * Notes learned the hard way:
 *  - The acp app serves stdio; stdin EOF tears the whole profile down, so the
 *    child's stdin is held open for the lifetime of the test.
 *  - Cordis in the acp profile silences plugin logger output (stdout must stay
 *    protocol-clean per the official dsh-acp README), so boot readiness is
 *    detected by polling the gateway TCP port, not by waiting for a log line.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect as tcpConnect } from 'node:net';

const require = createRequire(import.meta.url ? process.cwd() + '/package.json' : undefined);
const { default: WebSocket } = await import('ws');

const DSH_BIN = process.env.DSH_BIN;
const DSH_HOME = process.env.DSH_HOME;
const PORT = 9440;
if (!DSH_BIN || !DSH_HOME) { console.error('DSH_BIN and DSH_HOME required'); process.exit(1); }

// overlay: route the gateway's child at THIS dsh binary (the profile runs
// under the test's PATH shims; the gateway child would otherwise fail ENOENT)
const overlay = '/tmp/acptest-overlay.yml';
writeFileSync(overlay, `- id: acp-remote
  config:
    port: ${PORT}
    host: 127.0.0.1
    token: e2e-token
    command: ${DSH_BIN}
`);

const dshProc = spawn(DSH_BIN, ['--profile', 'acptest', '--patch', overlay], {
  env: { ...process.env, DSH_HOME },
  stdio: ['pipe', 'pipe', 'pipe'], // keep stdin open: acp exits on EOF
});
dshProc.stdout.resume();
dshProc.stderr.resume();

// poll the gateway port until the plugin's WS server accepts TCP
const portOpen = () => new Promise((resolve) => {
  const sock = tcpConnect(PORT, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});
let up = false;
const deadline = Date.now() + 60_000;
while (!up && Date.now() < deadline) {
  up = await portOpen();
  if (!up) await new Promise((r) => setTimeout(r, 400));
}
if (!up) {
  console.log('FAIL gateway port never opened');
  dshProc.kill('SIGKILL');
  process.exit(1);
}
console.log('PASS plugin booted inside dsh profile, gateway port open');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const socket = new WebSocket(`ws://127.0.0.1:${PORT}?token=e2e-token`);
await new Promise((r, j) => { socket.on('open', r); socket.on('error', j); });
const send = (obj) => socket.send(JSON.stringify(obj) + '\n');
const waitId = (id, timeoutMs = 90_000) => new Promise((resolve) => {
  let buf = '';
  const onData = (data) => {
    buf += data.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) { cleanup(); resolve(msg); }
      } catch { /* keep buffering */ }
    }
  };
  const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
  const cleanup = () => { clearTimeout(timer); socket.off('message', onData); };
  socket.on('message', onData);
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
const init = await waitId(1);
check('initialize through installed plugin', init?.result?.agentInfo?.name === 'deepseek-harness-acp', JSON.stringify(init?.result?.agentInfo ?? init?.error ?? null));

send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });
const session = await waitId(2);
check('session/new returns sessionId', typeof session?.result?.sessionId === 'string', JSON.stringify(session?.result ?? session?.error ?? null).slice(0, 140));

send({ jsonrpc: '2.0', id: 3, method: 'session/list', params: {} });
const list = await waitId(3);
check('session/list returns sessions array', Array.isArray(list?.result?.sessions), JSON.stringify(list?.result ?? list?.error ?? null).slice(0, 100));

send({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: session?.result?.sessionId } });
const closed = await waitId(4);
check('session/close settles', closed !== null);

socket.close();
await new Promise((r) => setTimeout(r, 2000));

// verify the bridged `dsh --profile acp` child was reclaimed after disconnect
const pg = spawn('pgrep', ['-lf', 'profile acp']);
let pgOut = '';
pg.stdout.on('data', (d) => { pgOut += d.toString(); });
await new Promise((r) => pg.on('close', r));
const leaked = pgOut.split('\n').filter((l) => l.includes('--profile acp') && !l.includes('acptest'));
check('no orphan dsh --profile acp children after disconnect', leaked.length === 0, leaked.slice(0, 2).join(' | '));

dshProc.stdin.end(); // graceful: let the acp app exit on EOF
await new Promise((r) => setTimeout(r, 800));
try { dshProc.kill('SIGKILL'); } catch { /* gone */ }
console.log(failures === 0 ? 'INSTALL-E2E ALL PASS' : `INSTALL-E2E ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
