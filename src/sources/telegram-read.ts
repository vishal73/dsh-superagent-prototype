/**
 * Recent Telegram messages kept in memory, by Thread, while the Source runs.
 * The Bot API cannot read a chat's history, so this cache is the only record of what a Thread said before an assessment;
 * it starts empty again when dsh-superagent restarts, exactly as the bot's own view of the chat does.
 */
import type { Trigger } from '../core/index.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { SOURCE } from './telegram-trigger.ts'

/** Messages kept per Thread, and Threads kept at all; both bound the memory a busy bot uses. */
const PER_THREAD = 200
const THREADS = 500
const messages = new Map<string, ContextMessage[]>()
/** Which Thread each known message belongs to, so a reply continues its parent's Thread rather than starting one. */
const threads = new Map<string, string>()

const messageKey = (chatId: string, messageId: string): string => `${chatId}:${messageId}`
export const threadOf = (chatId: string, messageId: string): string | undefined => threads.get(messageKey(chatId, messageId))
/** The message that started the Thread `messageId` belongs to, when it was seen; a reply continues it. */
export function rootOfMessage(chatId: string, messageId: string): string | undefined {
  return threadOf(chatId, messageId)?.split(':').at(-1)
}
/** Records one message on its Thread; a repeated message ID, such as a replayed update, is ignored. */
export function remember(thread: string, chatId: string, message: ContextMessage): void {
  const list = messages.get(thread) ?? []
  if (list.some(item => item.id === message.id)) return
  list.push(message)
  if (list.length > PER_THREAD) list.splice(0, list.length - PER_THREAD)
  messages.set(thread, list)
  threads.set(messageKey(chatId, message.id), thread)
  if (messages.size > THREADS) {
    const oldest = messages.keys().next().value
    if (oldest !== undefined) { messages.delete(oldest); for (const [key, value] of threads) if (value === oldest) threads.delete(key) }
  }
}
export const cached = (thread: string): ContextMessage[] => messages.get(thread) ?? []
/** The message a Thread started with, when it is still cached. */
export const rootOf = (thread: string): ContextMessage | undefined => cached(thread)[0]
/** Forgets everything; tests use it to isolate one Source run from the next. */
export function clearCache(): void { messages.clear(); threads.clear() }

/** Reads a Thread from the local cache for assessments; `thread` pages through it, `root` and `parent` read one message. */
export const telegramThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (_commands, trigger, part, cursor, config) => {
    const ref = trigger.threads[0]
    if (!ref) return { messages: [], body: { status: 'no_thread' }, status: 'no_thread' }
    const thread = `${SOURCE}:${ref.id}`
    const list = cached(thread)
    if (!list.length) return { messages: [], body: { status: 'not_cached' }, status: 'not_cached' }
    if (part === 'root') return { messages: [list[0]!], body: { status: 'available', messages: [list[0]!] }, status: 'available' }
    if (part === 'parent') {
      const parent = list.find(item => item.id === String(trigger.meta.parentId ?? ''))
      return parent ? { messages: [parent], body: { status: 'available', messages: [parent] }, status: 'available' }
        : { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
    }
    const start = cursor ? Number(cursor) : 0
    if (!Number.isInteger(start) || start < 0) throw new Error('Use the next cursor the previous page returned')
    const page = list.slice(start, start + config.readPageSize)
    const next = start + page.length < list.length ? String(start + page.length) : undefined
    return { messages: page, ...(next ? { next } : {}), body: { status: 'available', messages: page, next: next ?? null }, status: 'available' }
  },
}
