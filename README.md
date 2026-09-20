# herdr-web

A small local web app (mobile-first) to monitor and interact with [herdr](https://herdr.dev)
agent sessions running on this Mac. No framework, no build step, zero npm
dependencies — plain `node:http` + `node:net` bridging HTTP/SSE to herdr's
Unix-socket JSON API.

## Deployment

Runs as a persistent background service on this Mac (launchd, see
`launchd/`), not something started by hand day to day. Reachable at
**https://herdr.giuswhite.eu:4270** — a hostname that only resolves inside
the home network (split-horizon DNS; the public `giuswhite.eu` domain points
elsewhere). By design it's never exposed to the internet: reachable only
from the home LAN, or remotely over VPN back into that network.

## Start

```sh
npm start            # http://127.0.0.1:4270
# or
node server.mjs [--port 4270] [--host 127.0.0.1] [--token <secret>] [--tls-cert cert.pem --tls-key key.pem] [--notify]
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
once and stores it in localStorage. Hardening applied when `--token` is set:

- All `/api` routes require `Authorization: Bearer <token>`, compared in
  constant time. `?token=` is accepted **only** on the two EventSource routes
  (`GET /api/events`, `GET /api/agents/:id/stream`), where browsers cannot set
  headers.
- Per-IP throttling: 5 failed auths within 60s → `429 {error:"too many failed
  attempts"}` with `Retry-After: 60` for that IP until the window expires. A
  successful auth clears the counter.
- Audit log at `~/.local/state/herdr-web/audit.log` (honours `XDG_STATE_HOME`):
  one JSON line per `send`/`keys` call (`{ts, ip, route, target, bytes}` — the
  payload length only, never its content) and per auth failure
  (`{ts, ip, route, event:"auth_failed"}`). The token is never logged or
  echoed in a response.

### TLS

`--tls-cert` and `--tls-key` are required together; the server then listens on
`https://`. Both phones only allow PWA installation and Notifications on a
*trusted* origin, so the cert must be publicly trusted — a self-signed one is
not enough, and clicking through the browser warning does not make the origin
secure (no service worker, no install).

The cert is a real Let's Encrypt one, issued over the **DNS-01** challenge, so
`herdr.giuswhite.eu` never needs to be reachable from the internet — only a TXT
record in the public `giuswhite.eu` zone (hosted at Hostinger, which `lego`
drives through its API).

One-time setup:

```sh
brew install lego
mkdir -p ~/.config/herdr-web
cat > ~/.config/herdr-web/acme.env <<'ENV'
HOSTINGER_API_TOKEN=<token from hPanel → Account → API>
ACME_EMAIL=<contact address for expiry notices>
ENV
chmod 600 ~/.config/herdr-web/acme.env

scripts/renew-tls.sh          # issues, installs, restarts the service
```

`scripts/renew-tls.sh` is idempotent: it issues on first run, renews only
inside 30 days of expiry, and copies the result to
`~/.config/herdr-web/tls/{cert,key}.pem` + `launchctl kickstart -k` **only when
the cert actually changed** (the server reads the pair at startup).
`launchd/com.giuswhite.herdr-web-tls.plist` runs it daily at 03:40; log at
`~/Library/Logs/herdr-web-tls.log`.

## Install as an app (PWA)

herdr-web ships a web manifest and a small service worker, so it can be added
to the home screen and opened as a standalone app.

- **iOS Safari**: open the site, tap Share → *Add to Home Screen*.
- **Android Chrome**: open the site, tap ⋮ → *Add to Home screen* (or *Install
  app* when Chrome offers it).

Install and the service worker both require a secure origin: `https://` with a
publicly trusted certificate (see [TLS](#tls)) or `http://localhost` on the Mac
itself. Over plain `http://<lan-ip>`, or over `https://` with an untrusted cert,
the app still works in the browser but is not installable and nothing is cached
— Chrome then offers only *Add to Home screen*, which opens a normal browser tab
with the full toolbar instead of the app.

The manifest asks for `display: "fullscreen"` (falling back to `standalone` via
`display_override`), so on Android the installed app has no status or navigation
bar. iOS ignores `display` entirely: there a home-screen app is always
standalone with the status bar drawn, and `apple-mobile-web-app-status-bar-style:
black-translucent` + `viewport-fit=cover` + the `env(safe-area-inset-*)` padding
is what makes it run edge-to-edge. Chrome reads `display` at install time only,
so changing it means removing and re-adding the app.

What the service worker does: precaches the static shell only (`/`,
`/index.html`, the manifest and the icons) under a versioned cache
(`SW_VERSION` in `public/sw.js`), serves it cache-first with network fallback,
and drops old caches on activate. It **never** touches `/api/*` — overview,
output, send/keys and the SSE streams always go straight to the network, so
nothing live is ever served stale. Offline, the shell opens and the connection
indicator shows "offline". `sw.js` is served with `Cache-Control: no-cache` so
a bumped `SW_VERSION` is picked up on the next visit; the UI then shows an
"Updated — reload" toast.

## HTTP API

| Route | Maps to |
|---|---|
| `GET /api/health` | `ping` |
| `GET /api/overview` | `workspace.list` + `agent.list`, agents grouped per workspace, each with a derived `last_activity_at` (epoch ms, or null) |
| `GET /api/agents/:terminalId/output?lines=1000&format=text` | `pane.read`, then the last `lines` of the stitched history (see [Scrollback history](#scrollback-history)): `{text, start, end, total, pane_id, revision}` |
| `GET /api/agents/:terminalId/history?before=<idx>&lines=1000&format=text` | lines `[before-lines, before)` of the stitched history, no herdr read: `{text, start, end, total}` |
| `GET /api/agents/:terminalId/stream?format=text` | per-pane live SSE: `pane.read` loop every 350ms, pushes `output` events `{text, start, total}` (the history tail) only when it changed; max 4 concurrent streams (429 beyond) |

`:terminalId` is resolved server-side to the pane currently hosting that
agent (index refreshed on every `agent.list` read; unknown ids → 404). herdr
≥ 0.8 accepts only agent names or pane ids as `target`, never terminal ids,
and `agent.send` was removed — text goes through `pane.send_text`. Reads ask
for 1000 lines, the most `pane.read` will return (`truncated: true` above it).

`format` is `text` (default) or `ansi` on both read routes; anything else is a
400. With `ansi` the returned `text` carries the raw escape sequences.
| `POST /api/agents/:terminalId/send` body `{text}` | `pane.send_text` |
| `POST /api/panes/:paneId/keys` body `{keys: ["enter"]}` | `pane.send_keys` |
| `GET /api/events` | SSE bridge over one long-lived `events.subscribe` connection, plus authoritative `overview` snapshots |

## Managing agents

Three mutating routes let the UI start, rename and close agents. Like every
non-SSE route they are Bearer-auth only, and each call is written to the audit
log (see [LAN mode](#reach-it-from-your-phone-lan-mode)) — payload content is
never logged, only its byte length plus `workspace`/`cwd` for start and
`target` for rename/close. Each success also triggers an immediate overview
poll so connected clients see the change without waiting for the 2.5s tick.

| Route | Body | Maps to |
|---|---|---|
| `POST /api/agents` | `{name, cwd, workspace_id?, argv: string[]}` — `name` non-empty ≤ 64 chars, `argv` non-empty string array (no shell: split the command yourself), `cwd` optional string | `agent.start` → `{type:"agent_started", agent:{terminal_id, pane_id, …}, argv}` |
| `POST /api/agents/:terminalId/rename` | `{name}` — empty or `null` clears the custom name | `agent.rename` → `{type:"agent_info", agent:{…}}` |
| `POST /api/panes/:paneId/close` | — | `pane.close` → `{type:"ok"}` |

herdr param schemas (from `herdr api schema --json`): `agent.start`
`{name, argv, cwd?, workspace_id?, tab_id?, split?, env?, focus?}`;
`agent.rename` `{target, name: string|null}`; `pane.close` `{pane_id}`.
A custom name comes back as `name` on `agent.list` entries and takes precedence
over the terminal title in the UI.

UI affordances:

- **+** on each workspace header opens a bottom sheet: Name, Directory
  (prefilled with the workspace's worktree checkout or the cwd of one of its
  agents — `workspace.list` itself carries no cwd) and a Command chooser with
  preset chips `claude`, `claude --continue`, `codex` plus a custom field
  (split on whitespace into argv). On success the UI opens the new agent.
- **⋯** on each agent card (the rest of the card still opens the detail view)
  and in the detail header: *Rename* swaps the title into an inline input
  (Enter/blur saves, Esc cancels, empty clears); *Close* asks inline
  ("Close this agent? Yes / No" — no `window.confirm`) before calling the
  route. Closing from the detail view returns home.

## UI routes

Hash-based, so deep links and refresh work without server routing:

- `#/` (or no hash) — home: workspaces and their agents.
- `#/agent/<terminal_id>` — agent detail view. Directly loadable/bookmarkable;
  if the terminal no longer exists the UI shows a "session not found" state
  with a link home. Browser back returns to the list.

## Card ordering (most recently used first)

Within each workspace section, agent cards are sorted by last activity,
newest first; sessions with no recorded activity keep their herdr order at the
end. Workspace section order is unchanged.

herdr exposes no timestamps, so recency is derived here: each `agent.list`
poll compares every pane's `revision` counter with its previous value, and an
increase stamps `last_activity_at` (epoch ms) for that `terminal_id`. Sending
text or keys from the UI stamps it too. `revision` is a per-pane counter and
is only ever compared against that same pane's last value, never across panes.
Polling continues at a slow 10s tick when no client is connected, so ordering
is already right when the page opens. The counter advances when a pane emits
output, so ordering granularity is coarse (seconds), which is all "last used"
needs.

State lives in `~/.local/state/herdr-web/activity.json` (honours
`XDG_STATE_HOME`), created lazily and written at most every 30s when dirty. It
stores only `{terminal_id: {t: last_activity_at, r: last_revision}}`. A
missing or corrupt file is ignored, and entries are pruned once the terminal
is gone and either never active or untouched for 30 days. On first ever run
everything is "unknown", so the list looks exactly as before and sorts itself
as sessions produce output.

## Agent status (home list)

Card status comes from **reads, never from events** — events are unreliable
hints (they never fire for panes in unfocused workspaces, and replay stale
statuses). While at least one SSE client is connected the server polls
`workspace.list` + `agent.list` every 2.5s, compares the snapshot with the
last one, and emits an `overview` SSE event only when it actually changed;
with no clients connected it polls nothing. The client renders the list from
those snapshots (coalesced 500ms), so finished sessions hold a steady status
and closed workspaces disappear on their own. `pane_updated` is kept purely
as an output-refresh hint for the open detail view.

## Notifications & attention

When an agent transitions `working → blocked`, `working → idle`,
`working → done` (herdr's completion status) or `unknown → blocked`, the
server broadcasts a `status_changed` SSE event
(`{terminal_id, pane_id, name, workspace, from, to, at}`) over `/api/events`.
Transitions are detected by comparing consecutive **overview snapshot reads**
(the same 2.5s poll that feeds the list), never from herdr events — events
replay stale statuses on resubscribe and never fire for unfocused workspaces
(see [Agent status](#agent-status-home-list)). Nothing is emitted the first
time a terminal is seen, so a server restart is silent.

- **Browser notifications**: the 🔔 button in the home header asks for
  permission and toggles delivery; it is hidden when the browser has no
  `Notification` API and shows as struck-through when permission was denied.
  Only an explicit "off" is remembered (`herdr_notify_off` in localStorage).
  A notification (`<name> · <status>`, body = workspace) is shown when the
  tab is hidden or the affected agent is not the open detail view; clicking
  it opens `#/agent/<id>`. Browsers only grant the permission on a secure
  origin, so from a phone this needs `https://` — see
  [Optional TLS](#optional-tls).
- **`--notify`**: optional native fallback. On each `status_changed` the
  server also calls herdr's `notification.show` (title `<name> · <status>`,
  body = workspace, `sound: request` for blocked, `done` otherwise), which
  surfaces on the Mac even with no browser open. Failures are logged and
  ignored.
- **Tab badge**: the document title becomes `(n) herdr` where `n` is the
  number of agents currently `blocked` in the latest snapshot (derived from
  the snapshot, not counted from events).
- **Needs attention first**: within each workspace, `blocked` agents sort
  before everyone else, then the usual recency order applies. Blocked cards
  get a red left accent, and a "n need attention" pill appears in the home
  header (hidden when 0).

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

## Scrollback history

herdr's `pane.read` returns at most 1000 lines and has no offset parameter,
whatever the pane's buffer holds (measured on 0.8.2: a pane with ~3000 rows of
scrollback per `pane.get` still reads back exactly 1000; the cap is compiled
in, `[advanced] scrollback_limit_bytes` only sizes the buffer). herdr-web
therefore keeps its own per-pane history (`history.mjs`) and grows it from
overlapping reads:

- Every read the server makes — the 350ms `/stream` loop, `/output`, a
  background pass over all agents whose `revision` moved since their last read
  (piggybacking on the 2.5s / 10s `agent.list` polls), and a 500ms tick over
  agents in `working` state — is ingested. Panes nobody has open still
  accumulate history, at the poll granularity: a burst that outruns the
  overlap between two reads leaves a dimmed `── history gap ──` marker where
  the unread part was.
- **Alternate-screen TUIs have no scrollback in herdr at all.** Claude Code
  with `"tui": "fullscreen"` (its default for recent installs) draws on the
  alternate screen; `pane.get` reports `max_offset_from_bottom: 0` and every
  read returns just the viewport (~47 lines, `truncated: false`). The history
  is then built purely from viewport snapshots, which is why the 500ms tick
  exists and why the anchor window shrinks to a third of the read. It cannot
  bridge a jump of more than ~two thirds of a screen between reads. For real
  scrollback run Claude Code with `/tui default` or
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`.
- Stitching anchors the new read inside the stored lines by comparing a
  30-line window (ANSI-stripped, right-trimmed) at several offsets into the
  read, most recent occurrence first, so redrawn tails (spinners, prompts) and
  edited top lines still line up. Reads use `source: recent_unwrapped` so a
  pane resize doesn't re-wrap lines under the anchors. A full-buffer read
  (`truncated: false`) that matches nothing and is at least as long as the
  stored history replaces it: the pane id is living a new life after a
  restart. A shorter unmatched one is a viewport that jumped, and is appended
  after a gap marker.
- Stored in ANSI; `format=text` strips it on the way out. Cap
  `--history-lines` (default 10000) per pane, persisted to
  `~/.local/state/herdr-web/history/<pane_id>.json` at most every 30s and on
  exit; files untouched for 7 days are pruned at startup.

In the UI the live tail works as before. A **Show earlier output** pill sits
above it whenever the history holds lines before the tail, and scrolling up to
the top loads the previous 1000 lines (scroll position is preserved). Loaded
history and the tail share history coordinates (`start`/`total` on every
`output` event), so the client drops overlapping lines and fills any gap when
the tail moves past the loaded block. Switching **Aa** or opening another
agent resets the loaded block.

## Output rendering

The detail view reads the pane with `format=ansi` and renders colors and text
attributes itself — a small hand-written SGR parser in `index.html`, no
library. The **Aa** button in the detail header toggles it (`aria-pressed`,
default on, `herdr_ansi=0` in localStorage when off); switching reopens the
live stream and refetches with the matching `format`, so the change is
immediate. Off means exactly the old behavior: `format=text`, plain text.

Supported SGR: reset (0), bold/dim/italic/underline/inverse/strikethrough
(1/2/3/4/7/9) and their offs (22/23/24/27/29), the 16 base colors as fg/bg
(30–37, 90–97, 40–47, 100–107, plus 39/49 defaults) via `--ansi-0`…`--ansi-15`
CSS variables tuned to the dark pane, 256-color (`38;5;n` / `48;5;n`, xterm
cube and grayscale computed) and truecolor (`38;2;r;g;b` / `48;2;r;g;b`) as
inline styles. Inverse swaps fg/bg, falling back to the pane's own colors.
Every other escape — cursor movement, erase, mode switches (`?…h/l`), OSC
titles/hyperlinks, lone ESC — is stripped and ignored. Output is built from
text nodes and `<span>`s (never innerHTML), in one pass, with same-styled runs
coalesced into a single span.

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
- **Resubscribing replays a stale event window — never resubscribe in
  response to an event.** A new `events.subscribe` re-delivers a window of
  recent events, including lifecycle ones (`pane_created`, `pane_closed`,
  `workspace_created`, …) and `pane_updated` events carrying *old* revisions
  and *old* `agent_status`. If a client resubscribes whenever it sees a
  lifecycle event, the replayed window triggers another resubscribe and the
  loop never ends: measured here, a single `workspace create` produced 50
  replays of `workspace_created`, 49 of a `workspace_closed` for a workspace
  closed minutes earlier, and drove one pane's revision backwards from 1494
  to 1030 with 49 regressions — which is what made agent status flicker.
  A single static subscription is strictly monotonic and current (measured:
  246 events over 30s, 0 regressions), so subscribe once and reconnect only
  when the socket actually closes. An earlier note in this file blamed herdr
  for lagging/throttling delivery; that was wrong — the replays were
  self-inflicted.
- Defensive rule for any consumer: keep a per-pane highwater `revision` and
  drop events at or below it.
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
  unwraps `read` for `GET /api/agents/:id/output`. `source: recent` returns
  at most 1000 lines of host scrollback (measured on 0.8.2: `truncated: true`
  at exactly 1000 regardless of a larger `lines`); `lines: null` means ~80.
- `pane.agent_status_changed` subscriptions **require a `pane_id`** (they are
  per-pane, not global). The server subscribes per agent pane from
  `agent.list` plus a set of global events (`pane.created/closed/updated`,
  `workspace.*`, `tab.*`), and resubscribes when the pane set changes. The
  upstream socket reconnects with exponential backoff if it drops.
- `pane.send_keys` params: `{pane_id: string, keys: string[]}`. Key names
  follow herdr's keybinding convention (`enter`, `esc`, `ctrl+c`, `tab`,
  `up`, …).

## Composer

The send field is an auto-growing textarea: it expands with the typed text up
to 40vh, then scrolls. Enter submits and Shift+Enter inserts a newline on
pointer devices; on touch (no Shift key) Enter always inserts a newline and
the send button submits. Cmd/Ctrl+Enter submits anywhere. Multi-line text is
pasted by `agent.send` in one go and then submitted with a single `enter`
key; in keystroke mode a newline is sent as the `enter` key.

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

- **`agent.send` wrote literal text without submitting** (confirmed at the
  time). It no longer exists in herdr 0.8; `pane.send_text` is its direct
  replacement and the UI's send bar still follows each send with
  `pane.send_keys ["enter"]` after a short delay. `agent.prompt` is the
  atomic text+Enter alternative (rejects `blocked` agents) if that ever
  becomes preferable.
- **`pane.send_keys` names `enter`, `esc`/`escape`, `ctrl+c` are accepted and
  delivered** (invalid names return an `invalid_key` error). Note Claude Code
  itself keeps composer text on Esc; Ctrl+C clears/interrupts.
