/**
 * Keeps a Supervision Session on the Codex account until that account runs out
 * of quota, then retries the same step on DeepSeek, and last on the local
 * Strata model. A provider that reports an exhausted quota is skipped for a
 * cooldown; an explicit selection of another provider is never rewritten.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE, ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** One route in the fallback order; a missing model means the provider's first catalog model. */
export interface FallbackRoute {
  readonly provider: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Codex first, then the DeepSeek API key, then the local model. */
export const DEFAULT_CHAIN: readonly FallbackRoute[] = Object.freeze([
  { provider: 'openai-codex' },
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'local-strata' }
])

/** How long a provider stays skipped after it reports an exhausted quota. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000

const QUOTA_CODES: ReadonlySet<string> = new Set([QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE])

/** Whether a normalized failure means the account cannot serve any more requests right now. */
export function isExhaustion (failure: { readonly code?: string } | undefined): boolean {
  return failure?.code !== undefined && QUOTA_CODES.has(failure.code)
}

export interface FallbackOptions {
  readonly chain?: readonly FallbackRoute[]
  readonly cooldownMs?: number
  /** Clock seam for tests. */
  readonly now?: () => number
}

/**
 * Install the two waterfalls that implement the fallback order.
 * @param ctx - the host context; listeners are global, so they see every agent.
 * @param options - chain, cooldown and clock overrides.
 * @returns a probe of the current exhaustion state, for diagnostics and tests.
 */
export function installModelFallback (ctx: Context, options: FallbackOptions = {}): { exhausted: (provider: string) => boolean } {
  const chain = options.chain ?? DEFAULT_CHAIN
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const clock = options.now ?? Date.now
  const until = new Map<string, number>()
  const catalog = new Map<string, Promise<string | undefined>>()

  const indexOf = (provider: string) => chain.findIndex(route => route.provider === provider)
  const available = (provider: string) => (until.get(provider) ?? 0) <= clock()
  const mark = (provider: string) => { until.set(provider, clock() + cooldownMs) }
  const nextIndex = (from: number) => chain.findIndex((route, index) => index > from && available(route.provider))

  const firstModel = (provider: string): Promise<string | undefined> => {
    let pending = catalog.get(provider)
    if (pending === undefined) {
      pending = ctx.llm.listModels(provider).then(models => models[0]?.id, () => undefined)
      catalog.set(provider, pending)
    }
    return pending
  }

  const route = async (target: FallbackRoute, from: LlmCallConfig): Promise<LlmCallConfig | undefined> => {
    const model = target.model ?? await firstModel(target.provider)
    if (model === undefined) return undefined
    try {
      const resolved = await ctx.llm.resolveCallConfig({ provider: target.provider, model,
        ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(target.reasoningEffort) }) })
      // Keep sampling controls, but never carry a reasoning effort across providers.
      const { reasoningEffort: _unused, ...controls } = from
      return { ...controls, provider: resolved.provider, model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
    } catch {
      return undefined
    }
  }

  const fallbackFrom = async (index: number, config: LlmCallConfig): Promise<LlmCallConfig | undefined> => {
    let next = nextIndex(index)
    while (next >= 0) {
      const target = await route(chain[next]!, config)
      if (target !== undefined) return target
      next = nextIndex(next)
    }
    return undefined
  }

  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    const index = indexOf(config.provider)
    if (index < 0 || available(config.provider)) return config
    let target: LlmCallConfig | undefined
    try { target = await fallbackFrom(index, config) } catch { target = undefined }
    if (target === undefined) return config
    ctx.logger.warn('dsh-superagent: %s is over its quota; using %s/%s', config.provider, target.provider, target.model)
    return target
  })

  ctx.on('agent/request-error', async (payload, next) => {
    const index = indexOf(payload.provider)
    if (index < 0 || !isExhaustion(payload.failure)) return next()
    // A provider that is already skipped keeps the failure terminal, so a request that could not be rewritten cannot loop here.
    if (!available(payload.provider)) return next()
    mark(payload.provider)
    if (nextIndex(index) < 0) return next()
    ctx.logger.warn('dsh-superagent: %s is over its quota; retrying the step on the next route', payload.provider)
    return { kind: 'retry' }
  })

  return { exhausted: (provider: string) => !available(provider) }
}
