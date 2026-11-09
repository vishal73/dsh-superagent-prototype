# dsh-plugin-codex

A DeepSeek Harness plugin that puts the [Codex CLI](https://github.com/openai/codex) in front of the agent as one tool:

- **`codex` tool** — the agent delegates one self-contained task to a GPT-6.1 Sol / Astra / Luna / Terra run. Codex works in the Session's working directory with its own shell and file tools, then returns one final message.
- **`codex-wrap` command** — the same run from a shell or script.

Both share `src/spec.js`, so the shorthand `"sol xhigh"` means the same model and reasoning effort everywhere.

## Why a tool and not a model route

Model routes belong to `@deepseek-ai/dsh-llm-pi-ai`, which already serves the account's Codex models natively (`openai-codex/gpt-6.1-sol` and friends) with real tool calling. A CLI-backed model route would be worse: the adapter has no Session working directory, so Codex would run in the host process directory, and it cannot return DSH tool calls. This plugin therefore adds the *delegation* path; keep the native routes for ordinary model selection.

If the deployment has not registered the routes yet, add them to the profile's `llm-pi-ai` config and sign in with the Codex account (the grant is stored under `llm-pi-ai/openai-codex` in `~/.dsh/.credentials.yaml`):

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        displayName: Codex (ChatGPT account)
        timeoutMs: 600000
        streamIdleTimeoutMs: 600000
        models:
          - id: gpt-6.1-sol
            name: GPT-6.1 Sol
          - id: gpt-6-astra
            name: GPT-6 Astra
```

## Install

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/plugins/dsh-plugin-codex
```

Then add the bundle to that profile's `package.json` so its patch layer is composed:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "…", "dsh-plugin-codex"]
    }
  }
}
```

Restart the profile. The plugin needs no DSH credential of its own: Codex reads `~/.codex/auth.json` (or `CODEX_HOME`). Sign in once with `codex login`, or copy an existing `auth.json`.

## Models and shorthands

| Shorthand | Model | Use |
| --- | --- | --- |
| `sol` (default) | `gpt-6.1-sol` | everyday coding, the strongest generalist |
| `astra` | `gpt-6-astra` | hard design and ambiguous analysis |
| `luna` | `gpt-6-luna` | mechanical, cheaper work |
| `terra` | `gpt-6.1-terra` | only when the account serves it |
| `sol-6` | `gpt-6-sol` | the previous Sol |

Effort defaults to `xhigh`; pass `minimal | low | medium | high | xhigh | max`, either after the model (`"sol xhigh"`) or with `--effort`/`effort`. An exact `gpt-*` id is accepted too.

## The tool

| Parameter | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | the complete task, including what "done" means |
| `model` | no | shorthand above; defaults to the plugin config's `model` (`sol`) |
| `effort` | no | overrides an effort in the shorthand |
| `cwd` | no | absolute directory; defaults to the Session working directory |

The tool has a 15-minute timeout and is cancellable through the Session's abort signal.

## The command

```sh
# final message only
node plugins/dsh-plugin-codex/bin/codex-wrap.mjs -m "sol xhigh" -C ../repo -- "explain the failing test"

# raw JSONL events, and a dry run to inspect the argv
node plugins/dsh-plugin-codex/bin/codex-wrap.mjs -m astra --json -- "review the diff"
node plugins/dsh-plugin-codex/bin/codex-wrap.mjs -m "sol xhigh" --dry-run -- "hello"
```

`codex-wrap` resolves the binary from `--codex`, `CODEX_CLI`, the macOS app bundle, or `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`.

## Safety

The runs pass `--ignore-user-config` (an older CLI rejects today's global `service_tier` and models cache) and `-s danger-full-access`: this deployment's headless Windows host cannot start the Codex sandboxed runner, so `read-only`/`workspace-write` fail after 15 seconds. Only send trusted prompts; Codex can execute anything the agent's shell can.

The CLI builds differ: `gpt-6.1-sol` needs a recent CLI (0.166 works); an older 0.130 build answers `model_not_found` for it with a ChatGPT account. Upgrade the CLI or keep using the native `openai-codex` routes.

## Tests

The repository's vitest suite covers the shorthands, the argv, and tool registration:

```sh
pnpm test -- tests/codex-plugin.spec.ts
```
