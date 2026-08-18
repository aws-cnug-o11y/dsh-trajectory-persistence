---
layout: home

hero:
  name: dsh-trajectory-persistence
  text: Persist and move dsh session trajectories
  tagline: An observe-only cordis plugin for the DeepSeek Harness — ship byte-faithful zstd segments of every session to S3 and restore them on another machine with sync-down, and export OpenTelemetry GenAI spans to any OTLP backend, including SigV4-signed direct delivery to AWS CloudWatch / Bedrock AgentCore Observability.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Ship & Sync
      link: /guide/ship-sync
    - theme: alt
      text: View on GitHub
      link: https://github.com/aws-cnug-o11y/dsh-trajectory-persistence

features:
  - title: Byte-faithful ship mode
    details: Tails the official jsonl backend's on-disk artifact read-only and uploads complete zstd frame segments plus a per-session _manifest.json watermark — no re-serialization, and the torn tail a crash leaves behind never leaves the machine.
  - title: Cross-machine sync-down
    details: The bundled sync-down CLI restores shipped sessions into a fresh machine's session root — manifest-validated, atomically published, with no-overwrite / prefix-append / conflict-refuse semantics — then dsh resume picks up where the other machine stopped.
  - title: OpenTelemetry GenAI semantics
    details: Turns, model calls, and tool executions map to spans following the OTel GenAI semantic conventions, with gen_ai.usage.* token attributes — ready for Jaeger, an OTel Collector, or Langfuse.
  - title: AWS SigV4 built in
    details: Sign OTLP batches with AWS Signature Version 4 and POST straight to the CloudWatch OTLP endpoint — the ingest path of Bedrock AgentCore Observability — over the default credential chain. No collector required.
  - title: Hot-reload, zero restart
    details: Edit $DSH_HOME/settings.yaml and the plugin rebuilds exactly the sinks whose config changed, draining the old one first so no trajectory data is lost on a switch.
  - title: Nothing lost on failure
    details: Bounded ring buffers, exponential-backoff retry, deterministic segment keys, and a local dead-letter directory keep memory flat and trajectories recoverable when a backend stalls.
---
