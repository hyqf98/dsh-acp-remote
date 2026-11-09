/**
 * Host entry for dsh-acp-remote.
 *
 * Exposes the dsh ACP profile (`dsh --profile acp`, NDJSON JSON-RPC over stdio)
 * to remote clients over WebSocket. Each accepted connection spawns one child
 * `dsh --profile acp` process and bridges WS text frames <-> child stdio
 * line-by-line; either side closing kills the other. Multiple clients run
 * concurrently (one child process per connection, independent sessions).
 *
 * This is a byte-level transport bridge: it never parses ACP JSON-RPC, so every
 * ACP v1 method dsh implements (including reverse requests like
 * `session/request_permission`) passes through untouched. It qualifies as a
 * documented "custom transport" under the ACP spec (JSON-RPC framing and
 * lifecycle preserved; see README for the framing contract).
 *
 * Settings (all volatile, adjustable in the dsh Settings UI):
 *  - enabled        : master switch; toggling off/on or editing port restarts
 *                     the server (Cordis HMR unloads/re-applies the plugin).
 *  - port           : listen port (default 9420).
 *  - host           : bind address (default 0.0.0.0; restrict on untrusted nets).
 *  - token          : shared secret; clients pass `?token=` on the WS URL or
 *                     (preferred) an `Authorization: Bearer <token>` header.
 *                     Empty disables auth (trusted LAN only). Wrong token ->
 *                     close 4001. Compared in constant time.
 *  - command / args : child process command line (default dsh --profile acp).
 *                     The command must resolve in the HOST process PATH —
 *                     inside the DSH Desktop that usually excludes the user
 *                     shell PATH, so an absolute path is often required.
 *  - maxConnections : concurrent client limit (0 = unlimited); over-limit
 *                     connections are closed with 1013 and never spawn.
 *  - heartbeatMs    : liveness ping interval (0 = disabled). A socket that
 *                     misses two consecutive pongs is terminated, which
 *                     reclaims its child (protects against half-open
 *                     connections leaking `dsh` children).
 *
 * Stop = Settings toggle `enabled` off (or unload the plugin) -> server closes
 * and every bridged child process is killed. Restart = toggle on again / change
 * port / reload dsh.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

/** Plugin display name (diagnostics). */
export const name = 'dsh-acp-remote';

/** No host services required — self-contained bridge. */
export const inject = [];

/** stderr tail kept per child for the closing diagnostic frame. */
const STDERR_TAIL_LINES = 20;

/** Default heartbeat ping interval in ms; two missed pongs terminate. */
const DEFAULT_HEARTBEAT_MS = 30_000;

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
    command: Schema.string().default('dsh').volatile().description('ACP child command (absolute path unless on host PATH)'),
    args: Schema.array(Schema.string()).default(['--profile', 'acp']).volatile().description('ACP child args'),
    maxConnections: Schema.natural().default(0).volatile().description('Max concurrent connections (0 = unlimited)'),
    heartbeatMs: Schema.natural().default(DEFAULT_HEARTBEAT_MS).volatile().description('Heartbeat ping interval ms (0 = disable)'),
  });
}

const maybeSchema = schemaConstructor();
/** Config schema (host provides Schemastery; otherwise undefined and defaults apply). */
export const Config = maybeSchema ? buildConfig(maybeSchema) : undefined;

/** Constant-time secret comparison; differing lengths reject immediately. */
function tokenMatches(expected, actual) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(actual));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extract the auth token from a WS upgrade request:
 * `Authorization: Bearer <token>` header first, then `?token=` query param.
 */
function tokenOf(request) {
  try {
    const header = request.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
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
  let disposed = false;

  // liveness: ping periodically; two consecutive silent intervals terminate
  // the socket, which reclaims the child via the close->dispose path
  let missedPongs = 0;
  socket.on('pong', () => { missedPongs = 0; });
  const heartbeatMs = Number(config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        missedPongs += 1;
        if (missedPongs > 2) {
          log.warn('[dsh-acp-remote] heartbeat timeout, terminating connection');
          socket.terminate();
          return;
        }
        try { socket.ping(); } catch { /* socket gone */ }
      }, heartbeatMs)
    : null;
  heartbeat?.unref?.();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (heartbeat) clearInterval(heartbeat);
    try { child.stdin?.end(); } catch { /* pipe gone */ }
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000).unref();
  };

  const closeSocket = (code, reason) => {
    if (socket.readyState === socket.OPEN) {
      socket.close(code, reason);
    }
    dispose();
  };

  // spawn failures (ENOENT: command not on the host PATH) surface here;
  // without this listener they crash the host as an uncaught exception
  child.on('error', (error) => {
    log.error(`[dsh-acp-remote] child error: ${error.message}`);
    closeSocket(1011, `acp child failed: ${String(error.message).slice(0, 100)}`);
  });

  // writes racing child exit raise EPIPE here; same crash protection
  child.stdin?.on('error', (error) => {
    log.warn(`[dsh-acp-remote] child stdin error: ${error.message}`);
    closeSocket(1011, `acp child stdin failed: ${String(error.message).slice(0, 100)}`);
  });

  // client -> agent: buffer partial lines so any WS frame boundary is safe;
  // on backpressure pause the socket and flush from the buffer once the
  // child drains (never drop: a false write() return is buffering, not failure)
  let stdinBuffer = '';
  let stdinPaused = false;
  const writeStdin = () => {
    let index = stdinBuffer.indexOf('\n');
    while (index >= 0) {
      const line = stdinBuffer.slice(0, index);
      stdinBuffer = stdinBuffer.slice(index + 1);
      if (line.trim().length > 0 && !child.stdin?.write(line + '\n')) {
        if (!stdinPaused) { stdinPaused = true; socket.pause(); }
        child.stdin?.once('drain', () => {
          stdinPaused = false;
          socket.resume();
          writeStdin();
        });
        return;
      }
      index = stdinBuffer.indexOf('\n');
    }
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      log.warn('[dsh-acp-remote] ignoring binary frame (ACP bridge carries NDJSON text only)');
      return;
    }
    stdinBuffer += data.toString('utf8');
    writeStdin();
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
    dispose();
  });

  socket.on('close', dispose);
  socket.on('error', dispose);

  return dispose;
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
  const maxConnections = Number(config.maxConnections ?? 0);
  const children = new Set();
  const wss = new WebSocketServer({ host, port });

  wss.on('connection', (socket, request) => {
    if (expectedToken && !tokenMatches(expectedToken, tokenOf(request))) {
      socket.close(4001, 'invalid token');
      log.warn('[dsh-acp-remote] rejected connection: invalid token');
      return;
    }
    if (maxConnections > 0 && children.size >= maxConnections) {
      socket.close(1013, 'too many connections');
      log.warn(`[dsh-acp-remote] rejected connection: limit ${maxConnections} reached`);
      return;
    }
    log.info(`[dsh-acp-remote] connection accepted, spawning ${config.command ?? 'dsh'}`);
    const dispose = bridgeConnection(socket, config, log);
    children.add(dispose);
    socket.on('close', () => children.delete(dispose));
  });

  wss.on('error', (error) => {
    log.error(`[dsh-acp-remote] server error: ${error.message}`);
  });

  ctx.effect(() => {
    log.info(`[dsh-acp-remote] listening on ws://${host}:${port} (auth ${expectedToken ? 'token' : 'disabled'}${maxConnections > 0 ? `, max ${maxConnections} conns` : ''})`);
    return () => {
      for (const dispose of children) {
        try { dispose(); } catch { /* already dead */ }
      }
      children.clear();
      wss.close(() => { /* sockets closed above */ });
    };
  }, 'dsh-acp-remote: ws gateway');
}
