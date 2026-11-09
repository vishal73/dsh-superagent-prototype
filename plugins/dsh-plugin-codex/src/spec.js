/**
 * Model shorthands and Codex CLI discovery shared by the plugin and the CLI
 * wrapper. Kept dependency-free so both can import it without a build step.
 */
import { existsSync } from 'node:fs'

/** The Codex models this deployment's account serves, by shorthand. */
const MODEL_ALIASES = new Map([
  ['sol', 'gpt-6.1-sol'],
  ['gpt-6.1-sol', 'gpt-6.1-sol'],
  ['sol-6', 'gpt-6-sol'],
  ['gpt-6-sol', 'gpt-6-sol'],
  ['astra', 'gpt-6-astra'],
  ['gpt-6-astra', 'gpt-6-astra'],
  ['luna', 'gpt-6-luna'],
  ['gpt-6-luna', 'gpt-6-luna'],
  ['terra', 'gpt-6.1-terra'],
  ['gpt-6.1-terra', 'gpt-6.1-terra']
])

/** Reasoning efforts the CLI accepts; `max` needs a newer CLI than `xhigh`. */
export const EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const DEFAULT_EFFORT = 'xhigh'

/**
 * Resolve a model shorthand such as `"sol xhigh"` into a route.
 * @param {string} spec - a model shorthand, optionally followed by an effort.
 * @param {string} [override] - an explicit effort that wins over the shorthand.
 * @returns {{ model: string, effort: string }}
 */
export function parseModelSpec (spec, override) {
  const words = String(spec).trim().toLowerCase().split(/[\s,+]+/).filter(Boolean)
  if (words.length === 0) throw new Error('model is empty')
  let model = MODEL_ALIASES.get(words[0])
  if (model === undefined && /^gpt-[a-z0-9.-]+$/i.test(words[0])) model = words[0]
  if (model === undefined) throw new Error(`unknown model "${words[0]}"; use sol, astra, luna, terra or an exact gpt-* id`)
  let effort
  for (const word of words.slice(1)) {
    if (!EFFORTS.includes(word)) throw new Error(`unknown effort "${word}"; use ${EFFORTS.join(', ')}`)
    effort = word
  }
  if (override !== undefined) {
    if (!EFFORTS.includes(override)) throw new Error(`unknown effort "${override}"; use ${EFFORTS.join(', ')}`)
    effort = override
  }
  return { model, effort: effort ?? DEFAULT_EFFORT }
}

/** Locate the Codex binary the way this deployment installs it. */
export function findCodex (explicit) {
  const candidates = [
    explicit,
    process.env.CODEX_CLI,
    process.platform === 'darwin' ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined
      ? `${process.env.LOCALAPPDATA}\\OpenAI\\Codex\\bin\\codex.exe`
      : undefined
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return explicit ?? process.env.CODEX_CLI ?? 'codex'
}

/**
 * Build the `codex exec` argv for one delegated run.
 * `--ignore-user-config` keeps an older CLI's global config out of the call;
 * authentication still comes from `CODEX_HOME`.
 */
export function buildArgs ({ model, effort, cwd, sandbox }) {
  return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '-C', cwd, '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-s', sandbox, '-']
}
