/**
 * Host entry for dsh-acp-remote.
 *
 * Exposes the dsh ACP profile (`dsh --profile acp`, NDJSON JSON-RPC over stdio)
 * to remote clients over WebSocket. Each accepted connection spawns one child
 * `dsh --profile acp` process and bridges WS text frames <-> child stdio
 * line-by-line; either side closing kills the other. Multiple clients run
 * concurrently (one child process per connection, independent sessions).
 *
 * Settings (all volatile, adjustable in the dsh Settings UI):
 *  - enabled   : master switch; toggling off/on or editing port restarts the
 *                server (Cordis HMR unloads/re-applies the plugin effect).
 *  - port      : listen port (default 9420).
 *  - host      : bind address (default 0.0.0.0; restrict on untrusted nets).
 *  - token     : shared secret; clients pass `?token=` on the WS URL. Empty
 *                disables auth (trusted LAN only). Wrong token -> close 4001.
 *  - command / args : child process command line (default dsh --profile acp).
 *
 * Stop  = Settings toggle `enabled` off (or unload the plugin)  -> server
 * closes and every bridged child process is killed. Restart = toggle on
 * again / change port / reload dsh.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

/** Plugin display name (diagnostics). */
export const name = 'dsh-acp-remote';

/** No host services required — self-contained bridge. */
export const inject = [];

/** stderr tail kept per child for the closing diagnostic frame. */
const STDERR_TAIL_LINES = 20;

/**
 * Resolve the Schemastery constructor tolerating different host embeddings
 * (global `Schema`, cordis export, or missing -> declarative config disabled
 * and defaults are used until values arrive through `config`).
 */
function schemaConstructor() {
  if (typeof Schema !== 'undefined') return Schema;
  return undefined;
}

/**
 * Plugin config schema. All fields volatile so they surface in the Settings
 * UI (dsh settings projects volatile fields; edits reload this plugin).
 */
export function buildConfig(Schema) {
  return Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('Master switch (off = stop the server)'),
    port: Schema.natural().default(9420).volatile().description('WebSocket listen port'),
    host: Schema.string().default('0.0.0.0').volatile().description('Bind address'),
    token: Schema.string().default('').volatile().description('Auth token (empty = no auth, trusted LAN only)'),
    command: Schema.string().default('dsh').volatile().description('ACP child command'),
    args: Schema.array(Schema.string()).default(['--profile', 'acp']).volatile().description('ACP child args'),
  });
}

const maybeSchema = schemaConstructor();
/** Config schema (host provides Schemastery; otherwise undefined and defaults apply). */
export const Config = maybeSchema ? buildConfig(maybeSchema) : undefined;

/** Extract `token` query param from a WS request URL. */
function tokenOf(request) {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    return url.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/** Spawn one ACP child and wire it to the socket. Returns a disposer. */
function bridgeConnection(socket, config, log) {
  const child = spawn(config.command ?? 'dsh', config.args ?? ['--profile', 'acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrTail = [];
  let closed = false;

  const killChild = () => {
    if (closed) return;
    closed = true;
    try { child.stdin?.end(); } catch { /* pipe gone */ }
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000).unref();
  };

  const closeSocket = (code, reason) => {
    if (socket.readyState === socket.OPEN) {
      socket.close(code, reason);
    }
    killChild();
  };

  // client -> agent: each WS text frame may carry one or more NDJSON lines
  socket.on('message', (data) => {
    const text = data.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      if (!child.stdin?.write(line + '\n')) {
        log.warn(`[dsh-acp-remote] child stdin backpressure, dropping frame tail`);
        break;
      }
    }
  });

  // agent -> client: stdout lines become WS text frames
  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim().length > 0 && socket.readyState === socket.OPEN) {
        socket.send(line + '\n');
      }
      index = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  child.on('exit', (code) => {
    const tail = stderrTail.join(' | ');
    const reason = `acp child exited (code ${code}${tail ? `: ${tail.slice(0, 300)}` : ''})`;
    log.info(`[dsh-acp-remote] ${reason}`);
    if (socket.readyState === socket.OPEN) {
      socket.close(1011, reason.slice(0, 120));
    }
    closed = true;
  });

  socket.on('close', killChild);
  socket.on('error', killChild);

  return killChild;
}

/**
 * Plugin entry: start the WS gateway inside a reversible effect; unloading
 * (Settings toggle / config edit / dsh reload) stops the server and kills
 * every live bridged child process.
 *
 * @param {object} ctx     cordis context
 * @param {object} config  resolved plugin config
 */
export function apply(ctx, config) {
  const log = ctx.logger ?? console;
  if (config.enabled === false) {
    log.info('[dsh-acp-remote] disabled by config, not starting');
    return;
  }
  const port = Number(config.port ?? 9420);
  const host = config.host ?? '0.0.0.0';
  const expectedToken = config.token ?? '';
  const children = new Set();
  const wss = new WebSocketServer({ host, port });

  wss.on('connection', (socket, request) => {
    if (expectedToken && tokenOf(request) !== expectedToken) {
      socket.close(4001, 'invalid token');
      log.warn('[dsh-acp-remote] rejected connection: invalid token');
      return;
    }
    log.info(`[dsh-acp-remote] connection accepted, spawning ${config.command ?? 'dsh'}`);
    const killChild = bridgeConnection(socket, config, log);
    children.add(killChild);
    socket.on('close', () => children.delete(killChild));
  });

  wss.on('error', (error) => {
    log.error(`[dsh-acp-remote] server error: ${error.message}`);
  });

  ctx.effect(() => {
    log.info(`[dsh-acp-remote] listening on ws://${host}:${port} (auth ${expectedToken ? 'token' : 'disabled'})`);
    return () => {
      for (const killChild of children) {
        try { killChild(); } catch { /* already dead */ }
      }
      children.clear();
      wss.close(() => { /* sockets closed above */ });
    };
  }, 'dsh-acp-remote: ws gateway');
}
