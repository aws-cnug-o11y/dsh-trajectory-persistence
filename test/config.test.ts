import { describe, expect, it, vi } from 'vitest'
import { Config, validateConfig } from '../src/config.js'
import type { Config as ResolvedConfig, OtelSinkConfig, S3SinkConfig } from '../src/config.js'

function s3Config(overrides: Partial<S3SinkConfig> = {}): S3SinkConfig {
  return {
    enabled: false,
    mode: 'push',
    bucket: '',
    prefix: 'dsh-trajectories',
    region: 'us-east-1',
    batchSize: 100,
    maxBufferedEvents: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    deadLetterDir: '/nonexistent-deadletter',
    root: '/nonexistent-sessions',
    pollIntervalMs: 5_000,
    segmentBytes: 262_144,
    segmentMaxDelayMs: 60_000,
    dormantAfterMs: 300_000,
    ...overrides,
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
    expect(() => validateConfig(config(otelConfig()))).toThrow(
      /url or sinks\.otel\.aws is required/,
    )
  })

  it('rejects url and aws together (mutually exclusive)', () => {
    expect(() =>
      validateConfig(
        config(
          otelConfig({
            url: 'http://localhost:4318/v1/traces',
            aws: { region: 'us-east-1' },
          }),
        ),
      ),
    ).toThrow(/mutually exclusive/)
  })

  it('rejects an aws block without a region', () => {
    expect(() => validateConfig(config(otelConfig({ aws: { region: '' } })))).toThrow(
      /aws\.region is required/,
    )
  })

  it('accepts aws with a region and no url', () => {
    expect(() => validateConfig(config(otelConfig({ aws: { region: 'us-east-1' } })))).not.toThrow()
  })

  it('accepts aws with an endpoint override', () => {
    expect(() =>
      validateConfig(
        config(
          otelConfig({
            aws: {
              region: 'cn-north-1',
              url: 'https://xray.cn-north-1.amazonaws.com.cn/v1/traces',
            },
          }),
        ),
      ),
    ).not.toThrow()
  })

  it('still accepts a plain url endpoint without aws', () => {
    expect(() =>
      validateConfig(config(otelConfig({ url: 'http://localhost:4318/v1/traces' }))),
    ).not.toThrow()
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
    expect(() =>
      Config({
        sinks: {
          s3: {},
          otel: { enabled: true, aws: {} },
        },
      }),
    ).toThrow(/region/)
  })
})

describe('Config schema (s3 ship mode)', () => {
  it('defaults to push mode with ship fields resolved', () => {
    const resolved = Config({ sinks: { s3: {}, otel: {} } })
    expect(resolved.sinks.s3.mode).toBe('push')
    expect(resolved.sinks.s3.root).toMatch(/\/sessions$/)
    expect(resolved.sinks.s3.pollIntervalMs).toBe(5_000)
    expect(resolved.sinks.s3.segmentBytes).toBe(262_144)
    expect(resolved.sinks.s3.segmentMaxDelayMs).toBe(60_000)
    expect(resolved.sinks.s3.dormantAfterMs).toBe(300_000)
    expect(resolved.sinks.s3.writerId).toBeUndefined()
  })

  it('defaults root to $DSH_HOME/sessions when DSH_HOME is set', async () => {
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = '/custom/dsh'
    try {
      // The default is computed at module load, so re-import with a fresh registry.
      vi.resetModules()
      const fresh = await import('../src/config.js')
      const resolved = fresh.Config({ sinks: { s3: {}, otel: {} } })
      expect(resolved.sinks.s3.root).toBe('/custom/dsh/sessions')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      vi.resetModules()
    }
  })

  it('accepts ship mode with its fields', () => {
    const resolved = Config({
      sinks: {
        s3: { mode: 'ship', root: '/data/sessions', pollIntervalMs: 1000, writerId: 'w-1' },
        otel: {},
      },
    })
    expect(resolved.sinks.s3.mode).toBe('ship')
    expect(resolved.sinks.s3.root).toBe('/data/sessions')
    expect(resolved.sinks.s3.pollIntervalMs).toBe(1000)
    expect(resolved.sinks.s3.writerId).toBe('w-1')
  })

  it('rejects an unknown mode at schema level', () => {
    expect(() => Config({ sinks: { s3: { mode: 'pull' }, otel: {} } })).toThrow()
  })
})

describe('validateConfig (s3 ship mode)', () => {
  it('rejects ship mode with an empty root when enabled', () => {
    expect(() =>
      validateConfig({
        sinks: {
          s3: s3Config({ enabled: true, bucket: 'b', mode: 'ship', root: '' }),
          otel: otelConfig({ enabled: false }),
        },
      }),
    ).toThrow(/sinks\.s3\.root is required/)
  })

  it('accepts ship mode with a root when enabled', () => {
    expect(() =>
      validateConfig({
        sinks: {
          s3: s3Config({ enabled: true, bucket: 'b', mode: 'ship', root: '/data/sessions' }),
          otel: otelConfig({ enabled: false }),
        },
      }),
    ).not.toThrow()
  })

  it('tolerates an empty root when ship mode is disabled', () => {
    expect(() =>
      validateConfig({
        sinks: { s3: s3Config({ mode: 'ship', root: '' }), otel: otelConfig({ enabled: false }) },
      }),
    ).not.toThrow()
  })
})
