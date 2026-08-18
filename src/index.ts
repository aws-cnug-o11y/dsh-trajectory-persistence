/**
 * dsh-trajectory-persistence — observe-only DeepSeek Harness plugin that
 * persists session trajectories to two independently toggleable sinks:
 *
 * - **S3/OSS**: JSONL part files (jsonl-persistence-compatible layout) with
 *   bounded in-memory buffering, batch uploads, backoff retry, and a local
 *   dead-letter directory.
 * - **OTel GenAI**: spans following the OTel GenAI semantic conventions over
 *   OTLP HTTP/protobuf (Jaeger / OTel Collector / …).
 *
 * Subscribes `session/event`, `session/created`, `session/flush`, and
 * `session/disposed`; drains all sinks on cordis `dispose`.
 *
 * Two optional capabilities light up when their services are mounted:
 * `ctx.settings` exposes the plugin config as the `trajectory-persistence`
 * settings namespace (hot-rebuilt on every committed change), and
 * `ctx.commands` registers the `/trajectory-status` slash command.
 *
 * @module dsh-trajectory-persistence
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, validateConfig } from './config.js'
import { TrajectorySinks } from './sinks.js'

export const name = 'dsh-trajectory-persistence'
export const inject = ['sessions']
/** Settings namespace under which `$DSH_HOME/settings.yaml` overrides this plugin's config. */
export const namespace = settingsNamespace('trajectory-persistence')
export { Config, validateConfig }
export type { Config as TrajectoryPersistenceConfig } from './config.js'
export { TrajectorySinks } from './sinks.js'
export type { SinkFactories, TrajectoryStatus } from './sinks.js'
export { S3TrajectorySink, EventBuffer, createS3Uploader } from './s3-sink.js'
export type { ObjectUploader, S3SinkStats } from './s3-sink.js'
export { OtelTrajectorySink, GenAISpanMapper } from './otel-sink.js'
export type { OtelSinkStats } from './otel-sink.js'
export { SigV4OtlpTraceExporter, defaultAwsOtlpUrl } from './sigv4-otlp-exporter.js'
export type { SigV4Credentials, SigV4OtlpTraceExporterConfig } from './sigv4-otlp-exporter.js'
export { withRetry } from './retry.js'
export { toHeaderLine, encodeSegment, projectKey, serializePart } from './jsonl.js'
export { scanZstdFrames } from './zstd-scan.js'
export type { ZstdFrameRange, ZstdFrameScan } from './zstd-scan.js'
export {
  MANIFEST_VERSION,
  ManifestError,
  segmentKey,
  manifestKey,
  parseManifest,
  serializeManifest,
  readManifest,
  writeManifest,
  updateManifest,
  getOrCreateWriterId,
} from './manifest.js'
export type { ManifestSegment, ShipManifest, ObjectStore } from './manifest.js'
export {
  SHIP_STATE_FILE,
  defaultShipStateDir,
  initialSessionState,
  loadShipState,
  saveShipState,
  getSessionState,
  updateSessionState,
  advanceSessionOffset,
} from './ship-state.js'
export type { SessionShipState, ShipState } from './ship-state.js'
export type { S3SinkMode } from './config.js'

export function apply(ctx: Context, config: Config) {
  // Invalid composed config (e.g. a sink enabled without its bucket/url)
  // throws here and fails the plugin load, as before.
  const sinks = new TrajectorySinks(ctx, config)
  // The authoritative config source: the composed entry until the settings
  // service takes over, and again after it goes away.
  let current = () => config

  ctx.on('session/created', (session) => {
    sinks.sessionCreated(session)
  })
  ctx.on('session/event', (session, event) => {
    sinks.onEvent(session, event)
  })
  // Durability checkpoint: the harness awaits flush listeners, so return the
  // sink's upload promise — a settled flush means the trajectory left the
  // process (uploaded or dead-lettered; the promise never rejects).
  ctx.on('session/flush', (session) => sinks.onFlush(session))
  ctx.on('session/disposed', (session) => {
    sinks.onDisposed(session)
  })
  // Graceful drain at fiber disposal (cordis runs the returned disposer).
  ctx.effect(() => () => sinks.close(), 'trajectory-persistence.drain')

  // Optional settings capability: while a settings provider is mounted, the
  // plugin config resolves through the `trajectory-persistence` namespace and
  // every committed change rebuilds the affected sinks in place. With no
  // provider this never runs and the composed config stays authoritative.
  installSettingsSection(ctx, namespace, Config, config, {
    setSource: (source) => {
      current = source
    },
    // reconfigure() rebuilds only the sinks whose config changed; a build
    // failure is contained inside it (the previous sink keeps running).
    onChange: () => sinks.reconfigure(current()),
    validate: validateConfig,
  })

  // Optional commands capability: with no commands service the child fiber
  // simply never starts, so the plugin loads unchanged minus the command.
  ctx.inject(['commands'], (cctx) => {
    cctx.commands.register({
      name: 'trajectory-status',
      description: 'Show trajectory persistence status: sink switches, upload statistics, last error.',
      handler: () => ({
        kind: 'success',
        // The resolved settings value is a fresh frozen object; the detached
        // source returns the composed entry itself, which is identity-equal.
        text: sinks.statusText(current() !== config),
      }),
    })
  })
}

export default { name, inject, Config, apply }
