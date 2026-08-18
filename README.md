# dsh-trajectory-persistence

Trajectory persistence plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
An observe-only cordis plugin that subscribes to the session event firehose
(`session/event` / `session/created` / `session/flush` / `session/disposed`)
and persists every session's trajectory to two **independently toggleable** sinks:

- **S3 / OSS sink** — JSONL part files compatible with the
  `@deepseek-ai/dsh-session-persistence-jsonl` artifact layout (header line +
  one event per line), with a bounded in-memory ring buffer, batch uploads,
  exponential-backoff retry, and a local dead-letter directory.
- **OTel GenAI sink** — spans following the
  [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
  exported over OTLP HTTP/protobuf straight to Jaeger, to an OTel Collector
  (which can land them in ClickHouse, …), or SigV4-signed to AWS CloudWatch /
  Bedrock AgentCore Observability.

> **Compatibility notice.** The DeepSeek Harness is in developer preview with no
> compatibility guarantees. This plugin was built and verified against monorepo
> commit [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)
> (`master` as of 2026-08-14, `@deepseek-ai/dsh-session@0.1.0-rc.6`).

## Architecture

```mermaid
flowchart LR
    subgraph dsh [DeepSeek Harness]
        SS[SessionStore<br/>ctx.sessions] -->|session/created| P
        SS -->|session/event seq-ordered firehose| P
        SS -->|session/flush| P
        SS -->|session/disposed| P
        P[dsh-trajectory-persistence<br/>observe-only plugin]
    end
    subgraph sinks [Sinks — independently enabled]
        S3S[S3 sink<br/>ring buffer + batcher<br/>backoff retry]
        OTS[OTel GenAI sink<br/>GenAISpanMapper<br/>BatchSpanProcessor]
    end
    P --> S3S
    P --> OTS
    S3S -->|PutObject JSONL parts<br/>prefix/projectId/sessionId/seqStart-seqEnd.jsonl| S3[(AWS S3 / Aliyun OSS / MinIO)]
    S3S -->|final failure| DL[(local dead-letter dir)]
    OTS -->|OTLP HTTP/protobuf| J[Jaeger :4318]
    OTS -->|OTLP HTTP/protobuf| C[OTel Collector]
    OTS -->|OTLP + SigV4| CW[(CloudWatch / AgentCore Observability)]
    C -->|clickhouse exporter| CH[(ClickHouse)]
```

### Event → GenAI span mapping

| dsh session events | span | key attributes |
|---|---|---|
| `turn/start` … `turn/end` | `gen_ai.turn` | `gen_ai.operation.name=turn`, `gen_ai.conversation.id=<sessionId>` |
| `step/start` … `step/end` + `assistant/message` + `assistant/chunk` | `chat` (child of turn) | `gen_ai.operation.name=chat`, `gen_ai.request.model` (from the latest `request/context`), `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (from `assistant/message.usage`), chunk aggregation in `dsh.assistant.*` |
| `tool/call` … `tool/result` (paired by `callId`) | `execute_tool` (child of the step's chat span) | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments` (truncated at 8192 characters); failures (`error` or `isError`) set span status `ERROR` |

Spans still open when a session is disposed are ended defensively; a
`tool/call` whose turn ends without `tool/result` is closed with status `ERROR`.

### S3 sink flush triggers

1. `session/flush` event (the harness's durability checkpoint),
2. the session's buffer reaching `batchSize` events,
3. `session/disposed`,
4. cordis fiber disposal (graceful drain of all sinks).

Each flush uploads part files named `{prefix}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl`,
where `projectId` is the readable `projectKey(cwd)` slug (`_no-cwd` when the
session has no cwd) and `sessionId` is `~XXXX`-escaped — byte-compatible with
the jsonl persistence backend's encoding. Every part starts with the
`type: "session"` header line, so each part is independently parseable.

Uploads retry `maxRetries` times with exponential backoff (retry `n` waits
`retryBaseDelayMs * 2^(n-1)`, plus 25 % jitter). A part that still fails is written verbatim to
`{deadLetterDir}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl`.

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
the full `config` block), or — with no restart at all — through
`settings.yaml`, see [Live settings & status](#live-settings--status):

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

## Live settings & status

The plugin integrates two optional harness capabilities. Both degrade
gracefully: on a profile without the settings or commands service the plugin
loads exactly as before, just without these two features.

### `settings.yaml` switches (hot-reload)

When a settings provider is mounted (the standard harness profiles have one),
the plugin registers its whole `Config` schema as the **`trajectory-persistence`
settings namespace**. The composed plugin config (cordis.patch.yml layers)
becomes the base; `$DSH_HOME/settings.yaml` layers on top of it — deep-merged,
so you only restate the keys you change:

```yaml
# $DSH_HOME/settings.yaml
trajectory-persistence:
  sinks:
    s3:
      enabled: true
      bucket: my-trajectory-bucket
```

Every committed change applies **live, without a restart**: the plugin compares
the newly resolved config per sink and rebuilds exactly the sinks whose
effective config changed (`sinks.s3.*` and `sinks.otel.*` are independent). The
replaced sink first drains — buffered events are uploaded or dead-lettered,
open spans are ended and flushed — so no trajectory data is lost on a switch.
New session events go to the new sink immediately. A rebuild whose config the
sink cannot use keeps the previous sink running and logs a warning; a write
that violates the cross-field rules (`sinks.s3.enabled` without `bucket`,
`batchSize > maxBufferedEvents`, `sinks.otel.enabled` without `url` or `aws`,
`sinks.otel.url` together with `sinks.otel.aws`) is refused
upfront by the namespace's validate hook, before anything persists. If the
settings service itself goes away, the plugin falls back to the composed
config.

### `/trajectory-status`

When the commands service is mounted, the plugin registers a slash command
that reports the switch state, upload statistics, and the most recent error
of each sink, plus whether the settings namespace has taken over the config:

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

## Configuration reference

```yaml
config:
  sinks:
    s3:
      enabled: false                    # master switch
      bucket: ''                        # required when enabled
      prefix: dsh-trajectories          # key prefix
      region: us-east-1                 # signing region
      endpoint: ~                       # S3-compatible endpoint (OSS, MinIO)
      forcePathStyle: ~                 # path-style addressing (MinIO, OSS)
      credentials: ~                    # { accessKeyId, secretAccessKey }; absent = AWS default chain
      batchSize: 100                    # flush trigger: buffered events per session
      maxBufferedEvents: 10000          # ring cap; oldest dropped with a warning beyond it
      maxRetries: 3                     # retries after the first attempt
      retryBaseDelayMs: 200             # backoff base (retry n waits base * 2^(n-1) + jitter)
      deadLetterDir: .dsh/trajectory-deadletter
    otel:
      enabled: false
      url: ''                           # full OTLP traces endpoint, e.g. http://jaeger:4318/v1/traces (mutually exclusive with aws)
      aws: ~                            # { region, url?, service? }; SigV4-signed OTLP to CloudWatch / AgentCore
      headers: ~                        # extra HTTP headers (auth, …)
      serviceName: dsh-trajectory-persistence
      maxExportBatchSize: 512           # BatchSpanProcessor
      scheduledDelayMillis: 5000        # BatchSpanProcessor
      shutdownTimeoutMillis: 3000       # dispose drain allowance
```

### AWS S3

```yaml
config:
  sinks:
    s3:
      enabled: true
      bucket: prod-dsh-trajectories
      prefix: trajectories
      region: ap-southeast-1
      # credentials omitted: the AWS default provider chain applies
      # (env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, shared config, IAM role)
```

### Aliyun OSS (S3-compatible endpoint)

```yaml
config:
  sinks:
    s3:
      enabled: true
      bucket: dsh-trajectories
      prefix: trajectories
      region: oss-cn-hangzhou
      endpoint: https://oss-cn-hangzhou.aliyuncs.com
      forcePathStyle: true
      credentials:
        accessKeyId: ${OSS_ACCESS_KEY_ID}
        secretAccessKey: ${OSS_ACCESS_KEY_SECRET}
```

MinIO is the same shape: `endpoint: http://minio:9000`, `forcePathStyle: true`.

### Jaeger (OTLP)

Run Jaeger with the OTLP receiver (enabled by default in `jaegertracing/all-in-one`),
then:

```yaml
config:
  sinks:
    otel:
      enabled: true
      url: http://localhost:4318/v1/traces
```

### AWS CloudWatch / Bedrock AgentCore Observability (SigV4)

Instead of a plain OTLP endpoint, the otel sink can sign each batch with
AWS SigV4 and POST it straight to the
[CloudWatch OTLP endpoint](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)
(`https://xray.<region>.amazonaws.com/v1/traces`, service name `xray`) — the
same ingest path Bedrock AgentCore Observability uses. Spans land in the
CloudWatch `aws/spans` log group, and the standard `gen_ai.*` span attributes
this sink already emits are recognized by the CloudWatch GenAI observability
dashboard (enable **Transaction Search** in CloudWatch to see them).

```yaml
config:
  sinks:
    otel:
      enabled: true
      aws:
        region: us-west-2
        # url: ~      # endpoint override — VPC endpoint or another partition
                        # (e.g. https://xray.cn-north-1.amazonaws.com.cn/v1/traces)
        # service: ~  # SigV4 service name override; defaults to xray
```

`aws` is mutually exclusive with `url`, and `aws.region` is required.
Credentials come from the **AWS default provider chain** — nothing to put in
the config. For static credentials, use the environment:

```sh
export AWS_ACCESS_KEY_ID=<your-access-key-id>
export AWS_SECRET_ACCESS_KEY=<your-secret-access-key>
# export AWS_SESSION_TOKEN=<your-session-token>   # only for temporary credentials
```

Extra entries in `headers` are merged into the signed request as usual.

### OTel Collector → ClickHouse

Point the plugin at the collector:

```yaml
config:
  sinks:
    otel:
      enabled: true
      url: http://localhost:4318/v1/traces
```

Collector configuration (`otel-collector.yml`), using the
[ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    send_batch_size: 1000
    timeout: 5s

exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000?database=otel
    ttl: 72h
    traces_table_name: otel_traces

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouse]
```

The GenAI span attributes (`gen_ai.operation.name`, `gen_ai.conversation.id`,
`gen_ai.usage.input_tokens`, `gen_ai.tool.name`, …) land in the ClickHouse
trace table's attributes map and are directly queryable, e.g. token usage per
conversation:

```sql
SELECT
  SpanAttributes['gen_ai.conversation.id'] AS session,
  sum(toUInt64OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS output_tokens
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.operation.name'] = 'chat'
GROUP BY session
ORDER BY output_tokens DESC;
```

## Local development with `--patch`

You can load the plugin straight from a source checkout, without installing it
into a profile:

```sh
git clone <this-repo> && cd dsh-trajectory-persistence
pnpm install && pnpm build

# overlay patch that points at the local build ($PWD expands to the checkout)
cat > /tmp/traj.patch.yml <<YAML
- insert:
    - id: trajectory-persistence
      name: file://$PWD/lib/index.js
      config:
        sinks:
          otel:
            enabled: true
            url: http://localhost:4318/v1/traces
YAML

dsh web --patch /tmp/traj.patch.yml        # or: dsh tui / pnpm dsh web from a source checkout
```

`--patch` overlays apply after bundle and profile patches, so the row above
wins over any installed `trajectory-persistence` row.

## Development

```sh
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # vitest: span mapping, S3 buffering/flush triggers, retry
```

Layout:

```
├── cordis.patch.yml     # bundle layer: inserts the plugin row (sinks disabled)
├── src/
│   ├── index.ts         # cordis plugin entry: name/inject/Config/apply, event wiring, dispose drain,
│   │                    #   settings namespace + /trajectory-status registration (optional capabilities)
│   ├── config.ts        # Schemastery schema (sinks.s3 / sinks.otel) + cross-field validateConfig
│   ├── sinks.ts         # TrajectorySinks: hot-swappable sinks, per-sink rebuild, status snapshot
│   ├── jsonl.ts         # jsonl-persistence-compatible header line, projectKey, encodeSegment
│   ├── sink-utils.ts    # EventBuffer (ring) + BufferedPartSink (batch/retry/dead-letter, stats())
│   ├── s3-sink.ts       # S3TrajectorySink: S3 transport (uploader + key layout) over BufferedPartSink
│   ├── otel-sink.ts     # GenAISpanMapper (pure mapping) + OtelTrajectorySink (OTLP pipeline)
│   ├── sigv4-otlp-exporter.ts # SigV4-signed OTLP exporter: CloudWatch / AgentCore Observability
│   └── retry.ts         # exponential backoff helper
└── test/                # vitest: otel-map, sigv4-otlp-exporter, config, s3-sink, sinks (rebuild),
                         #   retry, integration (real cordis ctx)
```

## Notes & caveats

- **Imports.** Only published packages are used: `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-session` (type-only, for `Session` / `SessionEvent` /
  `SessionHeader` and its cordis event augmentation), `@deepseek-ai/schemastery`,
  `@deepseek-ai/dsh-settings` (runtime, for `installSettingsSection` /
  `settingsNamespace`), and `@deepseek-ai/dsh-commands` (type-only: the command
  registry is reached through `ctx.commands`, so no runtime import is needed).
  The header-line / path-encoding helpers of
  `@deepseek-ai/dsh-session-persistence-jsonl` are **reimplemented** in
  `src/jsonl.ts` (kept byte-compatible): the published jsonl package loads a
  native zstd binding (`koffi`) at import time, which a remote-only sink must
  not require. If the monorepo changes that format, update `src/jsonl.ts`.
- **No model identity on events.** The `chat` span's `gen_ai.request.model`
  comes from the most recent `request/context` event seen in the session;
  sessions that never log one produce spans without the model attribute.
- **Observation, not authoring.** This plugin never writes through
  `Session.append`; it is purely a consumer of the firehose. The `session/flush`
  listener returns the sink's upload promise, so the harness's awaited
  durability checkpoint covers this sink: a settled flush means the buffered
  trajectory has been uploaded (or dead-lettered after exhausting retries).
  Turn latency is unaffected — only the checkpoint itself waits.
- Requires Node.js ≥ 22 (matching the harness).
