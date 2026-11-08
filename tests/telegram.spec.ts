import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { KV } from '../src/kv.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { apply, clearCache, pollUpdates, sendTelegram, telegramGone, telegramKind, telegramThreadContext, telegramTrigger } from '../src/sources/telegram.ts'
import { testDeployment } from './fixtures/deployment.ts'

const ME = { id: 7, is_bot: true, username: 'widgets_bot' }
const ALLOWED = { id: '42', name: 'Alice' }
/** One Bot API update's message; `fields` replaces or adds top-level message keys. */
const message = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  message_id: 10, date: 1_700_000_000,
  chat: { id: -100123, type: 'supergroup', title: 'Ops' },
  from: { id: 42, is_bot: false, username: 'alice', first_name: 'Alice' },
  text: 'please fix the flaky test', ...fields,
})
const update = (fields: Record<string, unknown> = {}, updateId = 1): Record<string, unknown> =>
  ({ update_id: updateId, message: message(fields) })
const answer = (result: unknown): Response => ({ status: 200, json: async () => ({ ok: true, result }) }) as Response
const refusal = (error_code: number, description: string): Response =>
  ({ status: error_code === 429 ? 429 : 400, json: async () => ({ ok: false, error_code, description }) }) as Response

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'telegram-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { telegram: { enabled: true, config: { chats: [{ chatId: '-100123', listen: 'all' }], directMessages: true } } },
    policy: { sources: { telegram: { allowed: [ALLOWED] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(telegramKind)
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, receive, health: board.all, ctx: sourceContextOf(deps, telegramKind) }
}

beforeEach(() => {
  clearCache()
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  process.env.TELEGRAM_API_BASE = 'https://telegram.test'
})
afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_API_BASE
  vi.unstubAllGlobals()
})

describe('Telegram messages as Triggers', () => {
  it('makes a direct message an addressed Trigger with a stable id and reply address', () => {
    const trigger = telegramTrigger(update({ chat: { id: 42, type: 'private' } }) as never, ME)!
    expect(trigger).toMatchObject({
      id: key('telegram', '42:10'), source: 'telegram',
      threads: [{ source: 'telegram', id: '42:10' }], actor: { source: 'telegram', id: '42' },
      human: true, addressed: 'direct', at: '2023-11-14T22:13:20.000Z',
      channel: { source: 'telegram', thread: 'telegram:42:10', address: { chatId: '42', messageId: '10' } },
      meta: { chatId: '42', chatType: 'private', messageId: '10', threadId: '42:10', root: '10', direct: true, mentioned: false },
    })
    expect(trigger.text).toBe('please fix the flaky test')
  })
  it('recognizes a forum topic, an @mention and a reply to the bot', () => {
    const topic = telegramTrigger(update({ message_thread_id: 5, is_topic_message: true }) as never, ME)!
    expect(topic.threads[0]).toEqual({ source: 'telegram', id: '-100123:topic-5' })
    expect(topic.channel?.address).toEqual({ chatId: '-100123', messageId: '10', topic: '5' })
    const mentioned = telegramTrigger(update({ entities: [{ type: 'mention', offset: 0, length: 12 }], text: '@widgets_bot fix it' }) as never, ME)!
    expect(mentioned.addressed).toBe('mention')
    const other = telegramTrigger(update({ entities: [{ type: 'mention', offset: 0, length: 13 }], text: '@someone_else fix it' }) as never, ME)!
    expect(other.addressed).toBeUndefined()
    const replied = telegramTrigger(update({ reply_to_message: { message_id: 9, from: { id: 7, is_bot: true } } }) as never, ME)!
    expect(replied.addressed).toBe('mention')
    expect(telegramKind.repliesTo!(replied)).toBe(key('telegram', '-100123:9'))
  })
  it('drops the bot\'s own message, marks other bots non-human, and makes an edit a new event', () => {
    expect(telegramTrigger(update({ from: { id: 7, is_bot: true } }) as never, ME)).toBeUndefined()
    expect(telegramTrigger(update({ from: { id: 99, is_bot: true } }) as never, ME)?.human).toBe(false)
    const original = telegramTrigger(update() as never, ME)!
    const edited = telegramTrigger(update({ edit_date: 1_700_000_100 }) as never, ME)!
    expect(edited.id).not.toBe(original.id)
    expect(edited.at).toBe('2023-11-14T22:15:00.000Z')
  })
})

describe('Telegram polling', () => {
  it('stores the messages after the offset once, filters out-of-scope chats, and moves the offset past them', async () => {
    const h = host()
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(ME))
      .mockResolvedValueOnce(answer([update({}, 4), { update_id: 'five' }, update({ chat: { id: -100999, type: 'supergroup' } }, 6)]))
      .mockResolvedValueOnce(answer([]))
    vi.stubGlobal('fetch', fetch)
    expect(await pollUpdates(h.ctx, telegramKind.schema.parse({ chats: [{ chatId: '-100123', listen: 'all' }] }), 'test-token', new AbortController().signal))
      .toEqual({ read: 3, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(h.store.get(KV.telegram.offset)).toBe(7)
    expect(h.engine.candidate(key('telegram', '-100123:10'))?.strength).toBe('inferred')
    // The bot identity is read once for a token and reused on the next round.
    await pollUpdates(h.ctx, telegramKind.schema.parse({ chats: [] }), 'test-token', new AbortController().signal)
    expect(fetch).toHaveBeenCalledTimes(3)
    h.store.close()
  })
  it('leaves the offset at the last stored update when a round is cut short', async () => {
    const h = host()
    h.receive.mockImplementationOnce(() => 'stored').mockImplementation(() => { throw new Error('engine unavailable') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(ME)).mockResolvedValueOnce(answer([update({}, 4), update({ message_id: 11 }, 5)])))
    await expect(pollUpdates(h.ctx, telegramKind.schema.parse({ chats: [{ chatId: '-100123', listen: 'all' }] }), 'other-token', new AbortController().signal))
      .rejects.toThrow('engine unavailable')
    expect(h.store.get(KV.telegram.offset)).toBe(5)
    h.store.close()
  })
})

describe('Telegram Thread context', () => {
  it('reads a Thread from the messages this process received, and joins a reply to its parent\'s Thread', async () => {
    const h = host()
    const config = telegramKind.schema.parse({ chats: [{ chatId: '-100123', listen: 'all' }] })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(answer(ME))
      .mockResolvedValueOnce(answer([
        update({ message_id: 10, text: 'the root' }, 1),
        update({ message_id: 11, text: 'a reply', reply_to_message: { message_id: 10, from: { id: 42, is_bot: false } } }, 2),
      ])))
    await pollUpdates(h.ctx, config, 'thread-token', new AbortController().signal)
    expect(h.store.threads.get('telegram:-100123:10')).toBeDefined()
    const trigger = h.store.triggers.get(key('telegram', '-100123:11'))!
    const context = telegramThreadContext.read(undefined as never, trigger, 'thread', undefined, config)
    await expect(context).resolves.toMatchObject({ status: 'available', messages: [expect.objectContaining({ id: '10', text: 'the root' }), expect.objectContaining({ id: '11', text: 'a reply', reply_to: '10' })] })
    await expect(telegramThreadContext.read(undefined as never, trigger, 'parent', undefined, config)).resolves.toMatchObject({ messages: [{ id: '10' }] })
    h.store.close()
  })
  it('reports a Thread it never received instead of inventing one', async () => {
    const h = host()
    const trigger = telegramTrigger(update({ message_id: 40 }) as never, ME)!
    await expect(telegramThreadContext.read(undefined as never, trigger, 'thread', undefined, { readPageSize: 20 }))
      .resolves.toMatchObject({ status: 'not_cached', messages: [] })
    h.store.close()
  })
})

describe('Telegram replies', () => {
  const reply: OutboundMessage = { id: 'r1', kind: 'reply', text: 'On it',
    channel: { source: 'telegram', thread: 'telegram:-100123:5', address: { chatId: '-100123', messageId: '10', topic: '5' } } }
  it('posts under the message, in its topic, once', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ chat_id: '-100123', text: 'On it', reply_to_message_id: 10, message_thread_id: 5 })
      return answer({ message_id: 20 })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await sendTelegram({} as never, reply)).toBe('sent')
    expect(String((fetch.mock.calls[0]![0]))).toBe('https://telegram.test/bottest-token/sendMessage')
  })
  it('reports gone only for a permanent refusal and throws for a retryable one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal(400, 'Bad Request: message to reply not found')))
    expect(await sendTelegram({} as never, reply)).toBe('gone')
    vi.stubGlobal('fetch', vi.fn(async () => refusal(500, 'Internal Server Error')))
    await expect(sendTelegram({} as never, reply)).rejects.toThrow('Internal Server Error')
    expect(telegramGone(new Error('message to reply not found'))).toBe(false)
  })
  it('refuses text over the IM word limit before calling Telegram', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(sendTelegram({} as never, { ...reply, text: 'word '.repeat(101) })).rejects.toThrow('maximum is 100')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Telegram kind and plugin', () => {
  it('declares the admission rows its scope returns', () => {
    const config = telegramKind.schema.parse({ chats: [{ chatId: '-100123', listen: 'mentions' }], directMessages: false })
    expect(telegramKind.policy!.rows!(config)).toEqual([
      { id: '-100123', label: '-100123', note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: { zh: '不接收', en: 'Not received' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '不接收', en: 'Not received' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
    ])
    expect(telegramKind.scope!({ meta: { chatId: '-100123', direct: false } }, config)).toEqual({ listened: true, observed: false, row: '-100123' })
  })
  it('registers the kind and reports setupPending while the deployment is unconfigured', async () => {
    const h = host({ configured: () => false })
    const kinds: string[] = []
    const disposers: (() => void)[] = []
    const ctx = {
      effect: (fn: () => (() => void) | void) => { disposers.push(fn() as () => void) },
      orchestrator: { sources: { register: (kind: SourceKind) => { kinds.push(kind.kind); return () => {} } },
        context: (kind: SourceKind) => sourceContextOf(h, kind) },
    } as unknown as Context
    apply(ctx)
    expect(kinds).toEqual(['telegram'])
    await vi.waitFor(() => expect(h.health.telegram).toMatchObject({ state: 'paused', code: 'setupPending' }))
    expect(disposers).toHaveLength(2)
    expect(() => disposers[0]!()).not.toThrow()
    h.store.close()
  })
})
