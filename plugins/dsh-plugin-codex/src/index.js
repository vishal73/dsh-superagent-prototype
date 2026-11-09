/**
 * dsh-plugin-codex: exposes the Codex CLI as a `codex` tool so an agent can
 * delegate one bounded task to a GPT-6.1 Sol / Astra / Luna run.
 *
 * The tool works in the Session's working directory, so Codex edits the same
 * checkout the agent works in. It runs with `danger-full-access` because this
 * deployment's headless Windows host cannot start the sandboxed runner; only
 * trusted prompts belong here.
 */
import { isAbsolute } from 'node:path'
import { runCodex } from './run.js'

export const name = 'codex'
export const inject = ['tools']

/** Model-facing description; keep the scope limit visible to the model. */
const DESCRIPTION = [
  'Run one self-contained task with the OpenAI Codex CLI (GPT-6.1 Sol, Astra, Luna or Terra).',
  'Codex works in the given directory with its own shell and file tools and replies with one final message.',
  'It cannot ask follow-up questions, so send a complete task. Use it to delegate a bounded piece of work',
  'to a Codex model; use your own tools for quick reads or edits.'
].join(' ')

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The final message Codex produced.' },
    model: { type: 'string', description: 'The exact Codex model that ran.' },
    effort: { type: 'string', description: 'The reasoning effort that ran.' }
  },
  required: ['text', 'model', 'effort'],
  additionalProperties: false
}

/**
 * Mount the tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ model?: string, codexPath?: string }} [config] - deployment defaults.
 */
export function apply (ctx, config = {}) {
  const defaults = { model: 'sol', ...config }
  ctx.tools.register({
    name: 'codex',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The complete task for Codex, including what "done" means.' },
        model: { type: 'string', description: 'Model shorthand: sol (default), astra, luna, terra, or an exact gpt-* id; an effort may follow, for example "sol xhigh".' },
        effort: { type: 'string', description: 'Reasoning effort: minimal, low, medium, high, xhigh or max. Overrides an effort in the model shorthand.' },
        cwd: { type: 'string', description: 'Absolute working directory; defaults to the Session working directory.' }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    timeoutMs: 900_000,
    async execute (args, exec) {
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('codex: prompt is required')
      if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !isAbsolute(args.cwd))) throw new Error('codex: cwd must be an absolute path')
      const cwd = args.cwd ?? await sessionCwd(ctx, exec)
      const result = await runCodex({
        prompt: args.prompt,
        model: typeof args.model === 'string' && args.model !== '' ? args.model : defaults.model,
        effort: typeof args.effort === 'string' && args.effort !== '' ? args.effort : undefined,
        cwd,
        signal: exec.signal,
        codexPath: defaults.codexPath
      })
      return { text: result.text, model: result.model, effort: result.effort }
    }
  })
}

/**
 * The Session's working directory when the composition provides one, else the
 * process directory. Codex must edit the checkout the agent is working in.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ agent?: unknown, signal: AbortSignal }} exec - the tool execution.
 * @returns {Promise<string>} an absolute directory.
 */
async function sessionCwd (ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined || exec.agent === undefined) return process.cwd()
  return workingDirectory.ensure(exec.agent, exec.signal)
}

