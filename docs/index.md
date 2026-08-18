---
layout: home

hero:
  name: dsh-trajectory-persistence
  text: Persist every dsh session trajectory
  tagline: An observe-only cordis plugin for the DeepSeek Harness — JSONL parts to S3/OSS and OpenTelemetry GenAI spans to any OTLP backend, both independently toggleable.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Configuration Reference
      link: /guide/configuration
    - theme: alt
      text: View on GitHub
      link: https://github.com/aws-cnug-o11y/dsh-trajectory-persistence

features:
  - title: Two sinks, independently toggleable
    details: Ship trajectories to S3/OSS as JSONL parts, to any OTLP backend as GenAI spans, to both, or to neither. Each sink has its own master switch and its own hot-reload lifecycle.
  - title: Byte-compatible JSONL
    details: Part files replicate the @deepseek-ai/dsh-session-persistence-jsonl artifact layout — header line plus one event per line, identical key encoding — so existing readers parse them unchanged.
  - title: OpenTelemetry GenAI semantics
    details: Turns, model calls, and tool executions map to spans following the OTel GenAI semantic conventions, with gen_ai.usage.* token attributes, ready for Jaeger, ClickHouse, or Langfuse.
  - title: AWS SigV4 built in
    details: Sign OTLP batches with AWS Signature Version 4 and POST straight to the CloudWatch OTLP endpoint — the ingest path of Bedrock AgentCore Observability — with the default credential chain.
  - title: Hot-reload, zero restart
    details: Edit $DSH_HOME/settings.yaml and the plugin rebuilds exactly the sinks whose config changed, draining the old one first so no trajectory data is lost on a switch.
  - title: Nothing lost on failure
    details: Bounded ring buffers, exponential-backoff retry, and a local dead-letter directory keep memory flat and trajectories recoverable when a backend stalls.
---
