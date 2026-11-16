/** Which failures mean a provider cannot answer, and the `turn/end` shape that reports one. */
import { expect, it } from 'vitest'
import { isProviderFailure } from '../src/app/model-fallback.ts'
import { providerTurnFailure } from '../src/app/sessions.ts'

/** A `turn/end` event body as DSH writes it; `reason` mirrors the session log. */
const turnEnd = (reason: unknown): unknown => ({ turn: 1, reason })
const failure = (code: string) => ({ message: 'OAuth refresh failed for openai-codex (401)', code })

it('treats an exhausted quota or a rejected credential as a provider failure', () => {
  expect(isProviderFailure({ code: 'QUOTA' })).toBe(true)
  expect(isProviderFailure({ code: 'ACCOUNT_QUOTA' })).toBe(true)
  expect(isProviderFailure({ code: 'AUTH' })).toBe(true)
  expect(isProviderFailure({ code: 'INVALID_CREDENTIAL' })).toBe(true)
})

it('leaves transient and unknown failures on the provider they happened on', () => {
  expect(isProviderFailure({ code: 'RATE_LIMIT' })).toBe(false)
  expect(isProviderFailure({ code: 'CONTEXT_LIMIT' })).toBe(false)
  expect(isProviderFailure({ code: 'UNKNOWN' })).toBe(false)
  expect(isProviderFailure({})).toBe(false)
  expect(isProviderFailure(undefined)).toBe(false)
})

it('reads the provider failure out of a turn that ended in error', () => {
  expect(providerTurnFailure(turnEnd({ kind: 'error', error: failure('AUTH') })))
    .toEqual({ message: 'OAuth refresh failed for openai-codex (401)', code: 'AUTH' })
  expect(providerTurnFailure(turnEnd({ kind: 'error', error: failure('QUOTA') })))
    .toEqual({ message: 'OAuth refresh failed for openai-codex (401)', code: 'QUOTA' })
})

it('reports nothing for a turn that ended for another reason', () => {
  expect(providerTurnFailure(turnEnd({ kind: 'completed' }))).toBeUndefined()
  expect(providerTurnFailure(turnEnd({ kind: 'error', error: failure('RATE_LIMIT') }))).toBeUndefined()
  expect(providerTurnFailure(turnEnd({ kind: 'error', error: { message: 'aborted by a person' } }))).toBeUndefined()
  expect(providerTurnFailure(turnEnd({ kind: 'error' }))).toBeUndefined()
  expect(providerTurnFailure({ turn: 1 })).toBeUndefined()
  expect(providerTurnFailure(undefined)).toBeUndefined()
})
