#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODE=auto
case "${1:-}" in
  --headless) MODE=headless ;;
  --desktop) MODE=desktop ;;
  '') ;;
  *) echo 'Usage: sh install.sh [--headless|--desktop]' >&2; exit 2 ;;
esac
OS=$(uname -s)
if [ "$MODE" = auto ]; then
  MODE=desktop
  if [ "$OS" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then MODE=headless; fi
fi
DEST="${TRACE_INSTALL_DIR:-$HOME/.local/share/trace-gateway-app}"
BIN="${TRACE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST" "$BIN"
cp -R "$ROOT/cli/." "$DEST/"
ln -sf "$DEST/trace" "$BIN/trace"
if [ "$MODE" = desktop ]; then
  case "$OS" in
    Darwin)
      mkdir -p "$HOME/Applications"
      ditto "$ROOT/desktop/Trace Gateway.app" "$HOME/Applications/Trace Gateway.app"
      ;;
    Linux)
      set -- "$ROOT"/desktop/*.deb
      if [ ! -f "$1" ]; then echo 'Missing desktop .deb' >&2; exit 1; fi
      if [ "$(id -u)" = 0 ]; then apt-get install -y "$1"; else sudo apt-get install -y "$1"; fi
      ;;
    *) echo "Unsupported desktop platform: $OS" >&2; exit 1 ;;
  esac
fi
printf 'Installed (%s). CLI: %s/trace\n' "$MODE" "$BIN"
case ":$PATH:" in *":$BIN:"*) ;; *) printf 'Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"\n' ;; esac
printf 'Node.js is bundled. Configure a provider with trace provider add; start with trace start.\n'
