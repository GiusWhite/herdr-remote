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
let resubscribeQueued = false;

const GLOBAL_SUBS = [
  'workspace.updated', 'workspace.created', 'workspace.closed', 'workspace.renamed',
  'tab.renamed', 'tab.created', 'tab.closed',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.agent_detected',
].map((type) => ({ type }));

async function buildSubscriptions() {
  // pane.agent_status_changed requires pane_id, so subscribe per agent pane.
  const subs = [...GLOBAL_SUBS];
  try {
    const { agents = [] } = await rpc('agent.list');
    for (const a of agents) subs.push({ type: 'pane.agent_status_changed', pane_id: a.pane_id });
  } catch { /* global subs still work */ }
  return subs;
}

async function connectEvents() {
  const subs = await buildSubscriptions();
  const sock = net.connect(socketPath);
  eventsSock = sock;
  let buf = '';

  sock.on('connect', () => {
    sock.write(JSON.stringify({ id: '1', method: 'events.subscribe', params: { subscriptions: subs } }) + '\n');
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
        broadcast(msg.event, msg.data ?? {});
        // Pane set changed: resubscribe so new agent panes get status subscriptions.
        if (['pane_created', 'pane_closed', 'pane_agent_detected', 'pane_exited'].includes(msg.event)) {
          queueResubscribe();
        }
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

function queueResubscribe() {
  if (resubscribeQueued) return;
  resubscribeQueued = true;
  setTimeout(() => {
    resubscribeQueued = false;
    const old = eventsSock;
    eventsSock = null; // prevent the close handler from double-reconnecting
    old?.destroy();
    connectEvents();
  }, 500);
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
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJSON(res, 200, await rpc('ping'));
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const [ws, ag] = await Promise.all([rpc('workspace.list'), rpc('agent.list')]);
      const byWorkspace = new Map();
      for (const a of ag.agents || []) {
        if (!byWorkspace.has(a.workspace_id)) byWorkspace.set(a.workspace_id, []);
        byWorkspace.get(a.workspace_id).push(a);
      }
      const workspaces = (ws.workspaces || []).map((w) => ({
        ...w,
        agents: byWorkspace.get(w.workspace_id) || [],
      }));
      return sendJSON(res, 200, { workspaces });
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
      return sendJSON(res, 200, result ?? { ok: true });
    }

    if (req.method === 'POST' && parts[1] === 'panes' && parts[3] === 'keys') {
      const { keys } = await readBody(req);
      const list = Array.isArray(keys) ? keys : [keys];
      if (!list.length || !list.every((k) => typeof k === 'string' && k.length)) {
        return sendJSON(res, 400, { error: 'keys must be a non-empty string array' });
      }
      const result = await rpc('pane.send_keys', { pane_id: parts[2], keys: list });
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
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
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

await discoverSocket();
connectEvents();
server.listen(PORT, HOST, () => {
  console.log(`herdr-web on http://${HOST}:${PORT} (socket: ${socketPath}${TOKEN ? ', token required' : ''})`);
});
