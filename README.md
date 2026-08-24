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
  `agent_status` and `terminal_title_stripped`).
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

## Untested behavior

- **`agent.send`**: whether the sent text is also submitted (i.e. behaves like
  typing + Enter) is untested — nothing was sent to live agents during
  development. If it only types, follow up with the Enter button (which uses
  `pane.send_keys`).
- **`pane.send_keys` key names**: the `enter` / `esc` / `ctrl+c` names match
  herdr's documented keybinding syntax but were not exercised against a live
  pane for the same reason.
