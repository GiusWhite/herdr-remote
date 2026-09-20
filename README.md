<p align="center">
  <img src="docs/logo.png" alt="herdr" width="300">
</p>

# herdr-web

A mobile-first web UI for [herdr](https://herdr.dev) agent sessions running on a
Mac: watch what your coding agents are doing, and type back at them, from a
phone. No framework, no build step, zero npm dependencies — plain `node:http` +
`node:net` bridging HTTP/SSE to herdr's Unix-socket JSON API, installable as a
fullscreen PWA.

> **~90% vibecoded.** Most of this repo was written by Claude Code under review,
> not typed by hand. The findings in [docs/internals.md](docs/internals.md) —
> herdr's read caps, event-replay behaviour, status quirks — were measured
> against a live herdr, so those are load-bearing.

- Home: workspaces and their agents, most recently active first, blocked ones
  pulled to the top.
- Detail: live pane output over SSE with ANSI colors, plus scrollback past
  herdr's 1000-line read cap (herdr-web stitches its own history).
- Send text or raw keystrokes; start, rename and close agents.
- Browser and native notifications when an agent goes blocked, idle or done.

## Run

Needs Node 22+ and a running herdr >= 0.8 (its socket is discovered via
`herdr session list --json`, falling back to `~/.config/herdr/herdr.sock`).

```sh
npm start   # http://127.0.0.1:4270, localhost only
node server.mjs [--port 4270] [--host 127.0.0.1] [--token <secret>] \
                [--tls-cert cert.pem --tls-key key.pem] [--history-lines 10000] [--notify]
```

Binding past localhost **without `--token` is refused**.

## Setup outside this repo

The repo is only the app. Everything that makes it reachable and safe lives on
the machine:

1. **launchd** — copy `launchd/*.plist.example` to `~/Library/LaunchAgents/`,
   replace `__HOME__`, `__REPO__`, `__NODE_BIN__` and `__TOKEN__`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<file>.plist`. One
   agent keeps the server up, the other renews the cert daily.
2. **Access token** — a random secret (`openssl rand -hex 16`), living only in
   that plist and in each phone's localStorage. Never in the repo.
3. **DNS** — an `A` record in a domain you control, pointing at the Mac's *LAN*
   address. Public record, private address: the name resolves anywhere, routes
   only inside the network. No port forwarding, no reverse proxy, no tunnel.
4. **TLS** — a publicly trusted cert is mandatory (below). Put `HERDR_DOMAIN`,
   `HOSTINGER_API_TOKEN` and `ACME_EMAIL` in `~/.config/herdr-web/acme.env`
   (mode 600), then run `scripts/renew-tls.sh`: it issues or renews via Let's
   Encrypt **DNS-01**, installs the pair into `~/.config/herdr-web/tls/`, and
   restarts the service only when the cert actually changed. DNS-01 is what
   lets a host the internet cannot reach still hold a real certificate.
5. **State** — `~/.local/state/herdr-web/` holds activity, the audit log and the
   stitched scrollback. Nothing there belongs in git.

Off-LAN access is a VPN back into the network, not an open port.

## TLS

Not optional, and a self-signed cert will not do: browsers grant service
workers, installation and the Notification API only on a *trusted* origin, and
clicking through a certificate warning does not make an origin trusted. With an
untrusted cert Chrome offers only "Add to Home screen", which opens a normal
browser tab with the full toolbar instead of the app.

`scripts/renew-tls.sh` needs [lego](https://go-acme.github.io/lego/)
(`brew install lego`) and is written against lego 5, where `run` both issues and
renews. It checks propagation against public resolvers on purpose — a LAN router
will happily answer `NXDOMAIN` for the `_acme-challenge` name and stall
validation.

## Security

The token is the only thing between someone on your network and a prompt into
your agents' terminals. Treat it as a shell credential.

- Every `/api` route requires `Authorization: Bearer <token>`, compared in
  constant time. `?token=` is accepted only on the two EventSource routes, where
  browsers cannot set headers.
- 5 failed auths from one IP within 60s → `429` with `Retry-After` until the
  window expires; a success clears the counter.
- `~/.local/state/herdr-web/audit.log` records one JSON line per mutating call
  and per auth failure — byte lengths and targets, never payload text. The token
  is never logged or echoed.
- HTTPS end to end; the server reads the key pair once at startup.

## Install as an app

Open the site in Chrome (Android) or Safari (iOS) and install it. The manifest
asks for `display: fullscreen`, so Android draws no status or navigation bar;
iOS ignores `display` and relies on `apple-mobile-web-app-status-bar-style` +
`viewport-fit=cover` to go edge to edge. Chrome reads `display` only at install
time — changing it means removing and re-adding the app.

## More

[docs/internals.md](docs/internals.md) — HTTP API, agent management, live
updates, scrollback stitching, ANSI rendering, and the herdr protocol notes.
