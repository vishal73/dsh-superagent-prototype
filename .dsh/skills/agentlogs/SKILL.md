---
name: agentlogs
description: Export DeepSeek Harness agent trajectory logs from the Windows deployment to this Mac, decode them, and inspect them raw or live. Use when asked for Windows DSH agent logs, session trajectories, tool-call history, token-usage or turn evidence, or why the deployed agent did something.
---

# Agent logs: Windows → Mac

Every DSH session appends its complete event stream — turns, steps, model requests and replies, tool calls and results, inbox deliveries, job lifecycle — to one zstd-compressed JSONL log on the Windows host. That file is the trajectory; the Web GUI's **Trajectory** tab is only a projection of it.

## Where the data is

| What | Path on Windows |
| --- | --- |
| Session trajectory | `C:\Users\visha\.dsh\sessions\<workspace-slug>\<session-id>\session.v4.jsonl.zstd` |
| Process log (not trajectory) | `C:\Users\visha\.dsh\state\superagent.log` |
| Orchestrator state (not trajectory) | `C:\Users\visha\.dsh\state\superagent\orchestrator.sqlite` |
| Live Web GUI | `http://127.0.0.1:3082/` on the host, reachable through an SSH tunnel |

- `<workspace-slug>` is the session cwd with separators replaced: orchestrator sessions run in `C:\Users\visha\.dsh\state\superagent`, giving `--C-Users-visha-.dsh-state-superagent--`; per-ticket workers run in `...\state\superagent\work\<ticket>-<hash>` and get their own slug.
- Line 1 is the header (`type:"session"`, `id`, `createdAt`, `cwd`, `agentPreset`). Every later line is an event with `type`, `seq`, `time`.
- `/new` starts a new session directory. A worker ticket gets a fresh session too.
- `session.lock` marks live writer ownership; copying it is harmless.

## Access

Host and user come from `.codex/windows-deploy.json` (`host`, `user`) or `README.deployment.md`. Use SSH key auth with `BatchMode=yes` so a missing key fails instead of prompting. Never put credentials, tokens, or key material in commands, files, or output.

## Pull and decode

```bash
bash .dsh/skills/agentlogs/scripts/pull.sh
```

The script resolves host/user from `.codex/windows-deploy.json` (override with `--host`/`--user` or `DSH_WIN_HOST`/`DSH_WIN_USER`), copies `%USERPROFILE%\.dsh\sessions` to `.artifacts/agentlogs/sessions/` (git-ignored), decodes every `session.*.jsonl.zstd` to a sibling `.jsonl`, and prints counts plus the newest logs. Options: `--dest DIR`, `--no-pull` (decode and summarize an existing copy).

Manual equivalent when the script is unavailable:

```bash
DSH_WIN_HOST=<host from .codex/windows-deploy.json>
DSH_WIN_USER=<user from .codex/windows-deploy.json>
DEST=.artifacts/agentlogs
mkdir -p "$DEST"
scp -r "$DSH_WIN_USER@$DSH_WIN_HOST:C:/Users/visha/.dsh/sessions" "$DEST/"
find "$DEST/sessions" -name 'session.*.jsonl.zstd' -exec zstd -d -f {} \;
```

Keep the raw `.jsonl.zstd` files: they are the durable record. If a pull is repeated while the agent works, `scp -r` overwrites only files it copies; stale decoded `.jsonl` files remain, so re-run the decode step.

## Read the trajectory

Newest sessions first:

```bash
find .artifacts/agentlogs/sessions -name 'session.*.jsonl.zstd' -print0 | xargs -0 stat -f '%m %N' | sort -rn | head -5
```

Session identity from the header (id, cwd, preset):

```bash
zstd -dc "$LOG" 2>/dev/null | head -1 | jq '{id, cwd, agentPreset, createdAt}'
```

Event census, to see what a session contains before reading it:

```bash
zstd -dc "$LOG" | jq -r '.type' | sort | uniq -c | sort -rn
```

Readable transcript (user text, assistant text, tool calls and results):

```bash
zstd -dc "$LOG" | jq -r '
  if .type=="user/message" then "USER  " + ([.data.content[]? | select(.type=="text") | .text] | join("\n"))
  elif .type=="assistant/message" then "ASSISTANT " + ([.data.message.content[]? | select(.type=="text") | .text] | join("\n"))
  elif .type=="tool/call" then "TOOL CALL " + .data.name + " " + (.data.arguments|tostring)
  elif .type=="tool/result" then "TOOL RESULT " + ([.data.message.content[]? | select(.type=="text") | .text] | join("\n"))
  else empty end'
```

Assistant reasoning sits in `content[]` blocks typed `reasoning`; request metadata (model, tools, system prompt changes) is in `request/header` and `request/context`. Turn outcomes are in `turn/end.data.reason`.

## Live view (optional)

The same stream renders in the Web GUI's Trajectory tab. The GUI is loopback-only on the host, so forward the port and open the tokenized URL:

```bash
ssh -N -L 3082:127.0.0.1:3082 "$DSH_WIN_USER@$DSH_WIN_HOST" &
ssh "$DSH_WIN_USER@$DSH_WIN_HOST" 'findstr /i /c:"dsh web: http" C:\Users\visha\.dsh\state\superagent.log' | tail -1
```

A plain `ssh -N` tunnel eventually dies on a network blip (`Operation timed out`, exit 255) even with keepalives. For an always-on view, run it in a reconnect loop as a managed background job:

```bash
while true; do
  ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes \
      -L 3082:127.0.0.1:3082 "$DSH_WIN_USER@$DSH_WIN_HOST"
  sleep 5
done
```

- Open the printed URL verbatim: it already targets `127.0.0.1:3082`, and the tunnel preserves that authority.
- The token is minted per `dsh` process; a restart invalidates it. Take the **last** line.
- The first request exchanges the token for a signed, authority-bound cookie (30 days); afterwards plain `http://127.0.0.1:3082/` works in that browser.
- `401` means unauthenticated, `403` means the `Host`/`Origin` fence rejected the request — neither means the tunnel is down. `000`/connection refused means the tunnel itself is gone.
- Treat the token URL as a credential: it authenticates the whole GUI. Do not paste it into reports, tickets, or shared output.

## Gotchas

- While DSH runs, the final zstd frame may be mid-write. `zstd` then exits non-zero after writing the valid prefix; the script warns and keeps the partial `.jsonl`. Drop the trailing partial record or re-pull after the turn settles. Committed events never have `seq` gaps.
- Pulling is cheap (tens of MB including decoded copies) and grows append-only. Scope to one workspace slug when you only need the orchestrator or one ticket.

## Scope

Project-scoped by construction: DSH resolves the project root as the nearest ancestor containing `.git` and scans only `<root>/.dsh/skills`, so this skill loads for sessions rooted at this checkout and nowhere else. Keep it here — do not copy or symlink it into `~/.dsh/skills` or `~/.codex/skills`, which load for every project. A separate clone of this repository loads it too, by design.
