import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportResultCode } from '@opentelemetry/core'
import type { ExportResult } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { SigV4OtlpTraceExporter, defaultAwsOtlpUrl } from '../src/sigv4-otlp-exporter.js'
import type { SigV4OtlpTraceExporterConfig } from '../src/sigv4-otlp-exporter.js'
import { OtelTrajectorySink } from '../src/otel-sink.js'
import type { OtelSinkConfig } from '../src/config.js'
import { ev, fakeCtx, fakeSession } from './helpers.js'

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: Uint8Array
}

/** Produce one finished span through the real SDK pipeline. */
function finishedSpans(): ReadableSpan[] {
  const memory = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] })
  const span = provider.getTracer('test').startSpan('chat', {
    startTime: 1_700_000_000_000,
    attributes: { 'gen_ai.operation.name': 'chat' },
  })
  span.end(1_700_000_000_500)
  return memory.getFinishedSpans()
}

function config(
  overrides: Partial<SigV4OtlpTraceExporterConfig> = {},
): SigV4OtlpTraceExporterConfig {
  return { region: 'us-west-2', credentials, ...overrides }
}

function mockFetch(handler?: (call: FetchCall) => Response): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        input: unknown,
        init: { method: string; headers: Record<string, string>; body: Uint8Array },
      ) => {
        const call: FetchCall = {
          url: String(input),
          method: init.method,
          headers: init.headers,
          body: init.body,
        }
        calls.push(call)
        return handler ? handler(call) : new Response('', { status: 200 })
      },
    ),
  )
  return { calls }
}

function exportOnce(
  exporter: SigV4OtlpTraceExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> {
  return new Promise(resolve => exporter.export(spans, resolve))
}

describe('SigV4OtlpTraceExporter', () => {
  beforeEach(() => mockFetch())
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs SigV4-signed OTLP protobuf to the default CloudWatch endpoint', async () => {
    const exporter = new SigV4OtlpTraceExporter(config())
    const { calls } = mockFetch()

    const result = await exportOnce(exporter, finishedSpans())

    expect(result.code).toBe(ExportResultCode.SUCCESS)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://xray.us-west-2.amazonaws.com/v1/traces')
    expect(call.method).toBe('POST')
    expect(call.headers['host']).toBe('xray.us-west-2.amazonaws.com')
    expect(call.headers['content-type']).toBe('application/x-protobuf')
    expect(call.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    expect(call.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(call.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/xray\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    )
    expect(call.body).toBeInstanceOf(Uint8Array)
    expect(call.body.length).toBeGreaterThan(0)
    await exporter.shutdown()
  })

  it('honors a url override (VPC endpoint / non-standard partition)', async () => {
    const exporter = new SigV4OtlpTraceExporter(
      config({
        url: 'https://vpce-0123-xray.cn-north-1.vpce.amazonaws.com.cn/v1/traces',
      }),
    )
    const { calls } = mockFetch()

    const result = await exportOnce(exporter, finishedSpans())

    expect(result.code).toBe(ExportResultCode.SUCCESS)
    expect(calls[0].url).toBe('https://vpce-0123-xray.cn-north-1.vpce.amazonaws.com.cn/v1/traces')
    expect(calls[0].headers['host']).toBe('vpce-0123-xray.cn-north-1.vpce.amazonaws.com.cn')
    // The signing region still comes from `region`, not the overridden host.
    expect(calls[0].headers['authorization']).toContain('/us-west-2/xray/aws4_request')
    await exporter.shutdown()
  })

  it('honors a service override in the credential scope', async () => {
    const exporter = new SigV4OtlpTraceExporter(config({ service: 'custom-service' }))
    const { calls } = mockFetch()

    await exportOnce(exporter, finishedSpans())

    expect(calls[0].headers['authorization']).toContain('/us-west-2/custom-service/aws4_request')
    await exporter.shutdown()
  })

  it('merges custom headers into the signed request', async () => {
    const exporter = new SigV4OtlpTraceExporter(config({ headers: { 'x-custom': 'yes' } }))
    const { calls } = mockFetch()

    await exportOnce(exporter, finishedSpans())

    expect(calls[0].headers['x-custom']).toBe('yes')
    expect(calls[0].headers['authorization']).toMatch(/SignedHeaders=[^,]*x-custom/)
    await exporter.shutdown()
  })

  it('reports FAILED with the HTTP status on a non-2xx response', async () => {
    const exporter = new SigV4OtlpTraceExporter(config())
    mockFetch(() => new Response('AccessDenied', { status: 403 }))

    const result = await exportOnce(exporter, finishedSpans())

    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(String(result.error)).toContain('403')
    expect(String(result.error)).toContain('AccessDenied')
    await exporter.shutdown()
  })

  it('reports FAILED when the request itself rejects', async () => {
    const exporter = new SigV4OtlpTraceExporter(config())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up')
      }),
    )

    const result = await exportOnce(exporter, finishedSpans())

    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(String(result.error)).toContain('socket hang up')
    await exporter.shutdown()
  })

  it('refuses exports after shutdown', async () => {
    const exporter = new SigV4OtlpTraceExporter(config())
    await exporter.shutdown()
    const { calls } = mockFetch()

    const result = await exportOnce(exporter, finishedSpans())

    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(calls).toHaveLength(0)
  })

  it('requires a region', () => {
    expect(() => new SigV4OtlpTraceExporter(config({ region: '' }))).toThrow(/region is required/)
  })

  it('builds the default endpoint from the region', () => {
    expect(defaultAwsOtlpUrl('eu-central-1')).toBe(
      'https://xray.eu-central-1.amazonaws.com/v1/traces',
    )
  })
})

describe('OtelTrajectorySink aws wiring', () => {
  afterEach(() => vi.unstubAllGlobals())

  function sinkConfig(overrides: Partial<OtelSinkConfig> = {}): OtelSinkConfig {
    return {
      enabled: true,
      url: '',
      serviceName: 'test',
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5_000,
      shutdownTimeoutMillis: 3_000,
      ...overrides,
    }
  }

  it('rejects url and aws together', () => {
    expect(
      () =>
        new OtelTrajectorySink(
          fakeCtx(),
          sinkConfig({
            url: 'http://localhost:4318/v1/traces',
            aws: { region: 'us-east-1' },
          }),
        ),
    ).toThrow(/mutually exclusive/)
  })

  it('rejects an enabled sink with neither url nor aws', () => {
    expect(() => new OtelTrajectorySink(fakeCtx(), sinkConfig())).toThrow(/url or aws is required/)
  })

  it('rejects aws without a region', () => {
    expect(() => new OtelTrajectorySink(fakeCtx(), sinkConfig({ aws: { region: '' } }))).toThrow(
      /aws\.region is required/,
    )
  })

  it('ships spans to the CloudWatch endpoint signed with the env credential chain', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', credentials.accessKeyId)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', credentials.secretAccessKey)
    const { calls } = mockFetch()
    const sink = new OtelTrajectorySink(
      fakeCtx(),
      sinkConfig({ aws: { region: 'ap-southeast-2' } }),
    )
    const session = fakeSession()

    sink.onEvent(session, ev('turn/start', 0, { turn: 1 }))
    sink.onEvent(session, ev('turn/end', 1, { turn: 1, reason: { kind: 'completed' } as never }))
    await sink.close()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://xray.ap-southeast-2.amazonaws.com/v1/traces')
    expect(calls[0].headers['authorization']).toContain('/ap-southeast-2/xray/aws4_request')
    expect(calls[0].body.length).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })
})
