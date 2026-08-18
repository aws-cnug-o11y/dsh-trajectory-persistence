# S3 Sink

::: info This page describes `mode: 'push'`
The S3 sink has two delivery modes. This page covers `mode: 'push'` — the
default, legacy-but-supported mode that buffers the live event stream and
uploads JSONL part files. For `mode: 'ship'` (tailing the official on-disk
artifact, zstd frame segments + `_manifest.json`, restoring sessions with
`sync-down`), see [Ship & Sync](/guide/ship-sync).
:::

In push mode the S3 sink persists each session's trajectory as JSONL **part
files** to AWS S3 or any S3-compatible object store (Aliyun OSS, MinIO, …),
byte-compatible with the `@deepseek-ai/dsh-session-persistence-jsonl` artifact
layout. A bounded per-session buffer flushes on the harness's durability
checkpoints, uploads retry with exponential backoff, and a part whose upload
finally fails lands in a local dead-letter directory.

## Minimal configuration

```yaml
config:
  sinks:
    s3:
      enabled: true
      mode: push          # the default; shown for clarity
      bucket: my-bucket
      region: us-east-1
```

Omit `credentials` to use the AWS default provider chain. The full field table
lives in the [Configuration Reference](/guide/configuration#sinks-s3).

## Part layout

Every part is a self-contained JSONL file:

```
{"type":"session","version":1,"id":"…","createdAt":1755432000000,"cwd":"/repo","delegationDepth":0}
{"type":"turn/start","seq":1,…}
{"type":"step/start","seq":2,…}
…
```

- **Line 1 — header**: the `type: "session"` record carrying the immutable
  session metadata (`version`, `id`, `createdAt`, optional `cwd`,
  `parentSession`, `seedLength`, `origin`, `agentPreset`, and
  `delegationDepth`). Because every part repeats it, each part is
  independently parseable.
- **Following lines**: one serialized `SessionEvent` per line, in log order
  (unpacked layout — no chunk packing; `scanLog` readers of the jsonl backend
  are layout-blind and decode either form).

Part keys follow the jsonl backend's encoding exactly:

```
{prefix}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl
```

- `projectId` is the readable `projectKey(cwd)` slug — separators become `-`,
  unsafe code units become `~XXXX`, wrapped as `--<slug>--`. A session without
  a cwd lands in `_no-cwd`.
- `sessionId` is `~XXXX`-escaped (`encodeSegment`) — a `SessionId` is an
  unvalidated branded string and is always encoded before use in a key.
- `seqStart` / `seqEnd` are the session sequence numbers covered by the part.

The header-line and path-encoding helpers are **reimplemented** in
`src/jsonl.ts` (kept byte-compatible with the monorepo) because the published
jsonl package loads a native zstd binding (`koffi`) at import time, which a
remote-only sink must not require.

## Buffering and flush triggers

Each session gets a bounded in-memory buffer with ring (drop-oldest) overflow
semantics. A flush uploads the buffered events as one part and is triggered
by:

1. the `session/flush` event (the harness's durability checkpoint — the
   listener returns the upload promise, so a settled checkpoint means the
   buffered trajectory has been uploaded or dead-lettered),
2. the session's buffer reaching `batchSize` events,
3. `session/disposed`,
4. cordis fiber disposal (graceful drain of all sinks).

Flushes normally happen at `batchSize`, long before the cap;
`maxBufferedEvents` only bounds memory when uploads stall. Events evicted by
overflow are counted (`dropped by overflow` in `/trajectory-status`) and
logged with a warning.

## Retry and dead-letter

Uploads are serialized per session (parts never race each other) and retried
`maxRetries` times after the first attempt with exponential backoff: retry `n`
waits `retryBaseDelayMs * 2^(n-1)` plus up to 25 % jitter.

A part that still fails after all retries is written **verbatim** to the local
dead-letter directory, under the same key structure:

```
{deadLetterDir}/{projectId}/{sessionId}/{seqStart}-{seqEnd}.jsonl
```

Nothing is silently dropped: a failed part is always either uploaded or
recoverable from disk, and the dead-letter counter shows up in
`/trajectory-status`.

## S3-compatible stores (OSS, MinIO)

Set `endpoint` and, for MinIO and most OSS-compatible endpoints,
`forcePathStyle: true`. Static credentials go in
`credentials.accessKeyId` / `credentials.secretAccessKey`; omit `credentials`
to use the AWS default provider chain.

```yaml
config:
  sinks:
    s3:
      enabled: true
      bucket: my-bucket
      prefix: trajectories
      region: oss-cn-hangzhou
      endpoint: https://oss-cn-hangzhou.aliyuncs.com
      forcePathStyle: true
      credentials:
        accessKeyId: ${OSS_ACCESS_KEY_ID}
        secretAccessKey: ${OSS_ACCESS_KEY_SECRET}
```

MinIO is the same shape: `endpoint: http://minio:9000`, `forcePathStyle: true`.

## Troubleshooting

- **Parts not arriving** — run `/trajectory-status` and check `last error`,
  `uploaded parts`, and `dead-lettered`. A growing dead-letter count means the
  backend rejected the uploads after all retries; the parts are recoverable
  under `deadLetterDir` and can be re-uploaded manually once the cause is
  fixed.
- **`buffer overflow dropped N events` warnings** — uploads are stalling and
  the ring cap is evicting the oldest events. Check connectivity/credentials,
  or raise `maxBufferedEvents` to buy memory headroom.
- **Need restorable sessions instead of analytics parts** — that is
  `mode: 'ship'`; see [Ship & Sync](/guide/ship-sync).
