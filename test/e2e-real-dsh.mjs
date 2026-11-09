/**
 * E2E: bridge plugin over WebSocket <-> real `dsh --profile acp` child.
 * Expects DSH_BIN to point at a working dsh CLI. Verifies initialize passes
 * through the bridge and returns the official agentInfo.
 */
import { WebSocket } from 'ws';

const DSH_BIN = process.env.DSH_BIN;
const PORT = 9430;
if (!DSH_BIN) {
  console.error('set DSH_BIN to a dsh CLI path');
  process.exit(1);
}

const { apply } = await import('../src/host/index.js');
const ctx = {
  logger: console,
  disposers: [],
  effect(fn) { this.disposers.push(fn()); },
};
await apply(ctx, {
  enabled: true, port: PORT, host: '127.0.0.1', token: '',
  command: DSH_BIN, args: ['--profile', 'acp'], maxConnections: 0, heartbeatMs: 0,
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r, j) => { socket.on('open', r); socket.on('error', j); });

const send = (obj) => socket.send(JSON.stringify(obj) + '\n');
const waitId = (id, timeoutMs = 60_000) => new Promise((resolve) => {
  const lines = [];
  const onData = (data) => {
    lines.push(data.toString('utf8'));
    for (const line of lines.join('').split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) { cleanup(); resolve(msg); }
      } catch { /* partial line, keep buffering */ }
    }
  };
  const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
  const cleanup = () => { clearTimeout(timer); socket.off('message', onData); };
  socket.on('message', onData);
});

// 1. initialize through the bridge
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
const init = await waitId(1);
check('initialize via WS returns deepseek-harness-acp agentInfo',
  init?.result?.agentInfo?.name === 'deepseek-harness-acp',
  JSON.stringify(init?.result?.agentInfo ?? null));
check('session capabilities advertised (list/resume/close)',
  Boolean(init?.result?.agentCapabilities?.sessionCapabilities?.list
    && init?.result?.agentCapabilities?.sessionCapabilities?.resume
    && init?.result?.agentCapabilities?.sessionCapabilities?.close));

// 2. session/new through the bridge
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });
const session = await waitId(2);
check('session/new returns a sessionId', typeof session?.result?.sessionId === 'string', JSON.stringify(session?.result ?? null).slice(0, 120));

// 3. session/close (quiescent teardown through the bridge)
if (session?.result?.sessionId) {
  send({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: session.result.sessionId } });
  const closed = await waitId(3);
  check('session/close settles', closed !== null, JSON.stringify(closed?.result ?? closed?.error ?? null).slice(0, 120));
}

// 4. dispose plugin -> child reclaimed
socket.close();
await new Promise((r) => setTimeout(r, 500));
for (const dispose of ctx.disposers) await dispose();
console.log(failures === 0 ? 'E2E ALL PASS' : `E2E ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
