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
| `GET /api/agents/:terminalId/stream` | per-pane live SSE: `agent.read` loop every 350ms, pushes `output` events with the full text only when it changed; max 4 concurrent streams (429 beyond) |
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

- On open, the detail view connects `GET /api/agents/:id/stream` — a dedicated
  per-pane SSE stream that pushes the pane's text within ~350ms of any change
  (near-real-time). The stream is closed when navigating away; the green
  "live" dot in the detail header reflects this stream's state.
- Fallback (stream rejected by the 4-stream cap, or errored): the older
  behavior takes over — `pane_updated` revision hints trigger debounced
  refetches, plus a 10s keep-fresh tick while the agent is `working`. When
  the global SSE is down too, 10s polling refreshes the open detail.
- Auto-scroll to bottom only happens when already at/near the bottom, so
  reading scrollback is never interrupted.

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
- **`pane.updated` never fires for panes in unfocused workspaces** (verified:
  zero events for a background pane during 8s of steady output, while its
  `pane.get` revision advanced). Events cannot drive a live view of a
  background pane; only reads can.
- **`pane.wait_for_output` matches existing buffer content** (returns
  immediately if the match is already on screen), so it cannot wait for "any
  new output". It blocks until match or `timeout_ms` (error `timeout`), one
  response per connection; the result wraps a full current read but its
  top-level `revision` is always 0. `events.wait` accepts only
  `pane_agent_status_changed` matches (`pane_output_changed` is in the schema
  but returns `unsupported_event_wait_match`). Hence the `/stream` endpoint
  uses a 350ms `agent.read` compare loop.
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

## Keystroke mode (interactive prompts)

`agent.send` pastes text, which interactive TUI prompts ignore (Claude Code's
`/model` picker, y/n questions, numbered menus, permission dialogs treat a
pasted "5" as composer text). The composer therefore offers:

- A key row: Enter, Esc, Ctrl+C, ↑ ↓ ← →, Tab, Shift+Tab (scrolls
  horizontally on narrow screens).
- A ⌨ toggle: when on, the submitted input is sent as real keystrokes via
  `pane.send_keys` — one key per character (`" "` → `space`), with **no
  auto-Enter** (press the Enter button when ready). Off by default, remembered
  in memory for the page session only.

Key names accepted by `pane.send_keys` (verified): single characters (`4`,
`s`, `y`, `n`, …), `up`, `down`, `left`, `right`, `tab`, `shift+tab`,
`space`, `backspace`, `enter`, `esc`, `ctrl+c`. Not supported: `pageup`,
`home`. Invalid names return `{"code":"invalid_key"}`.

## Verified send behavior

Exercised against a throwaway Claude session:

- **`agent.send` writes literal text without submitting** (confirmed, and
  stated by `herdr agent --help`). The UI's send bar therefore follows each
  send with `pane.send_keys ["enter"]` after a short delay.
- **`pane.send_keys` names `enter`, `esc`/`escape`, `ctrl+c` are accepted and
  delivered** (invalid names return an `invalid_key` error). Note Claude Code
  itself keeps composer text on Esc; Ctrl+C clears/interrupts.
