/** The Superagent fallback order: Codex while it has quota, then DeepSeek, then the local model. */
import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { DEFAULT_CHAIN, installModelFallback } from '../src/app/model-fallback.ts'

interface CallConfig { provider: string, model: string, reasoningEffort?: string, maxTokens?: number }
type Handler = (...args: unknown[]) => Promise<unknown>

/** A host context whose LLM resolves any proposal to itself and advertises one local model. */
function host (now: () => number): { ctx: Context, handlers: Map<string, Handler>, install: (options?: object) => { exhausted: (provider: string) => boolean } } {
  const handlers = new Map<string, Handler>()
  const ctx = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler) },
    logger: { warn: () => {} },
    llm: {
      listModels: async (provider: string) => provider === 'local-strata' ? [{ provider, id: 'qwen3.8-flash-next-iq3_s', name: 'Qwen' }] : [],
      resolveCallConfig: async (config: CallConfig) => config
    }
  } as unknown as Context
  return { ctx, handlers, install: (options = {}) => installModelFallback(ctx, { now, ...options }) }
}

const request = async (handlers: Map<string, Handler>, config: CallConfig): Promise<CallConfig> =>
  await handlers.get('agent/request')!({}, async () => config) as CallConfig
const failure = async (handlers: Map<string, Handler>, provider: string, code: string): Promise<unknown> =>
  await handlers.get('agent/request-error')!({ provider, failure: { code, message: 'out of quota' } }, async () => undefined)

it('orders the fallback as Codex, DeepSeek, then local Strata', () => {
  expect(DEFAULT_CHAIN.map(route => route.provider)).toEqual(['openai-codex', 'deepseek-official', 'local-strata'])
})

it('leaves a Codex request alone while the account has quota', async () => {
  const { handlers, install } = host(() => 0)
  install()
  await expect(request(handlers, { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }))
    .resolves.toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
})

it('retries on the next route after an exhausted quota and drops the effort', async () => {
  const { handlers, install } = host(() => 1_000)
  install()
  await expect(failure(handlers, 'openai-codex', 'QUOTA')).resolves.toEqual({ kind: 'retry' })
  await expect(request(handlers, { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', maxTokens: 5000 }))
    .resolves.toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 5000 })
})

it('falls from DeepSeek to the local catalog model, and stops there', async () => {
  const { handlers, install } = host(() => 0)
  install()
  await failure(handlers, 'openai-codex', 'ACCOUNT_QUOTA')
  await failure(handlers, 'deepseek-official', 'QUOTA')
  await expect(request(handlers, { provider: 'deepseek-official', model: 'deepseek-flash' }))
    .resolves.toEqual({ provider: 'local-strata', model: 'qwen3.8-flash-next-iq3_s' })
  await expect(failure(handlers, 'local-strata', 'QUOTA')).resolves.toBeUndefined()
})

it('never rewrites a provider outside the chain', async () => {
  const { handlers, install } = host(() => 0)
  install()
  await expect(failure(handlers, 'openai-codex', 'QUOTA')).resolves.toEqual({ kind: 'retry' })
  await expect(request(handlers, { provider: 'local-qwen-image', model: 'qwen-image' }))
    .resolves.toEqual({ provider: 'local-qwen-image', model: 'qwen-image' })
})

it('ignores failures that are not an exhausted quota', async () => {
  const { handlers, install } = host(() => 0)
  install()
  await expect(failure(handlers, 'openai-codex', 'RATE_LIMIT')).resolves.toBeUndefined()
  await expect(request(handlers, { provider: 'openai-codex', model: 'gpt-6.1-sol' }))
    .resolves.toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
})

it('probes Codex again after the cooldown', async () => {
  let now = 0
  const { handlers, install } = host(() => now)
  install({ cooldownMs: 1000 })
  await failure(handlers, 'openai-codex', 'QUOTA')
  now = 1001
  await expect(request(handlers, { provider: 'openai-codex', model: 'gpt-6.1-sol' }))
    .resolves.toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol' })
})
