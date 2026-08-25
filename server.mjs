#!/usr/bin/env node
// herdr-web: local web UI bridging HTTP to the herdr Unix-socket JSON API.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const FALLBACK_SOCKET = `${process.env.HOME}/.config/herdr/herdr.sock`;
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(process.env.HOME, '.local', 'state'),
  'herdr-web',
);
const ACTIVITY_FILE = path.join(STATE_DIR, 'activity.json');

// ---- CLI args ----
const args = process.argv.slice(2);
function argValue(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const PORT = Number(argValue('--port', 4270));
const HOST = argValue('--host', '127.0.0.1');
const TOKEN = argValue('--token', null);

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !TOKEN) {
  console.error(`Refusing to bind to ${HOST} without --token. Pass --token <secret> for LAN mode.`);
  process.exit(1);
}

// ---- Socket discovery ----
let socketPath = FALLBACK_SOCKET;

function discoverSocket() {
  return new Promise((resolve) => {
    execFile('herdr', ['session', 'list', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (!err) {
        try {
          const sessions = JSON.parse(stdout).sessions || [];
          const def = sessions.find((s) => s.default) || sessions[0];
          if (def?.socket_path) {
            socketPath = def.socket_path;
            return resolve(socketPath);
          }
        } catch { /* fall through */ }
      }
      resolve(socketPath);
    });
  });
}

// ---- herdr RPC: one request per connection ----
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`herdr rpc timeout: ${method}`));
    }, 10000);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: randomUUID(), method, params }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (msg.error) {
          const e = new Error(msg.error.message);
          e.code = msg.error.code;
          reject(e);
        } else {
          resolve(msg.result);
        }
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---- SSE fan-out + upstream event subscription ----
const sseClients = new Set();

function broadcast(name, data) {
  const line = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(line);
}

let eventsSock = null;
let backoff = 1000;

// Static subscription set: global pane.updated already carries agent_status,
// so no per-pane pane.agent_status_changed subs are needed. That matters —
// they were the only reason to resubscribe, and resubscribing replays a stale
// event window whose lifecycle events triggered another resubscribe, looping
// forever and flooding clients with outdated revisions.
const SUBSCRIPTIONS = [
  'workspace.updated', 'workspace.created', 'workspace.closed', 'workspace.renamed',
  'tab.renamed', 'tab.created', 'tab.closed',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.agent_detected',
].map((type) => ({ type }));

// Highwater revision per pane; a replayed window can never reach clients.
let paneHighwater = new Map();

function isStalePaneEvent(data) {
  const pane = data?.pane;
  if (!pane?.pane_id || typeof pane.revision !== 'number') return false;
  const seen = paneHighwater.get(pane.pane_id);
  if (seen !== undefined && pane.revision <= seen) return true;
  paneHighwater.set(pane.pane_id, pane.revision);
  return false;
}

function connectEvents() {
  const sock = net.connect(socketPath);
  eventsSock = sock;
  let buf = '';

  sock.on('connect', () => {
    // A fresh subscription streams current events; drop stale highwaters so a
    // restarted herdr (revisions back to 0) can't be filtered out forever.
    paneHighwater = new Map();
    sock.write(JSON.stringify({ id: '1', method: 'events.subscribe', params: { subscriptions: SUBSCRIPTIONS } }) + '\n');
  });

  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.result?.type === 'subscription_started') {
        backoff = 1000;
        broadcast('connected', { ok: true });
        continue;
      }
      if (msg.event) {
        // Wire event names use underscores (e.g. "pane_updated"), unlike the
        // dotted subscription types.
        if (isStalePaneEvent(msg.data)) continue;
        broadcast(msg.event, msg.data ?? {});
      }
    }
  });

  const retry = () => {
    if (eventsSock !== sock) return;
    eventsSock = null;
    setTimeout(connectEvents, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  sock.on('error', retry);
  sock.on('close', retry);
}

// ---- Activity tracking (recency ordering) ----
// herdr exposes no timestamps, so recency is derived here: a pane's revision
// counter advancing means it produced output. Revisions are per-pane counters
// and are never compared across panes — only against that pane's last value.
const ACTIVITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVITY_SAVE_MS = 30000;
const activity = new Map();       // terminal_id -> { t: last_activity_at|null, r: revision }
const paneToTerminal = new Map(); // pane_id -> terminal_id (panes move, terminals don't)
let activityDirty = false;
let activitySaveTimer = null;

function loadActivity() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
    for (const [id, e] of Object.entries(raw)) {
      if (e && typeof e === 'object') activity.set(id, { t: e.t ?? null, r: e.r ?? null });
    }
  } catch { /* missing or corrupt state is not an error */ }
}

// Written synchronously: the file is tiny, and the exit handler must not race
// an async write. Via a temp file so a crash mid-write can't truncate it.
function saveActivity() {
  if (activitySaveTimer) { clearTimeout(activitySaveTimer); activitySaveTimer = null; }
  if (!activityDirty) return;
  activityDirty = false;
  const out = {};
  for (const [id, e] of activity) out[id] = e;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${ACTIVITY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, ACTIVITY_FILE);
  } catch { /* state is best-effort */ }
}

function markActivityDirty() {
  activityDirty = true;
  if (!activitySaveTimer) activitySaveTimer = setTimeout(saveActivity, ACTIVITY_SAVE_MS);
}

// An explicit interaction counts as use, even without new output.
function touchActivity(terminalId) {
  if (!terminalId) return;
  const e = activity.get(terminalId) || { t: null, r: null };
  e.t = Date.now();
  activity.set(terminalId, e);
  markActivityDirty();
}

function touchActivityByPane(paneId) {
  touchActivity(paneToTerminal.get(paneId));
}

function recordActivity(agents) {
  const now = Date.now();
  for (const a of agents) {
    if (!a.terminal_id) continue;
    paneToTerminal.set(a.pane_id, a.terminal_id);
    const prev = activity.get(a.terminal_id);
    if (!prev) {
      // First sight: remember the revision, but claim no activity time yet.
      activity.set(a.terminal_id, { t: null, r: a.revision ?? null });
      markActivityDirty();
      continue;
    }
    if (typeof a.revision === 'number' && prev.r !== null && a.revision > prev.r) {
      prev.t = now;
      markActivityDirty();
    }
    if (typeof a.revision === 'number' && prev.r !== a.revision) {
      prev.r = a.revision;
      markActivityDirty();
    }
  }
  pruneActivity(new Set(agents.map((a) => a.terminal_id)));
}

function pruneActivity(liveIds) {
  const now = Date.now();
  for (const [id, e] of activity) {
    if (liveIds.has(id)) continue;
    // Gone and either long idle or never active: nothing left to remember.
    if (e.t === null || now - e.t > ACTIVITY_TTL_MS) {
      activity.delete(id);
      markActivityDirty();
    }
  }
}

// Keep timestamps current even with nobody watching, so ordering is right
// the moment someone opens the page.
async function refreshActivity() {
  try {
    const { agents = [] } = await rpc('agent.list');
    recordActivity(agents);
  } catch { /* transient */ }
}

// ---- Authoritative overview snapshots ----
// Events are unreliable hints: they never fire for panes in unfocused
// workspaces, and status flips on replay. Reads are always current, so while
// a client is watching we poll and broadcast the snapshot when it changes.
const OVERVIEW_POLL_MS = 2500;
let overviewTimer = null;
let lastOverviewJSON = null;

async function buildOverview() {
  const [ws, ag] = await Promise.all([rpc('workspace.list'), rpc('agent.list')]);
  const agents = ag.agents || [];
  recordActivity(agents);
  const byWorkspace = new Map();
  for (const a of agents) {
    if (!byWorkspace.has(a.workspace_id)) byWorkspace.set(a.workspace_id, []);
    byWorkspace.get(a.workspace_id).push({ ...a, last_activity_at: activity.get(a.terminal_id)?.t ?? null });
  }
  return {
    workspaces: (ws.workspaces || []).map((w) => ({
      ...w,
      agents: byWorkspace.get(w.workspace_id) || [],
    })),
  };
}

async function pollOverview() {
  if (!sseClients.size) return;
  try {
    const snapshot = await buildOverview();
    const json = JSON.stringify(snapshot);
    if (json !== lastOverviewJSON) {
      lastOverviewJSON = json;
      broadcast('overview', snapshot);
    }
  } catch { /* transient; next tick retries */ }
}

function startOverviewPolling() {
  if (overviewTimer) return;
  overviewTimer = setInterval(pollOverview, OVERVIEW_POLL_MS);
  pollOverview();
}

function stopOverviewPolling() {
  clearInterval(overviewTimer);
  overviewTimer = null;
  lastOverviewJSON = null; // next client gets a snapshot immediately
}

// ---- Per-pane live streams ----
// events.subscribe never emits pane_updated for unfocused panes and
// pane.wait_for_output matches existing content, so a short read-compare
// loop is the only reliable liveness source. Local socket, capped streams.
const MAX_PANE_STREAMS = 4;
const STREAM_POLL_MS = 350;
let paneStreams = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleAgentStream(req, res, terminalId) {
  if (paneStreams >= MAX_PANE_STREAMS) {
    return sendJSON(res, 429, { error: `too many live streams (max ${MAX_PANE_STREAMS})` });
  }
  paneStreams++;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    paneStreams--;
  };
  req.on('close', cleanup);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  let lastText = null;
  let lastWrite = Date.now();
  while (!closed) {
    try {
      const result = await rpc('agent.read', { target: terminalId, source: 'recent', lines: 300, format: 'text' });
      const text = (result?.read ?? result)?.text ?? '';
      if (text !== lastText) {
        lastText = text;
        res.write(`event: output\ndata: ${JSON.stringify({ text })}\n\n`);
        lastWrite = Date.now();
      } else if (Date.now() - lastWrite > 25000) {
        res.write(': ping\n\n');
        lastWrite = Date.now();
      }
    } catch (e) {
      if (!closed) {
        res.write(`event: stream_error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      }
      break;
    }
    await sleep(STREAM_POLL_MS);
  }
  cleanup();
}

// ---- HTTP helpers ----
function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  if (header === `Bearer ${TOKEN}`) return true;
  return url.searchParams.get('token') === TOKEN;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- Routes ----
async function handleApi(req, res, url) {
  if (!authorized(req, url)) return sendJSON(res, 401, { error: 'unauthorized' });
  // decode segments: pane ids contain ':' which clients URL-encode
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJSON(res, 200, await rpc('ping'));
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return sendJSON(res, 200, await buildOverview());
    }

    if (req.method === 'GET' && parts[1] === 'agents' && parts[3] === 'stream') {
      return handleAgentStream(req, res, parts[2]);
    }

    if (req.method === 'GET' && parts[1] === 'agents' && parts[3] === 'output') {
      const lines = Number(url.searchParams.get('lines') || 300);
      const source = url.searchParams.get('source') || 'recent';
      const format = url.searchParams.get('format') || 'text';
      const result = await rpc('agent.read', { target: parts[2], source, lines, format });
      return sendJSON(res, 200, result?.read ?? result); // unwrap {type:"pane_read", read:{...}}
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts[3] === 'send') {
      const { text } = await readBody(req);
      if (typeof text !== 'string' || !text.length) return sendJSON(res, 400, { error: 'text required' });
      const result = await rpc('agent.send', { target: parts[2], text });
      touchActivity(parts[2]);
      return sendJSON(res, 200, result ?? { ok: true });
    }

    if (req.method === 'POST' && parts[1] === 'panes' && parts[3] === 'keys') {
      const { keys } = await readBody(req);
      const list = Array.isArray(keys) ? keys : [keys];
      if (!list.length || !list.every((k) => typeof k === 'string' && k.length)) {
        return sendJSON(res, 400, { error: 'keys must be a non-empty string array' });
      }
      const result = await rpc('pane.send_keys', { pane_id: parts[2], keys: list });
      touchActivityByPane(parts[2]);
      return sendJSON(res, 200, result ?? { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      startOverviewPolling();
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
        if (!sseClients.size) stopOverviewPolling();
      });
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 502, { error: e.message, code: e.code });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method not allowed' });
  serveStatic(res, url.pathname);
});

const IDLE_ACTIVITY_POLL_MS = 10000;

await discoverSocket();
loadActivity();
connectEvents();
refreshActivity();
// Slow always-on tick: keeps recency current when no client is watching.
setInterval(() => { if (!sseClients.size) refreshActivity(); }, IDLE_ACTIVITY_POLL_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveActivity(); process.exit(0); });
server.listen(PORT, HOST, () => {
  console.log(`herdr-web on http://${HOST}:${PORT} (socket: ${socketPath}${TOKEN ? ', token required' : ''})`);
});
