# Getting Started

## What it is

`dsh-trajectory-persistence` is a trajectory persistence plugin for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
It is an **observe-only** cordis plugin: it subscribes to the session event
firehose (`session/created` / `session/event` / `session/flush` /
`session/disposed`) and persists every session's trajectory to two
**independently toggleable** sinks:

- **S3 / OSS sink** — two delivery modes: `push` (default, legacy) uploads
  JSONL part files compatible with the
  `@deepseek-ai/dsh-session-persistence-jsonl` artifact layout (header line +
  one event per line), with a bounded in-memory ring buffer, batch uploads,
  exponential-backoff retry, and a local dead-letter directory; `ship` tails
  the official jsonl backend's on-disk artifact read-only and uploads zstd
  frame segments plus a per-session manifest — restorable on another machine
  with the bundled `sync-down` CLI (see [Ship & Sync](/guide/ship-sync)).
- **OTel GenAI sink** — spans following the
  [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
  exported over OTLP HTTP/protobuf straight to Jaeger, to an OTel Collector,
  or SigV4-signed to AWS CloudWatch / Bedrock AgentCore Observability.

The plugin never writes through `Session.append` — it is purely a consumer of
the firehose, so turn latency is unaffected.

::: warning Compatibility notice
The DeepSeek Harness is in developer preview with no compatibility guarantees.
This plugin was built and verified against monorepo commit
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
(`master` as of 2026-08-14, `@deepseek-ai/dsh-session@0.1.0-rc.6`).
:::

Requires Node.js ≥ 22 (matching the harness).

## Install into a profile

The package carries the bundle manifest expected by the CLI:

```jsonc
// package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```sh
dsh plugin add dsh-trajectory-persistence
```

This applies the shipped `cordis.patch.yml`, which inserts one (inert) row:

```yaml
- insert:
    - id: trajectory-persistence
      name: dsh-trajectory-persistence
```

All sinks default to **disabled**; enable and configure them in your profile's
own `cordis.patch.yml` (later layers replace a row's whole config, so restate
the full `config` block):

```yaml
# $DSH_HOME/profiles/<your-profile>/cordis.patch.yml
- replace:
    - id: trajectory-persistence
      name: dsh-trajectory-persistence
      config:
        sinks:
          s3:
            enabled: true
            bucket: my-trajectory-bucket
          otel:
            enabled: true
            url: http://localhost:4318/v1/traces
```

Or — with no restart at all — through `$DSH_HOME/settings.yaml`, which
deep-merges on top of the composed config and applies **live**; see
[Hot-reload behavior](/guide/configuration#hot-reload-behavior).

## First trace with a local Jaeger

The fastest way to see the plugin working end to end is a local Jaeger
all-in-one, which enables the OTLP receiver by default:

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

Enable only the otel sink in your profile's `cordis.patch.yml`:

```yaml
- replace:
    - id: trajectory-persistence
      name: dsh-trajectory-persistence
      config:
        sinks:
          otel:
            enabled: true
            url: http://localhost:4318/v1/traces
```

Start `dsh` and run one turn in a session — ask the model anything, ideally
something that triggers a tool call. Then open the Jaeger UI at
`http://localhost:16686`, select the `dsh-trajectory-persistence` service, and
you should see a trace shaped like:

```
gen_ai.turn (gen_ai.operation.name=turn)
└── chat (gen_ai.request.model, gen_ai.usage.input_tokens / output_tokens)
    └── execute_tool (gen_ai.tool.name, gen_ai.tool.call.id)
```

One `gen_ai.turn` span per turn, one `chat` span per model step inside it, and
one `execute_tool` span per tool call. See [OTel GenAI Sink](/guide/otel-sink)
for the full event → span mapping.

## Inspecting status

When the harness's commands service is mounted, the plugin registers the
`/trajectory-status` slash command, which reports the switch state, upload
statistics, and the most recent error of each sink:

```
trajectory-persistence status
settings: managed by the settings service (namespace "trajectory-persistence") — edit $DSH_HOME/settings.yaml; changes apply without a restart

s3 sink: enabled
  uploaded parts: 12, dead-lettered: 0
  sessions: 1, buffered events: 34, dropped by overflow: 0
  last upload: 2026-08-17T16:00:00.000Z

otel sink: disabled
```

Independently of this command, the plugin's cordis fiber (with its current
phase) is always visible in the web UI under **Settings → Plugins → 全部**.

## Loading from a source checkout

For local development you can load the plugin without installing it into a
profile — see [Development](/guide/development#running-from-a-source-checkout).
