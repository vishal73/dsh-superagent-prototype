# This deployment

Where the dsh-superagent instance runs, what it currently does, and how to change
it.

## Where it runs

| Part | Value |
| --- | --- |
| Development checkout | `/Users/vishal/gitcode/dsh-superagent-prototype` (Mac), tip of `main` |
| Runtime deployment | `C:\Users\visha\gitcode\dsh-superagent-prototype` (Windows), the same commit, rebuilt there |
| DeepSeek Harness profile | `superagent` (`dsh --profile superagent --no-open`) |
| Panel / API | `http://127.0.0.1:3082` — reachable from the Mac through the SSH tunnel `127.0.0.1:3082 → Windows 3082`; open the token URL printed in the log. On the tailnet it is `http://vishal.taile57eb7.ts.net:3082/` through `tailscale serve` (see [Tailnet access](#tailnet-access-for-mobile)) |
| State directory | `C:\Users\visha\.dsh\state\superagent` — `orchestrator.sqlite`, `work/`, `worker-bin/`, `worker-gitconfig` |
| Launcher | `C:\Users\visha\.dsh\run-superagent.cmd` (reads `TELEGRAM_BOT_TOKEN` from `C:\Users\visha\.hermes\.env`; runs headless with `--no-open` and stdin from `NUL`) |
| Autostart | Scheduled task `DSH-Superagent` — at system startup with a 30 s delay, S4U as `vishal`, restarts on failure. A host reboot no longer leaves the agent down. |
| Startup log | `C:\Users\visha\.dsh\state\superagent.log` |
| Telegram | bot `@Wini7Bot`; direct messages only; allowed operator `5555980193` |
| GitHub | `vishal73/product-finder-v2`, agent account `vis-yadav` (the Windows user's default `gh` account), CLI `gh` |
| Deploy helper | `.codex/windows-deploy.json` (SSH `vishal@100.105.105.124`, helper state under `~/.codex/windows-deploy/`) |

The helper’s saved state still names an old remote path
(`C:/Users/visha/gitcode/dsh-superagent`); the live checkout is the
`-prototype` directory above.

Start, restart and inspect the runtime:

```powershell
schtasks /Run   /TN DSH-Superagent        # start (or restart after stopping)
schtasks /End   /TN DSH-Superagent        # stop
schtasks /Query /TN DSH-Superagent /V     # state, trigger, last result
Get-Content C:\Users\visha\.dsh\state\superagent.log -Tail 40
```

Startup takes about 45 s when the previous run left a stale
`C:\Users\visha\.dsh\state\superagent.lock`; the lock expires on its own. A quick
`Get-NetTCPConnection -LocalPort 3082 -State Listen` shows when the panel is up.
Do not start inside that 30 s window: a start that loses the lock still serves the
panel, but neither Source mounts and the API answers without an Orchestrator. If it
happens, stop it, wait 30 s or delete the lock, and start again.

Reopen the tunnel:

```bash
ssh -N -L 3082:127.0.0.1:3082 vishal@100.105.105.124
```

All panel API calls need `x-orchestrator-request: 1` and a loopback or trusted host.

### Tailnet access for mobile

The panel also answers on the tailnet at `http://vishal.taile57eb7.ts.net:3082/`, so a
phone on Tailscale needs no tunnel. `tailscale serve` proxies that name to the loopback
panel, which keeps the Web server on `127.0.0.1` and keeps the management routes'
loopback-only guard satisfied. Three pieces make it work:

1. The profile's `webserver` entry lists the tailnet name in `trustedHosts`, because
   `dsh web` refuses an untrusted Host on its own `/api` routes.
2. The launcher exports `DSH_SUPERAGENT_TRUSTED_HOSTS=vishal.taile57eb7.ts.net`.
   `sameOrigin()` accepts that authority (a port-less entry matches any port) with an
   `http` or `https` Origin naming it; loopback stays accepted and every other
   authority is still 403.
3. `tailscale serve` publishes the name:

```powershell
tailscale serve --bg --http=3082 http://127.0.0.1:3082
tailscale serve status
tailscale serve --http=3082 off   # stop publishing
```

The tailnet cannot issue TLS certificates (`tailscale cert` answers "your Tailscale
account does not support getting TLS certs"), so this is plain HTTP carried inside
WireGuard. Enable HTTPS Certificates in the admin console and switch to `--https=443`
once that changes. Open the token URL printed in the log: the token query creates the
browser session, and a plain `/` answers 401.

Anyone who can reach the tailnet and holds the token can drive the agent. Keep the
tailnet to the operator's own devices, or add an ACL that limits `tcp:3082` to the
phone.

## What it does

- **Telegram source**: long-polls `getUpdates`; accepts direct messages from the
  allowed operator; replies in the same chat. Group chats are off (`otherChats:
  none`). Telegram replies use ASD-STE100 Simplified Technical English (short
  sentences, one fact or instruction each, active voice, consistent terms),
  built into the replies guidance.
- **GitHub source**: watches `vishal73/product-finder-v2` notifications of
  `@vis-yadav`; the agent comments, commits and opens pull requests as
  `vis-yadav`, so a mention of that account is what starts work.
- **Flow**: Trigger → Eval → Ticket → worker Session + ticket directory → reply
  or pull request. Accepted work is acknowledged once, worked silently, and
  reported when a result, question or blocker exists.
- **Tickets**: each gets a `worker-<id>` Session and a directory under
  `...\state\superagent\work`. The prepare command is
  `git clone --depth 1 https://github.com/vishal73/product-finder-v2 $env:DSH_SUPERAGENT_DIR`.
- **Policy**: accept mode `observe`; rules *Copy fixes* and *Visual fixes* are
  recorded, not executed. Explicit requests from the allowed operator always run.
- **Chat commands**: `/new` starts a fresh main conversation; model changes are
  applied by `orchestrator_model_set`; status questions are answered from the
  ticket store.
- **Panel**: Overview, Source, Trigger, Eval, Execution, Settings — retry, stop,
  pause, dropped replies, decisions, prompt history.
- **Skills**: built-ins `github`, `telegram`, `desktop`, `browser`; team skill
  `codex-on-windows`, which maps Codex model requests to the `openai-codex`
  provider and points at the `codex` tool and its CLI wrapper.
- **Codex plugin**: `plugins/dsh-plugin-codex` mounts a `codex` tool that
  delegates one bounded task to a Codex CLI run in the Session's working
  directory (shorthands `sol`, `astra`, `luna`, `terra`, plus an effort such as
  `sol xhigh`). It also ships `bin/codex-wrap.mjs` for shell use. Install it
  into a profile with `dsh plugin --profile <name> add link:<checkout>/plugins/dsh-plugin-codex`.
- **Models**: `openai-codex` (`gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-astra`,
  `gpt-6-luna`, `gpt-6.1-terra`) through the ChatGPT account signed in to the
  Codex CLI, plus `deepseek-official` and `local-strata`. The OAuth grant is
  stored in `~/.dsh/.credentials.yaml` under `llm-pi-ai/openai-codex`.
- **Model order**: the Eval role — the main Session that assesses work — runs
  DeepSeek `deepseek-flash`, because a stalled assessor is what silenced Telegram.
  The Executor role keeps Codex `gpt-6.1-sol` at `xhigh`, so workers start on
  Codex and fall to DeepSeek, then local Strata. When a provider reports an
  exhausted quota (`QUOTA` or `ACCOUNT_QUOTA`) or a rejected credential
  (`AUTH`/`CREDENTIAL`, such as a reused Codex refresh token),
  `src/app/model-fallback.ts` retries the step on the next route and skips the
  failed provider for 30 minutes.
  A role model changed in Settings or with `orchestrator_model_set` now also
  retargets the running main Session (through DSH's session controller, which
  records it as the profile default like DSH's own model picker); a changed
  worker model applies to the workers created after it. Workers pass the same
  route to `subagent` as `provider`/`model`/`reasoning_effort`.
- **Windows specifics**: workers run as `vishal` without per-command approval;
  the host is headless (session 0). Codex GUI apps cannot open; the bundled CLI
  needs `--ignore-user-config` (the user config's `service_tier` is rejected by
  CLI 0.130) and `--sandbox danger-full-access` — the `codex-on-windows` team
  skill and wrapper encode this. Prefer the native provider; an older CLI can
  answer `model_not_found` for these models.
- **Not available**: group chats, desktop GUI automation, automatic merging.

## Change behaviour without code

1. **Settings → Sources / Eval / Execution** — repository, `gh` CLI, chats, DMs,
   allowed lists, admission table, accept mode, worker model, concurrency,
   prepare command, blocked commands. Saves are revisioned and audited.
2. **Settings → Prompts** — team sections (communication, scope, delivery),
   built-in part overrides, and team skills. Saving a prompt revision is
   delivered to Sessions without a code change; new Sessions mount the latest.
3. **Pause processing** on Execution stops new Evals and deliveries while
   Sources keep recording.

Use this route first: most “the agent should …” requests are a prompt, skill or
setting, not code.

## Add or fix a feature in code

Map:

| Area | Path |
| --- | --- |
| Runtime, Sources wiring, tools, HTTP API, views | `src/app/` (`runtime.ts`, `tools/`, `api.ts`, `http.ts`, `views/`) |
| Domain engine: Eval, Tickets, Replies, Assignments | `src/core/` |
| Source implementations | `src/sources/` (`telegram-*`, `github-*`) |
| Panel client | `src/client/` |
| Built-in prompts and skills | `prompts/`, `skills/` |
| Tests | `tests/*.spec.ts`, fixtures in `tests/fixtures/` |

Recipes:

- **A main-Session tool**: `src/app/tools/main.ts` (schema + execute), extend
  `MainToolsHost`, wire it in `Runtime`, add a test.
- **A worker tool**: `src/app/tools/executor.ts`.
- **A Source**: follow `docs/008-cookbook.md`; implement the kind in
  `src/sources/`, register it in `cordis.patch.yml`, test it in `tests/`.
- **Behaviour text**: edit `prompts/*.md` or a `skills/dsh-superagent-*/SKILL.md`
  for a built-in change (rebuild + deploy), or Settings → Prompts for a live team
  change.
- **A setting**: extend the block in `src/app/settings.ts`, the panel view, and
  add tests; account/environment fields go through `SETUP_FIELDS`.

Workflow:

```bash
pnpm vitest run tests/<area>.spec.ts   # focused, red first
pnpm check                             # typecheck + tests + build
```

Tests are the contract; add a regression test for every bug. A behaviour change
without a test or a recorded live reproduction is not ready.

## Deploy and verify

1. Commit and push the change from the Mac.
2. On Windows, update the checkout and rebuild (`git pull`, then `pnpm
   install`/`pnpm run build` as needed).
3. Restart the service with the launcher (`run-superagent.cmd`) or
   `scripts/dsh-superagent --profile superagent restart` from Git Bash. After a
   forced kill, wait 30 s or delete `C:\Users\visha\.dsh\state\superagent.lock`
   before starting: a fresh lock makes the new process give up with
   `Lock file is already being held`.
4. Verify with the panel API:

```bash
curl -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state
curl -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/sources
```

Require `health.runtime = ready`, the Sources `ready`, and an empty `dropped`
list before calling the deploy good.

## Diagnose a live problem

- **No reply**: check `threads`, `sources.dropped` and the ticket stage; a
  `channelIgnored` drop means the Source no longer listens to that chat.
  A turn cut off by a restart produces no outbox row at all — the answer was
  never queued. See the main Session transcript under
  `C:\Users\visha\.dsh\sessions\--C-Users-visha-.dsh-state-superagent--\`.
  When the assessor's model cannot answer (a rejected credential, or every route
  failing), the held Eval now ends at once with
  `Model provider failed: <the provider's message>` in `overview.problems`; it no
  longer waits 6 minutes to report `Assessment timed out`. The cause is also in
  the main Session transcript as a `turn/end` error.
- **Stuck queue**: `overview.flow` (received/judged/accepted/evaluating/dropped)
  and the `reply`/`delivery` health entries.
- **Worker failure**: ticket detail (`assignments`, `report`), the ticket
  directory, and `superagent.log`.
- **Two processes / lock held**: `orchestrator` health and the lock file in the
  state directory; never start a second instance on the same state directory.
  A lock left by a killed process is treated as live for 30 s (`stale: 30000`),
  so the next start fails until it is old or removed.
- **Codex on Windows**: `timed out after 15000ms connecting runner pipe-in` is
  the known Windows SSH sandbox bug — use `--sandbox danger-full-access` for
  trusted prompts; never `read-only`/`workspace-write` there. The old CLI also
  rejects the global `service_tier`, so pass `--ignore-user-config`, and it can
  answer `model_not_found` for `gpt-6.1-sol`; the native `openai-codex` route
  is the supported path there.

## Known issues

- The Codex OAuth grant belongs to one host. Windows holds its own, re-issued
  2026-11-16 (access token valid to about 2026-11-26). Never copy
  `~/.dsh/.credentials.yaml` between the Mac and Windows: Codex rotates the
  refresh token on every refresh, so a shared copy is invalidated by whichever
  host refreshes first. That is what stopped Telegram replies on 2026-11-16 —
  every assessment turn failed with `refresh_token_reused` and nothing answered
  the person. Sign in again per host with the headless device flow.
- Restarting while a reply turn is in flight can lose that reply; the notice is
  already marked delivered and is not replayed. Deploy when idle, and check the
  panel afterwards.
- `run-superagent.cmd` contains a hardcoded `DEEPSEEK_API_KEY`; move it to the
  environment file like `TELEGRAM_BOT_TOKEN`.
- The deploy helper’s state points at the nonexistent
  `C:/Users/visha/gitcode/dsh-superagent`; fix it to the `-prototype` path
  before relying on the helper for sync/run.
- The Telegram bot cannot message itself: an end-to-end Telegram test needs a
  human account to send the message.
- The Windows host is headless: Codex GUI apps and desktop skills are
  unavailable; use the CLI and native tools.

## Further reading

- `SETUP.md` — guided setup.
- `docs/006-deployment.md` — operating, upgrades, troubleshooting.
- `docs/007-architecture.md` — how the pieces fit.
- `docs/008-cookbook.md` — adding a Source.
