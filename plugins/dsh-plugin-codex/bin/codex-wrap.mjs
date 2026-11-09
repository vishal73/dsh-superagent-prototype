#!/usr/bin/env node
/**
 * codex-wrap: run one Codex CLI task from the shell with a model shorthand.
 *
 *   codex-wrap -m "sol xhigh" -C ../repo -- "explain the failing test"
 *   codex-wrap -m astra --json -- "review the diff"
 *
 * The plugin's `codex` tool runs the same core (`src/run.js`); this command is
 * for a shell, a script or a host with no DSH session.
 */
import { buildArgs, EFFORTS, findCodex, parseModelSpec } from '../src/spec.js'
import { runCodex } from '../src/run.js'

const HELP = `Usage: codex-wrap [options] [--] [prompt]

Run the Codex CLI with a model shorthand and the headless flags this
deployment needs.

Options:
  -m, --model <spec>    "sol", "sol xhigh", "astra", "luna", "terra" or an exact gpt-* id
  -e, --effort <level>  ${EFFORTS.join(' | ')}
  -C, --cwd <dir>       working root for Codex (default: current directory)
  -s, --sandbox <mode>  read-only | workspace-write | danger-full-access (default: danger-full-access)
      --json            print raw JSONL events instead of the final message
      --dry-run         print the command instead of running it
      --codex <path>    Codex binary (default: CODEX_CLI or the app's install path)
  -h, --help            show this help

The sandboxed runner is broken on this headless Windows host; danger-full-access
is the only mode that runs. Use it for trusted prompts only.
`

/** Split argv into options and the prompt, keeping `--` safe. */
function parseArgs (argv) {
  const options = { json: false, dryRun: false }
  const prompt = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') { prompt.push(...argv.slice(index + 1)); break }
    if (arg === '-h' || arg === '--help') { options.help = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '-m' || arg === '--model') { options.model = argv[++index]; continue }
    if (arg === '-e' || arg === '--effort') { options.effort = argv[++index]; continue }
    if (arg === '-C' || arg === '--cwd') { options.cwd = argv[++index]; continue }
    if (arg === '-s' || arg === '--sandbox') { options.sandbox = argv[++index]; continue }
    if (arg === '--codex') { options.codex = argv[++index]; continue }
    prompt.push(arg)
  }
  options.prompt = prompt.join(' ')
  return options
}

/** Read stdin when the prompt is omitted or `-`. */
async function readStdin () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) { process.stdout.write(HELP); return 0 }
  if (options.model === undefined) throw new Error('--model is required (sol, "sol xhigh", astra, luna, terra)')
  const route = parseModelSpec(options.model, options.effort)
  const cwd = options.cwd ?? process.cwd()
  if (options.dryRun === true) {
    process.stdout.write(JSON.stringify([findCodex(options.codex), ...buildArgs({ ...route, cwd, sandbox: options.sandbox ?? 'danger-full-access' })]) + '\n')
    return 0
  }
  let prompt = options.prompt
  if (prompt === '' || prompt === '-') prompt = await readStdin()
  if (prompt.trim() === '') throw new Error('a prompt is required as arguments or stdin')
  await runCodex({
    prompt,
    model: options.model,
    effort: options.effort,
    cwd,
    codexPath: options.codex,
    sandbox: options.sandbox,
    onEvent: options.json ? line => process.stdout.write(line + '\n') : undefined,
    onMessage: options.json ? undefined : text => process.stdout.write(text.endsWith('\n') ? text : text + '\n')
  })
  return 0
}

main().then(code => { process.exitCode = code }).catch(error => {
  process.stderr.write(`codex-wrap: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
