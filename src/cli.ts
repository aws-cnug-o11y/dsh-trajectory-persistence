#!/usr/bin/env node
/**
 * `dsh-trajectory-persistence` command line: restore local session artifacts
 * from segments a ship-mode sink uploaded to S3 (`sync-down` subcommand).
 *
 * @module dsh-trajectory-persistence/cli
 */

import { createS3ObjectStore } from './shipper.js'
import { syncDown } from './sync-down.js'
import type { SyncDownSummary } from './sync-down.js'

const HELP = `dsh-trajectory-persistence — restore dsh sessions from S3 ship-mode segments

USAGE
  dsh-trajectory-persistence sync-down --bucket <name> [options]

PREREQUISITE
  dsh must NOT be running and the target sessions must be inactive
  (single-writer discipline): sync-down writes the official
  session.jsonl.zstd under the local root, and a live dsh writer on the
  same root would race the restore.

OPTIONS
  --bucket <name>      bucket holding the shipped segments (required)
  --region <name>      AWS region / endpoint signing region (default: us-east-1)
  --prefix <prefix>    key prefix the shipper uploaded under (default: dsh-trajectories)
  --endpoint <url>     custom endpoint for S3-compatible stores (OSS, MinIO, ...)
  --force-path-style   path-style addressing (required by MinIO and most OSS endpoints)
  --session <id>       restore only this session id (raw or key-encoded)
  --root <dir>         local session root receiving restored artifacts
                       (default: $DSH_HOME/sessions or ~/.dsh/sessions)
  --force              overwrite a diverged local artifact; the original is
                       backed up to session.jsonl.zstd.bak-<epochMs> first
  --help               show this help

Credentials resolve through the AWS default provider chain (environment,
shared config, IAM role) — the same resolution the sink uses.
`

interface CliArgs {
  command?: string
  bucket?: string
  region?: string
  prefix?: string
  endpoint?: string
  forcePathStyle?: boolean
  session?: string
  root?: string
  force?: boolean
  help?: boolean
}

const VALUE_FLAGS: Record<string, keyof CliArgs> = {
  '--bucket': 'bucket',
  '--region': 'region',
  '--prefix': 'prefix',
  '--endpoint': 'endpoint',
  '--session': 'session',
  '--root': 'root',
}
const BOOL_FLAGS: Record<string, keyof CliArgs> = {
  '--force-path-style': 'forcePathStyle',
  '--force': 'force',
  '--help': 'help',
}

/** Parse argv into {@link CliArgs}; throws on unknown flags or missing values. */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  let index = 0
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    args.command = argv[0]
    index = 1
  }
  for (; index < argv.length; index++) {
    const arg = argv[index]!
    const [flag, inline] = arg.split('=', 2) as [string, string | undefined]
    if (flag in BOOL_FLAGS) {
      if (inline !== undefined) throw new Error(`${flag} takes no value`)
      args[BOOL_FLAGS[flag]!] = true as never
      continue
    }
    if (flag in VALUE_FLAGS) {
      const value = inline ?? argv[++index]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      args[VALUE_FLAGS[flag]!] = value as never
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** Default local session root, mirroring the ship-mode default in `./config.js`. */
function defaultRoot(): string {
  return `${process.env.DSH_HOME ?? `${process.env.HOME ?? '~'}/.dsh`}/sessions`
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n\n${HELP}`)
    return 1
  }
  if (args.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (args.command !== 'sync-down') {
    process.stderr.write(`error: ${args.command === undefined ? 'no subcommand given' : `unknown subcommand ${args.command}`}\n\n${HELP}`)
    return 1
  }
  if (!args.bucket) {
    process.stderr.write(`error: --bucket is required\n\n${HELP}`)
    return 1
  }

  const store = createS3ObjectStore({
    bucket: args.bucket,
    region: args.region ?? 'us-east-1',
    ...args.endpoint !== undefined ? { endpoint: args.endpoint } : {},
    ...args.forcePathStyle !== undefined ? { forcePathStyle: args.forcePathStyle } : {},
    // No static credentials here: the AWS default provider chain resolves them.
  })
  try {
    const summary: SyncDownSummary = await syncDown({
      store,
      bucket: args.bucket,
      prefix: args.prefix ?? 'dsh-trajectories',
      root: args.root ?? defaultRoot(),
      ...args.session !== undefined ? { sessionId: args.session } : {},
      ...args.force !== undefined ? { force: args.force } : {},
      log: line => process.stdout.write(`${line}\n`),
    })
    if (summary.sessions.length === 0) {
      process.stderr.write(args.session !== undefined
        ? `no manifest found for session ${args.session}\n`
        : 'no shipped sessions found under the prefix\n')
      return 1
    }
    const counts = new Map<string, number>()
    for (const session of summary.sessions) {
      counts.set(session.status, (counts.get(session.status) ?? 0) + 1)
    }
    const line = ['restored', 'appended', 'skipped', 'conflict', 'error']
      .map(status => `${counts.get(status) ?? 0} ${status}`)
      .join(', ')
    process.stdout.write(`sync-down: ${line}\n`)
    return (counts.get('conflict') ?? 0) + (counts.get('error') ?? 0) > 0 ? 1 : 0
  } finally {
    await store.close()
  }
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code },
  error => {
    process.stderr.write(`sync-down failed: ${String(error)}\n`)
    process.exitCode = 1
  },
)
