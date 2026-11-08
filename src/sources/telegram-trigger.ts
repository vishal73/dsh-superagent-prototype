/** Normalizes Telegram Bot API updates into domain Triggers, thread IDs and reply addresses. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { TelegramMe } from './telegram-api.ts'

export const SOURCE = 'telegram'
const UserSchema = z.looseObject({ id: z.number().int(), is_bot: z.boolean().default(false),
  username: z.string().optional(), first_name: z.string().optional() })
const ChatSchema = z.looseObject({ id: z.number().int(), type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(), username: z.string().optional(), is_forum: z.boolean().optional() })
const EntitySchema = z.looseObject({ type: z.string(), offset: z.number().int(), length: z.number().int(), user: UserSchema.optional() })
/** The replied-to message as an update carries it: only its ID and sender decide threading and whether the bot was addressed. */
const ReplySchema = z.looseObject({ message_id: z.number().int(), from: UserSchema.optional(),
  sender_chat: z.looseObject({ id: z.number().int() }).optional() })
/** A message or channel post as `getUpdates` prints it; media may carry only a caption. */
export const MessageSchema = z.looseObject({
  message_id: z.number().int(), date: z.number().int(), edit_date: z.number().int().optional(),
  text: z.string().optional(), caption: z.string().optional(),
  chat: ChatSchema, from: UserSchema.optional(), sender_chat: z.looseObject({ id: z.number().int() }).optional(),
  message_thread_id: z.number().int().optional(), is_topic_message: z.boolean().optional(),
  reply_to_message: ReplySchema.optional(),
  entities: z.array(EntitySchema).optional(), caption_entities: z.array(EntitySchema).optional(),
})
export type TelegramMessage = z.infer<typeof MessageSchema>
/** One `getUpdates` item; the loop reads `message` and `edited_message`, which are what it subscribes to. */
export const UpdateSchema = z.looseObject({
  update_id: z.number().int(),
  message: MessageSchema.optional(),
  edited_message: MessageSchema.optional(),
})
export type TelegramUpdate = z.infer<typeof UpdateSchema>
/** Thread of a chat or forum topic; `root` is the chat's main conversation. */
export const telegramThreadId = (chatId: number | string, topic: number | string | undefined): string =>
  `${chatId}:${topic === undefined ? 'root' : String(topic)}`
/** Constructs the reply address; a forum topic is part of it so the reply lands in the same topic. */
export const telegramChannel = (chatId: number | string, messageId: number | string, topic?: number | string, url?: string): ChannelRef => ({
  source: SOURCE, thread: `telegram:${telegramThreadId(chatId, topic)}`,
  address: { chatId: String(chatId), messageId: String(messageId), ...(topic === undefined ? {} : { topic: String(topic) }), ...(url ? { url } : {}) },
})
/** Deterministic trigger ID for a message; an edit appends its `edit_date` so the edit is a new event. */
export const telegramTriggerId = (chatId: number | string, messageId: number | string, version?: number): string =>
  key('telegram', `${chatId}:${messageId}${version === undefined ? '' : `:${version}`}`)
/**
 * True when a message addresses the bot: an `@username` mention entity, a `text_mention` entity naming it, or a reply to
 * one of its messages. Telegram does not report mentions in plain text without an entity, so a bare `@bot` is not one.
 */
export function telegramAddressed(message: TelegramMessage, me: TelegramMe): boolean {
  const text = message.text ?? message.caption ?? ''
  const entities = [...message.entities ?? [], ...message.caption_entities ?? []]
  if (entities.some(entity => entity.type === 'text_mention' ? entity.user?.id === me.id
    : entity.type === 'mention' && !!me.username && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${me.username.toLowerCase()}`)) return true
  return message.reply_to_message?.from?.id === me.id
}
/** Converts one update into a Trigger; returns undefined when it carries no message or only the bot's own post. */
export function telegramTrigger(update: TelegramUpdate, me: TelegramMe): Trigger | undefined {
  const message = update.message ?? update.edited_message
  if (!message) return undefined
  const from = message.from
  // Channel posts have no `from` and are written by the channel, never by a person who may originate work.
  if (from?.id === me.id) return undefined
  const chatId = message.chat.id
  const direct = message.chat.type === 'private'
  const topic = message.message_thread_id
  const mentioned = telegramAddressed(message, me)
  const addressed = direct ? 'direct' as const : mentioned ? 'mention' as const : undefined
  const at = new Date((message.edit_date ?? message.date) * 1000).toISOString()
  const url = message.chat.username ? `https://t.me/${message.chat.username}/${message.message_id}` : undefined
  const parentId = message.reply_to_message?.message_id
  return {
    id: telegramTriggerId(chatId, message.message_id, message.edit_date),
    source: SOURCE,
    threads: [{ source: SOURCE, id: telegramThreadId(chatId, topic) }],
    actor: { source: SOURCE, id: String(from?.id ?? message.sender_chat?.id ?? chatId) },
    human: !(from?.is_bot ?? false) && message.sender_chat === undefined,
    ...(addressed ? { addressed } : {}),
    at,
    text: message.text ?? message.caption ?? '',
    channel: telegramChannel(chatId, message.message_id, topic, url),
    ...(url ? { url } : {}),
    meta: { chatId: String(chatId), chatType: message.chat.type, messageId: String(message.message_id),
      threadId: telegramThreadId(chatId, topic), direct, mentioned,
      ...(topic === undefined ? {} : { topic: String(topic) }),
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      ...(parentId === undefined ? {} : { parentId: String(parentId) }) },
  }
}
