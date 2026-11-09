/**
 * Run one Codex CLI task and return its final message. Shared by the `codex`
 * tool and the `codex-wrap` command so both apply the same flags.
 */
import { spawn } from 'node:child_process'
import { buildArgs, findCodex, parseModelSpec } from './spec.js'

/** A run that failed, with the CLI's own diagnostic when it printed one. */
export class CodexFailure extends Error {
  constructor (message, exitCode, stderr) {
    super(message)
    this.name = 'CodexFailure'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/**
 * Spawn `codex exec` for one prompt.
 * @param {object} options
 * @param {string} options.prompt - the task sent on stdin.
 * @param {string} [options.model] - shorthand such as `sol` or `astra xhigh`.
 * @param {string} [options.effort] - explicit effort overriding the shorthand.
 * @param {string} options.cwd - working root handed to Codex.
 * @param {AbortSignal} [options.signal] - cancels the child when aborted.
 * @param {string} [options.codexPath] - explicit Codex binary.
 * @param {(line: string) => void} [options.onEvent] - every raw JSONL line.
 * @param {(text: string) => void} [options.onMessage] - each agent message.
 * @returns {Promise<{ text: string, model: string, effort: string, messages: string[], durationMs: number }>}
 */
export async function runCodex ({ prompt, model = 'sol', effort, cwd, signal, codexPath, sandbox = 'danger-full-access', onEvent, onMessage }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt is empty')
  const route = parseModelSpec(model, effort)
  const binary = findCodex(codexPath)
  const start = Date.now()
  const args = buildArgs({ ...route, cwd, sandbox })
  const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

  const messages = []
  let stderr = ''
  let failure
  let buffer = ''

  const handle = line => {
    if (line.trim() === '') return
    onEvent?.(line)
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      messages.push(event.item.text)
      onMessage?.(event.item.text)
    }
    if (event.type === 'turn.failed') failure ??= event.error?.message ?? 'Codex reported a failed turn'
    if (event.type === 'error') failure ??= event.message ?? 'Codex reported an error'
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384) })

  const kill = () => { if (child.exitCode === null) child.kill('SIGTERM') }
  signal?.addEventListener('abort', kill, { once: true })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  let code
  try {
    code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
  } catch (error) {
    throw new CodexFailure(`could not start Codex (${binary}): ${error instanceof Error ? error.message : String(error)}`, undefined, '')
  } finally {
    signal?.removeEventListener('abort', kill)
  }
  if (buffer.trim() !== '') handle(buffer)

  if (signal?.aborted === true) {
    const reason = signal.reason
    throw reason instanceof Error ? reason : new CodexFailure('Codex run was cancelled', code, stderr)
  }
  if (failure !== undefined) throw new CodexFailure(failure, code, stderr)
  if (code !== 0) {
    const detail = stderr.trim().split('\n').slice(-4).join(' · ')
    throw new CodexFailure(`Codex exited with ${code}${detail === '' ? '' : `: ${detail}`}`, code, stderr)
  }
  const last = messages.at(-1)?.trim()
  if (last === undefined || last === '') throw new CodexFailure('Codex returned no message', code, stderr)
  return { text: last, model: route.model, effort: route.effort, messages, durationMs: Date.now() - start }
}
