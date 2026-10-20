#!/bin/sh
set -eu
SELF=$0
while [ -L "$SELF" ]; do
  BASE=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
  LINK=$(readlink "$SELF")
  case "$LINK" in /*) SELF=$LINK ;; *) SELF=$BASE/$LINK ;; esac
done
DEST=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
PURGE=0
case "${1:-}" in
  --purge-data) PURGE=1 ;;
  '') ;;
  *) echo 'Usage: trace-uninstall [--purge-data]' >&2; exit 2 ;;
esac
if [ ! -f "$DEST/.trace-managed" ] || [ "$(cat "$DEST/.trace-managed")" != trace-gateway-v1 ]; then
  echo 'Refusing uninstall: missing installation ownership marker.' >&2; exit 1
fi
OS=$(uname -s)
case "$OS" in
  Darwin) DEFAULT_DATA="$HOME/Library/Application Support/trace-gateway" ;;
  Linux) DEFAULT_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/trace-gateway" ;;
  *) echo "Unsupported platform: $OS" >&2; exit 1 ;;
esac
DATA=${TRACE_HOME:-$DEFAULT_DATA}
# Refuse broad or unrelated data paths before changing the installation.
if [ "$PURGE" = 1 ]; then
  case "$DATA" in /*) ;; *) echo 'TRACE_HOME must be absolute for data removal.' >&2; exit 1 ;; esac
  if [ -d "$DATA" ]; then DATA=$(CDPATH= cd -- "$DATA" && pwd -P); fi
  USER_HOME=$(CDPATH= cd -- "$HOME" && pwd -P)
  case "$DATA" in /|"$USER_HOME"|"$DEST"|*/..|*/../*|*/.) echo 'Unsafe data directory.' >&2; exit 1 ;; esac
  if [ -e "$DATA" ] && [ ! -f "$DATA/config.json" ] && [ ! -f "$DATA/control.token" ]; then
    echo 'Refusing to delete a directory without Trace Gateway state.' >&2; exit 1
  fi
fi
# Disable startup before stopping the daemon, so it cannot restart.
if [ "$OS" = Darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/dev.trace.gateway.plist"
  if [ -f "$PLIST" ]; then
    LABEL="gui/$(id -u)/dev.trace.gateway"
    if launchctl print "$LABEL" >/dev/null 2>&1; then launchctl bootout "$LABEL"; fi
    rm -f "$PLIST"
  fi
else
  UNIT="$HOME/.config/systemd/user/trace-gateway.service"
  if [ -f "$UNIT" ]; then
    systemctl --user disable --now trace-gateway.service
    rm -f "$UNIT"
    systemctl --user daemon-reload
  fi
  rm -f "$HOME/.config/autostart/trace-gateway.desktop"
fi
"$DEST/trace" --home "$DATA" stop
# A manually launched tray can still own files or restart the daemon.
if pgrep -x trace-desktop >/dev/null 2>&1; then
  echo 'Quit Trace Gateway from the tray, then run trace-uninstall again.' >&2; exit 1
fi
if [ -f "$DEST/.trace-desktop" ]; then
  if [ "$OS" = Darwin ]; then
    rm -rf "$HOME/Applications/Trace Gateway.app"
  else
    PACKAGE=$(cat "$DEST/.trace-package")
    case "$PACKAGE" in ''|*[!a-z0-9+.-]*) echo 'Invalid package name' >&2; exit 1 ;; esac
    if dpkg-query -W "$PACKAGE" >/dev/null 2>&1; then
      if [ "$(id -u)" = 0 ]; then apt-get remove -y "$PACKAGE"; else sudo apt-get remove -y "$PACKAGE"; fi
    fi
  fi
fi
BIN=$(cat "$DEST/.trace-bin-dir")
for NAME in trace trace-uninstall; do
  if [ -L "$BIN/$NAME" ]; then
    case "$(readlink "$BIN/$NAME")" in "$DEST/trace"|"$DEST/uninstall.sh") rm -f "$BIN/$NAME" ;; esac
  fi
done
if [ "$PURGE" = 1 ] && [ -e "$DATA" ]; then rm -rf "$DATA"; fi
# Only remove files owned by this installer; leave any other user files intact.
rm -rf "$DEST/runtime"
rm -f "$DEST/trace" "$DEST/trace-background" "$DEST/README.md" "$DEST/LICENSE" "$DEST/THIRD_PARTY_NOTICES.md" "$DEST/.trace-managed" "$DEST/.trace-bin-dir" "$DEST/.trace-desktop" "$DEST/.trace-package" "$DEST/uninstall.sh"
rmdir "$DEST" 2>/dev/null || true
if [ "$PURGE" = 1 ]; then echo 'Uninstalled; selected gateway data deleted.'; else printf 'Uninstalled. Configuration and recordings retained: %s\n' "$DATA"; fi
