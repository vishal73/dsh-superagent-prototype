#!/usr/bin/env bash
# Pull DeepSeek Harness session logs from the Windows deployment and decode them.
#
# Defaults: host/user from .codex/windows-deploy.json, destination
# .artifacts/agentlogs, remote sessions %USERPROFILE%\.dsh\sessions.
#
# Usage: pull.sh [--host H] [--user U] [--dest DIR] [--no-pull]
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pull.sh [options]

  --host H     Windows host or Tailscale IP (default: .codex/windows-deploy.json)
  --user U     SSH user on the Windows host (default: .codex/windows-deploy.json)
  --dest DIR   Local destination (default: <repo>/.artifacts/agentlogs)
  --no-pull    Skip scp; decode and summarize an existing copy
  -h, --help   Show this help

Environment: DSH_WIN_HOST, DSH_WIN_USER, DSH_AGENTLOGS_DIR.
Requires: ssh key auth to the host, zstd, scp. jq is optional (used only by
the commands in SKILL.md).
EOF
}

die() { printf 'pull: %s\n' "$*" >&2; exit 1; }

script_dir=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -P "$script_dir/../../../.." && pwd)
config="$repo_root/.codex/windows-deploy.json"
dest=${DSH_AGENTLOGS_DIR:-"$repo_root/.artifacts/agentlogs"}
host=${DSH_WIN_HOST:-}
user=${DSH_WIN_USER:-}
no_pull=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --host) host=${2:?missing value for --host}; shift 2 ;;
    --user) user=${2:?missing value for --user}; shift 2 ;;
    --dest) dest=${2:?missing value for --dest}; shift 2 ;;
    --no-pull) no_pull=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'pull: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# Read a top-level string field from the deployment config without requiring jq.
config_field() {
  [[ -f $config ]] || return 0
  if command -v node >/dev/null 2>&1; then
    node -p "const c=require(process.argv[1]); typeof c[process.argv[2]]==='string'?c[process.argv[2]]:''" "$config" "$1" 2>/dev/null || true
  else
    sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$config" | head -1
  fi
}

[[ -n $host ]] || host=$(config_field host)
[[ -n $user ]] || user=$(config_field user)
[[ -n $host ]] || die "no host: pass --host, set DSH_WIN_HOST, or create .codex/windows-deploy.json"
[[ -n $user ]] || die "no SSH user: pass --user or set DSH_WIN_USER"
command -v ssh >/dev/null 2>&1 || die "ssh is not installed"
command -v scp >/dev/null 2>&1 || die "scp is not installed"
command -v zstd >/dev/null 2>&1 || die "zstd is not installed (brew install zstd)"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

win_home=$(ssh "${ssh_opts[@]}" "$user@$host" 'cmd /c echo %USERPROFILE%' | tr -d '\r')
[[ -n $win_home ]] || die "could not read %USERPROFILE% from $user@$host"
win_home=${win_home//\\//}
remote_sessions="$win_home/.dsh/sessions"

if [[ $no_pull -eq 0 ]]; then
  mkdir -p "$dest"
  printf 'pulling %s:%s -> %s/sessions\n' "$user@$host" "$remote_sessions" "$dest"
  scp -q -r "${ssh_opts[@]}" "$user@$host:$remote_sessions" "$dest/" \
    || die "scp failed (check SSH key auth and that $remote_sessions exists)"
fi

[[ -d $dest/sessions ]] || die "no sessions directory at $dest/sessions (run without --no-pull)"

decoded=0
torn=0
while IFS= read -r -d '' log; do
  out=${log%.zstd}
  if zstd -d -c -q "$log" >"$out" 2>/dev/null; then
    decoded=$((decoded + 1))
  else
    torn=$((torn + 1))
    printf 'warn: partial or invalid zstd frame, kept decoded prefix: %s\n' "${out#"$dest/"}" >&2
  fi
done < <(find "$dest/sessions" -name 'session.*.jsonl.zstd' -print0)

total=$(find "$dest/sessions" -name 'session.*.jsonl.zstd' | wc -l | tr -d ' ')
size=$(du -sh "$dest/sessions" | cut -f1 | tr -d ' ')
printf 'sessions: %s logs (%s), decoded: %s, partial: %s\n' "$total" "$size" "$decoded" "$torn"

if [[ $total -gt 0 ]]; then
  printf 'newest:\n'
  find "$dest/sessions" -name 'session.*.jsonl.zstd' -print0 \
    | xargs -0 stat -f '%m %N' 2>/dev/null \
    | sort -rn \
    | head -5 \
    | sed "s|^[0-9]* $dest/|  |" || true
fi
