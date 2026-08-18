# OTel GenAI Sink

The otel sink maps the dsh session event stream to spans following the
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
and exports them over OTLP HTTP/protobuf — straight to Jaeger, to an OTel
Collector (which can land them in ClickHouse, …), to Langfuse, or
[SigV4-signed to AWS CloudWatch / AgentCore Observability](/guide/aws-cloudwatch).

## Minimal configuration

```yaml
config:
  sinks:
    otel:
      enabled: true
      url: http://localhost:4318/v1/traces
```

`url` is the full OTLP HTTP/protobuf traces endpoint; `aws` replaces it for
[SigV4 delivery](/guide/aws-cloudwatch) (the two are mutually exclusive). The
full field table lives in the
[Configuration Reference](/guide/configuration#sinks-otel).

## Event → GenAI span mapping

| dsh session events | span | key attributes |
|---|---|---|
| `turn/start` … `turn/end` | `gen_ai.turn` | `gen_ai.operation.name=turn`, `gen_ai.conversation.id=<sessionId>`, `dsh.turn`, `dsh.turn.end_reason` at close |
| `step/start` … `step/end` + `assistant/message` + `assistant/chunk` | `chat` (child of turn) | `gen_ai.operation.name=chat`, `gen_ai.request.model` / `gen_ai.provider.name` (from the latest `request/context`), `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (from `assistant/message.usage`, plus `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` when reported), chunk aggregation in `dsh.assistant.*` |
| `tool/call` … `tool/result` (paired by `callId`) | `execute_tool` (child of the step's chat span) | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments` (truncated at 8192 bytes); failures (`error` or `isError`) set span status `ERROR` and `error.type` |

Defensive close-out rules:

- Spans still open when a session is disposed are ended defensively.
- A `tool/call` whose turn ends without `tool/result` is closed with status
  `ERROR`.

Two mapping caveats to be aware of:

- **No model identity on events.** The `chat` span's `gen_ai.request.model`
  comes from the most recent `request/context` event seen in the session;
  sessions that never log one produce spans without the model attribute.
- Usage attributes (`gen_ai.usage.input_tokens` / `output_tokens`) appear only
  when the adapter reported usage on `assistant/message`.

## Batching and resource attributes

Export batching is the standard OTel `BatchSpanProcessor` — tune it with
`maxExportBatchSize` and `scheduledDelayMillis`. `shutdownTimeoutMillis` caps
both a single export attempt and the drain on dispose. All exported spans
carry `service.name = <serviceName>` (`dsh-trajectory-persistence` by
default).

## Backends

Any OTLP HTTP/protobuf endpoint works: set `sinks.otel.url` to the full traces
endpoint and, when the backend needs it, pass auth through `sinks.otel.headers`.

### Jaeger

Run Jaeger with the OTLP receiver (enabled by default in
`jaegertracing/all-in-one`):

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

```yaml
config:
  sinks:
    otel:
      enabled: true
      url: http://localhost:4318/v1/traces
```

Open `http://localhost:16686` and look for the `dsh-trajectory-persistence`
service. Full walkthrough: [Getting Started](/guide/getting-started#first-trace-with-a-local-jaeger).

### OTel Collector → ClickHouse

Point the plugin at the collector (`url: http://localhost:4318/v1/traces`) and
configure the collector with the
[ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter):

```yaml
# otel-collector.yml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000?database=otel
    ttl: 72h
    traces_table_name: otel_traces

service:
  pipelines:
    traces:
      receivers: [otlp]
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

### Langfuse

Langfuse ingests OTLP traces at `/api/public/otel/v1/traces` with Basic auth
built from your public/secret key pair:

```yaml
config:
  sinks:
    otel:
      enabled: true
      url: https://cloud.langfuse.com/api/public/otel/v1/traces   # or your self-hosted host
      headers:
        Authorization: Basic <base64(pk-lf-…:sk-lf-…)>
```

The `gen_ai.*` attributes map onto Langfuse's generation model, so turns show
up as traces with nested model generations and tool spans.

::: tip
`headers` works with any backend — it is a plain map of extra HTTP headers
merged into every OTLP request. When the [SigV4 `aws` mode](/guide/aws-cloudwatch)
is active, `headers` entries are merged into the signed request instead.
:::
