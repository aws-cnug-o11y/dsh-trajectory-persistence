/**
 * Plugin configuration: two independently toggleable sinks under `sinks`.
 *
 * @module dsh-trajectory-persistence/config
 */

import z from '@deepseek-ai/schemastery'

/** S3 / S3-compatible (OSS, MinIO) sink configuration. */
export interface S3SinkConfig {
  /** Master switch for this sink. */
  enabled: boolean
  /** Target bucket. */
  bucket: string
  /** Key prefix; parts land at `{prefix}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl`. */
  prefix: string
  /** AWS region (or the endpoint's signing region for S3-compatible stores). */
  region: string
  /** Custom endpoint for S3-compatible object stores (Aliyun OSS, MinIO, …). */
  endpoint?: string
  /** Path-style addressing — required by MinIO and most OSS-compatible endpoints. */
  forcePathStyle?: boolean
  /** Static credentials; absent means the default AWS provider chain (env, shared config, IAM). */
  credentials?: { accessKeyId: string; secretAccessKey: string }
  /** Flush a session's buffer once it holds at least this many events. */
  batchSize: number
  /** Upper bound of buffered events per session; oldest events are dropped (with a warning) beyond it. */
  maxBufferedEvents: number
  /** Retries after the first upload attempt (exponential backoff). */
  maxRetries: number
  /** Base backoff delay in milliseconds. */
  retryBaseDelayMs: number
  /** Local directory receiving parts whose upload finally failed (dead letter). */
  deadLetterDir: string
}

/** OTel GenAI span sink configuration. */
export interface OtelSinkConfig {
  /** Master switch for this sink. */
  enabled: boolean
  /** Full OTLP HTTP/protobuf traces endpoint (e.g. `http://localhost:4318/v1/traces`). */
  url: string
  /** Extra OTLP HTTP headers (e.g. auth). */
  headers?: Record<string, string>
  /** `service.name` resource attribute of exported spans. */
  serviceName: string
  /** BatchSpanProcessor's maximum export batch size. */
  maxExportBatchSize: number
  /** BatchSpanProcessor's scheduled delay in milliseconds. */
  scheduledDelayMillis: number
  /** Maximum time spent awaiting the provider's shutdown drain. */
  shutdownTimeoutMillis: number
}

export interface Config {
  sinks: {
    s3: S3SinkConfig
    otel: OtelSinkConfig
  }
}

const S3SinkSchema = z.object({
    enabled: z.boolean().default(false),
    bucket: z.string().default(''),
    prefix: z.string().default('dsh-trajectories'),
    region: z.string().default('us-east-1'),
    endpoint: z.string(),
    forcePathStyle: z.boolean(),
    credentials: z.object({
      accessKeyId: z.string().required(),
      secretAccessKey: z.string().required(),
      // Object schemas default to `{}` in schemastery; reset to `undefined` so
      // absent credentials stay absent (AWS default chain) while a present but
      // incomplete object fails validation.
    }).default(undefined as never),
    batchSize: z.number().min(1).step(1).default(100),
    maxBufferedEvents: z.number().min(1).step(1).default(10_000),
    maxRetries: z.number().min(0).step(1).default(3),
    retryBaseDelayMs: z.number().min(0).step(1).default(200),
    deadLetterDir: z.string().default('.dsh/trajectory-deadletter'),
  })

const OtelSinkSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  headers: z.dict(z.string()),
  serviceName: z.string().default('dsh-trajectory-persistence'),
  maxExportBatchSize: z.number().min(1).step(1).default(512),
  scheduledDelayMillis: z.number().min(0).step(1).default(5_000),
  shutdownTimeoutMillis: z.number().min(0).step(1).default(3_000),
})

export const Config: z<Config> = z.object({
  sinks: z.object({
    s3: S3SinkSchema,
    otel: OtelSinkSchema,
  }),
})

/**
 * Cross-field constraints the schema cannot express. Passed to the settings
 * namespace as its `validate` hook (a violating settings.yaml write is
 * refused); the sink constructors enforce the same rules on the composed
 * config path.
 */
export function validateConfig(config: Config): void {
  const { s3, otel } = config.sinks
  if (s3.enabled && !s3.bucket) throw new Error('sinks.s3.bucket is required when the s3 sink is enabled')
  if (s3.enabled && s3.batchSize > s3.maxBufferedEvents) {
    throw new Error(`sinks.s3.batchSize (${s3.batchSize}) must not exceed sinks.s3.maxBufferedEvents (${s3.maxBufferedEvents})`)
  }
  if (otel.enabled && !otel.url) {
    throw new Error('sinks.otel.url is required when the otel sink is enabled (the full OTLP traces endpoint)')
  }
}
