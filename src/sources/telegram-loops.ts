/** Telegram background loop: long-polls `getUpdates`, stores each update's Trigger, and follows the Source switch. */
import { threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { z } from 'zod'
import { health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { TelegramMeSchema, telegramCall, telegramToken, type TelegramMe } from './telegram-api.ts'
import { SOURCE, UpdateSchema, telegramTrigger } from './telegram-trigger.ts'
import type { TelegramConfig } from './telegram.ts'

/** Runs the loop until `signal` aborts; disposal awaits it, so a restart does not leave a poll running. */
export const runTelegram = (ctx: SourceContext, signal: AbortSignal): Promise<void> => watch(ctx, signal)

/** The bot identity is stable for a token, so it is read once and reused until the token changes. */
let identity: { token: string; me: TelegramMe } | undefined
async function bot(token: string, signal: AbortSignal): Promise<TelegramMe> {
  if (identity?.token === token) return identity.me
  const me = TelegramMeSchema.parse(await telegramCall(token, 'getMe', {}, signal))
  identity = { token, me }
  return me
}

async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chat = trigger.meta.direct === true
    ? { value: { zh: '私聊', en: 'Direct message' } }
    : { value: String(trigger.meta.chatTitle ?? trigger.meta.chatId ?? 'Telegram') }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { ...(trigger.url ? { url: trigger.url } : {}), facts: { chat } })
}

/**
 * Reads the updates after the stored offset, takes in each message, then advances the offset past it.
 * A message that cannot be read alone is counted and skipped; the offset still moves, because replaying it would not help.
 */
export async function pollUpdates(ctx: SourceContext, config: TelegramConfig, token: string, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const me = await bot(token, signal)
  const offset = ctx.state.get(KV.telegram.offset) ?? 0
  const updates = z.array(z.unknown()).parse(await telegramCall(token, 'getUpdates',
    { offset, timeout: config.pollTimeoutSeconds, allowed_updates: ['message', 'edited_message'] }, signal))
  let unreadable = 0
  for (const raw of updates) {
    if (signal.aborted) throw new Error('The Telegram Source stopped during the read')
    const update = UpdateSchema.safeParse(raw)
    if (!update.success) { unreadable += 1; continue }
    const trigger = telegramTrigger(update.data, me)
    // Updates read while the Source is switched off are consumed without being stored.
    if (trigger && ctx.config<TelegramConfig>(SOURCE)) await receive(ctx, trigger)
    ctx.state.set(KV.telegram.offset, update.data.update_id + 1)
  }
  return { read: updates.length, unreadable }
}

/** Long-polls while the Source is on; `getUpdates` itself holds the request, so a returned empty page waits a second. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup resolves the GitHub account first; until it does, an unconfigured deployment restarts dsh-superagent once it is.
  if (!ctx.configured()) { ctx.report('telegram', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TelegramConfig>(SOURCE)
    if (!config) {
      ctx.report('telegram', health('paused', 'sourceOff'))
      await pause(5000, signal)
      continue
    }
    const token = telegramToken()
    if (!token) {
      ctx.report('telegram', { state: 'error', detail: 'TELEGRAM_BOT_TOKEN is not set for the dsh-superagent process' })
      await pause(60_000, signal)
      continue
    }
    const at = new Date().toISOString()
    try {
      const { read, unreadable } = await pollUpdates(ctx, config, token, signal)
      failures = 0
      ctx.report('telegram', { state: 'ready', detail: `${read} updates, ${unreadable} unreadable`, at })
      if (read === 0) await pause(1000, signal)
    } catch (error) {
      if (signal.aborted) return
      failures += 1
      // One network failure is retried with backoff; the configured number in a row needs a person.
      if (failures >= config.failuresBeforeError) ctx.report('telegram', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      await pause(Math.min(1000 * 2 ** (failures - 1), 60_000), signal)
    }
  }
}
