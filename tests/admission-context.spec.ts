import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { admissionContext, threadWindow } from '../src/sources/admission-context.ts'
import type { Commands } from '../src/infra/commands.ts'
import { clearCache, pollUpdates, telegramKind } from '../src/sources/telegram.ts'
import type { ContextMessage } from '../src/sources/kind.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Trigger } from '../src/core/index.ts'

const ME = { id: 7, is_bot: true, username: 'widgets_bot' }
const CHAT = -100123
const TOPIC = 5
const message = (index: number): ContextMessage => ({ id: `${index}`, from: '42', at: String(index), text: `Message ${index}` })
const answer = (result: unknown): Response => ({ status: 200, json: async () => ({ ok: true, result }) }) as Response

/** A Source context over an in-memory offset and a Telegram configuration that reads `readPageSize` messages a page. */
function source(readPageSize: number) {
  const state = new Map<string, unknown>(), received: Trigger[] = []
  const context = {
    config: <C extends Record<string, unknown>>() => ({ chats: [{ chatId: String(CHAT), listen: 'all' }], directMessages: true, readPageSize }) as unknown as C,
    state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => { state.set(name, value) } },
    receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' },
    threads: { describe: () => {} },
  }
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { telegram: { enabled: true, config: { readPageSize } } } }))
  sources.register(telegramKind)
  return { ctx: context as unknown as SourceContext, received, sources }
}

/** Reads `count` messages of one forum topic through `pollUpdates`, so the cache holds what the Source would have received. */
let token = 0
async function seed(ctx: SourceContext, count: number) {
  const updates = Array.from({ length: count }, (_, index) => ({ update_id: index + 1, message: { message_id: 10 + index, date: 1_700_000_000 + index,
    chat: { id: CHAT, type: 'supergroup', is_forum: true, title: 'Ops' }, from: { id: 42, is_bot: false, username: 'alice' },
    text: `Message ${10 + index}`, message_thread_id: TOPIC, is_topic_message: true } }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(ME)).mockResolvedValueOnce(answer(updates)))
  await pollUpdates(ctx, telegramKind.schema.parse({ chats: [{ chatId: String(CHAT), listen: 'all' }], readPageSize: 2 }), `topic-token-${++token}`, new AbortController().signal)
}

beforeEach(() => { clearCache() })
afterEach(() => { vi.unstubAllGlobals() })

it('returns the thread opening and trigger neighbors with exact internal and trailing gaps', () => {
  const result = threadWindow(Array.from({ length: 40 }, (_, i) => message(i)), '25')
  expect(result.entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  expect(result.entries[5]?.omitted_before).toBe(15)
  expect(result.omitted_after).toBe(9)
  expect(result.source_found).toBe(true)
})
it('deduplicates overlapping windows and reports an absent source without inventing neighbors', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  expect(threadWindow(messages, '3').entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(threadWindow(messages, 'absent')).toMatchObject({ source_found: false, loaded_messages: 12, omitted_after: 7 })
})
it('retains pagination limits and exact loaded counts rather than claiming complete history', async () => {
  const { ctx, received, sources } = source(2)
  await seed(ctx, 6)
  const trigger = received.at(-1)!
  expect(trigger.threads[0]).toEqual({ source: 'telegram', id: `${CHAT}:topic-${TOPIC}` })
  const result = await admissionContext(sources.threadContext(trigger)!, {} as Commands, 1)
  expect(result).toMatchObject({ complete: false, next: '2', status: 'available', window: { loaded_messages: 2, source_found: false } })
  expect(result.messages.map(message => message.id)).toEqual(['10', '11'])
})
it('reads a whole Thread from the cache across pages, oldest first, when no page is cut short', async () => {
  const { ctx, received, sources } = source(2)
  await seed(ctx, 6)
  const trigger = received.at(-1)!
  const result = await admissionContext(sources.threadContext(trigger)!, {} as Commands, 3)
  expect(result).toMatchObject({ status: 'available', complete: true, next: null, window: { source_found: true, loaded_messages: 6 } })
  expect(result.messages.map(message => message.id)).toEqual(['10', '11', '12', '13', '14', '15'])
  expect(result.window.entries.length).toBe(6)
})
