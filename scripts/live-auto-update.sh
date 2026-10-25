#!/usr/bin/env bash
# One pass of the live install's automatic update, run by a systemd user timer:
# docs/operations/runbooks.md#update-the-live-install-automatically
#
# It takes the live install to origin's --branch (default `main`) through scripts/live-update.sh,
# whose backup, upgrade checks, and rollback are the safety; this pass only decides whether to start
# one:
#   - nothing while it is paused ($DSH_HOME/system/auto-update.paused), while another pass or a
#     live update runs, or while an update that stopped the daemon is unfinished;
#   - `git fetch origin refs/heads/<branch>`: nothing to do when it is the live checkout's HEAD;
#   - only a fast-forward of the live commit, merged at least --settle minutes ago, inside --hours,
#     with every check run and commit status on GitHub completed with success (`gh api`: no gh, no
#     sign-in, or a check still running is a wait; a failed one is a refusal);
#   - the target built in its own check checkout (never the live one), then live-update.sh from
#     there: a dry run, then --apply. The profile's patch is never changed (no --patch).
# A stop the operator must look at (a refused dry run, an update stopped or rolled back, a target
# that does not build, not a fast-forward) writes the pause file with the reason and exits 1, so the
# unit's OnFailure= notifier runs once; the operator removes the file to resume. Every pass appends
# one line of outcome to <backups>/auto-update/log, naming the branch it follows.
#
# The whole pass is in main(), read before it runs: the pass checks out another commit in the
# checkout this file is in, so bash must not read the rest of it afterwards.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
usage: scripts/live-auto-update.sh [--branch <name>] [--live <checkout>] [--check <checkout>]
         [--dsh-home <dir>] [--node-dir <dir>] [--pnpm-dir <dir>] [--backups <dir>] [--settle <minutes>]
         [--hours <HH-HH>]

One pass of the automatic update, to the head of origin's --branch (default main: a plain branch
name, such as dev or release/1). The defaults are this host's live install: --live
~/workspaces/system-live, --check ~/workspaces/system-live-check (a worktree of the live repository),
--dsh-home $DSH_HOME or ~/.dsh, --node-dir Node 24's bin, --pnpm-dir Node 22's bin, --backups
~/system-backups, --settle 30 (minutes since the pass first saw the commit on the branch), --hours any
(02-06: from 02:00 to 05:59 local time; 22-04 wraps midnight).
Exit status: 0 the pass ended as it should (updated, nothing to do, waiting, refused, or paused
already), 1 it stopped and paused itself, 2 usage.
EOF
}

main() {
  local live=$HOME/workspaces/system-live check=$HOME/workspaces/system-live-check
  local dsh_home=${DSH_HOME:-$HOME/.dsh} node_dir=$HOME/.nvm/versions/node/v24.21.0/bin
  local pnpm_dir=$HOME/.nvm/versions/node/v22.23.2/bin backups=$HOME/system-backups settle=30 hours=''
  local branch=main
  while (($#)); do
    case $1 in
      --branch | --live | --check | --dsh-home | --node-dir | --pnpm-dir | --backups | --settle | --hours)
        if (($# < 2)); then usage >&2; exit 2; fi
        case $1 in
          --branch) branch=$2 ;;
          --live) live=$2 ;;
          --check) check=$2 ;;
          --dsh-home) dsh_home=$2 ;;
          --node-dir) node_dir=$2 ;;
          --pnpm-dir) pnpm_dir=$2 ;;
          --backups) backups=$2 ;;
          --settle) settle=$2 ;;
          --hours) hours=$2 ;;
        esac
        shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  if [[ ! $settle =~ ^[0-9]+$ ]]; then usage >&2; exit 2; fi
  if [[ -n $hours ]] && ! window_valid "$hours"; then usage >&2; exit 2; fi
  # Before any git command: the name goes into a refspec and into every line the pass writes.
  if ! branch_valid "$branch"; then
    printf 'not a plain branch name: %q (--branch)\n' "$branch" >&2
    usage >&2
    exit 2
  fi
  BRANCH=$branch

  if [[ ! -d $backups ]]; then
    printf 'stopped: no backup directory %s (--backups)\n' "$backups" >&2
    exit 1
  fi
  BACKUPS=$(realpath "$backups")
  AUTO=$BACKUPS/auto-update
  mkdir -p "$AUTO"
  LOG=$AUTO/log
  if [[ ! -d $dsh_home/system ]]; then outcome stopped "no DSH state directory $dsh_home/system (--dsh-home)"; exit 1; fi
  DSH_HOME_DIR=$(realpath "$dsh_home")
  PAUSE=$DSH_HOME_DIR/system/auto-update.paused

  exec 8>>"$AUTO/lock"
  if ! flock -n 8; then outcome busy "another pass runs"; exit 0; fi
  trap 'on_err $? $LINENO' ERR
  trap 'pause_self "the pass was interrupted by a signal"' TERM INT HUP

  if [[ -e $PAUSE ]]; then outcome paused "$(head -n 1 "$PAUSE") ($PAUSE)"; exit 0; fi
  if ! flock -n "$BACKUPS/.live-update.lock" true; then outcome wait "a live update runs (lock $BACKUPS/.live-update.lock)"; exit 0; fi
  local unfinished
  if unfinished=$(unfinished_update); then
    pause_self "an update that stopped the daemon is unfinished ($unfinished): take it up with the command its notes name"
  fi

  [[ -d $live ]] || pause_self "no live checkout at $live (--live)"
  [[ -d $check ]] || pause_self "no check checkout at $check: git -C $live worktree add --detach $check (--check)"
  LIVE=$(realpath "$live")
  CHECK=$(realpath "$check")
  [[ $CHECK != "$LIVE" ]] || pause_self "the check checkout is the live checkout ($LIVE)"
  if [[ $(git -C "$CHECK" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) != "$(git -C "$LIVE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ]]; then
    pause_self "$CHECK is not a worktree of $LIVE's repository"
  fi

  local fetched
  # The branch itself (refs/heads/), never a tag of the same name; only FETCH_HEAD is written.
  if ! fetched=$(git -C "$CHECK" fetch --quiet origin "refs/heads/$BRANCH" 2>&1); then outcome wait "git fetch origin $BRANCH failed: $(tail -n 1 <<<"$fetched")"; exit 0; fi
  FROM=$(git -C "$LIVE" rev-parse HEAD)
  TARGET=$(git -C "$CHECK" rev-parse --verify 'FETCH_HEAD^{commit}')
  if [[ $TARGET == "$FROM" ]]; then outcome current "the live install is at origin/$BRANCH ${TARGET:0:12}"; exit 0; fi
  if ! git -C "$CHECK" merge-base --is-ancestor "$FROM" "$TARGET"; then
    pause_self "origin/$BRANCH ${TARGET:0:12} does not descend from the live commit ${FROM:0:12}: not a fast-forward"
  fi

  local seen_sha='' seen_at=0 left
  if [[ -f $AUTO/seen ]]; then read -r seen_sha seen_at <"$AUTO/seen" || true; fi
  if [[ $seen_sha != "$TARGET" || ! $seen_at =~ ^[0-9]+$ ]]; then
    seen_at=$(date +%s)
    printf '%s %s\n' "$TARGET" "$seen_at" >"$AUTO/seen"
  fi
  left=$((seen_at + settle * 60 - $(date +%s)))
  if ((left > 0)); then outcome wait "${TARGET:0:12} settles for $(((left + 59) / 60)) more minute(s)"; exit 0; fi
  if [[ -n $hours ]] && ! in_window "$hours"; then outcome wait "outside the hours $hours"; exit 0; fi

  local ci=0
  ci_verdict || ci=$?
  case $ci in
    0) ;;
    1) outcome wait "CI of ${TARGET:0:12}: $CI_DETAIL"; exit 0 ;;
    *) outcome refused "CI of ${TARGET:0:12}: $CI_DETAIL"; exit 0 ;;
  esac

  OUT=$AUTO/$(date -u +%Y%m%dT%H%M%SZ)-${TARGET:0:12}.out
  local build_path=$node_dir:$PATH:$pnpm_dir
  [[ -z $(git -C "$CHECK" status --porcelain --untracked-files=no) ]] || pause_self "the check checkout $CHECK has uncommitted changes"
  if ! { git -C "$CHECK" checkout --quiet --detach "$TARGET" &&
    (cd "$CHECK" && PATH=$build_path pnpm install --frozen-lockfile --prefer-offline --config.confirm-modules-purge=false &&
      PATH=$build_path pnpm build); } >>"$OUT" 2>&1; then
    pause_self "${TARGET:0:12} did not install or build in $CHECK"
  fi

  # The target's own script, from the check checkout: never from the live one, which it replaces.
  local -a update=(bash "$CHECK/scripts/live-update.sh" "$TARGET" --from "$FROM" --check-with "$CHECK" --live "$LIVE"
    --dsh-home "$DSH_HOME_DIR" --node-dir "$node_dir" --pnpm-dir "$pnpm_dir" --backups "$BACKUPS")
  local status=0
  "${update[@]}" >>"$OUT" 2>&1 || status=$?
  if ((status)); then pause_self "the dry run refused ${TARGET:0:12} (exit $status): the output says why (the live patch fails the target's system check, say)"; fi
  "${update[@]}" --apply >>"$OUT" 2>&1 || status=$?
  case $status in
    0) outcome updated "the live install runs origin/$BRANCH ${TARGET:0:12} (from ${FROM:0:12}); notes: $OUT" ;;
    1) pause_self "the update to ${TARGET:0:12} stopped or rolled back (exit 1): the live install stays at ${FROM:0:12}" ;;
    *) pause_self "the update to ${TARGET:0:12} needs a look (exit $status): LOOK FIRST" ;;
  esac
}

LOG=/dev/null
BRANCH=main
PAUSE=''
OUT=''
FROM=''
TARGET=''
CI_DETAIL=''

# The pass's one line of outcome: <time> origin/<branch> <kind>: <detail>.
outcome() { printf '%s origin/%s %s: %s\n' "$(date -u +%FT%TZ)" "$BRANCH" "$1" "$2" | tee -a "$LOG" >&2; }

# A stop the operator looks at: pause, and exit 1 for the unit's OnFailure= notifier.
pause_self() {
  trap - ERR TERM INT HUP
  printf '%s\npaused %s; branch origin/%s, live %s, target %s; output %s\nlook, then remove this file to resume: rm %s\n' \
    "$1" "$(date -u +%FT%TZ)" "$BRANCH" "${FROM:-?}" "${TARGET:-?}" "${OUT:--}" "$PAUSE" >"$PAUSE"
  outcome stopped "$1${OUT:+ (output: $OUT)}; paused: $PAUSE"
  exit 1
}

# An unexpected failure pauses too. A subshell (with -E it inherits this trap) only exits.
on_err() {
  if ((BASH_SUBSHELL > 0)); then exit "$1"; fi
  pause_self "unexpected error (exit $1) at line $2 of the pass"
}

# An update recorded under the backups that stopped the daemon and has not finished, or rolled back.
unfinished_update() {
  local state phase
  shopt -s nullglob
  for state in "$BACKUPS"/*-before-base*/live-update.state; do
    phase=$(sed -n 's/^phase=//p' "$state")
    case $phase in
      new | captured | done | rolled-back | set-aside) ;;
      *)
        shopt -u nullglob
        printf '%s, phase %s' "${state%/*}" "$phase"
        return 0 ;;
    esac
  done
  shopt -u nullglob
  return 1
}

# A plain branch name, checked without git: components of letters, digits, `.`, `_`, `-`, joined by
# single `/`s; none empty, starting with `.` or `-`, or ending with `.` or `.lock`; no `..`; not HEAD.
# Stricter than git check-ref-format: no `@{`, `~`, `^`, `:`, space, glob, or option-like name.
branch_valid() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && ${#1} -le 200 && $1 != HEAD ]] || return 1
  case /$1/ in
    *//* | */.* | */-* | *./* | *.lock/* | *..*) return 1 ;;
  esac
}

window_valid() {
  [[ $1 =~ ^([0-9]{2})-([0-9]{2})$ ]] && ((10#${BASH_REMATCH[1]} <= 23 && 10#${BASH_REMATCH[2]} <= 24 && 10#${BASH_REMATCH[1]} != 10#${BASH_REMATCH[2]}))
}

# The local hour is in [start, end), wrapping midnight when start > end.
in_window() {
  local start=$((10#${1%-*})) end=$((10#${1#*-})) hour
  hour=$((10#$(date +%H)))
  if ((start < end)); then ((hour >= start && hour < end)); else ((hour >= start || hour < end)); fi
}

# GitHub's verdict on the target: 0 every check run and status succeeded, 1 wait (none yet, one
# still running, or gh unusable), 3 a check failed. CI_DETAIL says which.
ci_verdict() {
  local runs combined state count status conclusion name n=0 red='' pending=''
  if ! command -v gh >/dev/null; then CI_DETAIL='no gh on PATH'; return 1; fi
  if ! runs=$(cd "$CHECK" && gh api --paginate "repos/{owner}/{repo}/commits/$TARGET/check-runs?per_page=100" \
    --jq '.check_runs[] | "\(.status) \(.conclusion) \(.name)"' 2>&1); then
    CI_DETAIL="gh api failed: $(tail -n 1 <<<"$runs")"
    return 1
  fi
  while read -r status conclusion name; do
    [[ -n $status ]] || continue
    n=$((n + 1))
    if [[ $status != completed ]]; then
      pending=${pending:-"check run '$name' is $status"}
    elif [[ $conclusion != success ]]; then
      red=${red:-"check run '$name' ended $conclusion"}
    fi
  done <<<"$runs"
  if ! combined=$(cd "$CHECK" && gh api "repos/{owner}/{repo}/commits/$TARGET/status" --jq '"\(.state) \(.total_count)"' 2>&1); then
    CI_DETAIL="gh api failed: $(tail -n 1 <<<"$combined")"
    return 1
  fi
  read -r state count <<<"$combined"
  if [[ $count != 0 ]]; then
    case $state in
      success) ;;
      pending) pending=${pending:-'a commit status is pending'} ;;
      *) red=${red:-"the commit status is $state"} ;;
    esac
  fi
  if [[ -n $red ]]; then CI_DETAIL=$red; return 3; fi
  if [[ -n $pending ]]; then CI_DETAIL=$pending; return 1; fi
  if ((n == 0)); then CI_DETAIL='no check run yet'; return 1; fi
  CI_DETAIL="$n check run(s) succeeded"
  return 0
}

main "$@"; exit
