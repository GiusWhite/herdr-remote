#!/bin/sh
# Issues/renews the herdr-web TLS cert via Let's Encrypt DNS-01 (Hostinger),
# installs it where the server reads it, and restarts the service only on change.
set -eu

DOMAIN=herdr.giuswhite.eu
LABEL=com.giuswhite.herdr-web
CONF="$HOME/.config/herdr-web"
LEGO_PATH="$CONF/lego"
TLS="$CONF/tls"

if [ ! -f "$CONF/acme.env" ]; then
  echo "missing $CONF/acme.env (needs HOSTINGER_API_TOKEN and ACME_EMAIL)" >&2
  exit 1
fi
. "$CONF/acme.env"
export HOSTINGER_API_TOKEN

mkdir -p "$LEGO_PATH" "$TLS"

# lego 5 dropped the `renew` command: `run` issues or renews as needed.
lego run --accept-tos --email "$ACME_EMAIL" --dns hostinger \
     --domains "$DOMAIN" --path "$LEGO_PATH" --renew-days 30 \
     --dns.resolvers 1.1.1.1:53,8.8.8.8:53

CRT="$LEGO_PATH/certificates/$DOMAIN.crt"
KEY="$LEGO_PATH/certificates/$DOMAIN.key"

if cmp -s "$CRT" "$TLS/cert.pem"; then
  echo "$(date -u +%FT%TZ) cert unchanged"
  exit 0
fi

install -m 644 "$CRT" "$TLS/cert.pem"
install -m 600 "$KEY" "$TLS/key.pem"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "$(date -u +%FT%TZ) installed new cert for $DOMAIN, restarted $LABEL"
