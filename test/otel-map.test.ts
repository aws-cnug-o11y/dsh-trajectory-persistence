import { describe, expect, it, beforeEach } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { GenAISpanMapper, OtelTrajectorySink } from '../src/otel-sink.js'
import type { OtelSinkConfig } from '../src/config.js'
import { ev, fakeCtx, fakeSession, resetClock } from './helpers.js'

function setup() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const mapper = new GenAISpanMapper(provider.getTracer('test'))
  return { exporter, mapper }
}

function toolResultMessage(callId: string, isError = false) {
  return {
    id: 'msg-1',
    role: 'user' as const,
    source: { kind: 'tool' as const },
    content: [{ type: 'tool-result' as const, toolCallId: callId, content: [], isError }],
  } as never
}

describe('GenAISpanMapper', () => {
  beforeEach(resetClock)

  it('maps a full turn: turn span, chat span with usage, paired tool span', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()

    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(
      session,
      ev('request/context', 1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    )
    mapper.handle(session, ev('step/start', 2, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('assistant/chunk', 3, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hello ' },
      }),
    )
    mapper.handle(
      session,
      ev('assistant/chunk', 4, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'world' },
      }),
    )
    mapper.handle(
      session,
      ev('assistant/message', 5, {
        turn: 1,
        step: 1,
        message: { id: 'a1', role: 'assistant', content: [], source: { kind: 'model' } } as never,
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 12 },
      }),
    )
    mapper.handle(
      session,
      ev('tool/call', 6, {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: '{"cmd":"ls"}',
      }),
    )
    mapper.handle(
      session,
      ev('tool/result', 7, { turn: 1, step: 1, message: toolResultMessage('call-1') }),
    )
    mapper.handle(session, ev('step/end', 8, { turn: 1, step: 1 }))
    mapper.handle(session, ev('turn/end', 9, { turn: 1, reason: { kind: 'completed' } as never }))

    const spans = exporter.getFinishedSpans()
    const byName = (name: string) => spans.filter(s => s.name === name)
    expect(byName('gen_ai.turn')).toHaveLength(1)
    expect(byName('chat')).toHaveLength(1)
    expect(byName('execute_tool')).toHaveLength(1)

    const turn = byName('gen_ai.turn')[0]
    expect(turn.attributes['gen_ai.operation.name']).toBe('turn')
    expect(turn.attributes['gen_ai.conversation.id']).toBe('sess-1')
    expect(turn.attributes['dsh.turn.end_reason']).toBe('completed')

    const chat = byName('chat')[0]
    expect(chat.attributes['gen_ai.operation.name']).toBe('chat')
    expect(chat.attributes['gen_ai.request.model']).toBe('deepseek-v4-flash')
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(120)
    expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(30)
    expect(chat.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(12)
    // chunk aggregation surfaced at step end
    expect(chat.attributes['dsh.assistant.chunks']).toBe(2)
    expect(chat.attributes['dsh.assistant.text_bytes']).toBe('hello world'.length)
    // chat is a child of the turn span
    expect(chat.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)

    const tool = byName('execute_tool')[0]
    expect(tool.attributes['gen_ai.tool.name']).toBe('bash')
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('call-1')
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"cmd":"ls"}')
    expect(tool.status.code).toBe(SpanStatusCode.UNSET)
    // tool span is a child of the chat span
    expect(tool.parentSpanContext?.spanId).toBe(chat.spanContext().spanId)
  })

  it('sets ERROR status on a failed tool result and records error.type', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()
    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(session, ev('step/start', 1, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 2, { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{}' }),
    )
    mapper.handle(
      session,
      ev('tool/result', 3, {
        turn: 1,
        step: 1,
        message: toolResultMessage('c9', true),
        error: { name: 'ToolError', code: 'ENOENT' },
      }),
    )

    const tool = exporter.getFinishedSpans().find(s => s.name === 'execute_tool')!
    expect(tool.status.code).toBe(SpanStatusCode.ERROR)
    expect(tool.status.message).toContain('ENOENT')
    expect(tool.attributes['error.type']).toBe('ToolError')
  })

  it('ends still-open spans when the session is disposed', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()
    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(session, ev('step/start', 1, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 2, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    )
    expect(exporter.getFinishedSpans()).toHaveLength(0)

    mapper.endSession(session)
    const names = exporter
      .getFinishedSpans()
      .map(s => s.name)
      .sort()
    expect(names).toEqual(['chat', 'execute_tool', 'gen_ai.turn'])
  })

  it('closes dangling tool spans with ERROR when the turn ends without tool/result', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()
    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(session, ev('step/start', 1, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 2, { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }),
    )
    mapper.handle(
      session,
      ev('turn/end', 3, { turn: 1, reason: { kind: 'aborted', reason: 'user' } as never }),
    )

    const tool = exporter.getFinishedSpans().find(s => s.name === 'execute_tool')!
    expect(tool.status.code).toBe(SpanStatusCode.ERROR)
  })

  it('truncates oversized tool-call arguments attributes', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()
    mapper.handle(
      session,
      ev('tool/call', 0, {
        turn: 1,
        step: 1,
        callId: 'big',
        name: 'write',
        arguments: 'x'.repeat(10_000),
      }),
    )
    mapper.handle(
      session,
      ev('tool/result', 1, { turn: 1, step: 1, message: toolResultMessage('big') }),
    )
    const tool = exporter.getFinishedSpans().find(s => s.name === 'execute_tool')!
    expect(String(tool.attributes['gen_ai.tool.call.arguments'])).toHaveLength(8192)
  })

  it('ends all still-open spans across sessions on endAll, children before parents', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()
    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(session, ev('step/start', 1, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 2, { turn: 1, step: 1, callId: 'c3', name: 'bash', arguments: '{}' }),
    )
    expect(exporter.getFinishedSpans()).toHaveLength(0)

    mapper.endAll()
    const names = exporter.getFinishedSpans().map(s => s.name)
    expect(names).toEqual(['execute_tool', 'chat', 'gen_ai.turn'])
    // endAll is idempotent: no spans re-ended
    mapper.endAll()
    expect(exporter.getFinishedSpans()).toHaveLength(3)
  })

  it('closes dangling tool spans of the ended turn only, leaving other turns open', () => {
    const { exporter, mapper } = setup()
    const session = fakeSession()
    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(session, ev('step/start', 1, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 2, { turn: 1, step: 1, callId: 't1', name: 'bash', arguments: '{}' }),
    )
    mapper.handle(session, ev('turn/start', 3, { turn: 2 }))
    mapper.handle(session, ev('step/start', 4, { turn: 2, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 5, { turn: 2, step: 1, callId: 't2', name: 'read', arguments: '{}' }),
    )

    mapper.handle(
      session,
      ev('turn/end', 6, { turn: 1, reason: { kind: 'aborted', reason: 'user' } as never }),
    )

    const tools = exporter.getFinishedSpans().filter(s => s.name === 'execute_tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].attributes['gen_ai.tool.call.id']).toBe('t1')
    expect(tools[0].status.code).toBe(SpanStatusCode.ERROR)
    // turn 2's tool span is still open until the session is disposed
    mapper.endSession(session)
    const remaining = exporter.getFinishedSpans().filter(s => s.name === 'execute_tool')
    expect(remaining).toHaveLength(2)
    expect(remaining[1].attributes['gen_ai.tool.call.id']).toBe('t2')
  })

  it('reports open-span and session counts via stats()', () => {
    const { mapper } = setup()
    const session = fakeSession()
    expect(mapper.stats()).toEqual({ sessions: 0, openSpans: 0 })

    mapper.handle(session, ev('turn/start', 0, { turn: 1 }))
    mapper.handle(session, ev('step/start', 1, { turn: 1, step: 1 }))
    mapper.handle(
      session,
      ev('tool/call', 2, { turn: 1, step: 1, callId: 'c4', name: 'bash', arguments: '{}' }),
    )
    expect(mapper.stats()).toEqual({ sessions: 1, openSpans: 3 })

    mapper.handle(
      session,
      ev('tool/result', 3, { turn: 1, step: 1, message: toolResultMessage('c4') }),
    )
    mapper.handle(session, ev('step/end', 4, { turn: 1, step: 1 }))
    mapper.handle(session, ev('turn/end', 5, { turn: 1, reason: { kind: 'completed' } as never }))
    // The session entry stays until disposal even with every span closed.
    expect(mapper.stats()).toEqual({ sessions: 1, openSpans: 0 })

    mapper.endSession(session)
    expect(mapper.stats()).toEqual({ sessions: 0, openSpans: 0 })
  })
})

describe('OtelTrajectorySink', () => {
  beforeEach(resetClock)

  it('merges the SDK default resource (telemetry.sdk.*) with service.name', async () => {
    const exporter = new InMemorySpanExporter()
    // InMemorySpanExporter.shutdown() clears its buffer, so snapshot on export
    const exported: ReadableSpan[] = []
    const original = exporter.export.bind(exporter)
    exporter.export = (spans, done) => {
      exported.push(...spans)
      original(spans, done)
    }
    const config: OtelSinkConfig = {
      enabled: true,
      url: '',
      serviceName: 'dsh-trajectory-persistence',
      maxExportBatchSize: 512,
      scheduledDelayMillis: 5_000,
      shutdownTimeoutMillis: 3_000,
    }
    const sink = new OtelTrajectorySink(fakeCtx(), config, exporter)
    const session = fakeSession()
    sink.onEvent(session, ev('turn/start', 0, { turn: 1 }))
    await sink.close()

    expect(exported).toHaveLength(1)
    expect(exported[0].resource.attributes['telemetry.sdk.name']).toBeDefined()
    expect(exported[0].resource.attributes['service.name']).toBe('dsh-trajectory-persistence')
  })
})
