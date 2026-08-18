# Getting Started

`dsh-trajectory-persistence` is an observe-only plugin for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`):
it never writes to a session — it persists every session's trajectory to two
independently toggleable sinks, S3/OSS (JSONL parts in `mode: 'push'`, or
byte-faithful zstd segments in `mode: 'ship'`) and OpenTelemetry GenAI spans.
Requires Node.js ≥ 22, matching the harness.

::: warning Compatibility notice
The DeepSeek Harness is in developer preview with no compatibility guarantees.
This plugin was built and verified against monorepo commit
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
(`master` as of 2026-08-14, `@deepseek-ai/dsh-session@0.1.0-rc.6`).
:::

## Install

The package is published on npm and carries the bundle manifest the dsh CLI
expects:

```sh
dsh plugin --profile web add dsh-trajectory-persistence
```

All sinks default to **disabled**, so the plugin loads as an inert no-op until
you enable one.

## Enable a sink

The fastest path is `$DSH_HOME/settings.yaml`. The plugin registers the
`trajectory-persistence` settings namespace, deep-merges your keys on top of
the composed config, and applies every committed change **live, without a
restart**:

```yaml
# $DSH_HOME/settings.yaml
trajectory-persistence:
  sinks:
    otel:
      enabled: true
      url: http://localhost:4318/v1/traces
```

Config can also live in profile `cordis.patch.yml` layers — see the
[Configuration Reference](/guide/configuration) for every field, the layering
rules, and the validation behavior.

## First trace with a local Jaeger

The quickest end-to-end check is a local Jaeger all-in-one, which enables the
OTLP receiver by default:

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

Start `dsh` and run one turn in a session — ideally something that triggers a
tool call. Open the Jaeger UI at `http://localhost:16686`, select the
`dsh-trajectory-persistence` service, and you should see a trace shaped like:

```
gen_ai.turn (gen_ai.operation.name=turn)
└── chat (gen_ai.request.model, gen_ai.usage.input_tokens / output_tokens)
    └── execute_tool (gen_ai.tool.name, gen_ai.tool.call.id)
```

One `gen_ai.turn` span per turn, one `chat` span per model step inside it, one
`execute_tool` span per tool call. The full mapping is documented in
[OTel GenAI Sink](/guide/otel-sink).

## Inspecting status

When the harness's commands service is mounted, the plugin registers the
`/trajectory-status` slash command, which reports each sink's switch state,
counters, and most recent error:

```
trajectory-persistence status
settings: managed by the settings service (namespace "trajectory-persistence") — edit $DSH_HOME/settings.yaml; changes apply without a restart

s3 sink: disabled

otel sink: enabled
  sessions: 1, open spans: 3
```

The plugin's cordis fiber (with its current phase) is also visible in the web
UI under **Settings → Plugins**.

## Next steps

- [Ship & Sync](/guide/ship-sync) — `mode: 'ship'`: byte-faithful segments,
  the `_manifest.json` watermark, and moving a session to another machine with
  `sync-down`.
- [S3 Sink](/guide/s3-sink) — `mode: 'push'`: JSONL part layout, buffering,
  retry, and the dead-letter directory.
- [OTel GenAI Sink](/guide/otel-sink) — the full event → span mapping and
  backend recipes (Jaeger, OTel Collector → ClickHouse, Langfuse).
- [AWS CloudWatch & AgentCore](/guide/aws-cloudwatch) — SigV4-signed OTLP
  straight to CloudWatch, no collector.
- [Configuration Reference](/guide/configuration) — every field, defaults,
  validation, and hot-reload semantics.
