import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { telegramChannel, telegramTrigger, telegramTriggerId } from '../src/sources/telegram-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { telegramKind } from '../src/sources/telegram.ts'
import { githubKind } from '../src/sources/github.ts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

describe('Source registry', () => {
  it('lists every installed kind with defaults, in id order, followed by stored instances whose kind is not installed', () => {
    const settings = SettingsSchema.parse({ sources: { probe: { enabled: false, config: { interval: 9 } }, retired: { enabled: true, config: { x: 1 } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(probe); sources.register(githubKind)
    expect(sources.instances()).toEqual([
      { id: 'github', kind: 'github', enabled: true, config: { repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3,
        observeIssues: false, observePulls: false, observeComments: false, observeCi: false }, installed: true },
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
  })
  it('validates submitted instances with the kind schema and refuses kinds that are not installed', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(probe)
    expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({ enabled: true, config: { interval: 5 } })
    expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
    expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow('not installed')
  })
  it('sends, links and reads a kind\'s Threads through its own channel and context, and nothing for a kind without them', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } }))
    const sent: OutboundMessage[] = []
    const read: unknown[] = []
    sources.register({ ...probe,
      channel: { send: async (_host, message) => { sent.push(message); return 'sent' },
        link: address => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }) },
      threadContext: { messageId: trigger => String(trigger.meta.id), read: async (_commands, trigger, part, cursor, config) => {
        read.push([trigger.id, part, cursor, config.interval])
        return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }],
          body: { page: cursor ?? 'first' } }
      } } })
    const commands = {} as Commands
    const message = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: 'probe:1', address: { room: 'r' } },
      text: 'hi', kind: 'reply' })
    expect(await sources.send(message('probe'), commands)).toBe('sent')
    expect(sent).toEqual([message('probe')])
    // A kind that is not installed keeps its replies waiting; links to it have no page.
    expect(await sources.send(message('retired'), commands)).toBe('waiting')
    expect(sources.link(message('probe').channel, {})).toEqual({ url: 'https://probe/r', label: { zh: '探针', en: 'Probe' } })
    expect(sources.link(message('retired').channel, {})).toEqual({ url: '', label: { zh: 'retired', en: 'retired' } })
    const trigger = { id: 't1', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'u' }, human: true,
      at: '', text: 'hi', meta: { id: 'm1' } }
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m1')
    expect(await context.read(commands, 'thread', '2')).toMatchObject({ body: { page: '2' } })
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    expect(context.images('img_x')).toEqual([])
    await expect(context.image({} as Agent, commands, { id: 'm1', text: '' }, 'img_x', '',
      new AbortController().signal)).rejects.toThrow('no images')
    // A kind without a channel or a context has neither.
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'), commands)).toBe('gone')
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
  })
  it('refuses a kind that declares a health entry another kind or dsh-superagent itself reports, and gives up its entries at unregister', () => {
    const board = new HealthBoard()
    // Pre-claim built-in health entries; sync:* entries are reserved for settings sync.
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const unregister = sources.register(githubKind)
    expect(() => sources.register({ ...probe, health: ['github'] })).toThrow('declares the health entry github')
    for (const name of ['runtime', 'reply', 'sync:github']) expect(() => sources.register({ ...probe, health: ['probe', name] })).toThrow(name)
    expect(sources.kind('probe')).toBeUndefined()
    sources.register({ ...probe, health: ['probe'] })
    const context = (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ sources } as unknown as SourceContextDeps, kind)
    const first = context(githubKind)
    first.report('github', { state: 'ready', detail: 'ok' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => first.report('probe', { state: 'ready', detail: '' })).toThrow('has no health entry probe')
    // A report sent after its kind unregisters (such as from an exiting CLI listener) is ignored and does not affect a later registration.
    unregister()
    expect(() => first.report('github', { state: 'error', detail: 'WARN exiting' })).not.toThrow()
    expect(board.all.github).toBeUndefined()
    sources.register(githubKind)
    first.report('github', { state: 'error', detail: 'late' })
    expect(board.all.github).toEqual({ state: 'starting', detail: '' })
    context(githubKind).report('github', { state: 'ready', detail: 'again' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'again' })
  })
  it('names the Trigger whose message a Trigger\'s message answers, where its kind can', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(telegramKind); sources.register(githubKind)
    const reply = telegramTrigger({ update_id: 2, message: { message_id: 2, date: 1_757_376_000,
      chat: { id: -100123, type: 'supergroup' }, from: { id: 42, is_bot: false, username: 'alice' }, text: 'yes',
      reply_to_message: { message_id: 1, from: { id: 42, is_bot: false } } } }, { id: 7, is_bot: true, username: 'widgets_bot' })!
    expect(sources.repliesTo(reply)).toBe(telegramTriggerId('-100123', '1'))
    expect(sources.repliesTo({ ...reply, meta: { ...reply.meta, parentId: undefined } })).toBeUndefined()
    expect(sources.repliesTo({ ...reply, source: 'github' })).toBeUndefined()
  })
  it('finds what a search query names in each kind\'s terms, where a kind has them', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(telegramKind); sources.register(githubKind)
    expect(sources.find('#12')).toEqual({ threads: ['github:12'], terms: [] })
    expect(sources.find('https://github.com/acme/widgets/pull/7#issuecomment-3')).toEqual({ threads: ['github:7'], terms: [] })
    // A Telegram message is found by its link or its text, not by a free-text term search.
    expect(telegramKind.find).toBeUndefined()
    expect(sources.find('login fails')).toEqual({ threads: [], terms: [] })
    expect(telegramKind.policy!.unnamed).toEqual({ person: { zh: 'Telegram 用户', en: 'Telegram user' }, bot: { zh: 'Telegram 机器人', en: 'Telegram bot' } })
  })
  it('refuses a second registration of one kind and forgets a kind after its disposer runs', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
  })
  it('validates each Source\'s part of the Policy with its kind, keeping parts of kinds that are not installed as stored', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ policy: { sources: { telegram: { allowed: [{ id: '42' }] } } } }))
    sources.register(telegramKind); sources.register(githubKind)
    expect(sources.validatePolicy({ telegram: { allowed: [{ id: '42', name: 'Alice' }] }, retired: { allowed: [], x: 1 } }))
      .toEqual({ telegram: { allowed: [{ id: '42', name: 'Alice' }], admission: {} }, retired: { allowed: [], x: 1 } })
    expect(() => sources.validatePolicy({ telegram: { allowed: [{ id: 'alice' }] } })).toThrow()
    expect(sources.policyPart('telegram')).toEqual({ allowed: [{ id: '42' }], admission: {} })
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    sources.register(probe)
    expect(sources.policyPart('probe')).toBeUndefined()
  })
  it('allows a reply only on a Channel whose Source still listens to its chat', () => {
    const settings = SettingsSchema.parse({ sources: { telegram: { enabled: true, config: { chats: [{ chatId: '-100123', listen: 'mentions' }], directMessages: false } } } })
    const sources = new SourceRegistry(() => settings)
    expect(sources.channelAllowed({ source: 'telegram', address: { chatId: '-100123' } })).toBe(false)
    sources.register(telegramKind); sources.register(githubKind)
    expect(sources.channelAllowed({ source: 'telegram', address: { chatId: '-100123' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'telegram', address: { chatId: '-100777' } })).toBe(false)
    // A direct chat is marked in the Channel's address; with direct messages off it gets no reply.
    expect(sources.channelAllowed(telegramChannel('42', '10'))).toBe(false)
    expect(sources.channelAllowed({ source: 'telegram', address: { chatId: '42', messageId: '10', direct: 'true' } })).toBe(false)
    expect(sources.channelAllowed({ source: 'github', address: { number: '7' } })).toBe(true)
  })
  it('delivers a reply under the default settings to a chat the Source receives', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(telegramKind)
    const trigger = telegramTrigger({ update_id: 10, message: { message_id: 10, date: 1_757_376_000,
      chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, username: 'alice' }, text: 'fix it' } },
    { id: 7, is_bot: true, username: 'widgets_bot' })!
    const channel = trigger.channel!
    expect(channel.address).toEqual({ chatId: '42', messageId: '10' })
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ status: 200, json: async () => ({ ok: true, result: { message_id: 20 } }) }) as Response)
    vi.stubGlobal('fetch', fetch)
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    try {
      // A direct chat is allowed while direct messages are on; its address names the chat to reply in.
      const allowed = { ...channel, address: { ...channel.address, direct: 'true' } }
      expect(sources.channelAllowed(allowed)).toBe(true)
      const reply: OutboundMessage = { id: 'reply-1', channel: allowed, text: 'Done', kind: 'reply' }
      expect(await sources.send(reply, commands)).toBe('sent')
      expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ chat_id: '42', text: 'Done', reply_to_message_id: 10 })
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN
      vi.unstubAllGlobals()
    }
  })
})
