# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI workflow: build, test suite, and docs build on push and pull requests.

## [0.1.0] - 2026-08-18

### Added

- **S3/OSS trajectory sink** (`sinks.s3`) with two modes:
  - `ship` — tails the official jsonl backend's on-disk artifact read-only and
    uploads byte-faithful zstd frame segments plus a per-session
    `_manifest.json` watermark (zstd frame scanner, manifest, ship state).
  - `push` (legacy, default) — buffers the live event stream and uploads
    JSONL part files with batch, exponential-backoff retry, and a local
    dead-letter directory.
- **`sync-down` CLI** — restores shipped sessions into a local session root
  from the bucket, manifest-validated and atomically published, with
  no-overwrite / prefix-append / conflict-refuse semantics.
- **OTel GenAI sink** (`sinks.otel`) — spans following the OpenTelemetry
  GenAI semantic conventions (turn / model-call / tool tree with token usage
  and error status), exported over OTLP HTTP/protobuf.
- **SigV4-signed OTLP exporter** — direct delivery to AWS CloudWatch / Bedrock
  AgentCore Observability over the default credential chain, no collector.
- **Settings hot-reload** — config changes apply live, rebuilding exactly the
  sinks whose config changed (old sink drains first).
- **`/trajectory-status` slash command** — per-sink switch state, counters,
  and most recent error.
- **Documentation site** — VitePress guides (getting started, configuration,
  ship & sync, S3 sink, OTel sink, AWS CloudWatch & AgentCore, development)
  deployed to GitHub Pages.

[0.1.0]: https://github.com/aws-cnug-o11y/dsh-trajectory-persistence/releases/tag/v0.1.0
