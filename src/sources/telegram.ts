/** Telegram Source kind definition, policy part, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sendTelegram, telegramLink } from './telegram-channel.ts'
import { runTelegram } from './telegram-loops.ts'
import { SOURCE, telegramTriggerId } from './telegram-trigger.ts'
import { sourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export { SOURCE, telegramAddressed, telegramChannel, telegramThreadId, telegramTrigger, telegramTriggerId } from './telegram-trigger.ts'
export { sendTelegram, telegramGone, telegramLink } from './telegram-channel.ts'
export { pollUpdates, runTelegram } from './telegram-loops.ts'
const ChatSchema = z.object({ chatId: z.string().regex(/^-?\d+$/), name: z.string().trim().max(60).optional(),
  listen: z.enum(['mentions', 'all']) }).strict()
const TelegramConfigSchema = z.object({
  chats: z.array(ChatSchema).refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  pollTimeoutSeconds: z.number().int().min(1).max(50).default(25),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>
const SenderSchema = z.object({ id: z.string().regex(/^-?\d+$/), name: z.string().trim().max(100).optional() }).strict()
/**
 * A Telegram Source is a bot. Its token comes from `TELEGRAM_BOT_TOKEN` in the dsh-superagent process, never from settings,
 * so an exported configuration or a screenshot of the Source page cannot hand out control of the bot.
 */
export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: { zh: '接收下列群和论坛话题中发给机器人的消息以及私聊，轮询机器人收到的更新。', en: 'Receives messages to the bot in these chats and forum topics, and direct messages, by polling the updates the bot receives.' },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '填数字 chat id，超级群是 -100 开头的负数；机器人须已在群里。“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: 'Write the numeric chat ID; a supergroup ID is negative and starts with -100. The bot must already be a member. "@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: '-?[0-9]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已在、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the bot is in that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'pollTimeoutSeconds', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '长轮询等待 / 秒', en: 'Long-poll wait / seconds' },
      hint: { zh: '一次 getUpdates 让 Telegram 最多等待多久；没有更新时请求在这段时间后返回，然后立即重新发起。', en: 'How long one getUpdates request may wait for Telegram; it returns after this time when there is nothing new, then the next request starts at once.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会退避重试，不必报告。', en: 'A single network interruption is retried with backoff and need not be reported.' } },
  ],
  health: ['telegram'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) => telegramKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendTelegram, link: telegramLink,
  },
  // The Bot API has no history read, so an assessment sees the Trigger's own text and the message it replies to, not the conversation around it.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? telegramTriggerId(String(trigger.meta.chatId ?? ''), trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: 'Telegram 用户', en: 'Telegram user' }, bot: { zh: 'Telegram 机器人', en: 'Telegram bot' } },
    schema: z.object({
      allowed: z.array(SenderSchema).refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user IDs').default([]),
      bots: z.array(SenderSchema).refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot IDs').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Telegram 用户', en: 'Telegram users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '-?[0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '-?[0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人私聊机器人或 @ 机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who messages the bot directly or mentions it always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = TelegramConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: { zh: '接下工单的 Telegram 群；工单不是从 Telegram 来的时为空', en: 'The Telegram chat that started the ticket; empty when the ticket did not start on Telegram' } },
      { key: 'DSH_SUPERAGENT_TELEGRAM_TOPIC', description: { zh: '群里的论坛话题；不是话题里的工单时为空', en: 'The forum topic in that chat; empty when the ticket did not start in one' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
      DSH_SUPERAGENT_TELEGRAM_TOPIC: trigger?.source === SOURCE ? String(trigger.meta.topic ?? '') : '',
    }),
  },
}
export const name = 'dsh-superagent-telegram'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), 'telegram: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, telegramKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = runTelegram(source, controller.signal)
      .catch((error: unknown) => { source.report('telegram', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
