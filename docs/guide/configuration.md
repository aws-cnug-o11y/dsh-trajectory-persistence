# Configuration Reference

All configuration lives under the plugin's `config` key, in two independently
toggleable sinks. Both default to **disabled**.

```yaml
config:
  sinks:
    s3:
      enabled: false                    # master switch
      mode: push                        # 'push' (event stream) | 'ship' (tail on-disk artifact)
      bucket: ''                        # required when enabled
      prefix: dsh-trajectories          # key prefix
      region: us-east-1                 # signing region
      endpoint: ~                       # S3-compatible endpoint (OSS, MinIO)
      forcePathStyle: ~                 # path-style addressing (MinIO, OSS)
      credentials: ~                    # { accessKeyId, secretAccessKey }; absent = AWS default chain
      batchSize: 100                    # push: flush trigger, buffered events per session
      maxBufferedEvents: 10000          # push: ring cap; oldest dropped with a warning beyond it
      maxRetries: 3                     # retries after the first attempt
      retryBaseDelayMs: 200             # backoff base (retry n waits base * 2^(n-1) + jitter)
      deadLetterDir: .dsh/trajectory-deadletter  # push: parts whose upload finally failed
      root: ~/.dsh/sessions             # ship: official jsonl backend's session root ($DSH_HOME/sessions)
      pollIntervalMs: 5000              # ship: poll interval for artifact growth
      segmentBytes: 262144              # ship: target segment size (never splits a zstd frame)
      segmentMaxDelayMs: 60000          # ship: ship a short segment after this without growth
      dormantAfterMs: 300000            # ship: dormant after this without change
      writerId: ~                       # ship: stable writer identity override
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

## `sinks.s3`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch for this sink. |
| `mode` | `'push' \| 'ship'` | `'push'` | Delivery mode: `push` buffers live events and uploads JSONL parts (legacy, default — see [S3](/guide/s3-sink)); `ship` tails the official jsonl backend's on-disk artifact and uploads zstd frame segments (see [Ship & Sync](/guide/ship-sync)). |
| `bucket` | string | `''` | Target bucket. **Required when enabled.** |
| `prefix` | string | `dsh-trajectories` | Key prefix; push parts land at `{prefix}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl`, ship segments at `{prefix}/{projectDir}/{sessionId}/{offsetStart}-{offsetEnd}.jsonl.zstd`. |
| `region` | string | `us-east-1` | AWS region (or the endpoint's signing region for S3-compatible stores). |
| `endpoint` | string? | — | Custom endpoint for S3-compatible object stores (Aliyun OSS, MinIO, …). |
| `forcePathStyle` | boolean? | — | Path-style addressing — required by MinIO and most OSS-compatible endpoints. |
| `credentials` | object? | — | `{ accessKeyId, secretAccessKey }` (both required if the object is present). Absent means the AWS default provider chain (env, shared config, IAM role). |
| `batchSize` | integer ≥ 1 | `100` | Push mode: flush a session's buffer once it holds at least this many events. |
| `maxBufferedEvents` | integer ≥ 1 | `10000` | Push mode: upper bound of buffered events per session; oldest events are dropped (with a warning) beyond it. |
| `maxRetries` | integer ≥ 0 | `3` | Retries after the first upload attempt (exponential backoff). |
| `retryBaseDelayMs` | integer ≥ 0 | `200` | Base backoff delay; retry `n` waits `retryBaseDelayMs * 2^(n-1)` plus 25 % jitter. |
| `deadLetterDir` | string | `.dsh/trajectory-deadletter` | Push mode: local directory receiving parts whose upload finally failed. |
| `root` | string | `$DSH_HOME/sessions` (or `~/.dsh/sessions`) | Ship mode: root directory of the official jsonl backend's session artifacts. **Required in ship mode.** |
| `pollIntervalMs` | integer ≥ 1 | `5000` | Ship mode: poll interval for artifact growth, in milliseconds. |
| `segmentBytes` | integer ≥ 1 | `262144` | Ship mode: target segment size in bytes; segments never split a zstd frame. |
| `segmentMaxDelayMs` | integer ≥ 0 | `60000` | Ship mode: ship a short segment after this many milliseconds without growth. |
| `dormantAfterMs` | integer ≥ 0 | `300000` | Ship mode: mark a session dormant after this many milliseconds without change. |
| `writerId` | string? | — | Ship mode: stable writer identity override; defaults to the persisted per-machine id. |

## `sinks.otel`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch for this sink. |
| `url` | string | `''` | Full OTLP HTTP/protobuf traces endpoint (e.g. `http://localhost:4318/v1/traces`). **Mutually exclusive with `aws`.** |
| `aws` | object? | — | AWS delivery: SigV4-signed OTLP to CloudWatch / Bedrock AgentCore Observability. See below. |
| `headers` | map&lt;string&gt;? | — | Extra OTLP HTTP headers (auth, …). With `aws`, merged into the signed request. |
| `serviceName` | string | `dsh-trajectory-persistence` | `service.name` resource attribute of exported spans. |
| `maxExportBatchSize` | integer ≥ 1 | `512` | BatchSpanProcessor's maximum export batch size. |
| `scheduledDelayMillis` | integer ≥ 0 | `5000` | BatchSpanProcessor's scheduled delay in milliseconds. |
| `shutdownTimeoutMillis` | integer ≥ 0 | `3000` | Maximum time spent awaiting the provider's shutdown drain. |

### `sinks.otel.aws`

| Field | Type | Default | Description |
|---|---|---|---|
| `region` | string | — | AWS region of the endpoint (and the signing region). **Required when `aws` is present.** |
| `url` | string? | `https://xray.{region}.amazonaws.com/v1/traces` | Full OTLP traces endpoint override — VPC endpoints or partitions with a different domain (e.g. `amazonaws.com.cn`). |
| `service` | string? | `xray` | SigV4 service name; `xray` for the CloudWatch OTLP endpoint. |

Credentials never go in the config: the AWS default provider chain applies
(env, shared config, IAM role).

## Cross-field validation rules

The schema cannot express these, so `validateConfig` enforces them — both on
the composed config path (a violating config fails plugin load) and as the
settings namespace's `validate` hook (a violating `settings.yaml` write is
refused upfront, before anything persists):

- `sinks.s3.enabled` requires `sinks.s3.bucket`.
- `sinks.s3.batchSize` must not exceed `sinks.s3.maxBufferedEvents`.
- `sinks.s3.root` is required when `sinks.s3.mode` is `'ship'` (a non-empty
  default exists, so this only bites if you explicitly blank it).
- `sinks.otel.enabled` requires `sinks.otel.url` **or** `sinks.otel.aws`.
- `sinks.otel.url` and `sinks.otel.aws` are mutually exclusive (`aws` already
  implies its endpoint).
- `sinks.otel.aws.region` is required when `aws` delivery is configured.

## Hot-reload behavior

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

Every committed change applies **live, without a restart**:

- The plugin compares the newly resolved config per sink and rebuilds exactly
  the sinks whose effective config changed (`sinks.s3.*` and `sinks.otel.*`
  are independent).
- The replaced sink first **drains** — buffered events are uploaded or
  dead-lettered, open spans are ended and flushed — so no trajectory data is
  lost on a switch. New session events go to the new sink immediately.
- A rebuild whose config the sink cannot use keeps the previous sink running
  and logs a warning.
- A write that violates the cross-field rules above is refused upfront by the
  namespace's validate hook, before anything persists.
- If the settings service itself goes away, the plugin falls back to the
  composed config.

## Profile recipes

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

More backends: [Jaeger, OTel Collector, Langfuse](/guide/otel-sink#backends) ·
[AWS CloudWatch / AgentCore (SigV4)](/guide/aws-cloudwatch).
