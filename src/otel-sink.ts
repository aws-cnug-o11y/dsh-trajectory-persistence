/**
 * OTel GenAI sink: maps the dsh session event stream to spans following the
 * OpenTelemetry GenAI semantic conventions and exports them over OTLP
 * HTTP/protobuf (Jaeger, OTel Collector, …).
 *
 * Mapping:
 * - `turn/start`…`turn/end` → span `gen_ai.turn`
 *   (`gen_ai.operation.name` = `turn`, `gen_ai.conversation.id` = sessionId)
 * - `step/start`…`step/end` + `assistant/message`/`assistant/chunk` → `chat`
 *   span (`gen_ai.request.model`, `gen_ai.usage.input_tokens` /
 *   `gen_ai.usage.output_tokens` when the adapter reported usage; raw chunks
 *   aggregate into `dsh.assistant.*` summary attributes)
 * - `tool/call`…`tool/result` (paired by `callId`) → `execute_tool` span
 *   (`gen_ai.tool.name`, `gen_ai.tool.call.id`; failures set span status ERROR)
 *
 * @module dsh-trajectory-persistence/otel-sink
 */

import { context, trace, SpanStatusCode } from '@opentelemetry/api'
import type { Context as OtelContext, Span, Tracer } from '@opentelemetry/api'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { OtelSinkConfig } from './config.js'
import { SigV4OtlpTraceExporter } from './sigv4-otlp-exporter.js'

/** Attribute ceiling for raw tool-call arguments on a span. */
const MAX_ARGUMENTS_ATTRIBUTE_BYTES = 8192

interface OpenSpan {
  span: Span
  ctx: OtelContext
}

interface StepState extends OpenSpan {
  chunks: number
  textBytes: number
  reasoningBytes: number
  toolCallDeltaBytes: number
}

/** Per-session span bookkeeping. */
class SessionSpans {
  turns = new Map<number, OpenSpan>()
  steps = new Map<string, StepState>()
  tools = new Map<string, OpenSpan & { stepKey?: string }>()
  provider?: string
  model?: string

  constructor(readonly sessionId: string) {}

  static stepKey(turn: number, step: number): string {
    return `${turn}:${step}`
  }
}

/**
 * Pure event → GenAI span mapper over any {@link Tracer}. Holds no exporter
 * state, so tests can drive it with an in-memory tracer provider.
 */
export class GenAISpanMapper {
  private readonly sessions = new Map<string, SessionSpans>()

  constructor(private readonly tracer: Tracer) {}

  private stateOf(session: Session): SessionSpans {
    let state = this.sessions.get(session.id)
    if (!state) {
      state = new SessionSpans(session.id)
      this.sessions.set(session.id, state)
    }
    return state
  }

  /** Open a step's `chat` span as a child of its turn span. */
  private openStep(state: SessionSpans, turn: number, step: number, startTime: number): StepState {
    const key = SessionSpans.stepKey(turn, step)
    const parent = state.turns.get(turn)?.ctx
    const span = this.tracer.startSpan('chat', {
      startTime,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.conversation.id': state.sessionId,
        ...state.provider !== undefined ? { 'gen_ai.provider.name': state.provider } : {},
        ...state.model !== undefined ? { 'gen_ai.request.model': state.model } : {},
        'dsh.turn': turn,
        'dsh.step': step,
      },
    }, parent)
    const stepState: StepState = {
      span, ctx: trace.setSpan(context.active(), span),
      chunks: 0, textBytes: 0, reasoningBytes: 0, toolCallDeltaBytes: 0,
    }
    state.steps.set(key, stepState)
    return stepState
  }

  private ensureStep(state: SessionSpans, turn: number, step: number, time: number): StepState {
    return state.steps.get(SessionSpans.stepKey(turn, step)) ?? this.openStep(state, turn, step, time)
  }

  /** Fold one session event into the span tree. */
  handle(session: Session, event: SessionEvent): void {
    const state = this.stateOf(session)
    switch (event.type) {
      case 'turn/start': {
        const span = this.tracer.startSpan('gen_ai.turn', {
          startTime: event.time,
          attributes: {
            'gen_ai.operation.name': 'turn',
            'gen_ai.conversation.id': session.id,
            'dsh.turn': event.data.turn,
          },
        })
        state.turns.set(event.data.turn, { span, ctx: trace.setSpan(context.active(), span) })
        break
      }
      case 'request/context': {
        state.provider = event.data.provider
        state.model = event.data.model
        break
      }
      case 'step/start': {
        this.openStep(state, event.data.turn, event.data.step, event.time)
        break
      }
      case 'assistant/chunk': {
        const stepState = this.ensureStep(state, event.data.turn, event.data.step, event.time)
        stepState.chunks++
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') stepState.textBytes += chunk.text.length
        else if (chunk.type === 'reasoning-delta') stepState.reasoningBytes += chunk.text.length
        else if (chunk.type === 'tool-call-delta') stepState.toolCallDeltaBytes += chunk.argumentsDelta.length
        break
      }
      case 'assistant/message': {
        const stepState = this.ensureStep(state, event.data.turn, event.data.step, event.time)
        const usage = event.data.usage
        if (usage) {
          stepState.span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens)
          stepState.span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens)
          if (usage.cacheReadTokens !== undefined) {
            stepState.span.setAttribute('gen_ai.usage.cache_read.input_tokens', usage.cacheReadTokens)
          }
          if (usage.cacheWriteTokens !== undefined) {
            stepState.span.setAttribute('gen_ai.usage.cache_creation.input_tokens', usage.cacheWriteTokens)
          }
        }
        break
      }
      case 'step/end': {
        const key = SessionSpans.stepKey(event.data.turn, event.data.step)
        const stepState = state.steps.get(key)
        if (!stepState) break
        stepState.span.setAttribute('dsh.assistant.chunks', stepState.chunks)
        stepState.span.setAttribute('dsh.assistant.text_bytes', stepState.textBytes)
        stepState.span.setAttribute('dsh.assistant.reasoning_bytes', stepState.reasoningBytes)
        stepState.span.setAttribute('dsh.assistant.tool_call_delta_bytes', stepState.toolCallDeltaBytes)
        stepState.span.end(event.time)
        state.steps.delete(key)
        break
      }
      case 'tool/call': {
        const stepKey = SessionSpans.stepKey(event.data.turn, event.data.step)
        const parent = state.steps.get(stepKey)?.ctx ?? state.turns.get(event.data.turn)?.ctx
        const args = event.data.arguments.length > MAX_ARGUMENTS_ATTRIBUTE_BYTES
          ? event.data.arguments.slice(0, MAX_ARGUMENTS_ATTRIBUTE_BYTES)
          : event.data.arguments
        const span = this.tracer.startSpan('execute_tool', {
          startTime: event.time,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.conversation.id': session.id,
            'gen_ai.tool.name': event.data.name,
            'gen_ai.tool.call.id': event.data.callId,
            'gen_ai.tool.call.arguments': args,
          },
        }, parent)
        state.tools.set(event.data.callId, { span, ctx: trace.setSpan(context.active(), span), stepKey })
        break
      }
      case 'tool/result': {
        const callId = event.data.message.content[0]?.toolCallId
        if (callId === undefined) break
        const open = state.tools.get(callId)
        if (!open) break
        const failed = event.data.error !== undefined || event.data.message.content[0]?.isError === true
        if (failed) {
          const errorName = event.data.error ? `${event.data.error.name}: ${event.data.error.code}` : 'tool result isError'
          open.span.setStatus({ code: SpanStatusCode.ERROR, message: errorName })
          open.span.setAttribute('error.type', event.data.error?.name ?? 'ToolError')
        }
        open.span.end(event.time)
        state.tools.delete(callId)
        break
      }
      case 'turn/end': {
        // Close dangling tool/step spans of this turn before the turn span.
        for (const [callId, open] of state.tools) {
          if (open.stepKey?.startsWith(`${event.data.turn}:`)) {
            open.span.setStatus({ code: SpanStatusCode.ERROR, message: 'turn ended before tool/result' })
            open.span.end(event.time)
            state.tools.delete(callId)
          }
        }
        for (const [key, stepState] of state.steps) {
          if (key.startsWith(`${event.data.turn}:`)) {
            stepState.span.end(event.time)
            state.steps.delete(key)
          }
        }
        const open = state.turns.get(event.data.turn)
        if (!open) break
        open.span.setAttribute('dsh.turn.end_reason', event.data.reason.kind)
        open.span.end(event.time)
        state.turns.delete(event.data.turn)
        break
      }
      default:
        break
    }
  }

  /** End every span still open for a session (session disposed / drain). */
  endSession(session: Session): void {
    const state = this.sessions.get(session.id)
    if (!state) return
    this.endState(state)
  }

  /** End every span still open across all sessions (sink shutdown). */
  endAll(): void {
    for (const state of this.sessions.values()) this.endState(state)
  }

  /** Read-only snapshot of open-span bookkeeping, for status reporting. */
  stats(): OtelSinkStats {
    let openSpans = 0
    for (const state of this.sessions.values()) {
      openSpans += state.turns.size + state.steps.size + state.tools.size
    }
    return { sessions: this.sessions.size, openSpans }
  }

  private endState(state: SessionSpans): void {
    const now = Date.now()
    for (const open of state.tools.values()) open.span.end(now)
    for (const stepState of state.steps.values()) stepState.span.end(now)
    for (const open of state.turns.values()) open.span.end(now)
    this.sessions.delete(state.sessionId)
  }
}

/** Point-in-time span bookkeeping of one OTel sink, surfaced by `/trajectory-status`. */
export interface OtelSinkStats {
  /** Sessions with at least one span seen and not yet fully ended. */
  sessions: number
  /** Spans currently open across all sessions. */
  openSpans: number
}

/**
 * The sink owned by the plugin: wires a `NodeTracerProvider` with a
 * `BatchSpanProcessor` over an OTLP HTTP/protobuf exporter, feeds every
 * session event through {@link GenAISpanMapper}, and drains on dispose.
 */
export class OtelTrajectorySink {
  private readonly provider: NodeTracerProvider
  private readonly processor: SpanProcessor
  private readonly mapper: GenAISpanMapper
  private readonly logger

  constructor(
    private readonly ctx: Context,
    private readonly config: OtelSinkConfig,
    exporter?: SpanExporter,
  ) {
    if (!config.url && !config.aws && !exporter) {
      throw new Error('otel sink: url or aws is required when the otel sink is enabled')
    }
    if (config.url && config.aws) {
      throw new Error('otel sink: url and aws are mutually exclusive (aws already implies its endpoint)')
    }
    if (config.aws && !config.aws.region) {
      throw new Error('otel sink: aws.region is required when aws delivery is configured')
    }
    if (!Number.isInteger(config.maxExportBatchSize) || config.maxExportBatchSize < 1) {
      throw new Error(`otel sink: maxExportBatchSize must be a positive integer, got ${String(config.maxExportBatchSize)}`)
    }
    this.logger = ctx.logger('dsh-trajectory-persistence/otel')
    this.processor = new BatchSpanProcessor(
      exporter ?? (config.aws
        ? new SigV4OtlpTraceExporter({
          region: config.aws.region,
          ...config.aws.url !== undefined ? { url: config.aws.url } : {},
          ...config.aws.service !== undefined ? { service: config.aws.service } : {},
          ...config.headers !== undefined ? { headers: config.headers } : {},
        })
        : new OTLPTraceExporter({
          url: config.url,
          ...config.headers !== undefined ? { headers: config.headers } : {},
        })),
      {
        maxExportBatchSize: config.maxExportBatchSize,
        scheduledDelayMillis: config.scheduledDelayMillis,
        exportTimeoutMillis: config.shutdownTimeoutMillis,
      },
    )
    this.provider = new NodeTracerProvider({
      resource: defaultResource().merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName })),
      spanProcessors: [this.processor],
    })
    this.mapper = new GenAISpanMapper(this.provider.getTracer('dsh-trajectory-persistence'))
  }

  onEvent(session: Session, event: SessionEvent): void {
    try {
      this.mapper.handle(session, event)
    } catch (error) {
      this.logger.warn(`span mapping failed for ${event.type} (session ${session.id}): ${String(error)}`)
    }
  }

  onDisposed(session: Session): void {
    this.mapper.endSession(session)
  }

  /** Read-only snapshot of this sink's span bookkeeping, for status reporting. */
  stats(): OtelSinkStats {
    return this.mapper.stats()
  }

  /** Graceful drain: end still-open spans, flush the batch processor, then shut the provider down. */
  async close(): Promise<void> {
    this.mapper.endAll()
    const timeout = this.config.shutdownTimeoutMillis
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`otel drain timed out after ${timeout}ms`)), timeout)
    })
    try {
      await Promise.race([this.provider.shutdown(), deadline])
    } catch (error) {
      this.logger.warn(String(error))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
