/** The Codex plugin: its bundle layer, model shorthands, argv, and tool registration. */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const plugin = join(import.meta.dirname, '..', 'plugins', 'dsh-plugin-codex')
const bin = join(plugin, 'bin', 'codex-wrap.mjs')
const lib = (file: string): string => pathToFileURL(join(plugin, 'src', file)).href

it('ships a bundle layer that mounts the codex tool', () => {
  const pkg = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string } } }
  expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  const patch = readFileSync(join(plugin, 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('name: dsh-plugin-codex')
  expect(patch).toContain('id: codex')
})

it('maps a shorthand to an exact model and effort', async () => {
  const spec = await import(lib('spec.js')) as { parseModelSpec: (spec: string, effort?: string) => { model: string, effort: string } }
  expect(spec.parseModelSpec('sol xhigh')).toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh' })
  expect(spec.parseModelSpec('astra')).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' })
  expect(spec.parseModelSpec('luna', 'low')).toEqual({ model: 'gpt-6-luna', effort: 'low' })
  expect(spec.parseModelSpec('gpt-6.1-sol,max')).toEqual({ model: 'gpt-6.1-sol', effort: 'max' })
  expect(() => spec.parseModelSpec('nope')).toThrow(/unknown model/)
  expect(() => spec.parseModelSpec('sol ultra')).toThrow(/unknown effort/)
})

it('builds the argv with the headless flags', async () => {
  const spec = await import(lib('spec.js')) as { buildArgs: (options: object) => string[] }
  expect(spec.buildArgs({ model: 'gpt-6.1-sol', effort: 'xhigh', cwd: '/tmp/x', sandbox: 'danger-full-access' })).toEqual([
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '-C', '/tmp/x', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', '-s', 'danger-full-access', '-'
  ])
})

it('prints the resolved command for a dry run', () => {
  const argv = JSON.parse(execFileSync(process.execPath, [bin, '-m', 'astra', '-C', '/tmp', '--dry-run', '--', 'hello'], { encoding: 'utf8' })) as string[]
  expect(argv).toContain('gpt-6-astra')
  expect(argv).toContain('model_reasoning_effort="xhigh"')
  expect(argv).toContain('danger-full-access')
})

it('rejects an unknown model with a hint', () => {
  const run = spawnSync(process.execPath, [bin, '-m', 'nope', '--dry-run', '--', 'hello'], { encoding: 'utf8' })
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('unknown model')
})

it('registers the codex tool with a prompt-only required schema', async () => {
  const mod = await import(lib('index.js')) as { apply: (ctx: object, config?: object) => void }
  let tool: { name: string, parameters: { required: string[] }, output: { schema: { required: string[] } }, execute: (args: object, exec: object) => Promise<unknown> } | undefined
  mod.apply({ tools: { register: (definition: typeof tool) => { tool = definition } }, get: () => undefined }, {})
  expect(tool?.name).toBe('codex')
  expect(tool?.parameters.required).toEqual(['prompt'])
  expect(tool?.output.schema.required).toEqual(['text', 'model', 'effort'])
  await expect(tool?.execute({ prompt: '' }, { signal: new AbortController().signal })).rejects.toThrow(/prompt is required/)
  await expect(tool?.execute({ prompt: 'x', cwd: 'relative' }, { signal: new AbortController().signal })).rejects.toThrow(/absolute path/)
})
