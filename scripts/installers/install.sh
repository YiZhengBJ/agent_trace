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
if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST")" ] && [ ! -f "$DEST/.trace-managed" ]; then
  echo 'Installation directory is not managed by this installer. Choose an empty TRACE_INSTALL_DIR.' >&2; exit 1
fi
mkdir -p "$DEST" "$BIN"
DEST=$(CDPATH= cd -- "$DEST" && pwd -P)
BIN=$(CDPATH= cd -- "$BIN" && pwd -P)
printf 'trace-gateway-v1\n' > "$DEST/.trace-managed"
printf '%s\n' "$BIN" > "$DEST/.trace-bin-dir"
cp -R "$ROOT/cli/." "$DEST/"
cp "$ROOT/uninstall.sh" "$DEST/uninstall.sh"
chmod +x "$DEST/uninstall.sh"
for NAME in trace trace-uninstall; do
  if [ -L "$BIN/$NAME" ]; then
    case "$(readlink "$BIN/$NAME")" in "$DEST/trace"|"$DEST/uninstall.sh") ;; *) echo "Command link belongs to another installation: $BIN/$NAME" >&2; exit 1 ;; esac
  elif [ -e "$BIN/$NAME" ]; then
    echo "Command already exists: $BIN/$NAME" >&2; exit 1
  fi
done
ln -sf "$DEST/trace" "$BIN/trace"
ln -sf "$DEST/uninstall.sh" "$BIN/trace-uninstall"
if [ "$MODE" = desktop ]; then
  case "$OS" in
    Darwin)
      mkdir -p "$HOME/Applications"
      ditto "$ROOT/desktop/Trace Gateway.app" "$HOME/Applications/Trace Gateway.app"
      ;;
    Linux)
      set -- "$ROOT"/desktop/*.deb
      if [ ! -f "$1" ]; then echo 'Missing desktop .deb' >&2; exit 1; fi
      dpkg-deb -f "$1" Package > "$DEST/.trace-package"
      if [ "$(id -u)" = 0 ]; then apt-get install -y "$1"; else sudo apt-get install -y "$1"; fi
      ;;
    *) echo "Unsupported desktop platform: $OS" >&2; exit 1 ;;
  esac
  touch "$DEST/.trace-desktop"
fi
printf 'Installed (%s). CLI: %s/trace\n' "$MODE" "$BIN"
case ":$PATH:" in *":$BIN:"*) ;; *) printf 'Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"\n' ;; esac
printf 'Node.js is bundled. Configure a provider with trace provider add; start with trace start.\n'

printf "Uninstall: %s/trace-uninstall (add --purge-data to delete recordings).\n" "$BIN"
