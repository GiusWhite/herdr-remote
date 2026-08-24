# herdr-web

A small local web app (mobile-first) to monitor and interact with [herdr](https://herdr.dev)
agent sessions running on this Mac. No framework, no build step, zero npm
dependencies — plain `node:http` + `node:net` bridging HTTP/SSE to herdr's
Unix-socket JSON API.

## Start

```sh
npm start            # http://127.0.0.1:4270
# or
node server.mjs [--port 4270] [--host 127.0.0.1] [--token <secret>]
```

The server discovers the herdr socket at startup via
`herdr session list --json` (the entry with `"default": true`), falling back to
`~/.config/herdr/herdr.sock`.

## Reach it from your phone (LAN mode)

Binding beyond localhost **without a token is refused**. To use it from a phone
on the same Wi-Fi:

```sh
node server.mjs --host 0.0.0.0 --token my-secret
```

Then open `http://<mac-lan-ip>:4270` on the phone. The UI prompts for the token
once and stores it in localStorage; all `/api` routes require it
(`Authorization: Bearer <token>` or `?token=<token>`).

## HTTP API

| Route | Maps to |
|---|---|
| `GET /api/health` | `ping` |
| `GET /api/overview` | `workspace.list` + `agent.list`, agents grouped per workspace |
| `GET /api/agents/:terminalId/output?lines=300&source=recent&format=text` | `agent.read` |
| `POST /api/agents/:terminalId/send` body `{text}` | `agent.send` |
| `POST /api/panes/:paneId/keys` body `{keys: ["enter"]}` | `pane.send_keys` |
| `GET /api/events` | SSE bridge over one long-lived `events.subscribe` connection |

## UI routes

Hash-based, so deep links and refresh work without server routing:

- `#/` (or no hash) — home: workspaces and their agents.
- `#/agent/<terminal_id>` — agent detail view. Directly loadable/bookmarkable;
  if the terminal no longer exists the UI shows a "session not found" state
  with a link home. Browser back returns to the list.

## Live updates (detail view)

- The detail view refetches output when a `pane_updated` event for the open
  pane carries a `revision` newer than the last one seen, coalesced with a
  400ms trailing debounce; only one fetch runs at a time (a newer revision
  arriving mid-fetch queues exactly one follow-up).
- Safety net: while the agent is `working`, output is also refreshed every
  10s if no revision-driven fetch happened — herdr's event delivery can lag
  far behind a fast-producing pane (see protocol notes), while reads are
  always current.
- Auto-scroll to bottom only happens when already at/near the bottom, so
  reading scrollback is never interrupted.
- The detail header shows a green "live" dot while SSE is connected; when SSE
  drops, the existing 10s polling fallback also refreshes the open detail.

## herdr protocol notes

- Wire format: newline-delimited JSON over the Unix socket.
  Request: `{"id":"<string>","method":"<name>","params":{...}}\n` — the
  `params` field is **required even when empty** (`{}`), otherwise the server
  errors and closes.
- **One request per connection**: the server closes the connection after the
  response line, so every call opens a fresh socket. The exception is
  `events.subscribe`, which keeps streaming `{"event":"<name>","data":{...}}`
  lines after an initial `{"result":{"type":"subscription_started"}}`.
- Subscription types are dotted (`pane.updated`), but the streamed event names
  use **underscores** (`{"event":"pane_updated","data":{...}}`). `pane_updated`
  fires on every output tick and carries the full pane object (including
  `agent_status`, `revision` and `terminal_title_stripped`).
- **Event delivery is queued/throttled per subscription** (observed ~10
  events/s): a fast-producing pane can leave a long-lived subscription far
  behind (event `revision` hundreds below the pane's real revision from
  `agent.list`/`agent.read`), replaying stale windows. Reads are always
  current, so consumers should treat events as refresh hints, never mix the
  event revision counter with the read/list one, and refresh on a timer as a
  fallback.
- `agent.read` / `pane.read` results wrap the payload:
  `{type:"pane_read", read:{text, revision, truncated, ...}}` — the bridge
  unwraps `read` for `GET /api/agents/:id/output`.
- `pane.agent_status_changed` subscriptions **require a `pane_id`** (they are
  per-pane, not global). The server subscribes per agent pane from
  `agent.list` plus a set of global events (`pane.created/closed/updated`,
  `workspace.*`, `tab.*`), and resubscribes when the pane set changes. The
  upstream socket reconnects with exponential backoff if it drops.
- `pane.send_keys` params: `{pane_id: string, keys: string[]}`. Key names
  follow herdr's keybinding convention (`enter`, `esc`, `ctrl+c`, `tab`,
  `up`, …).

## Verified send behavior

Exercised against a throwaway Claude session:

- **`agent.send` writes literal text without submitting** (confirmed, and
  stated by `herdr agent --help`). The UI's send bar therefore follows each
  send with `pane.send_keys ["enter"]` after a short delay.
- **`pane.send_keys` names `enter`, `esc`/`escape`, `ctrl+c` are accepted and
  delivered** (invalid names return an `invalid_key` error). Note Claude Code
  itself keeps composer text on Esc; Ctrl+C clears/interrupts.
