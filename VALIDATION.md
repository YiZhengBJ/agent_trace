# Validation status

## 2026-10-22: Trace Lab v1

- Independent offline engine under `lab/`, launched by `scripts/trace-lab`; no online gateway service or Rust CLI changes are required.
- The gateway and Lab suite passes 49 checks; an additional opt-in smoke test passes with the installed Claude Code 2.1.304 against a temporary mock local model endpoint. It verifies source-history injection on all three calls, real Read/Edit execution in a restored workspace, a final answer that uses prior context, and unchanged source files. This is not a real local-model quality evaluation.
- Tests cover trace grouping, pre-query evidence copies, source/output separation including symlink aliases, path escape and missing-dependency rejection, history drift detection, verifier plugins, uncertain labels for invalid replays, input-only policy features, held-out calibration and rejected publication of insufficient/tampered policies.
- `tests/lab_packaging_smoke.py` checks the standalone portable layout, bundled-runtime entry point, shared JS modules, initialization and config overwrite refusal, without rebuilding the native app.
- Packaging includes Lab sources and launchers; the full native installers were not rebuilt in this change. No real user traces were replayed, no real model API was called, and no policy was activated online.

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

Lab UI: `runtime/node --test gateway/lab-view.test.mjs lab/test/lab.test.mjs` checks configuration binding authorization, empty data, artifact summaries, malformed JSON, symlink escapes and static module serving, alongside offline Lab regression.
