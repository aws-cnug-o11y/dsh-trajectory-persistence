import { describe, expect, it } from 'vitest'
import { Config, validateConfig } from '../src/config.js'
import type { Config as ResolvedConfig, OtelSinkConfig, S3SinkConfig } from '../src/config.js'

function s3Config(): S3SinkConfig {
  return {
    enabled: false,
    bucket: '',
    prefix: 'dsh-trajectories',
    region: 'us-east-1',
    batchSize: 100,
    maxBufferedEvents: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    deadLetterDir: '/nonexistent-deadletter',
  }
}

function otelConfig(overrides: Partial<OtelSinkConfig> = {}): OtelSinkConfig {
  return {
    enabled: true,
    url: '',
    serviceName: 'test',
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5_000,
    shutdownTimeoutMillis: 100,
    ...overrides,
  }
}

function config(otel: OtelSinkConfig): ResolvedConfig {
  return { sinks: { s3: s3Config(), otel } }
}

describe('validateConfig (otel aws)', () => {
  it('rejects an enabled otel sink with neither url nor aws', () => {
    expect(() => validateConfig(config(otelConfig()))).toThrow(/url or sinks\.otel\.aws is required/)
  })

  it('rejects url and aws together (mutually exclusive)', () => {
    expect(() => validateConfig(config(otelConfig({
      url: 'http://localhost:4318/v1/traces',
      aws: { region: 'us-east-1' },
    })))).toThrow(/mutually exclusive/)
  })

  it('rejects an aws block without a region', () => {
    expect(() => validateConfig(config(otelConfig({ aws: { region: '' } })))).toThrow(/aws\.region is required/)
  })

  it('accepts aws with a region and no url', () => {
    expect(() => validateConfig(config(otelConfig({ aws: { region: 'us-east-1' } })))).not.toThrow()
  })

  it('accepts aws with an endpoint override', () => {
    expect(() => validateConfig(config(otelConfig({
      aws: { region: 'cn-north-1', url: 'https://xray.cn-north-1.amazonaws.com.cn/v1/traces' },
    })))).not.toThrow()
  })

  it('still accepts a plain url endpoint without aws', () => {
    expect(() => validateConfig(config(otelConfig({ url: 'http://localhost:4318/v1/traces' })))).not.toThrow()
  })
})

describe('Config schema (otel aws)', () => {
  it('keeps aws absent when not configured', () => {
    const resolved = Config({
      sinks: {
        s3: {},
        otel: { enabled: true, url: 'http://localhost:4318/v1/traces' },
      },
    })
    expect(resolved.sinks.otel.aws).toBeUndefined()
  })

  it('resolves a full aws block', () => {
    const resolved = Config({
      sinks: {
        s3: {},
        otel: { enabled: true, aws: { region: 'us-west-2', service: 'xray' } },
      },
    })
    expect(resolved.sinks.otel.aws).toEqual({ region: 'us-west-2', service: 'xray' })
  })

  it('refuses an aws block without region at schema level', () => {
    expect(() => Config({
      sinks: {
        s3: {},
        otel: { enabled: true, aws: {} },
      },
    })).toThrow(/region/)
  })
})
