/**
 * Integration smoke test over a real cordis root context: the plugin's
 * settings namespace registration, hot sink rebuild on `settings.update()`,
 * and the `/trajectory-status` command registration — with a stub commands
 * service and an in-memory settings provider.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.js'
import type { Config } from '../src/config.js'

class MemSettings extends SettingsProvider {
  readonly writable = true
  doc: Record<string, unknown> = {}

  protected async load(): Promise<Record<string, unknown>> {
    return this.doc
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: section }
  }
}

const ns = settingsNamespace('trajectory-persistence')

function entryConfig(): Config {
  return {
    sinks: {
      s3: {
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
      },
      otel: {
        enabled: false,
        url: '',
        serviceName: 'test',
        maxExportBatchSize: 512,
        // Keep the batch processor from exporting during the test.
        scheduledDelayMillis: 60_000,
        shutdownTimeoutMillis: 100,
      },
    },
  }
}

function setup() {
  const ctx = new Context()
  new MemSettings(ctx)
  let definition: CommandDefinition | undefined
  ctx.provide('commands', {
    register(def: CommandDefinition) {
      definition = def
      return () => {}
    },
  })
  apply(ctx, entryConfig())
  const statusText = () => {
    const result = definition!.handler({} as never) as CommandResult
    if (result.kind !== 'success') throw new Error(`unexpected command result: ${result.kind}`)
    return result.text ?? ''
  }
  return { ctx, statusText, commandDefined: () => definition !== undefined }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

describe('plugin integration (real cordis context)', () => {
  it('loads without the settings and commands services, just without those features', async () => {
    const ctx = new Context()
    apply(ctx, entryConfig())
    await tick()

    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.get('commands')).toBeUndefined()
  })

  it('registers /trajectory-status and the settings namespace; starts with both sinks disabled', async () => {
    const { ctx, statusText, commandDefined } = setup()
    await tick()

    expect(commandDefined()).toBe(true)
    expect(ctx.settings.get(ns)).toMatchObject({
      sinks: { s3: { enabled: false }, otel: { enabled: false } },
    })
    const text = statusText()
    expect(text).toContain('settings: managed')
    expect(text).toContain('s3 sink: disabled')
    expect(text).toContain('otel sink: disabled')
  })

  it('rebuilds the s3 sink live when settings.yaml enables it', async () => {
    const { ctx, statusText } = setup()
    await tick()
    expect(statusText()).toContain('s3 sink: disabled')

    await ctx.settings.update(ns, { sinks: { s3: { enabled: true, bucket: 'bucket-1' } } })
    await tick()

    const text = statusText()
    expect(text).toContain('s3 sink: enabled')
    expect(text).toContain('otel sink: disabled')
  })

  it('refuses a settings write that enables a sink without its required field', async () => {
    const { ctx, statusText } = setup()
    await tick()

    await expect(ctx.settings.update(ns, { sinks: { otel: { enabled: true } } })).rejects.toThrow(
      /url/,
    )
    // The rejected write never committed: the otel sink stays disabled.
    await tick()
    expect(statusText()).toContain('otel sink: disabled')
  })
})
