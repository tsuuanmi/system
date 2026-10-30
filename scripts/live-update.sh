#!/usr/bin/env bash
# Update the live install of `system` from one commit to another, and roll back when the update
# fails: docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release
#
# A dry run by default: it checks what it can without changing anything (the running profile is
# only read) and prints the plan. With --apply it acts:
#   1. capture what the running profile answers: its health, every run's explain and result, each
#      Worker's availability (its roster); and where its unit, system.service, sends the daemon's output;
#   1b. pause dispatch (unless paused or off already), hold steps (T257: each running run finishes
#      the step it is in and starts no next one; released on every exit before the stop, ended by
#      the next start after it), and wait, up to --runs-wait minutes (5), until no
#      workflow step runs (every RUNNING step of every running run in the store, read-only, on a
#      Worker or not; each run, its step, its Worker, for how long, with what the roster adds) (T234);
#      at the bound, cut (T269, the default): an update never waits long, and never needs a quiet
#      moment, since each cut step resumes by itself; with --no-cut, stop there, the unit untouched;
#   2. the stop: when it cuts, `system shutdown --deadline <--cut-deadline, 60 s>` (the CLI's
#      shutdownHost: a short drain, then the daemon stopped; agent runs are cut at once, their sessions
#      and worktrees kept, and a website turn already sent is reconciled at the next start, never
#      resent); then `systemctl --user stop system.service`, whose ExecStop drains (`system shutdown
#      --deadline 600`) when the daemon still runs; the daemon is never killed; wait until it has exited;
#   3. back up the store and the vault (`system backup`, verified by a restore preview) and the
#      profile's files, into <backups>/<date>-before-base/;
#   4. check out the target, install with the frozen lockfile, build, and read in the built lib the
#      commit it was built from (packages/cli/lib/build-commit): the target's;
#   5. link the profile's bundle from the live installation (`system init`, when it links another
#      checkout), put the candidate profile patch in place (--patch), and `system check` the profile;
#   6. `systemctl --user start system.service`, and wait for /healthz;
#   7. the upgrade checks (scripts/live-update-check.ts): every Worker that took work before takes
#      work again within --workers-wait seconds (one that stays unavailable fails, with its reason;
#      the Workers before and after are printed), no health check worse, every old run explains and
#      answers as before, no migration backwards, every record valid; then `system plugins` and the
#      MCP header helper; then dispatch resumed, when step 1b paused it (a rollback resumes it too);
#   8. when it cut: the report of each cut step and how it resumed (a free retry, its session resumed,
#      not settled yet), and each check the stop cut that ran again (T269), read from the store.
# The daemon runs only under its unit, with the unit's environment file: the script refuses a daemon
# started any other way. A failure after step 2 rolls back: the unit stopped, the profile's files
# and the previous commit put back, installed and built, the store and vault restored from step 3's
# backup when the new code ran on them, and the unit started again. Each step checks its outcome,
# and a step already done is not done again: after an interruption, run the same command again.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
usage: scripts/live-update.sh <target sha> [--stage | --apply] [--check-with <built checkout of the target>]
         [--patch <candidate cordis.patch.yml>] [--from <sha>] [--live <checkout>] [--dsh-home <dir>]
         [--node-dir <dir>] [--pnpm-dir <dir>] [--backups <dir>] [--new-workers <prefix,...>]
         [--workers-wait <seconds>] [--runs-wait <minutes>] [--runs-every <seconds>] [--cut-running | --no-cut]
         [--cut-deadline <seconds>] [--keep <updates>]

After an update verified (never a rolled-back one), it prunes the older backups under --backups: it
keeps the last --keep updates (3) and the newest of each of the last 4 weeks, every backup an
unfinished update refers to, and this one's; it drops this update's `after` snapshot; the notes list
what it removed. A dry run lists what it would remove now.

A dry run unless --apply. --stage <commit> is the way to update the live install (T323): it updates
and checks the system-test profile first, with the target's code and the same patch (the test
profile has its own data directory and port, no website or agent account, and the conformance
fakes as Workers), and runs the canary there: a run through algorithm-development, an ask, a
research run, and the removability smoke. Only when they pass does it go on with --apply's steps on
`system`; when they fail, `system` is not touched. --apply alone skips the stage (it is the live steps only). --apply needs --check-with: the profile is checked against the
target's code before anything is stopped. Before the stop it pauses dispatch (unless paused or off already),
holds steps (each running run finishes the step it is in and starts no next one; released on every
exit before the stop, ended by the restart after it),
and waits until no workflow step runs, up to --runs-wait minutes, reading the store (read-only) and
the roster every --runs-every seconds and saying what runs (run, step, Worker, for how long). At the
bound it cuts (the default, --cut-running): it names each step, stops the daemon with a drain of at
most --cut-deadline seconds (system shutdown), and each cut step resumes by itself after the restart;
the update's report says how. With --no-cut it stops there instead, exit 1, the unit not stopped.
The daemon runs under the user unit system.service, which is stopped and started (its ExecStop
drains). The defaults are this host's live install: --from e218ae7, --live ~/workspaces/system-live,
--dsh-home $DSH_HOME or ~/.dsh, --node-dir Node 24's bin, --pnpm-dir Node 22's bin (appended to
PATH, for pnpm only), --backups ~/system-backups, --new-workers agent:, --workers-wait 600 (how
long the Workers that took work before the update have to take work again after it: two probe
TTLs), --runs-wait 5, --runs-every 30, --cut-deadline 60.
Exit status: 0 done (or nothing to do), 1 stopped or rolled back, 2 usage, or a state to look at.
EOF
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPLY=0
STAGE=0             # T323: the update runs on the system-test profile first (scripts/live-stage.sh); --stage implies --apply
TARGET_REF=''
FROM_REF=e218ae7
LIVE=$HOME/workspaces/system-live
DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
NODE_DIR=$HOME/.nvm/versions/node/v24.21.0/bin
PNPM_DIR=$HOME/.nvm/versions/node/v22.23.2/bin
BACKUPS=$HOME/system-backups
NEW_WORKERS=agent:
WORKERS_WAIT=600
RUNS_WAIT=5         # minutes: how long the update waits for the steps in flight before it cuts (T269)
RUNS_EVERY=30       # seconds between two reads of what runs
CUT_RUNNING=1       # at the wait's bound, cut (T269); --no-cut stops the update there instead
CUT_DEADLINE=60     # seconds: the drain of the stop when it cuts, then the daemon stops
KEEP=3              # updates whose backups are kept after a verified update (besides the newest of each of 4 weeks)
KEEP_WEEKS=4
CHECK_WITH=''
PATCH_CANDIDATE=''

while (($#)); do
  case $1 in
    --apply) APPLY=1 ;;
    --stage) STAGE=1; APPLY=1 ;;
    --cut-running) CUT_RUNNING=1 ;;
    --no-cut) CUT_RUNNING=0 ;;
    --check-with | --patch | --from | --live | --dsh-home | --node-dir | --pnpm-dir | --backups | --new-workers | --workers-wait | --runs-wait | --runs-every | --cut-deadline | --keep)
      if (($# < 2)); then usage >&2; exit 2; fi
      case $1 in
        --check-with) CHECK_WITH=$2 ;;
        --patch) PATCH_CANDIDATE=$2 ;;
        --from) FROM_REF=$2 ;;
        --live) LIVE=$2 ;;
        --dsh-home) DSH_HOME_DIR=$2 ;;
        --node-dir) NODE_DIR=$2 ;;
        --pnpm-dir) PNPM_DIR=$2 ;;
        --backups) BACKUPS=$2 ;;
        --new-workers) NEW_WORKERS=$2 ;;
        --workers-wait)
          if [[ ! $2 =~ ^[0-9]+$ ]]; then usage >&2; exit 2; fi
          WORKERS_WAIT=$2 ;;
        --runs-wait)
          if [[ ! $2 =~ ^[0-9]+$ ]]; then usage >&2; exit 2; fi
          RUNS_WAIT=$((10#$2)) ;;
        --runs-every)
          if [[ ! $2 =~ ^[0-9]+$ ]] || ((10#$2 < 1)); then usage >&2; exit 2; fi
          RUNS_EVERY=$((10#$2)) ;;
        --cut-deadline)
          if [[ ! $2 =~ ^[0-9]+$ ]] || ((10#$2 > 600)); then usage >&2; exit 2; fi
          CUT_DEADLINE=$((10#$2)) ;;
        --keep)
          if [[ ! $2 =~ ^[0-9]+$ ]] || ((10#$2 < 1)); then usage >&2; exit 2; fi
          KEEP=$((10#$2)) ;;
      esac
      shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *)
      if [[ -n $TARGET_REF ]]; then usage >&2; exit 2; fi
      TARGET_REF=$1 ;;
  esac
  shift
done
if [[ -z $TARGET_REF ]]; then usage >&2; exit 2; fi

# --- output and failure -------------------------------------------------------------------------

LOG_FILE=/dev/null
ATTEMPT=''      # this update's directory under the backups: state, notes, backup
STATE=''
STOPPED=0       # set once the daemon is asked to stop: from then on a failure rolls back
ROLLING_BACK=0
SCRATCH=''

log() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

# A refusal before anything of the live install changed.
die() {
  trap - ERR
  log "STOP: $*"
  log "the live install was not changed${ATTEMPT:+ (notes: $ATTEMPT)}"
  exit 1
}

# A state the script will not act on: the operator looks first.
stuck() {
  trap - ERR
  log "LOOK FIRST: $*"
  log "  live checkout: $(git -C "$LIVE" rev-parse --short=12 HEAD 2>/dev/null || echo '?') (previous ${FROM:0:12}, target ${TARGET:0:12})"
  log "  daemon: $(if daemon_running; then echo "running, pid $DAEMON_PID"; else echo 'not running'; fi)"
  if [[ -n $ATTEMPT ]]; then
    log "  backup: $ATTEMPT/store (restore with the previous code built: system restore $ATTEMPT/store --yes); profile files: $ATTEMPT/profiles/system"
    log "  notes: $ATTEMPT/live-update.log; state: $STATE"
    if [[ $(state_get dispatch_paused) == update ]]; then log "  dispatch: paused by this update; once the daemon runs, resume it: system dispatch resume"; fi
  fi
  log "  runbook: docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release"
  exit 2
}

# A failure: roll back once the daemon was asked to stop; a failure while rolling back is stuck.
fail() {
  trap - ERR
  if ((ROLLING_BACK)); then
    if [[ -n $STATE ]]; then state_set phase rollback-failed; fi
    stuck "the rollback failed: $*"
  fi
  if ((STOPPED)); then rollback "$*"; fi
  die "$*"
}

# An unexpected failure. A subshell (with -E it inherits this trap) only exits: its caller decides.
on_err() {
  if ((BASH_SUBSHELL > 0)); then exit "$1"; fi
  fail "unexpected error (exit $1) at line $2"
}
trap 'on_err $? $LINENO' ERR

# Every exit, an interruption's too: the wait's reader stopped, the update's hold between steps
# released while the daemon it was set in still runs (T257: a hold never outlives the update's wait;
# once the daemon stopped, its next start ends the hold), and the scratch directory removed.
WAITER=''      # the wait's reader (live-update-check.ts await-idle), while it runs
on_exit() {
  local code=$?
  trap - ERR
  set +e
  if [[ -n $WAITER ]]; then kill "$WAITER" 2>/dev/null; fi
  if [[ -n $STATE ]] && steps_owed; then release_steps; fi
  [[ -z $SCRATCH ]] || rm -rf -- "$SCRATCH"
  exit "$code"
}
trap on_exit EXIT
# An interruption exits, so the exit's cleanup runs; a wait in progress returns at once (`wait`).
trap 'log "interrupted"; exit 130' INT
trap 'log "terminated"; exit 143' TERM

# --- environment --------------------------------------------------------------------------------

[[ -x $NODE_DIR/node ]] || die "no node at $NODE_DIR/node (--node-dir)"
[[ -d $LIVE ]] || die "no live checkout at $LIVE (--live)"
[[ -d $DSH_HOME_DIR ]] || die "no DSH home at $DSH_HOME_DIR (--dsh-home)"
LIVE=$(realpath "$LIVE")
# Bash reads a script as it runs it, and the update replaces the live checkout's files.
if [[ $(realpath "$SCRIPT_DIR")/ == "$LIVE"/* ]]; then die "run this script from another checkout than $LIVE (the target's, say): the update replaces its files"; fi
DSH_HOME_DIR=$(realpath "$DSH_HOME_DIR")
BACKUPS=$(realpath -m "$BACKUPS")
RUN_PATH=$NODE_DIR:$PATH            # the daemon and the CLI: Node 24 first, then the caller's PATH
BUILD_PATH=$RUN_PATH:$PNPM_DIR      # pnpm from Node 22's bin; `node` stays Node 24

node24() { PATH=$RUN_PATH "$NODE_DIR/node" "$@"; }
# A checkout's CLI, as the operator, on this DSH home.
cli() {
  local checkout=$1
  shift
  PATH=$RUN_PATH DSH_HOME=$DSH_HOME_DIR "$NODE_DIR/node" "$checkout/packages/cli/lib/bin.js" "$@"
}
pnpm_live() { (cd "$LIVE" && PATH=$BUILD_PATH pnpm "$@"); }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }

PROFILE_DIR=$DSH_HOME_DIR/profiles/system
LIVE_PATCH=$PROFILE_DIR/cordis.patch.yml
HOME_PATCH=$DSH_HOME_DIR/cordis.patch.yml
STATE_DIR=$DSH_HOME_DIR/system
DISCOVERY=$STATE_DIR/mcp.json
# The commit a build was made from, written by the CLI's build (packages/cli/README.md, "Build stamp").
STAMP_FILE=packages/cli/lib/build-commit
FROM=''
TARGET=''
HEAD_AT=''

# --- processes ----------------------------------------------------------------------------------

alive() {
  local stat
  [[ -n ${1:-} ]] || return 1
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  [[ ${stat%% *} != Z ]]
}
ppid_of() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  stat=${stat#* }
  printf '%s' "${stat%% *}"
}
# When a process started, in seconds since the epoch (boot time plus its start time in clock ticks).
started_at() {
  local stat btime
  local -a fields
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  read -r -a fields <<<"${stat##*) }"
  btime=$(grep '^btime ' /proc/stat | cut -d' ' -f2) || return 1
  printf '%s' $((btime + fields[19] / $(getconf CLK_TCK)))
}
discovery_field() {
  [[ -f $DISCOVERY ]] || return 0
  node24 -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(d[process.argv[2]] ?? "")' "$DISCOVERY" "$1"
}

# The daemon's unit, the one way it is stopped and started (docs/operations/runbooks.md#run-as-a-service).
UNIT=system.service
unit() { systemctl --user "$@"; }
unit_show() { systemctl --user show -p "$1" --value "$UNIT"; }
# active, inactive, failed, activating (a start, or a restart's wait), deactivating, …
unit_state() { systemctl --user is-active "$UNIT" 2>/dev/null || true; }

# Whether the profile's daemon runs from the live checkout under its unit: 0 yes, 1 no, 2 a process
# that is not the live checkout's daemon holds the discovery file, 3 the live checkout's daemon runs
# outside the unit. Sets DAEMON_PID (the dsh process the discovery file names) and WRAPPER_PID (its
# parent `system start`, the unit's main process).
DAEMON_PID=''
WRAPPER_PID=''
daemon_running() {
  local pid args parent
  DAEMON_PID=''
  WRAPPER_PID=''
  pid=$(discovery_field pid) || return 1
  alive "$pid" || return 1
  args=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || return 1
  [[ $args == *"$LIVE/node_modules/"*"/@deepseek-ai/dsh/lib/bin.js --profile system"* ]] || return 2
  DAEMON_PID=$pid
  parent=$(ppid_of "$pid") || return 3
  if alive "$parent" && [[ $(tr '\0' ' ' <"/proc/$parent/cmdline" 2>/dev/null) == *"packages/cli/lib/bin.js start"* ]] &&
    [[ $(unit_show MainPID 2>/dev/null) == "$parent" ]]; then
    WRAPPER_PID=$parent
    return 0
  fi
  return 3
}

# How the unit runs the daemon, read from its main process: in the live checkout, on --node-dir's
# Node, its output appended to a file (START_LOG, read on a failed start).
read_start() {
  local cwd exe
  cwd=$(readlink "/proc/$WRAPPER_PID/cwd") || return 1
  exe=$(readlink "/proc/$WRAPPER_PID/exe") || return 1
  START_LOG=$(readlink "/proc/$WRAPPER_PID/fd/1") || return 1
  if [[ $(realpath "$cwd") != "$LIVE" ]]; then log "$UNIT runs the daemon in $cwd, not $LIVE"; return 1; fi
  if [[ $(realpath "$exe") != $(realpath "$NODE_DIR/node") ]]; then log "$UNIT runs the daemon on $exe, not $NODE_DIR/node (--node-dir)"; return 1; fi
  if [[ $START_LOG != /* || ! -f $START_LOG ]]; then log "$UNIT sends the daemon's output to $START_LOG, not a file (StandardOutput=append:)"; return 1; fi
}

load_start() { START_LOG=$(state_get start_log); }

wait_gone() {
  local until=$((SECONDS + $1)) pid any
  shift
  while :; do
    any=0
    for pid in "$@"; do
      if alive "$pid"; then any=1; fi
    done
    if ((!any)); then return 0; fi
    if ((SECONDS >= until)); then return 1; fi
    sleep 2
  done
}

# `systemctl --user stop`: the unit's ExecStop drains (`system shutdown --deadline`), then stops the
# daemon; systemctl returns once the unit is down. Then the daemon and its parent must be gone.
stop_daemon() {
  local state running=0
  local -a pids=()
  daemon_running || running=$?
  if ((running == 0)); then
    pids=("$DAEMON_PID" "$WRAPPER_PID")
  fi
  state=$(unit_state)
  if ((running != 0)) && [[ $state == inactive || $state == failed ]]; then
    log "the daemon is not running ($UNIT: $state)"
    steps_held_until_start
    return 0
  fi
  log "systemctl --user stop $UNIT (${pids[*]:-no daemon}; $state): its ExecStop drains, then stops"
  if ! unit stop "$UNIT" 2>&1 | tee -a "$LOG_FILE" >&2; then
    log "systemctl --user stop $UNIT failed"
    return 1
  fi
  state=$(unit_state)
  if [[ $state != inactive && $state != failed ]]; then
    log "$UNIT is $state after its stop"
    return 1
  fi
  if ((${#pids[@]})) && ! wait_gone 60 "${pids[@]}"; then
    log "the daemon (${pids[*]}) has not exited after $UNIT stopped (it is never killed)"
    return 1
  fi
  log "the daemon has exited"
  steps_held_until_start
}

# The daemon the hold was set in has exited: its next start ends the hold (the engine releases one
# left over before it schedules any run), and every run goes on from its recorded state.
steps_held_until_start() {
  if [[ -n $STATE ]] && steps_owed; then
    state_set steps_held restart
    log "steps: the hold ends with the next start of the daemon"
  fi
}

healthz_ok() {
  local url
  url=$(discovery_field url) || return 1
  [[ -n $url ]] || return 1
  node24 -e 'fetch(new URL("/healthz", process.argv[1]), { signal: AbortSignal.timeout(5000) }).then(async (r) => process.exit(r.ok && (await r.text()).trim() === "ok" ? 0 : 1), () => process.exit(1))' "$url"
}

# `systemctl --user start`, then wait for /healthz. A start that failed before (a crash loop that
# reached the start limit) is reset first: a later start is this script's to make.
start_daemon() {
  local from until state
  from=$(stat -c %s "$START_LOG" 2>/dev/null || echo 0)
  unit reset-failed "$UNIT" 2>/dev/null || true
  log "systemctl --user start $UNIT"
  unit start "$UNIT" 2>&1 | tee -a "$LOG_FILE" >&2 || { log "systemctl --user start $UNIT failed"; return 1; }
  until=$((SECONDS + 180))
  while ((SECONDS < until)); do
    sleep 3
    if daemon_running && healthz_ok; then
      log "the daemon is up: pid $DAEMON_PID ($UNIT: $WRAPPER_PID)"
      return 0
    fi
    state=$(unit_state)
    if [[ $state == failed || $state == inactive ]]; then log "$UNIT is $state"; break; fi
    if grep -q 'startup failed' < <(tail -c +"$((from + 1))" "$START_LOG" 2>/dev/null); then break; fi
  done
  log "the daemon did not come up; its log since the start:"
  tail -c +"$((from + 1))" "$START_LOG" 2>/dev/null | tail -n 40 >&2 || true
  return 1
}

# The unit runs the live checkout with an environment file of its own (one, required) naming this
# DSH home. Sets ENV_FILE, or UNIT_PROBLEM when it does not.
ENV_FILE=''
UNIT_PROBLEM=''
unit_ok() {
  local files home
  if [[ $(unit_show LoadState 2>/dev/null) != loaded ]]; then
    UNIT_PROBLEM="there is no $UNIT user unit: run the daemon under it once (docs/operations/runbooks.md#run-the-live-daemon-under-systemservice)"
    return 1
  fi
  if [[ $(realpath -m "$(unit_show WorkingDirectory)") != "$LIVE" ]]; then
    UNIT_PROBLEM="$UNIT runs in $(unit_show WorkingDirectory), not in $LIVE (WorkingDirectory=)"
    return 1
  fi
  files=$(unit_show EnvironmentFiles)
  if [[ ! $files =~ ^(/[^ ]+)\ \(ignore_errors=no\)$ ]]; then
    UNIT_PROBLEM="$UNIT must name one environment file, required (EnvironmentFile= without \"-\"); it names '$files'"
    return 1
  fi
  ENV_FILE=${BASH_REMATCH[1]}
  if [[ ! -f $ENV_FILE ]]; then UNIT_PROBLEM="no environment file $ENV_FILE ($UNIT)"; return 1; fi
  home=$(sed -n 's/^[[:space:]]*DSH_HOME=//p' "$ENV_FILE" | tail -n 1)
  home=${home%\"}; home=${home#\"}; home=${home%\'}; home=${home#\'}
  if [[ -z $home || $(realpath -m "$home") != "$DSH_HOME_DIR" ]]; then
    UNIT_PROBLEM="$ENV_FILE does not set DSH_HOME to $DSH_HOME_DIR (--dsh-home)"
    return 1
  fi
}

# --- state of an update -------------------------------------------------------------------------

PHASES=(new captured stopped backed-up checked-out built linked patched checked starting started verified done)

state_get() {
  local line
  [[ -n $STATE && -f $STATE ]] || return 0
  while IFS= read -r line; do
    if [[ $line == "$1="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$STATE"
}
state_set() {
  local tmp=$STATE.tmp line found=0
  : >"$tmp"
  if [[ -f $STATE ]]; then
    while IFS= read -r line; do
      if [[ $line == "$1="* ]]; then
        printf '%s=%s\n' "$1" "$2" >>"$tmp"
        found=1
      else
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$STATE"
  fi
  if ((!found)); then printf '%s=%s\n' "$1" "$2" >>"$tmp"; fi
  mv -f "$tmp" "$STATE"
}
phase_index() {
  local i
  for i in "${!PHASES[@]}"; do
    if [[ ${PHASES[i]} == "$1" ]]; then
      printf '%s' "$i"
      return 0
    fi
  done
  printf '%s' -1
}
reached() { (($(phase_index "$(state_get phase)") >= $(phase_index "$1"))); }
set_phase() {
  state_set phase "$1"
  log "-- $1"
}

# The unfinished update of this checkout from FROM to TARGET, if one is recorded under the backups.
find_attempt() {
  local dir
  shopt -s nullglob
  for dir in "$BACKUPS"/*-before-base*/; do
    STATE=${dir}live-update.state
    if [[ -f $STATE && $(state_get from) == "$FROM" && $(state_get target) == "$TARGET" && $(state_get live) == "$LIVE" ]]; then
      case $(state_get phase) in
        done | rolled-back | set-aside) ;;
        *)
          shopt -u nullglob
          ATTEMPT=${dir%/}
          return 0 ;;
      esac
    fi
  done
  shopt -u nullglob
  STATE=''
  return 1
}

# A new update's directory, <backups>/<date>-before-base (-2, -3, … when taken).
new_attempt() {
  local base dir n=1
  base=$BACKUPS/$(date +%F)-before-base
  dir=$base
  while [[ -e $dir ]]; do
    n=$((n + 1))
    dir=$base-$n
  done
  mkdir -m 700 "$dir"
  ATTEMPT=$dir
  STATE=$dir/live-update.state
  state_set from "$FROM"
  state_set target "$TARGET"
  state_set live "$LIVE"
  state_set dsh_home "$DSH_HOME_DIR"
  state_set opened_at "$(date -u +%FT%TZ)"
  # The patch this update puts in place, copied once: every later run of it uses this copy.
  if [[ -n $PATCH_CANDIDATE ]]; then
    cp "$PATCH_CANDIDATE" "$dir/candidate.cordis.patch.yml"
    state_set patch_sha256 "$(sha_of "$dir/candidate.cordis.patch.yml")"
  else
    state_set patch_sha256 none
  fi
  state_set phase new
}

# The patch named now is the one this update started with.
same_patch() {
  local now=none
  if [[ -n $PATCH_CANDIDATE ]]; then now=$(sha_of "$PATCH_CANDIDATE"); fi
  [[ $now == "$(state_get patch_sha256)" ]]
}

# --- steps --------------------------------------------------------------------------------------

# The commit a checkout's lib was built from, or nothing when its build wrote no stamp.
stamp_of() {
  local line=''
  [[ -f $1/$STAMP_FILE ]] || return 0
  IFS= read -r line <"$1/$STAMP_FILE" || true
  printf '%s' "$line"
}
# What a build of a commit stamps: the commit, or nothing for code from before the stamp was written.
stamp_for() {
  if git -C "$LIVE" show "$1:packages/cli/package.json" 2>/dev/null | grep -q -F -e "> lib/build-commit"; then printf '%s' "$1"; fi
}
# The live checkout's lib is a build of this commit.
built_at() { [[ $(stamp_of "$LIVE") == "$(stamp_for "$1")" ]]; }

# Every package the system bundle composes resolves to a built entry file, and so does the CLI.
bundle_built() {
  node24 -e '
    const fs = require("fs"), path = require("path")
    const bundle = path.join(process.argv[1], "packages/system-bundle")
    const missing = []
    for (const dep of Object.keys(JSON.parse(fs.readFileSync(path.join(bundle, "package.json"), "utf8")).dependencies ?? {})) {
      const dir = path.join(bundle, "node_modules", dep)
      let pkg
      try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) } catch { missing.push(`${dep} (not installed)`); continue }
      const dot = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."]
      const entry = (typeof dot === "string" ? dot : dot?.import ?? dot?.default) ?? pkg.main ?? "index.js"
      if (!fs.existsSync(path.join(dir, entry))) missing.push(`${dep} (${entry})`)
    }
    if (!fs.existsSync(path.join(process.argv[1], "packages/cli/lib/bin.js"))) missing.push("packages/cli/lib/bin.js")
    if (missing.length) { console.error(`not built: ${missing.join(", ")}`); process.exit(1) }
  ' "$LIVE"
}

checkout() {
  local sha=$1
  if [[ $(git -C "$LIVE" rev-parse HEAD) != "$sha" ]]; then
    log "git checkout --detach ${sha:0:12} in $LIVE"
    git -C "$LIVE" checkout --quiet --detach "$sha" || return 1
  fi
  [[ $(git -C "$LIVE" rev-parse HEAD) == "$sha" && -z $(git -C "$LIVE" status --porcelain --untracked-files=no) ]]
}

# Install and build the checked-out commit. A purge of node_modules that pnpm would ask about
# (settings changed between the commits) goes ahead: the daemon is stopped, and this is the install.
build() {
  # A stamp left from another commit's build never vouches for this one.
  rm -f -- "$LIVE/$STAMP_FILE"
  log "pnpm install --frozen-lockfile, then pnpm build, in $LIVE"
  pnpm_live install --frozen-lockfile --prefer-offline --config.confirm-modules-purge=false 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  pnpm_live build 2>&1 | tail -n 20 | tee -a "$LOG_FILE" >&2 || return 1
  bundle_built
}

# `system check` by a checkout's CLI on a scratch home that holds only the profile's files and the
# patch to check, with the unit's environment file: nothing else of the live home is read, nothing
# is written to it.
check_profile_with() {
  local checkout=$1 patch=$2 home
  if [[ -z $SCRATCH ]]; then SCRATCH=$(mktemp -d); fi
  home=$SCRATCH/check-home
  rm -rf -- "$home"
  mkdir -p "$home/profiles/system" || return 1
  cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/cordis.yml" "$home/profiles/system/" || return 1
  cp "$patch" "$home/profiles/system/cordis.patch.yml" || return 1
  if [[ -f $HOME_PATCH ]]; then cp "$HOME_PATCH" "$home/cordis.patch.yml" || return 1; fi
  PATH=$RUN_PATH DSH_HOME=$home "$NODE_DIR/node" "$checkout/packages/cli/lib/bin.js" check --env-file "$ENV_FILE" 2>&1 | tee -a "$LOG_FILE" >&2
}

capture() {
  log "capturing what the running profile answers: health, and every run's explain and result"
  node24 --disable-warning=ExperimentalWarning "$SCRIPT_DIR/live-update-check.ts" capture "$LIVE/packages/cli/lib/index.js" "$DSH_HOME_DIR" "$1" 2>&1 | tee -a "$LOG_FILE" >&2
}

check_tool() {
  local command=$1
  shift
  node24 --disable-warning=ExperimentalWarning "$SCRIPT_DIR/live-update-check.ts" "$command" "$LIVE/packages/cli/lib/index.js" "$DSH_HOME_DIR" "$@"
}

# Pause dispatch before the wait, so no ready task starts by itself meanwhile; one the operator
# paused, or dispatch off, is left as it is. The update's own pause is recorded, and lifted once the
# profile runs again (resume_dispatch).
pause_dispatch() {
  local out
  if [[ $(state_get dispatch_paused) == update ]]; then
    log "dispatch: paused by this update already"
    return 0
  fi
  out=$(check_tool dispatch-pause "live update to ${TARGET:0:12}: waiting for the running steps before the stop") || return 1
  log "${out#*: }"
  if [[ $out == paused:* ]]; then state_set dispatch_paused update; fi
}

# Lift this update's own pause of dispatch, once the daemon runs (done, or rolled back, or stopped
# at the wait's bound). A resume that fails is a note: the operator resumes it.
resume_dispatch() {
  [[ $(state_get dispatch_paused) == update ]] || return 0
  if check_tool dispatch-resume 2>&1 | tee -a "$LOG_FILE" >&2; then
    state_set dispatch_paused resumed
  else
    log "note: dispatch stays paused by this update: system dispatch resume"
  fi
}

# Record how the update ended once the daemon runs again (`host.live-update`), so each project's
# lead inbox tells it (live-update.done or live-update.failed, D107). A profile that cannot record
# it is a note: the update's outcome stands.
record_outcome() {
  if ! check_tool live-update-record "$@" 2>&1 | tee -a "$LOG_FILE" >&2; then
    log "note: the lead inbox was not told this update's outcome ($1)"
  fi
}

# Hold steps before the wait (T257): each running run finishes the step it is in and starts no next
# one, so the wait ends at the next step boundary instead of when every run is done. Recorded
# (steps_held=update) until it is released (release_steps) or the daemon stopped (the next start
# ends it). A profile whose code has no hold holds nothing: the wait is then T234's, for every step.
hold_steps() {
  local out
  # The release is owed before the hold is asked for (steps_held=pending): an interruption during
  # the request, or an answer lost after the daemon set the hold, leaves the outcome unknown, and
  # every way out then releases it as if it were held.
  state_set steps_held pending
  # Asked every time, a run taken up again too: holding a held engine changes nothing, and a hold
  # recorded before a restart of the daemon has ended with it.
  out=$(check_tool hold-steps "live update to ${TARGET:0:12}: waiting for the steps in flight before the stop") || return 1
  log "${out#*: }"
  if [[ $out == held:* ]]; then
    state_set steps_held update
  else
    state_set steps_held none
  fi
}

# Whether this update holds steps, or may (its request's outcome unknown): a release is owed.
steps_owed() {
  local held
  held=$(state_get steps_held)
  [[ $held == update || $held == pending ]]
}

# Release this update's hold while the daemon it was set in runs (the update stops before the stop:
# at the wait's bound, on a refusal, or interrupted), a hold whose request's outcome is unknown too.
# Once that daemon has exited, its next start releases it. A release that fails is said, with what to do.
release_steps() {
  steps_owed || return 0
  if ! daemon_running; then
    state_set steps_held restart
    log "steps: the daemon is not running; its next start ends the hold"
    return 0
  fi
  if check_tool release-steps 2>&1 | tee -a "$LOG_FILE" >&2; then
    state_set steps_held released
  else
    log "note: steps stay held by this update: release them (MCP hold_steps with release: true), or restart $UNIT, which ends the hold"
  fi
}

# Wait, bounded, until no workflow step runs, on a Worker or not (T234). Steps are held first (T257),
# so only the steps in flight are waited for. At the bound, cut (T269, the default): go on, and say
# what the stop cuts, written to cut.json for the report after the restart; with --no-cut, stop, the
# unit untouched (steps released, dispatch resumed). The reader runs in the background and is waited
# for, so an interruption ends the wait at once and the exit releases the hold.
wait_idle() {
  local -a cut=()
  local status=0 fifo teed
  if ((CUT_RUNNING)); then cut=(--cut-running --cut-file "$ATTEMPT/cut.json"); fi
  pause_dispatch || die "dispatch could not be paused (above)"
  hold_steps || die "steps could not be held (above)"
  log "waiting until no workflow step runs: up to $RUNS_WAIT min, a look every $RUNS_EVERY s"
  if [[ -z $SCRATCH ]]; then SCRATCH=$(mktemp -d); fi
  fifo=$SCRATCH/await-idle.out
  rm -f -- "$fifo"
  mkfifo -m 600 "$fifo"
  tee -a "$LOG_FILE" <"$fifo" >&2 &
  teed=$!
  PATH=$RUN_PATH "$NODE_DIR/node" --disable-warning=ExperimentalWarning "$SCRIPT_DIR/live-update-check.ts" await-idle "$LIVE/packages/cli/lib/index.js" "$DSH_HOME_DIR" \
    --wait $((RUNS_WAIT * 60)) --every "$RUNS_EVERY" ${cut[@]+"${cut[@]}"} >"$fifo" 2>&1 &
  WAITER=$!
  wait "$WAITER" || status=$?
  WAITER=''
  wait "$teed" || true
  if ((status == 0)); then
    return 0
  fi
  if ((CUT_RUNNING)); then
    log "cutting: the stop cuts the steps above, still running after $RUNS_WAIT min; each resumes by itself after the restart (a free retry, or its session resumed), and the update's report says how"
    return 0
  fi
  release_steps
  resume_dispatch
  die "steps still run after $RUNS_WAIT min (above): $UNIT was not stopped (--no-cut). Run the update again once they finish (or with a longer --runs-wait), or without --no-cut to cut them"
}

# The cut's stop (T269): the daemon stopped by `system shutdown --deadline $CUT_DEADLINE` (the CLI's
# shutdownHost: no new run admitted, a drain of at most that long, then SIGTERM and its exit), not by
# the unit's ExecStop, whose 600 s drain waits for every step. Agent runs are cut at once then, their
# sessions and worktrees kept; a website turn already sent is reconciled at the next start, never
# resent (INV-4). The unit's own stop follows, and finds the daemon gone. A cut never falls back to
# the unit's drain: a CLI without shutdownHost, or a short stop that failed with the daemon still
# running, returns 1, and the caller refuses the update, nothing stopped (the 600 s drain is what
# the cut exists to avoid).
cut_stop() {
  local status=0
  log "stopping the daemon with a drain of at most $CUT_DEADLINE s (system shutdown --deadline $CUT_DEADLINE): what still runs then is cut, and resumes by itself after the restart"
  check_tool stop-cut --deadline "$CUT_DEADLINE" 2>&1 | tee -a "$LOG_FILE" >&2 || status=$?
  if ((status != 0)); then
    # The daemon may have gone anyway (a stop that failed late): only one still running is refused.
    if daemon_running; then
      if ((status == 3)); then
        log "this profile's CLI has no shutdownHost, so the short stop is unavailable"
      else
        log "the short stop failed (above) and the daemon still runs"
      fi
      return 1
    fi
  fi
  # Its main process, `system start`, exits with the daemon: the unit goes down by itself (its
  # ExecStop finds no main process, and does nothing).
  local until=$((SECONDS + 30)) state
  while ((SECONDS < until)); do
    state=$(unit_state)
    if [[ $state == inactive || $state == failed ]]; then break; fi
    sleep 0.5
  done
  return 0
}

# The update's report of what its stop cut (T269): each cut step and how it resumed, and each check
# the stop cut that ran again, read from the store after the restart. A note, never a failure.
report_cuts() {
  [[ -f $ATTEMPT/cut.json ]] || return 0
  log "what the stop cut, and how it resumed:"
  if ! check_tool cut-report "$ATTEMPT/cut.json" 2>&1 | tee "$ATTEMPT/cut-report.txt" | tee -a "$LOG_FILE" >&2; then
    log "note: what the stop cut could not be read back (above): system explain <run> follows each run named in the wait's output"
  fi
}

# Policy drift (T352), after a verified update: each policy file the target ships that the live set
# does not hold, and the policy change it needs, printed into the notes (policy-drift.txt too). A policy
# enters the live set only through an approved policy change, so nothing else puts a changed file
# there; this proposes nothing (the operator approves it). A failure is a note, never the update's.
report_policy_drift() {
  log "policy drift: the policy files of ${TARGET:0:12} against the live set"
  if ! check_tool policy-drift "$LIVE" "$TARGET" "$ATTEMPT" 2>&1 | tee "$ATTEMPT/policy-drift.txt" | tee -a "$LOG_FILE" >&2; then
    log "note: policy drift could not be read (above): lead_health's policy rows show it"
  fi
}

# The stage (T323): the target's code and the patch to ship on the system-test profile, and its
# canary, by scripts/live-stage.sh. Nothing of the live profile is read for writing or touched: a
# failure is a refusal before anything of the live install changed.
stage() {
  log "stage: the target's code and the patch on the system-test profile first (canary: algorithm-development, ask, research, the removability smoke)"
  bash "$SCRIPT_DIR/live-stage.sh" --check-with "$CHECK_WITH" --dsh-home "$DSH_HOME_DIR" --node-dir "$NODE_DIR" --pnpm-dir "$PNPM_DIR" \
    --env-file "$ENV_FILE" ${PATCH_CANDIDATE:+--patch "$PATCH_CANDIDATE"} 2>&1 | tee -a "$LOG_FILE" >&2
}

backup() {
  local store=$ATTEMPT/store
  if [[ ! -f $store/system-backup.json ]]; then
    # One without a manifest was interrupted: `system backup` takes an empty directory only.
    rm -rf -- "$store"
    log "system backup $store (the store by VACUUM INTO, and the vault; its key stays in $STATE_DIR)"
    cli "$LIVE" backup "$store" 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  fi
  # A restore preview verifies every file against the backup's manifest, and restores nothing.
  cli "$LIVE" restore "$store" 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  rm -rf -- "$ATTEMPT/profiles"
  mkdir -p "$ATTEMPT/profiles" || return 1
  cp -a "$PROFILE_DIR" "$ATTEMPT/profiles/" || return 1
  if [[ -f $HOME_PATCH ]]; then cp -p "$HOME_PATCH" "$ATTEMPT/home.cordis.patch.yml" || return 1; fi
  cmp -s "$LIVE_PATCH" "$ATTEMPT/profiles/system/cordis.patch.yml" || return 1
  state_set store_sha256 "$(sha_of "$STATE_DIR/system.db")"
  log "backed up to $ATTEMPT"
}

# Nothing ran on the store since the backup.
store_unchanged() {
  [[ ! -s $STATE_DIR/system.db-wal && $(sha_of "$STATE_DIR/system.db") == "$(state_get store_sha256)" ]]
}

install_patch() {
  local candidate=$ATTEMPT/candidate.cordis.patch.yml tmp
  [[ -f $candidate ]] || return 0
  if ! cmp -s "$candidate" "$LIVE_PATCH"; then
    log "the candidate patch replaces $LIVE_PATCH (the previous one is in $ATTEMPT/profiles/system)"
    tmp=$(mktemp "$PROFILE_DIR/.cordis.patch.yml.XXXXXX") || return 1
    if ! { cp "$candidate" "$tmp" && chmod --reference="$LIVE_PATCH" "$tmp" && mv -f "$tmp" "$LIVE_PATCH"; }; then
      rm -f -- "$tmp"
      return 1
    fi
  fi
  cmp -s "$candidate" "$LIVE_PATCH"
}

BUNDLE_LINK=node_modules/@tsuuanmi/system-bundle

# The profile links its bundle from the installation that runs it, as `system init` makes it: the
# plugin host reads each plugin's manifest through that link (docs/design/plugin-host.md).
profile_linked() {
  [[ $(realpath -m "$PROFILE_DIR/$BUNDLE_LINK") == "$LIVE/packages/system-bundle" ]] &&
    grep -q -F -e "\"link:$LIVE/packages/system-bundle\"" "$PROFILE_DIR/package.json"
}

link_profile() {
  if profile_linked; then return 0; fi
  log "system init: the profile links its bundle from $(realpath -m "$PROFILE_DIR/$BUNDLE_LINK"), not from $LIVE; refreshing it from the live installation (its patch is never rewritten)"
  # `dsh plugin install` runs pnpm.
  PATH=$BUILD_PATH DSH_HOME=$DSH_HOME_DIR "$NODE_DIR/node" "$LIVE/packages/cli/lib/bin.js" init 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  profile_linked
}

restore_profile() {
  local saved=$ATTEMPT/profiles/system f
  for f in package.json pnpm-lock.yaml cordis.patch.yml; do
    if [[ -f $saved/$f ]] && ! cmp -s "$saved/$f" "$PROFILE_DIR/$f"; then
      log "putting back $PROFILE_DIR/$f"
      cp -p "$saved/$f" "$PROFILE_DIR/$f" || return 1
    fi
  done
  # The bundle link as it was (a relative link: compared as written, at the same depth).
  if [[ -d $saved/node_modules && $(readlink "$saved/$BUNDLE_LINK" 2>/dev/null) != "$(readlink "$PROFILE_DIR/$BUNDLE_LINK" 2>/dev/null)" ]]; then
    log "putting back $PROFILE_DIR/node_modules"
    rm -rf -- "$PROFILE_DIR/node_modules" && cp -a "$saved/node_modules" "$PROFILE_DIR/" || return 1
  fi
  if [[ -f $ATTEMPT/home.cordis.patch.yml ]] && ! cmp -s "$ATTEMPT/home.cordis.patch.yml" "$HOME_PATCH"; then
    cp -p "$ATTEMPT/home.cordis.patch.yml" "$HOME_PATCH" || return 1
  fi
}

verify() {
  local after=$ATTEMPT/after headers re='^\{"Authorization":"Bearer [A-Za-z0-9_-]+"\}$'
  if [[ ! -f $after/system-backup.json ]]; then
    rm -rf -- "$after"
    log "system backup $after (a snapshot of the updated store, for the record checks)"
    cli "$LIVE" backup "$after" 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  fi
  log "the upgrade checks: the Workers (up to ${WORKERS_WAIT} s for each that took work before to take work again), health, old runs, migrations, records"
  node24 --disable-warning=ExperimentalWarning "$SCRIPT_DIR/live-update-check.ts" verify "$LIVE/packages/cli/lib/index.js" "$DSH_HOME_DIR" \
    "$ATTEMPT/before.json" "$after" --new-workers "$NEW_WORKERS" --workers-wait "$WORKERS_WAIT" 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  log "system plugins"
  if ! cli "$LIVE" plugins >"$ATTEMPT/plugins.txt" 2>&1; then
    cat "$ATTEMPT/plugins.txt" >&2
    return 1
  fi
  if grep 'manifest refused' "$ATTEMPT/plugins.txt" >&2; then return 1; fi
  # Claude Code's `system` MCP server authenticates through this helper on every connection.
  headers=$(cli "$LIVE" mcp-headers) || return 1
  if [[ ! $headers =~ $re ]]; then
    log "system mcp-headers does not print the client token's header"
    return 1
  fi
  cli "$LIVE" health 2>&1 | tee -a "$LOG_FILE" >&2 || true
}

rollback() {
  local reason=$1 from_phase
  ROLLING_BACK=1
  from_phase=$(state_get rollback_from)
  if [[ -z $from_phase ]]; then
    from_phase=$(state_get phase)
    state_set rollback_from "$from_phase"
    state_set rollback_reason "$reason"
  fi
  state_set phase rolling-back
  log "ROLLING BACK to ${FROM:0:12} (the update reached '$from_phase'): $reason"
  stop_daemon || fail "the updated daemon did not stop"
  restore_profile || fail "the profile's files could not be put back"
  if [[ $(git -C "$LIVE" rev-parse HEAD) != "$FROM" || -n $(git -C "$LIVE" status --porcelain --untracked-files=no) ]] || ! built_at "$FROM"; then
    checkout "$FROM" || fail "git checkout of ${FROM:0:12} failed"
    build || fail "the previous code did not install or build"
    built_at "$FROM" || fail "the rebuilt $STAMP_FILE names '$(stamp_of "$LIVE")', not ${FROM:0:12}'s build"
  fi
  if (($(phase_index "$from_phase") >= $(phase_index starting))); then
    log "system restore $ATTEMPT/store --yes (the updated code ran on the store)"
    cli "$LIVE" restore "$ATTEMPT/store" --yes 2>&1 | tee -a "$LOG_FILE" >&2 || fail "the store could not be restored"
  fi
  start_daemon || fail "the previous code did not start"
  resume_dispatch
  record_outcome failed "$FROM" "$TARGET" rolled-back
  cli "$LIVE" health 2>&1 | tee -a "$LOG_FILE" >&2 || true
  state_set phase rolled-back
  log "rolled back: the live install runs ${FROM:0:12} again$( (($(phase_index "$from_phase") >= $(phase_index starting))) && echo ', on the store and vault of the backup'); why: $reason"
  log "notes: $ATTEMPT/live-update.log"
  exit 1
}

# --- pruning old backups (T346) -----------------------------------------------------------------

# Every update leaves a full snapshot under the backups; they are kept within a bound. Of the
# <date>-before-base[-n] directories, newest first, a backup is kept when it is one of the last $KEEP,
# or the newest of one of the last $KEEP_WEEKS weeks (counted back, in 7-day spans, from the newest
# backup's date), or this update's, or one a running or unfinished update refers to (its phase is not
# done, rolled-back, or set-aside: the lock admits one update at a time, so that is any other one).
# Sets PRUNE_KEEP and PRUNE_REMOVE (lines "<name> <why>" and "<name>").
PRUNE_KEEP=()
PRUNE_REMOVE=()
BACKUP_NAME_RE='^([0-9]{4}-[0-9]{2}-[0-9]{2})-before-base(-[0-9]+)?$'

prune_plan() {
  local dir name day anchor='' phase count=0 week why
  local -a names=()
  local -A seen=()
  PRUNE_KEEP=()
  PRUNE_REMOVE=()
  shopt -s nullglob
  for dir in "$BACKUPS"/*-before-base*/; do
    name=${dir%/}
    name=${name##*/}
    if [[ $name =~ $BACKUP_NAME_RE && ! -L ${dir%/} ]]; then names+=("$name"); fi
  done
  shopt -u nullglob
  ((${#names[@]})) || return 0
  # Newest first: date, then the attempt's number (-2 after the first of that day).
  mapfile -t names < <(printf '%s\n' "${names[@]}" | sed -E 's/^(.{10}-before-base)$/\1-1/' | LC_ALL=C sort -r | sed -E 's/^(.{10}-before-base)-1$/\1/')
  for name in "${names[@]}"; do
    [[ $name =~ $BACKUP_NAME_RE ]]
    phase=$( (STATE=$BACKUPS/$name/live-update.state; state_get phase) )
    # A rolled-back or set-aside update's backup is the store it never changed: it counts for nothing.
    if [[ $phase == rolled-back || $phase == set-aside ]]; then
      PRUNE_REMOVE+=("$name")
      continue
    fi
    day=$(($(date -u -d "${BASH_REMATCH[1]}" +%s) / 86400))
    if [[ -z $anchor ]]; then anchor=$day; fi
    week=$(((anchor - day) / 7))
    why=''
    if [[ -n $ATTEMPT && $BACKUPS/$name == "$ATTEMPT" ]]; then
      why='this update'
    elif [[ -f $BACKUPS/$name/live-update.state && $phase != done ]]; then
      why="an unfinished update (phase ${phase:-unknown})"
    elif ((count < KEEP)); then
      why="one of the last $KEEP updates"
    elif ((week < KEEP_WEEKS)) && [[ -z ${seen[$week]:-} ]]; then
      why="the newest of week $((week + 1)) back"
    fi
    if ((week < KEEP_WEEKS)); then seen[$week]=1; fi
    count=$((count + 1))
    if [[ -n $why ]]; then PRUNE_KEEP+=("$name $why"); else PRUNE_REMOVE+=("$name"); fi
  done
}

# List what pruning keeps and removes, and with $1 = remove, remove it. A backup is removed by its
# exact name under the backups only, never by a path read from anywhere else.
prune_backups() {
  local mode=$1 line name
  prune_plan
  for line in ${PRUNE_KEEP[@]+"${PRUNE_KEEP[@]}"}; do
    log "backup prune: keep ${line%% *} (${line#* })"
  done
  for name in ${PRUNE_REMOVE[@]+"${PRUNE_REMOVE[@]}"}; do
    if [[ $mode == remove ]]; then
      if rm -rf -- "${BACKUPS:?}/$name"; then log "backup prune: removed $name"; else log "note: backup prune: $name could not be removed"; fi
    else
      log "backup prune: would remove $name"
    fi
  done
  if ((${#PRUNE_REMOVE[@]} == 0)); then log "backup prune: nothing to remove"; fi
}

# After an update verified: its `after` snapshot has done its work, and the older backups are pruned.
# A failure here is a note: the update's outcome stands.
after_verified() {
  if [[ -d $ATTEMPT/after ]]; then
    rm -rf -- "$ATTEMPT/after" && log "dropped $ATTEMPT/after (the checks passed)"
  fi
  prune_backups remove || log "note: backup prune failed (above)"
}
# --- preflight: read-only, in a dry run too -----------------------------------------------------

preflight() {
  local problems=0 head untracked avail dir tool running=0

  for tool in git systemctl flock sha256sum realpath df mkfifo; do
    if ! command -v "$tool" >/dev/null; then log "missing tool: $tool"; problems=$((problems + 1)); fi
  done
  if ! node24 -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit((a === 24 && b >= 18) || (a === 26 && b >= 5) || a > 26 ? 0 : 1)'; then
    log "$NODE_DIR/node is $(node24 --version), outside the supported range (^24.18.1 || >=26.5.1)"
    problems=$((problems + 1))
  fi
  if ! PATH=$BUILD_PATH command -v pnpm >/dev/null; then log "no pnpm in $PNPM_DIR or on PATH"; problems=$((problems + 1)); fi

  git -C "$LIVE" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$LIVE is not a git checkout"
  FROM=$(git -C "$LIVE" rev-parse --verify --quiet "$FROM_REF^{commit}") || die "--from $FROM_REF is not a commit in $LIVE's repository"
  if ! TARGET=$(git -C "$LIVE" rev-parse --verify --quiet "$TARGET_REF^{commit}"); then
    if ((!APPLY)); then die "the target $TARGET_REF is not in $LIVE's repository: git fetch first (--apply fetches it)"; fi
    log "git fetch (the target $TARGET_REF is not in the repository)"
    git -C "$LIVE" fetch --quiet || die "git fetch failed"
    TARGET=$(git -C "$LIVE" rev-parse --verify --quiet "$TARGET_REF^{commit}") || die "the target $TARGET_REF is not in the repository after a fetch"
  fi
  [[ $FROM != "$TARGET" ]] || die "the target is the previous commit"
  git -C "$LIVE" merge-base --is-ancestor "$FROM" "$TARGET" || die "${TARGET:0:12} does not descend from ${FROM:0:12}: not a forward update"
  head=$(git -C "$LIVE" rev-parse HEAD)
  case $head in
    "$FROM") HEAD_AT=from ;;
    "$TARGET") HEAD_AT=target ;;
    *) die "$LIVE is at ${head:0:12}, neither the previous commit ${FROM:0:12} nor the target ${TARGET:0:12}" ;;
  esac
  if [[ -n $(git -C "$LIVE" status --porcelain --untracked-files=no) ]]; then
    die "$LIVE has uncommitted changes: $(git -C "$LIVE" status --short --untracked-files=no | head -n 5 | tr '\n' ' ')"
  fi
  untracked=$(git -C "$LIVE" status --porcelain | grep -c '^??' || true)
  if ((untracked)); then log "note: $LIVE has $untracked untracked file(s); a checkout that would overwrite one fails"; fi
  [[ -n $(stamp_for "$TARGET") ]] || die "${TARGET:0:12}'s build writes no $STAMP_FILE: update to it with the script of its own checkout"
  log "live checkout $LIVE: at the $([[ $HEAD_AT == from ]] && echo previous || echo target) commit; previous ${FROM:0:12}, target ${TARGET:0:12} ($(git -C "$LIVE" rev-list --count "$FROM..$TARGET") commits)"

  [[ -f $LIVE_PATCH && -f $PROFILE_DIR/package.json && -f $PROFILE_DIR/cordis.yml ]] || die "no system profile in $PROFILE_DIR"
  if ! profile_linked; then
    log "note: the profile links its bundle from $(realpath -m "$PROFILE_DIR/$BUNDLE_LINK"), not from $LIVE: --apply refreshes it (system init)"
  fi
  [[ -f $STATE_DIR/system.db ]] || die "no store at $STATE_DIR/system.db"
  # A backup holds the vault without its key, so a restore needs the key on this host.
  if [[ -f $STATE_DIR/vault.enc && ! -f $STATE_DIR/vault.key ]]; then
    die "the vault key is not in $STATE_DIR (it is kept elsewhere): this script restores with it there; update by hand"
  fi
  [[ -d $BACKUPS ]] || die "no backup directory $BACKUPS (--backups)"
  unit_ok || die "$UNIT_PROBLEM"
  log "$UNIT runs $LIVE, with the environment file $ENV_FILE"
  for dir in "$BACKUPS" "$LIVE" "$STATE_DIR"; do
    avail=$(df -Pk "$dir" | tail -n 1 | tr -s ' ' | cut -d' ' -f4)
    if ((avail < 5 * 1024 * 1024)); then log "less than 5 GiB free under $dir"; problems=$((problems + 1)); fi
  done

  if [[ -n $PATCH_CANDIDATE ]]; then
    [[ -f $PATCH_CANDIDATE ]] || die "no patch candidate at $PATCH_CANDIDATE"
    if cmp -s "$PATCH_CANDIDATE" "$LIVE_PATCH"; then
      log "the patch candidate is the live patch: the profile does not change"
    else
      log "the patch candidate changes the live patch:"
      diff -u "$LIVE_PATCH" "$PATCH_CANDIDATE" | sed 's/^/    /' >&2 || true
    fi
  fi

  if [[ -n $CHECK_WITH ]]; then
    git -C "$CHECK_WITH" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "--check-with $CHECK_WITH is not a git checkout"
    if [[ $(git -C "$CHECK_WITH" rev-parse HEAD:packages) != "$(git -C "$LIVE" rev-parse "$TARGET:packages")" ||
      $(git -C "$CHECK_WITH" rev-parse HEAD:pnpm-lock.yaml) != "$(git -C "$LIVE" rev-parse "$TARGET:pnpm-lock.yaml")" ]]; then
      die "--check-with $CHECK_WITH is not at the target's code (its packages/ or pnpm-lock.yaml differ from ${TARGET:0:12})"
    fi
    [[ -z $(git -C "$CHECK_WITH" status --porcelain --untracked-files=no -- packages pnpm-lock.yaml) ]] || die "--check-with $CHECK_WITH has uncommitted changes under packages/"
    if [[ ! -f $CHECK_WITH/packages/cli/lib/bin.js || $(stamp_of "$CHECK_WITH") != "$(git -C "$CHECK_WITH" rev-parse HEAD)" ]]; then
      die "--check-with $CHECK_WITH is not built at its commit (pnpm install --frozen-lockfile && pnpm build there)"
    fi
    log "system check: the profile$([[ -n $PATCH_CANDIDATE ]] && echo ', with the patch candidate,') and $ENV_FILE against the target's code ($CHECK_WITH)"
    check_profile_with "$CHECK_WITH" "${PATCH_CANDIDATE:-$LIVE_PATCH}" || die "the profile does not pass the target's checks: fix the patch or the environment file, then check again"
  elif ((APPLY)); then
    die "--apply needs --check-with <a built checkout of the target>: the profile is checked against the new code before anything stops"
  else
    log "note: no --check-with: the profile was not checked against the target's code (--apply requires it)"
  fi

  daemon_running || running=$?
  case $running in
    0) log "the daemon runs under $UNIT: pid $DAEMON_PID (system start: $WRAPPER_PID)" ;;
    2) die "a process that is not $LIVE's daemon holds $DISCOVERY" ;;
    3) die "the daemon (pid $DAEMON_PID) runs outside $UNIT: run it under the unit once (docs/operations/runbooks.md#run-the-live-daemon-under-systemservice)" ;;
    *) log "the daemon is not running ($UNIT: $(unit_state))" ;;
  esac
  if ((problems)); then die "$problems problem(s) above"; fi
}

dry_run() {
  local runs='every run'
  if [[ -n $DAEMON_PID ]]; then
    read_start || die "how $UNIT runs the daemon cannot be read"
    log "$UNIT runs the daemon in $LIVE on $NODE_DIR/node, its output appended to $START_LOG"
    if [[ $HEAD_AT == from ]]; then
      if [[ -z $SCRATCH ]]; then SCRATCH=$(mktemp -d); fi
      capture "$SCRATCH/before.json" || die "the running profile is down, or cannot be captured (above)"
      runs="$(node24 -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runs.length)' "$SCRATCH/before.json") run(s)"
    fi
    log "system health now:"
    cli "$LIVE" health >&2 || true
    log "what --apply would wait for before the stop (up to $RUNS_WAIT min$( ((CUT_RUNNING)) && echo ', then cut')):"
    check_tool running >&2 || true
  elif [[ $HEAD_AT == from ]]; then
    log "note: --apply refuses until the daemon runs (systemctl --user start $UNIT): what it answers is captured first"
  fi
  cat >&2 <<EOF

Plan for --apply (this dry run changed nothing):
  1. capture: health, the explain and result of $runs, and each Worker's availability (its roster)
     -> $BACKUPS/<date>-before-base/before.json
     then pause dispatch (unless paused or off already; resumed once the profile runs again), hold
     steps (each running run finishes its step in flight and starts no next one until the restart;
     released if the update stops before the stop), and
     wait until no workflow step runs, up to $RUNS_WAIT min, a look every $RUNS_EVERY s, saying
     what runs (above, now); $(if ((CUT_RUNNING)); then echo 'at the bound: cut, naming each step it cuts (-> cut.json)'; else echo "at the bound (--no-cut): stop, exit 1, $UNIT not stopped"; fi)
  2. $(if ((CUT_RUNNING)); then echo "system shutdown --deadline $CUT_DEADLINE (a drain of at most $CUT_DEADLINE s, then the daemon"; echo "     stops; what still runs is cut and resumes by itself after the restart), then"; else echo 'the stop:'; fi)
     systemctl --user stop $UNIT (its ExecStop: system shutdown --deadline, a drain, when the
     daemon still runs); the daemon and system start exit (never killed)
  3. system backup <that directory>/store (store and vault, verified by a restore preview);
     $PROFILE_DIR -> <that directory>/profiles
  4. git -C $LIVE checkout --detach $TARGET
     pnpm install --frozen-lockfile && pnpm build (Node 24 first on PATH; pnpm from $PNPM_DIR)
     $STAMP_FILE must name ${TARGET:0:12}; every package of the bundle built
  5. $(if profile_linked; then echo 'the profile links its bundle from the live checkout already;'; else echo "system init: the profile links its bundle from $LIVE;"; fi)
     $(if [[ -n $PATCH_CANDIDATE ]]; then echo "the patch candidate replaces $LIVE_PATCH;"; else echo 'the live patch stays;'; fi) system check --env-file $ENV_FILE must say ok
  6. systemctl --user start $UNIT; /healthz within 3 minutes
  7. checks: every Worker that took work before takes work again within ${WORKERS_WAIT} s (one that
     stays unavailable fails, with its reason; the Workers before and after are printed), no health
     check worse (new Workers '$NEW_WORKERS' may be unavailable), every old run explains and answers
     as before, migrations forward, every record valid, system plugins, mcp-headers
  8. when it cut: each cut step and how it resumed, and each cut check run again (-> cut-report.txt)
  A failure after step 2 rolls back: $UNIT stopped, the profile's files put back, ${FROM:0:12}
  checked out, installed, and built, system restore <that directory>/store --yes when the updated
  code started, $UNIT started, system health. Exit 1; 2 if the rollback fails too.
  9. once it verified (never a rolled-back one): drop <that directory>/after, and prune the older
     backups, keeping the last $KEEP updates (--keep) and the newest of each of $KEEP_WEEKS weeks
     (below, what it would remove now, counting no new backup)
EOF
  prune_backups list
}

# --- main ---------------------------------------------------------------------------------------

preflight
if ((!APPLY)); then
  dry_run
  exit 0
fi

exec 9>>"$BACKUPS/.live-update.lock"
flock -n 9 || die "another live-update runs (lock $BACKUPS/.live-update.lock)"

if find_attempt && ! reached stopped && ! same_patch; then
  # It stopped nothing, and the patch was changed since: a new attempt checks and uses the new one.
  log "an earlier attempt ($ATTEMPT) stopped nothing and named another patch: it is set aside"
  state_set phase set-aside
  ATTEMPT=''
  STATE=''
fi
# Staged before anything is stopped, and not again once this update stopped the live daemon.
if ((STAGE)) && [[ $HEAD_AT == from || -n $ATTEMPT ]] && ! { [[ -n $ATTEMPT ]] && reached stopped; }; then
  # A refusal the live steps would make anyway comes first: the stage takes minutes.
  [[ $HEAD_AT == from && -z $ATTEMPT && -z $DAEMON_PID ]] && die "the daemon is not running: start it (systemctl --user start $UNIT), so what it answers can be captured, then run this again"
  stage || die "the stage failed on the system-test profile (above): $UNIT and the live profile were not touched"
fi
if [[ -z $ATTEMPT ]] && ! find_attempt; then
  if [[ $HEAD_AT == target ]]; then
    [[ -n $DAEMON_PID ]] || die "$LIVE is at the target, the daemon is not running, and no unfinished update is recorded: look before going on"
    built_at "$TARGET" || die "$LIVE is at the target, but its lib is not the target's build ($STAMP_FILE: '$(stamp_of "$LIVE")'): look before going on"
    if (($(started_at "$DAEMON_PID") < $(stat -c %Y "$LIVE/$STAMP_FILE"))); then
      die "the daemon was started before $LIVE was built: it may run the previous code; systemctl --user restart $UNIT, or update by hand"
    fi
    log "the live install already runs ${TARGET:0:12}: nothing to update"
    cli "$LIVE" health >&2 || true
    exit 0
  fi
  [[ -n $DAEMON_PID ]] || die "the daemon is not running: start it (systemctl --user start $UNIT), so what it answers can be captured, then run this again"
  new_attempt
fi
LOG_FILE=$ATTEMPT/live-update.log
log "update of $LIVE from ${FROM:0:12} to ${TARGET:0:12}; backup and notes in $ATTEMPT (phase: $(state_get phase))"

case $(state_get phase) in
  rolling-back)
    load_start
    STOPPED=1
    rollback "$(state_get rollback_reason) (an interrupted rollback, taken up again)" ;;
  rollback-failed) stuck "an earlier rollback of this update failed" ;;
esac
same_patch || die "this update started with another patch candidate ($ATTEMPT/candidate.cordis.patch.yml, or none): name the same --patch"
if reached checked-out && [[ $HEAD_AT != target ]]; then stuck "the update reached its checkout, but $LIVE is at ${FROM:0:12}"; fi
if reached stopped && ! reached starting && [[ -n $DAEMON_PID ]]; then stuck "the daemon runs, though this update stopped it: someone started it"; fi

if ! reached captured || { ! reached stopped && [[ -n $DAEMON_PID ]]; }; then
  [[ $HEAD_AT == from ]] || die "$LIVE is at the target before the daemon was stopped: look before going on"
  [[ -n $DAEMON_PID ]] || die "the daemon is not running: start it (systemctl --user start $UNIT), so what it answers can be captured, then run this again"
  read_start || die "how $UNIT runs the daemon cannot be read"
  state_set start_log "$START_LOG"
  if [[ -f $ATTEMPT/candidate.cordis.patch.yml ]]; then
    # The patch that will run is the one checked: this update's copy, against the target's code.
    check_profile_with "$CHECK_WITH" "$ATTEMPT/candidate.cordis.patch.yml" || die "the patch candidate does not pass the target's checks"
  fi
  capture "$ATTEMPT/before.json" || die "the running profile is down, or cannot be captured (above)"
  set_phase captured
else
  load_start
fi

# No step runs when the unit stops, or the steps still running at the wait's bound are cut, named
# first (T234, T269): a stop never cuts an agent run unsaid.
CUT_HERE=0
if ! reached stopped && [[ -n $DAEMON_PID ]]; then
  wait_idle
  CUT_HERE=$CUT_RUNNING
  # Cutting, the daemon stops after a short drain (T269), never the unit's 600 s one: when the short
  # stop cannot be made, the update stops here, nothing stopped (steps released, dispatch resumed).
  if ((CUT_HERE)) && ! cut_stop; then
    release_steps
    resume_dispatch
    die "the short stop (system shutdown --deadline $CUT_DEADLINE) cannot be made: $UNIT was not stopped, so no cut would take the unit's 600 s drain. Run the update with the target's own checkout of this script, whose CLI (the profile's) has it, or with --no-cut to wait for the steps instead"
  fi
fi

STOPPED=1
if ! reached stopped; then
  stop_daemon || fail "the daemon did not stop"
  set_phase stopped
fi

if ! reached backed-up; then
  backup || fail "the backup failed"
  set_phase backed-up
elif ! reached starting && ! store_unchanged; then
  stuck "the store changed since this update's backup, while the daemon was stopped"
fi

if ! reached checked-out; then
  checkout "$TARGET" || fail "git checkout of the target failed"
  set_phase checked-out
fi

if ! reached built; then
  build || fail "the target did not install or build"
  built_at "$TARGET" || fail "the built $STAMP_FILE names '$(stamp_of "$LIVE")': not the target's build"
  set_phase built
fi

if ! reached linked; then
  link_profile || fail "the profile could not be linked to the live installation (system init)"
  set_phase linked
fi

if ! reached patched; then
  install_patch || fail "the patch candidate could not be put in place"
  set_phase patched
fi

if ! reached checked; then
  log "system check: the profile as it will start, and $ENV_FILE, against the built code"
  cli "$LIVE" check --env-file "$ENV_FILE" 2>&1 | tee -a "$LOG_FILE" >&2 || fail "system check refused the profile or its environment file"
  set_phase checked
fi

if ! reached started; then
  running=0
  daemon_running || running=$?
  if ((running == 2)); then fail "a process that is not $LIVE's daemon holds $DISCOVERY"; fi
  if ((running == 3)); then fail "the daemon (pid $DAEMON_PID) runs outside $UNIT: someone started it by hand"; fi
  if ((running == 1)); then
    set_phase starting
    start_daemon || fail "the updated daemon did not start"
  fi
  set_phase started
fi

if ! reached verified; then
  verify || fail "the upgrade checks failed"
  set_phase verified
fi
resume_dispatch
report_cuts
report_policy_drift
record_outcome done "$FROM" "$TARGET"

set_phase done
after_verified
log "updated: $LIVE runs ${TARGET:0:12} (pid $DAEMON_PID); backup and notes in $ATTEMPT"
