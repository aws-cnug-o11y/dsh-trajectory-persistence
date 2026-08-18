import { describe, expect, it, vi, beforeEach } from 'vitest'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { TrajectorySinks } from '../src/sinks.js'
import type { SinkFactories } from '../src/sinks.js'
import { S3TrajectorySink } from '../src/s3-sink.js'
import type { ObjectUploader } from '../src/s3-sink.js'
import { OtelTrajectorySink } from '../src/otel-sink.js'
import type { Config, OtelSinkConfig, S3SinkConfig } from '../src/config.js'
import { ev, fakeCtx, fakeSession, resetClock } from './helpers.js'

class MockUploader implements ObjectUploader {
  puts: { key: string; body: string }[] = []

  async putObject(key: string, body: string): Promise<void> {
    this.puts.push({ key, body })
  }

  async close(): Promise<void> {}
}

function s3Config(overrides: Partial<S3SinkConfig> = {}): S3SinkConfig {
  return {
    enabled: true,
    mode: 'push',
    bucket: 'bucket-1',
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
    url: 'http://localhost:4318/v1/traces',
    serviceName: 'test',
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5_000,
    shutdownTimeoutMillis: 100,
    ...overrides,
  }
}

function config(s3?: S3SinkConfig, otel?: OtelSinkConfig): Config {
  return {
    sinks: {
      s3: s3 ?? { ...s3Config(), enabled: false },
      otel: otel ?? { ...otelConfig(), enabled: false },
    },
  }
}

/** Spy record of one constructed sink: its uploader (s3 only) and close calls. */
interface SinkSpy {
  uploader?: MockUploader
  closeCount: number
}

/** Factories building real sinks over mock uploaders/exporters, spying on close(). */
function spyingFactories(built: { s3: SinkSpy[]; otel: SinkSpy[] }): SinkFactories {
  return {
    s3: (ctx, cfg) => {
      const uploader = new MockUploader()
      const sink = new S3TrajectorySink(ctx, cfg, uploader)
      const spy: SinkSpy = { uploader, closeCount: 0 }
      built.s3.push(spy)
      const close = sink.close.bind(sink)
      sink.close = async () => {
        spy.closeCount++
        await close()
      }
      return sink
    },
    otel: (ctx, cfg) => {
      const sink = new OtelTrajectorySink(ctx, cfg, new InMemorySpanExporter())
      const spy: SinkSpy = { closeCount: 0 }
      built.otel.push(spy)
      const close = sink.close.bind(sink)
      sink.close = async () => {
        spy.closeCount++
        await close()
      }
      return sink
    },
  }
}

/** Wait until the background drain of a replaced sink ran its close(). */
async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 1000, interval: 5 })
}

describe('TrajectorySinks', () => {
  beforeEach(resetClock)

  it('builds only the enabled sinks and reports per-sink status', () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(fakeCtx(), config(s3Config()), spyingFactories(built))

    expect(built.s3).toHaveLength(1)
    expect(built.otel).toHaveLength(0)
    const status = sinks.status()
    expect(status.s3.enabled).toBe(true)
    expect(status.otel.enabled).toBe(false)
  })

  it('reconfiguring with an equal config keeps the running sinks', async () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(fakeCtx(), config(s3Config(), otelConfig()), spyingFactories(built))
    const session = fakeSession()
    sinks.onEvent(session, ev('turn/start', 0, { turn: 1 }))

    // Structurally equal but fresh objects: no rebuild, buffered state survives.
    sinks.reconfigure(config(s3Config(), otelConfig()))

    expect(built.s3).toHaveLength(1)
    expect(built.otel).toHaveLength(1)
    const status = sinks.status()
    expect(status.s3.enabled && status.s3.bufferedEvents).toBe(1)
    expect(status.otel.enabled && status.otel.openSpans).toBe(1)
    await sinks.close()
  })

  it('drains and closes a sink when its switch flips to disabled', async () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(fakeCtx(), config(s3Config(), otelConfig()), spyingFactories(built))
    const session = fakeSession()
    sinks.onEvent(session, ev('turn/start', 0, { turn: 1 }))

    sinks.reconfigure(config(undefined, otelConfig()))

    expect(sinks.status().s3.enabled).toBe(false)
    // The replaced sink drained in the background: buffered events uploaded, then closed.
    await waitFor(() => expect(built.s3[0].closeCount).toBe(1))
    expect(built.s3[0].uploader!.puts.map(p => p.key)).toEqual(['dsh-trajectories/--repo-my-project--/sess-1/0-0.jsonl'])
    // The untouched otel sink kept running.
    expect(built.otel).toHaveLength(1)
    expect(built.otel[0].closeCount).toBe(0)
    expect(sinks.status().otel.enabled && sinks.status().otel.openSpans).toBe(1)
    await sinks.close()
  })

  it('routes new events to a sink enabled by a later reconfigure', async () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(fakeCtx(), config(), spyingFactories(built))
    const session = fakeSession()
    // Both sinks disabled: events are dropped on the floor.
    sinks.onEvent(session, ev('turn/start', 0, { turn: 1 }))

    sinks.reconfigure(config(s3Config()))
    sinks.onEvent(session, ev('turn/start', 1, { turn: 2 }))
    await sinks.onFlush(session)
    await sinks.close()

    expect(built.s3).toHaveLength(1)
    expect(built.s3[0].uploader!.puts.map(p => p.key)).toEqual(['dsh-trajectories/--repo-my-project--/sess-1/1-1.jsonl'])
  })

  it('rebuilds only the sink whose config changed', async () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(fakeCtx(), config(s3Config(), otelConfig()), spyingFactories(built))

    sinks.reconfigure(config(s3Config({ prefix: 'other-prefix' }), otelConfig()))

    expect(built.s3).toHaveLength(2)
    expect(built.otel).toHaveLength(1)
    await waitFor(() => expect(built.s3[0].closeCount).toBe(1))
    expect(built.otel[0].closeCount).toBe(0)
    // New uploads use the new prefix; stats restart with the new sink.
    const session = fakeSession()
    sinks.onEvent(session, ev('turn/start', 0, { turn: 1 }))
    await sinks.onFlush(session)
    expect(built.s3[1].uploader!.puts.map(p => p.key)).toEqual(['other-prefix/--repo-my-project--/sess-1/0-0.jsonl'])
    await sinks.close()
  })

  it('rebuilds only the otel sink when aws.region changes', async () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(
      fakeCtx(),
      config(s3Config(), otelConfig({ url: '', aws: { region: 'us-east-1' } })),
      spyingFactories(built),
    )

    sinks.reconfigure(config(s3Config(), otelConfig({ url: '', aws: { region: 'eu-central-1' } })))

    expect(built.otel).toHaveLength(2)
    expect(built.s3).toHaveLength(1)
    await waitFor(() => expect(built.otel[0].closeCount).toBe(1))
    expect(built.s3[0].closeCount).toBe(0)
    await sinks.close()
  })

  it('keeps the previous sink when a rebuild fails', () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const factories = spyingFactories(built)
    const sinks = new TrajectorySinks(fakeCtx(), config(s3Config()), factories)
    const session = fakeSession()
    sinks.onEvent(session, ev('turn/start', 0, { turn: 1 }))

    // A config the sink constructor rejects (batchSize > maxBufferedEvents):
    // the settings validate hook refuses such writes upstream; if one still
    // lands, the running sink must survive.
    sinks.reconfigure(config(s3Config({ batchSize: 10, maxBufferedEvents: 5 })))

    expect(built.s3).toHaveLength(1)
    const status = sinks.status()
    expect(status.s3.enabled && status.s3.bufferedEvents).toBe(1)
  })

  it('fails construction loudly on an invalid initial config', () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    expect(() => new TrajectorySinks(fakeCtx(), config(s3Config({ batchSize: 10, maxBufferedEvents: 5 })), spyingFactories(built)))
      .toThrow(/batchSize/)
  })

  it('renders a human-readable status summary', () => {
    const built = { s3: [] as SinkSpy[], otel: [] as SinkSpy[] }
    const sinks = new TrajectorySinks(fakeCtx(), config(s3Config()), spyingFactories(built))

    const managed = sinks.statusText(true)
    expect(managed).toContain('namespace "trajectory-persistence"')
    expect(managed).toContain('s3 sink: enabled')
    expect(managed).toContain('uploaded parts: 0, dead-lettered: 0')
    expect(managed).toContain('otel sink: disabled')

    const unmanaged = sinks.statusText(false)
    expect(unmanaged).toContain('no settings service mounted')
  })
})
