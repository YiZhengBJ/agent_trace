# Validation status

## Verified locally (macOS Apple Silicon)

- Rust CLI/background helper and Tauri desktop compile in release mode.
- Rust parser/config tests cover global CLI flags, port validation, explicit service installation and launch-config escaping; Provider commands do not accept API Key arguments.
- All 20 existing gateway integration/session-matching/redaction checks pass.
- `tests/cli_smoke.py`: detached start, idempotent start, no demo data by default, add/list/current/use/default URLs, JSON/SSE proxy, Session continuation, redacted export, unauthenticated management rejection, stop/restart persistence, daemon-parent crash cleanup, provider removal.
- `tests/native_tray_smoke.py`: actual packaged .app startup with bundled runtime, duplicate tray process suppression, daemon remains after tray exits, bundled CLI can stop daemon.
- `codesign --verify --deep --strict` succeeds for the local ad-hoc signed .app.
- All tests use temporary data directories/ports; original gateway at 4317 and personal trajectory data are not migrated or packaged.

## Prepared but not executed here

- Ubuntu 22.04 and Windows native installer builds and runtime tests: run the supplied GitHub Actions native matrix or build on those systems. No Ubuntu/Windows installer is represented as locally tested.
- User launchd/systemd/Scheduled Task installation: configurations are generated and dry-run tested; no startup item is installed on the user's machine during development.
- Developer ID signing/notarization and Windows Authenticode signing are not configured. The macOS preview archive is ad-hoc signed, not a public signed release.

The runtime engine remains the existing Node gateway, packaged with Node 24; the CLI, process supervision and desktop/tray framework are Rust/Tauri. It is not a full Rust proxy rewrite.
