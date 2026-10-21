# Validation status

## Verified locally (macOS Apple Silicon)

- 2026-10-21 file backups and settings: the full gateway suite passes 38 checks. Coverage includes Chat/Anthropic/Responses JSON and SSE, exact forwarded bytes, early text delivery, settings validation and local-origin protection, no global project-directory restriction, explicit relative-path resolution, query-scoped first snapshots, reuse across rounds and restart, concurrent capture, absent initial files, resource limits and cancellation cleanup. Fixtures use temporary directories and mock HTTP upstreams.
- Rust CLI tests pass, including `backup enable|disable|status` parsing. The packaged CLI smoke test passes with both stopped-gateway and live-gateway backup toggles, in addition to forwarding, session continuity and redacted export.
- Current macOS CLI/background helper and Tauri desktop release builds complete using the locked dependencies and local cache. The app includes Node.js and the new backup modules.
- Browser checks cover automatic settings persistence and failure states, navigation layout, token labels, first-new-user-instruction previews, read/write labels and archive tooltips separating new snapshots from reused snapshots.

- Rust CLI/background helper and Tauri desktop compile in release mode.
- Rust parser/config tests cover global CLI flags, port validation, explicit service installation and launch-config escaping; Provider commands do not accept API Key arguments.
- All 20 existing gateway integration/session-matching/redaction checks pass.
- `tests/cli_smoke.py`: detached start, idempotent start, no demo data by default, add/list/current/use/default URLs, JSON/SSE proxy, Session continuation, redacted export, unauthenticated management rejection, stop/restart persistence, daemon-parent crash cleanup, provider removal.
- `tests/native_tray_smoke.py`: actual packaged .app startup with bundled runtime, duplicate tray process suppression, daemon remains after tray exits, bundled CLI can stop daemon.
- `codesign --verify --deep --strict` succeeds for the local ad-hoc signed .app.
- All tests use temporary data directories/ports; no personal trajectory data or runtime state is included in distribution archives. The local preview at 4320 uses a separate data directory with copies of existing recordings.

## Prepared but not executed here


- Ubuntu 22.04 and Windows native installer builds and runtime tests: run the supplied GitHub Actions native matrix or build on those systems. No Ubuntu/Windows installer is represented as locally tested.
- User launchd/systemd/Scheduled Task installation: configurations are generated and dry-run tested; no startup item is installed on the user's machine during development.
- Developer ID signing/notarization and Windows Authenticode signing are not configured. The macOS preview archive is ad-hoc signed, not a public signed release.

The runtime engine remains the existing Node gateway, packaged with Node 24; the CLI, process supervision and desktop/tray framework are Rust/Tauri. It is not a full Rust proxy rewrite.
