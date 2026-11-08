/** Telegram outbound channel: posts a reply under the message and builds message deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { TelegramError, telegramCall, telegramToken } from './telegram-api.ts'

/**
 * Telegram answers a permanent refusal with 400 or 403: the target message, chat or topic is gone, or the bot lost access.
 * A timeout, a 429 or a 5xx is retryable and must not be mistaken for one of these.
 */
const GONE = /message to reply not found|message not found|chat not found|bot was blocked by the user|user is deactivated|chat was deleted|not enough rights|bot is not a member|topic .*closed/i
export const telegramGone = (error: unknown): boolean =>
  error instanceof TelegramError && (error.code === 400 || error.code === 403) && GONE.test(error.message)
/**
 * Sends one reply under its Trigger's message, in the same forum topic.
 * The Bot API has no idempotency key: a send that succeeded but whose answer was lost is posted again on retry.
 */
export async function sendTelegram(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { chatId, messageId, topic } = message.channel.address
  if (!chatId) throw new Error('Missing Telegram reply target')
  const text = checkedImText(message.text)
  try {
    await telegramCall(telegramToken(), 'sendMessage', { chat_id: chatId, text,
      ...(messageId ? { reply_to_message_id: Number(messageId) } : {}), ...(topic ? { message_thread_id: Number(topic) } : {}) })
    return 'sent'
  } catch (error) {
    if (telegramGone(error)) return 'gone'
    throw error
  }
}
/** Link to a message: its own `t.me` link when the chat is public, otherwise the internal `t.me/c/` form for a supergroup. */
export const telegramLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => {
  const chatId = address.chatId ?? ''
  const messageId = address.messageId ?? ''
  const internal = /^-100\d+$/.test(chatId) ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : ''
  return { url: address.url ?? internal, label: { zh: 'Telegram 消息', en: 'Telegram message' } }
}
