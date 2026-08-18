/**
 * S3 / S3-compatible (Aliyun OSS, MinIO) trajectory sink.
 *
 * Every session's live event stream is buffered in memory (bounded ring) and
 * uploaded as JSONL part files — header line + one event per line, compatible
 * with the `dsh-session-persistence-jsonl` artifact layout — under
 * `{prefix}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl`.
 *
 * Flush triggers, retry, and the dead-letter fallback are shared with the
 * other part-uploading sinks in `./sink-utils.js`; this module only carries
 * the S3 transport (uploader + key layout).
 *
 * @module dsh-trajectory-persistence/s3-sink
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { encodeSegment, projectKey } from './jsonl.js'
import { BufferedPartSink } from './sink-utils.js'
import type { PartSinkStats } from './sink-utils.js'
import type { S3SinkConfig } from './config.js'

export { EventBuffer } from './sink-utils.js'
/** S3 sink counters — the shared part-sink stats shape. */
export type S3SinkStats = PartSinkStats

/** Minimal object-store upload seam — implemented by the AWS SDK wrapper, mocked in tests. */
export interface ObjectUploader {
  putObject(key: string, body: string): Promise<void>
  close(): Promise<void>
}

/** Build the default uploader backed by `@aws-sdk/client-s3`. */
export function createS3Uploader(config: S3SinkConfig): ObjectUploader {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
  })
  return {
    async putObject(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/x-ndjson',
        }),
      )
    },
    async close() {
      client.destroy()
    },
  }
}

export class S3TrajectorySink extends BufferedPartSink {
  private readonly uploader: ObjectUploader

  constructor(
    ctx: Context,
    private readonly config: S3SinkConfig,
    uploader?: ObjectUploader,
  ) {
    super(ctx, config, 's3')
    if (!config.bucket) throw new Error('s3 sink: bucket is required when the s3 sink is enabled')
    this.uploader = uploader ?? createS3Uploader(config)
  }

  protected async uploadPart(
    header: SessionHeader,
    seqStart: number,
    seqEnd: number,
    body: string,
  ): Promise<void> {
    await this.uploader.putObject(this.keyOf(header, seqStart, seqEnd), body)
  }

  protected partName(header: SessionHeader, seqStart: number, seqEnd: number): string {
    return this.keyOf(header, seqStart, seqEnd)
  }

  protected async release(): Promise<void> {
    await this.uploader.close()
  }

  private keyOf(header: SessionHeader, seqStart: number, seqEnd: number): string {
    const prefix = this.config.prefix.replace(/^\/+|\/+$/g, '')
    const projectId = projectKey(header.cwd)
    const sessionId = encodeSegment(header.id)
    const base = prefix ? `${prefix}/` : ''
    return `${base}${projectId}/${sessionId}/${seqStart}-${seqEnd}.jsonl`
  }
}
