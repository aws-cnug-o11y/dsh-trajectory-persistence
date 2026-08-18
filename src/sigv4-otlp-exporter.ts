/**
 * AWS SigV4-signed OTLP HTTP/protobuf trace exporter.
 *
 * Targets the CloudWatch OTLP traces endpoint
 * (`https://xray.<region>.amazonaws.com/v1/traces`, HTTP only, SigV4-signed
 * with service name `xray`), which is also the ingest path of Bedrock
 * AgentCore Observability — spans land in the CloudWatch `aws/spans` log
 * group and the standard `gen_ai.*` attributes are picked up by the GenAI
 * dashboard (Transaction Search must be enabled in CloudWatch).
 *
 * Serialization reuses the OTel SDK's own `ProtobufTraceSerializer`
 * (`@opentelemetry/otlp-transformer`, the same serializer the upstream OTLP
 * HTTP/protobuf exporter uses); signing goes through `@smithy/signature-v4`
 * — the same stack as `@aws-sdk/client-s3`, no hand-rolled HMAC chain.
 *
 * @module dsh-trajectory-persistence/sigv4-otlp-exporter
 */

import { ExportResultCode } from '@opentelemetry/core'
import type { ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@smithy/core/checksum'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

/** Static AWS credentials; structurally compatible with the smithy credential types. */
export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SigV4OtlpTraceExporterConfig {
  /** AWS region the endpoint lives in (and the signing region). */
  region: string
  /**
   * Full OTLP traces endpoint. Defaults to
   * `https://xray.{region}.amazonaws.com/v1/traces`; override for VPC
   * endpoints or partitions with a different domain (e.g. `amazonaws.com.cn`
   * in the China regions).
   */
  url?: string
  /** SigV4 service name; `xray` for the CloudWatch OTLP endpoint. */
  service?: string
  /** Static credentials or a provider; absent means the AWS default provider chain. */
  credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
  /** Extra HTTP headers merged into every request (custom headers win on conflict). */
  headers?: Record<string, string>
}

/** Default CloudWatch OTLP traces endpoint for a region. */
export function defaultAwsOtlpUrl(region: string): string {
  return `https://xray.${region}.amazonaws.com/v1/traces`
}

/**
 * A {@link SpanExporter} that serializes each batch to OTLP protobuf, signs
 * the POST with SigV4, and sends it to the CloudWatch OTLP endpoint. Export
 * calls never throw: failures are reported through the result callback.
 */
export class SigV4OtlpTraceExporter implements SpanExporter {
  private readonly url: URL
  private readonly signer: SignatureV4
  private readonly headers: Record<string, string>
  private readonly inFlight = new Set<Promise<void>>()
  private closed = false

  constructor(config: SigV4OtlpTraceExporterConfig) {
    if (!config.region) throw new Error('sigv4 otlp exporter: region is required')
    this.url = new URL(config.url ?? defaultAwsOtlpUrl(config.region))
    this.signer = new SignatureV4({
      credentials: config.credentials ?? fromNodeProviderChain(),
      region: config.region,
      service: config.service ?? 'xray',
      sha256: Sha256,
      applyChecksum: true,
    })
    this.headers = { ...config.headers }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.closed) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('sigv4 otlp exporter is shut down'),
      })
      return
    }
    let body: Uint8Array | undefined
    try {
      body = ProtobufTraceSerializer.serializeRequest(spans)
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error })
      return
    }
    if (!body || body.length === 0) {
      // Nothing on the wire for an empty batch; the batch processor only
      // calls export with at least one span, so this is a defensive path.
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }
    const request = this.send(body).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => resultCallback({ code: ExportResultCode.FAILED, error: error as Error }),
    )
    this.inFlight.add(request)
    void request.finally(() => this.inFlight.delete(request))
  }

  /** Sign the protobuf POST and deliver it; rejects on a non-2xx response. */
  private async send(body: Uint8Array): Promise<void> {
    const request = new HttpRequest({
      protocol: this.url.protocol,
      hostname: this.url.hostname,
      ...(this.url.port !== '' ? { port: Number(this.url.port) } : {}),
      path: this.url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        host: this.url.host,
        ...this.headers,
      },
      body,
    })
    const signed = await this.signer.sign(request)
    const response = await fetch(this.url, {
      method: 'POST',
      headers: signed.headers,
      // Copy into a fresh buffer: fetch requires a non-shared ArrayBuffer.
      body: new Uint8Array(signed.body as Uint8Array),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 512)
      throw new Error(
        `sigv4 otlp export failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      )
    }
  }

  /** Refuse further exports and wait for the in-flight ones to settle. */
  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.inFlight])
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }
}
