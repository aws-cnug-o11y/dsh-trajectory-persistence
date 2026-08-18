/**
 * Hot-swappable sink set owned by the plugin entry.
 *
 * Session-event listeners talk to this manager, never to a captured sink
 * instance, so a settings change can rebuild one sink (closing the old one,
 * which drains its buffers) while the other keeps running untouched.
 *
 * @module dsh-trajectory-persistence/sinks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config, OtelSinkConfig, S3SinkConfig } from './config.js'
import { S3TrajectorySink } from './s3-sink.js'
import type { S3SinkStats } from './s3-sink.js'
import { OtelTrajectorySink } from './otel-sink.js'
import type { OtelSinkStats } from './otel-sink.js'

/** Construction seam for the two sinks — the default builds the real sinks; tests inject mocks. */
export interface SinkFactories {
  s3: (ctx: Context, config: S3SinkConfig) => S3TrajectorySink
  otel: (ctx: Context, config: OtelSinkConfig) => OtelTrajectorySink
}

const defaultFactories: SinkFactories = {
  s3: (ctx, config) => new S3TrajectorySink(ctx, config),
  otel: (ctx, config) => new OtelTrajectorySink(ctx, config),
}

/** Structural equality over JSON-compatible sink configs. */
function sameConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Status snapshot of one sink: its counters when enabled, just the flag when not. */
export type SinkStatus<T> = ({ enabled: true } & T) | { enabled: false }

export interface TrajectoryStatus {
  s3: SinkStatus<S3SinkStats>
  otel: SinkStatus<OtelSinkStats>
}

export class TrajectorySinks {
  private readonly logger
  private readonly factories: SinkFactories
  private s3?: S3TrajectorySink
  private otel?: OtelTrajectorySink
  private s3Config?: S3SinkConfig
  private otelConfig?: OtelSinkConfig
  /** False during the initial construction, where a bad config must fail the plugin load. */
  private initialized = false

  constructor(
    private readonly ctx: Context,
    config: Config,
    factories: Partial<SinkFactories> = {},
  ) {
    this.logger = ctx.logger('dsh-trajectory-persistence')
    this.factories = { ...defaultFactories, ...factories }
    this.reconfigure(config)
    this.initialized = true
    if (!this.s3 && !this.otel) {
      this.logger.warn('loaded with all sinks disabled; no trajectory data will leave the process')
    }
  }

  /**
   * Apply a new resolved config: rebuild exactly the sinks whose effective
   * config changed (a disabled sink compares as `undefined`). The replaced
   * sink keeps serving in-flight uploads while it drains in the background.
   */
  reconfigure(config: Config): void {
    const s3Config = config.sinks.s3.enabled ? config.sinks.s3 : undefined
    const otelConfig = config.sinks.otel.enabled ? config.sinks.otel : undefined
    let changed = false
    if (!sameConfig(s3Config, this.s3Config)) {
      changed = true
      this.swapS3(s3Config)
    }
    if (!sameConfig(otelConfig, this.otelConfig)) {
      changed = true
      this.swapOtel(otelConfig)
    }
    if (changed && this.initialized && !this.s3 && !this.otel) {
      this.logger.warn('all sinks are now disabled; no trajectory data will leave the process')
    }
  }

  sessionCreated(session: Session): void {
    this.s3?.sessionCreated(session)
  }

  onEvent(session: Session, event: SessionEvent): void {
    this.s3?.onEvent(session, event)
    this.otel?.onEvent(session, event)
  }

  /**
   * `session/flush` durability checkpoint; settles once the s3 sink's queued
   * uploads complete.
   */
  onFlush(session: Session): Promise<void> | undefined {
    return this.s3?.onFlush(session)
  }

  onDisposed(session: Session): void {
    this.s3?.onDisposed(session)
    this.otel?.onDisposed(session)
  }

  /** Drain the current sinks. Awaited at plugin dispose. */
  async close(): Promise<void> {
    await Promise.allSettled([this.s3?.close(), this.otel?.close()])
  }

  /** Status snapshot of all sinks, for `/trajectory-status`. */
  status(): TrajectoryStatus {
    return {
      s3: this.s3 ? { enabled: true, ...this.s3.stats() } : { enabled: false },
      otel: this.otel ? { enabled: true, ...this.otel.stats() } : { enabled: false },
    }
  }

  /** Human-readable status summary rendered by the `/trajectory-status` command. */
  statusText(settingsManaged: boolean): string {
    const status = this.status()
    const lines = [
      'trajectory-persistence status',
      settingsManaged
        ? 'settings: managed by the settings service (namespace "trajectory-persistence") — edit $DSH_HOME/settings.yaml; changes apply without a restart'
        : 'settings: no settings service mounted — running on the composed plugin config (restart or a cordis.patch.yml change required)',
      '',
      formatS3(status.s3),
      '',
      formatOtel(status.otel),
    ]
    return lines.join('\n')
  }

  private swapS3(config: S3SinkConfig | undefined): void {
    try {
      const built = config ? this.factories.s3(this.ctx, config) : undefined
      const old = this.s3
      this.s3 = built
      this.s3Config = config
      if (old) this.drain(old, 's3')
    } catch (error) {
      if (!this.initialized) throw error
      this.logger.warn(`rebuilding the s3 sink failed, keeping the previous one: ${String(error)}`)
    }
  }

  private swapOtel(config: OtelSinkConfig | undefined): void {
    try {
      const built = config ? this.factories.otel(this.ctx, config) : undefined
      const old = this.otel
      this.otel = built
      this.otelConfig = config
      if (old) this.drain(old, 'otel')
    } catch (error) {
      if (!this.initialized) throw error
      this.logger.warn(`rebuilding the otel sink failed, keeping the previous one: ${String(error)}`)
    }
  }

  /** Close a replaced sink in the background; close() drains its buffered events first. */
  private drain(sink: S3TrajectorySink | OtelTrajectorySink, kind: string): void {
    void sink.close().catch((error: unknown) => {
      this.logger.warn(`draining the replaced ${kind} sink failed: ${String(error)}`)
    })
  }
}

function formatS3(status: SinkStatus<S3SinkStats>): string {
  if (!status.enabled) return 's3 sink: disabled'
  const lines = [
    's3 sink: enabled',
    `  uploaded parts: ${status.uploadedParts}, dead-lettered: ${status.deadLetteredParts}`,
    `  sessions: ${status.sessions}, buffered events: ${status.bufferedEvents}, dropped by overflow: ${status.droppedEvents}`,
    `  last upload: ${status.lastUploadAt === undefined ? 'never' : new Date(status.lastUploadAt).toISOString()}`,
  ]
  if (status.lastError !== undefined) lines.push(`  last error: ${status.lastError}`)
  return lines.join('\n')
}

function formatOtel(status: SinkStatus<OtelSinkStats>): string {
  if (!status.enabled) return 'otel sink: disabled'
  return [
    'otel sink: enabled',
    `  sessions: ${status.sessions}, open spans: ${status.openSpans}`,
  ].join('\n')
}
