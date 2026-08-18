# Development

## Build and test

```sh
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # vitest: span mapping, S3 buffering/flush triggers, retry
```

Requires Node.js ≥ 22 (matching the harness).

## Repository layout

```
├── cordis.patch.yml     # bundle layer: inserts the plugin row (sinks disabled)
├── src/
│   ├── index.ts         # cordis plugin entry: name/inject/Config/apply, event wiring, dispose drain,
│   │                    #   settings namespace + /trajectory-status registration (optional capabilities)
│   ├── config.ts        # Schemastery schema (sinks.s3 / sinks.otel) + cross-field validateConfig
│   ├── sinks.ts         # TrajectorySinks: hot-swappable sinks, per-sink rebuild, status snapshot
│   ├── jsonl.ts         # jsonl-persistence-compatible header line, projectKey, encodeSegment
│   ├── sink-utils.ts    # EventBuffer (ring) + BufferedPartSink (batch/retry/dead-letter, stats())
│   ├── s3-sink.ts       # S3TrajectorySink: S3 transport (uploader + key layout) over BufferedPartSink
│   ├── zstd-scan.ts     # vendored scanZstdFrames (complete-frame ranges + torn-tail detection)
│   ├── manifest.ts      # _manifest.json format, segment keys, RMW updates, writerId
│   ├── ship-state.ts    # local ship watermarks (per-session offset, revision, conflicted)
│   ├── shipper.ts       # S3ShipperSink (mode: 'ship'): read-only tailer of the jsonl backend root
│   ├── sync-down.ts     # restore local artifacts from shipped segments (no-overwrite publish)
│   ├── cli.ts           # bin entry: `dsh-trajectory-persistence sync-down`
│   ├── otel-sink.ts     # GenAISpanMapper (pure mapping) + OtelTrajectorySink (OTLP pipeline)
│   ├── sigv4-otlp-exporter.ts # SigV4-signed OTLP exporter: CloudWatch / AgentCore Observability
│   └── retry.ts         # exponential backoff helper
└── test/                # vitest: otel-map, sigv4-otlp-exporter, config, s3-sink, shipper,
                         #   zstd-scan, manifest, ship-state, sync-down, sinks (rebuild),
                         #   retry, integration (real cordis ctx)
```

## Running from a source checkout

You can load the plugin straight from a checkout, without installing it into a
profile:

```sh
git clone <this-repo> && cd dsh-trajectory-persistence
pnpm install && pnpm build

# overlay patch that points at the local build ($PWD expands to the checkout)
cat > /tmp/traj.patch.yml <<YAML
- insert:
    - id: trajectory-persistence
      name: file://$PWD/lib/index.js
      config:
        sinks:
          otel:
            enabled: true
            url: http://localhost:4318/v1/traces
YAML

dsh web --patch /tmp/traj.patch.yml        # or: dsh tui / pnpm dsh web from a source checkout
```

`--patch` overlays apply after bundle and profile patches, so the row above
wins over any installed `trajectory-persistence` row.

## Sink architecture

Session-event listeners in `index.ts` never talk to a captured sink instance —
they go through `TrajectorySinks` (`src/sinks.ts`), which owns the current sink
instances and can rebuild one sink (closing the old one, which drains its
buffers) while the other keeps running untouched. This is what makes the
[settings hot-reload](/guide/configuration#hot-reload-behavior) safe.

The two sinks share very little by design, and what they share is explicit:

- **`BufferedPartSink`** (`src/sink-utils.ts`) is the machinery of every
  part-uploading sink: a bounded per-session `EventBuffer` (ring,
  drop-oldest), the flush triggers (`session/flush`, `batchSize`,
  `session/disposed`, drain on close), serialized per-session upload queues,
  exponential-backoff retry (`src/retry.ts`), and the local dead-letter
  fallback. A concrete sink supplies only the **transport**:
  - `uploadPart(key, body)` — how one serialized JSONL part is uploaded,
  - `partName(part)` — how a part is named in log lines,
  - `release()` — how the transport is torn down after the final drain.

  `S3TrajectorySink` (`src/s3-sink.ts`) is exactly that: the S3 uploader plus
  the key layout, over `BufferedPartSink`.

- **`GenAISpanMapper`** (`src/otel-sink.ts`) is a *pure* event → span mapper
  over any OTel `Tracer`. It holds no exporter state, so tests drive it with
  an in-memory tracer provider. `OtelTrajectorySink` wraps it in the real
  pipeline: `NodeTracerProvider` → `BatchSpanProcessor` → exporter.

- **The exporter is an injection seam.** `OtelTrajectorySink` picks a
  `SpanExporter` from the config: the upstream `OTLPTraceExporter` for `url`,
  or `SigV4OtlpTraceExporter` (`src/sigv4-otlp-exporter.ts`) for `aws`. Both
  sit behind the standard `SpanExporter` interface, and `TrajectorySinks`
  accepts factory overrides (`SinkFactories`) so tests inject mocks.

## Adding a new sink

1. **Config**: add a `sinks.<name>` block to the Schemastery schema in
   `src/config.ts` (with defaults), extend the `Config` interface, and add any
   cross-field rules to `validateConfig`.
2. **Implementation**: if the sink uploads JSONL parts, extend
   `BufferedPartSink` and implement only `uploadPart` / `partName` /
   `release` — buffering, flush triggers, retry, and dead-letter come for
   free. Otherwise model it on `OtelTrajectorySink`: a small class with the
   session-event handlers and an async `close()` that drains.
3. **Wiring**: add it to `SinkFactories` / `TrajectorySinks` in `src/sinks.ts`
   so it participates in per-sink hot rebuild and status reporting, and
   surface its stats in the `/trajectory-status` output in `src/index.ts`.
4. **Tests**: follow `test/s3-sink.test.ts` (buffering/flush/retry against a
   fake transport) and `test/sinks.test.ts` (hot-rebuild behavior).

## Notes for contributors

- **Imports.** Only published packages are used: `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-session` (type-only), `@deepseek-ai/schemastery`,
  `@deepseek-ai/dsh-settings` (runtime), and `@deepseek-ai/dsh-commands`
  (type-only — the command registry is reached through `ctx.commands`).
- **Keep `src/jsonl.ts` byte-compatible.** It mirrors
  `packages/session/session-persistence-jsonl/src/format.ts` of the
  deepseek-harness monorepo (commit noted in the README). If the monorepo
  changes that format, update `src/jsonl.ts`.
