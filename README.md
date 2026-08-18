# dsh-trajectory-persistence

[![npm](https://img.shields.io/npm/v/dsh-trajectory-persistence)](https://www.npmjs.com/package/dsh-trajectory-persistence)
[![docs](https://img.shields.io/badge/docs-aws--cnug--o11y.github.io-blue)](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Trajectory persistence plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
Observe-only: it never writes to a session — it persists every session's
trajectory to two **independently toggleable** sinks:

- **S3 sink** — archive the raw trajectory to S3 / OSS / MinIO. Two modes:
  `ship` tails the official jsonl backend's on-disk artifact read-only and
  uploads **byte-faithful zstd frame segments + manifest**, restorable on
  another machine with the bundled `sync-down` CLI; `push` (legacy, default)
  buffers the live event stream and uploads JSONL part files with batch,
  backoff retry, and a local dead-letter directory.
- **OTel GenAI sink** — spans following the
  [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
  (turn / model-call / tool tree with token usage and error status), exported
  over OTLP HTTP/protobuf to Jaeger, an OTel Collector, Langfuse, or
  **SigV4-signed straight to AWS CloudWatch / Bedrock AgentCore Observability**
  — no collector required.

Extras: settings **hot-reload** with per-sink rebuild, `/trajectory-status`
slash command, sync-down restore with no-overwrite / prefix-append /
conflict-refuse semantics.

## Install

```sh
dsh plugin --profile web add dsh-trajectory-persistence
```

All sinks default to **disabled**. Enable what you need in
`$DSH_HOME/settings.yaml` (applies live, no restart):

```yaml
trajectory-persistence:
  sinks:
    s3:
      enabled: true
      mode: ship
      bucket: my-trajectory-bucket
      region: us-east-1          # credentials: AWS default provider chain
    otel:
      enabled: true
      url: http://localhost:4318/v1/traces
```

Move a session to another machine:

```sh
# machine B, dsh not running — restores sessions from the bucket into the local root
dsh-trajectory-persistence sync-down --bucket my-trajectory-bucket --region us-east-1
dsh resume <session>
```

## Documentation

Full guides live on the [documentation site](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/):

- [Getting Started](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/getting-started) — install, first trace with a local Jaeger
- [Configuration Reference](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/configuration) — every field, defaults, validation, hot-reload
- [Ship & Sync](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/ship-sync) — ship mode architecture, manifest watermarks, machine switching
- [S3 Sink](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/s3-sink) — push mode: part layout, buffering, retry & dead-letter
- [OTel GenAI Sink](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/otel-sink) — event → span mapping, Jaeger / Collector / Langfuse
- [AWS CloudWatch & AgentCore](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/aws-cloudwatch) — SigV4 delivery, Transaction Search
- [Development](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/development) — build/test, sink architecture, adding a sink

## Compatibility

The DeepSeek Harness is in developer preview with no compatibility guarantees.
This plugin was built and verified against monorepo commit
[`47f9438`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
(`master` as of 2026-08-14, `@deepseek-ai/dsh-session@0.1.0-rc.6`) and
requires Node.js ≥ 22.

## Development

```sh
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # vitest (140 cases)
```

See [Development](https://aws-cnug-o11y.github.io/dsh-trajectory-persistence/guide/development)
for the source layout and how to run the plugin from a checkout with `--patch`.

## License

[MIT](./LICENSE)
