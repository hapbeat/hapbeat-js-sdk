# Changelog

All notable changes to `@hapbeat/sdk` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-06-25

Initial public release. One API, two transports.

### Added

- **`connect(options?)`** — Node (`@hapbeat/sdk` → `dist/node.js`, direct UDP
  broadcast) and Browser (`dist/browser.js`, via the `hapbeat-helper`
  WebSocket at `ws://localhost:7703`). The bundler/runtime picks the build
  automatically through the package `exports` map.
- **`Hapbeat`** facade — the level‑1 "fire" surface:
  - `play(eventId, opts?)` — the `EventMap` (kit manifest) decides the mode:
    **command** (`events`) plays the device's installed clip; **clip**
    (`stream_events`) streams the event's WAV from the host.
  - `streamPcm(pcm, opts?)` — stream an ad‑hoc PCM16 buffer (stereo for L/R
    directional haptics).
  - `openStream(opts?)` → `LiveStream` — a **persistent** stream for
    continuously‑modulated haptics (`STREAM_BEGIN` once, then `handle.write()`
    chunks, `handle.close()`), with no per‑chunk teardown.
  - `preloadClips()`, `stop()`, `stopAll()`, `ping()`, `discover()`, `close()`.
- **`EventMap`** — the orthogonal tuning side. `fromManifest()` (kit manifest
  schema 2.0.0), `fromGains()`, plus `get`/`gainFor`/`has`/`ids`/`size`.
- **`parseWav`**, **`ClipStreamer`**, **`LiveStream`** as named exports for
  advanced use, and `protocol.*` (Layer‑1 wire builders/parsers).
- Device discovery (broadcast PING/PONG) and target addressing
  (`"player_1/chest"`, `"*/chest"`, or `""` = broadcast).
- Examples: `examples/node-minimal.mjs`, `examples/browser-minimal.html`, and a
  browser haptic‑demo arcade under `examples/games/`.

[Unreleased]: https://github.com/hapbeat/hapbeat-js-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hapbeat/hapbeat-js-sdk/releases/tag/v0.1.0
