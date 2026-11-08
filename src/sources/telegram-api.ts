/** Telegram Bot API transport: reads the bot token from the environment and validates every answer before use. */
import { z } from 'zod'

/**
 * Reads the bot token from the process environment. The token never enters settings or the panel, so a leaked settings
 * export or a screenshot of the Source page cannot hand out control of the bot.
 */
export const telegramToken = (environment: NodeJS.ProcessEnv = process.env): string => environment.TELEGRAM_BOT_TOKEN?.trim() ?? ''
/** API origin; `TELEGRAM_API_BASE` lets a test or a local Bot API server stand in for `api.telegram.org`. */
export const telegramApiBase = (environment: NodeJS.ProcessEnv = process.env): string =>
  (environment.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')

/** A refused Bot API call; `code` is Telegram's `error_code` (400, 403, 409, 429, …). */
export class TelegramError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) { super(message) }
}
const Answer = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
  parameters: z.looseObject({ retry_after: z.number().int().optional() }).optional(),
})

/**
 * Calls one Bot API method and returns its `result`.
 * The token travels in the URL, so failures never echo the request URL; only Telegram's own description is kept.
 * @throws TelegramError when Telegram answers `ok: false`, and when the answer is not JSON.
 */
export async function telegramCall<T>(token: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (!token) throw new TelegramError('TELEGRAM_BOT_TOKEN is not set')
  const response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), ...(signal ? { signal } : {}),
  })
  let body: unknown
  try { body = await response.json() }
  catch { throw new TelegramError(`${method} answered without JSON (HTTP ${response.status})`, response.status) }
  const answer = Answer.parse(body)
  if (!answer.ok) throw new TelegramError(answer.description ?? `${method} failed`, answer.error_code, answer.parameters?.retry_after)
  return answer.result as T
}
/** The bot's own identity, used to recognize messages addressed to it and to ignore its own. */
export const TelegramMeSchema = z.looseObject({ id: z.number().int(), is_bot: z.boolean(), username: z.string().optional(), first_name: z.string().optional() })
export type TelegramMe = z.infer<typeof TelegramMeSchema>
