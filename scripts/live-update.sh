#!/usr/bin/env bash
# Update the live install of `system` from one commit to another, and roll back when the update
# fails: docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release
#
# A dry run by default: it checks what it can without changing anything (the running profile is
# only read) and prints the plan. With --apply it acts:
#   1. capture what the running profile answers: its health, every run's explain and result; and
#      how its daemon was started (directory, node, arguments, log), read from the process;
#   2. `system shutdown --deadline <s>`, then wait until the daemon has exited (it is never killed);
#   3. back up the store and the vault (`system backup`, verified by a restore preview) and the
#      profile's files, into <backups>/<date>-before-base/;
#   4. check out the target, install with the frozen lockfile, build, and find in the built lib a
#      marker that only the target's code has;
#   5. link the profile's bundle from the live installation (`system init`, when it links another
#      checkout), put the candidate profile patch in place (--patch), and `system check` the profile;
#   6. start the daemon as it was started, and wait for /healthz;
#   7. the upgrade checks (scripts/live-update-check.ts): no health check worse, every old run
#      explains and answers as before, no migration backwards, every record valid; then
#      `system plugins` and the MCP header helper.
# A failure after step 2 rolls back: the new daemon stopped, the profile's files and the previous
# commit put back, installed and built, the store and vault restored from step 3's backup when the
# new code ran on them, and the daemon started again. Each step checks its outcome, and a step
# already done is not done again: after an interruption, run the same command again.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'EOF'
usage: scripts/live-update.sh <target sha> [--apply] [--check-with <built checkout of the target>]
         [--patch <candidate cordis.patch.yml>] [--from <sha>] [--live <checkout>] [--dsh-home <dir>]
         [--node-dir <dir>] [--pnpm-dir <dir>] [--backups <dir>] [--deadline <seconds>]
         [--marker <lib file>:<text>] [--new-workers <prefix,...>]

A dry run unless --apply. --apply needs --check-with: the profile is checked against the target's
code before anything is stopped. The defaults are this host's live install: --from e218ae7,
--live ~/workspaces/system-live, --dsh-home $DSH_HOME or ~/.dsh, --node-dir Node 24's bin,
--pnpm-dir Node 22's bin (appended to PATH, for pnpm only), --backups ~/system-backups,
--deadline 600, --marker packages/cli/lib/index.js:hostPlugins, --new-workers agent:.
Exit status: 0 done (or nothing to do), 1 stopped or rolled back, 2 usage, or a state to look at.
EOF
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPLY=0
TARGET_REF=''
FROM_REF=e218ae7
LIVE=$HOME/workspaces/system-live
DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
NODE_DIR=$HOME/.nvm/versions/node/v24.21.0/bin
PNPM_DIR=$HOME/.nvm/versions/node/v22.23.2/bin
BACKUPS=$HOME/system-backups
DEADLINE=600
MARKER_SPEC=packages/cli/lib/index.js:hostPlugins
NEW_WORKERS=agent:
CHECK_WITH=''
PATCH_CANDIDATE=''

while (($#)); do
  case $1 in
    --apply) APPLY=1 ;;
    --check-with | --patch | --from | --live | --dsh-home | --node-dir | --pnpm-dir | --backups | --deadline | --marker | --new-workers)
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
        --deadline) DEADLINE=$2 ;;
        --marker) MARKER_SPEC=$2 ;;
        --new-workers) NEW_WORKERS=$2 ;;
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
if [[ -z $TARGET_REF || ! $DEADLINE =~ ^[0-9]+$ || $MARKER_SPEC != *:?* ]]; then usage >&2; exit 2; fi

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
trap '[[ -z $SCRATCH ]] || rm -rf -- "$SCRATCH"' EXIT

# --- environment --------------------------------------------------------------------------------

[[ -x $NODE_DIR/node ]] || die "no node at $NODE_DIR/node (--node-dir)"
[[ -d $LIVE ]] || die "no live checkout at $LIVE (--live)"
[[ -d $DSH_HOME_DIR ]] || die "no DSH home at $DSH_HOME_DIR (--dsh-home)"
LIVE=$(realpath "$LIVE")
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
MARKER_FILE=${MARKER_SPEC%%:*}
MARKER=${MARKER_SPEC#*:}
MARKER_SOURCE=${MARKER_FILE/\/lib\//\/src\/}
MARKER_SOURCE=${MARKER_SOURCE%.js}.ts
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

# Whether the profile's daemon runs from the live checkout: 0 yes, 1 no, 2 a process that is not the
# live checkout's daemon holds the discovery file. Sets DAEMON_PID (the dsh process the discovery
# file names) and WRAPPER_PID (its parent, when that is `system start`).
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
  parent=$(ppid_of "$pid") || return 0
  if alive "$parent" && [[ $(tr '\0' ' ' <"/proc/$parent/cmdline" 2>/dev/null) == *"packages/cli/lib/bin.js start"* ]]; then
    WRAPPER_PID=$parent
  fi
  return 0
}

# How the running daemon was started: START_CWD, START_NODE, START_ARGS (after `start`), START_LOG.
read_start() {
  local -a argv
  local i
  if [[ -z $WRAPPER_PID ]]; then
    log "the daemon's parent is not \`system start\`: how it was started cannot be read"
    return 1
  fi
  START_CWD=$(readlink "/proc/$WRAPPER_PID/cwd") || return 1
  START_NODE=$(readlink "/proc/$WRAPPER_PID/exe") || return 1
  START_LOG=$(readlink "/proc/$WRAPPER_PID/fd/1") || return 1
  mapfile -d '' -t argv <"/proc/$WRAPPER_PID/cmdline" || return 1
  START_ARGS=''
  for ((i = 0; i + 1 < ${#argv[@]}; i++)); do
    if [[ ${argv[i]} == *packages/cli/lib/bin.js && ${argv[i + 1]} == start ]]; then
      START_ARGS=${argv[*]:i+2}
      if (($(wc -w <<<"$START_ARGS") != ${#argv[@]} - i - 2)); then
        log "an argument of the daemon's start holds a space: start it by hand"
        return 1
      fi
      break
    fi
  done
  if [[ $(realpath "$START_CWD") != "$LIVE" ]]; then log "the daemon was started in $START_CWD, not $LIVE"; return 1; fi
  if [[ $(realpath "$START_NODE") != $(realpath "$NODE_DIR/node") ]]; then log "the daemon runs on $START_NODE, not $NODE_DIR/node (--node-dir)"; return 1; fi
  if [[ $START_LOG != /* || ! -f $START_LOG ]]; then log "the daemon's output goes to $START_LOG, not a file"; return 1; fi
}

load_start() {
  START_CWD=$(state_get start_cwd)
  START_NODE=$(state_get start_node)
  START_ARGS=$(state_get start_args)
  START_LOG=$(state_get start_log)
}

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

# `system shutdown` through a checkout's CLI, then wait until the daemon and its parent have exited.
stop_daemon() {
  local checkout=$1
  local -a pids
  if ! daemon_running; then
    log "the daemon is not running"
    return 0
  fi
  pids=("$DAEMON_PID")
  if [[ -n $WRAPPER_PID ]]; then pids+=("$WRAPPER_PID"); fi
  log "system shutdown --deadline $DEADLINE (daemon ${pids[*]}): drains, then stops"
  if ! cli "$checkout" shutdown --deadline "$DEADLINE" 2>&1 | tee -a "$LOG_FILE" >&2; then
    log "shutdown reported a failure; waiting for the daemon to exit"
  fi
  if ! wait_gone 300 "${pids[@]}"; then
    log "the daemon (${pids[*]}) has not exited 5 minutes after the shutdown (it is never killed)"
    return 1
  fi
  log "the daemon has exited"
}

healthz_ok() {
  local url
  url=$(discovery_field url) || return 1
  [[ -n $url ]] || return 1
  node24 -e 'fetch(new URL("/healthz", process.argv[1]), { signal: AbortSignal.timeout(5000) }).then(async (r) => process.exit(r.ok && (await r.text()).trim() === "ok" ? 0 : 1), () => process.exit(1))' "$url"
}

# Start the daemon the way it was started, in a session of its own, and wait for /healthz.
start_daemon() {
  # DSH_HOME named, so a value in the caller's environment never points the daemon elsewhere.
  local -a args env=(PATH="$RUN_PATH" DSH_HOME="$DSH_HOME_DIR")
  local from until
  read -r -a args <<<"$START_ARGS"
  from=$(stat -c %s "$START_LOG" 2>/dev/null || echo 0)
  log "start: cd $LIVE && setsid nohup $START_NODE packages/cli/lib/bin.js start${START_ARGS:+ $START_ARGS} >> $START_LOG 2>&1 < /dev/null &"
  # Without the update's lock (fd 9): the daemon outlives this script.
  (cd "$LIVE" && exec env "${env[@]}" setsid nohup "$START_NODE" packages/cli/lib/bin.js start "${args[@]}" >>"$START_LOG" 2>&1 </dev/null 9>&-) &
  until=$((SECONDS + 180))
  while ((SECONDS < until)); do
    sleep 3
    if daemon_running && healthz_ok; then
      log "the daemon is up: pid $DAEMON_PID${WRAPPER_PID:+ (system start: $WRAPPER_PID)}"
      return 0
    fi
    if grep -q 'startup failed' < <(tail -c +"$((from + 1))" "$START_LOG"); then break; fi
  done
  log "the daemon did not come up; its log since the start:"
  tail -c +"$((from + 1))" "$START_LOG" | tail -n 40 >&2 || true
  return 1
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

# The built lib of the live checkout holds the marker (the target's code) or not (the previous one).
marker_built() { grep -q -F -e "$MARKER" "$LIVE/$MARKER_FILE"; }

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
  log "pnpm install --frozen-lockfile, then pnpm build, in $LIVE"
  pnpm_live install --frozen-lockfile --prefer-offline --config.confirm-modules-purge=false 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
  pnpm_live build 2>&1 | tail -n 20 | tee -a "$LOG_FILE" >&2 || return 1
  bundle_built
}

# `system check` by a checkout's CLI on a scratch home that holds only the profile's files and the
# patch to check: nothing else of the live home is read, nothing is written to it.
check_profile_with() {
  local checkout=$1 patch=$2 home
  if [[ -z $SCRATCH ]]; then SCRATCH=$(mktemp -d); fi
  home=$SCRATCH/check-home
  rm -rf -- "$home"
  mkdir -p "$home/profiles/system" || return 1
  cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/cordis.yml" "$home/profiles/system/" || return 1
  cp "$patch" "$home/profiles/system/cordis.patch.yml" || return 1
  if [[ -f $HOME_PATCH ]]; then cp "$HOME_PATCH" "$home/cordis.patch.yml" || return 1; fi
  PATH=$RUN_PATH DSH_HOME=$home "$NODE_DIR/node" "$checkout/packages/cli/lib/bin.js" check 2>&1 | tee -a "$LOG_FILE" >&2
}

capture() {
  log "capturing what the running profile answers: health, and every run's explain and result"
  node24 --disable-warning=ExperimentalWarning "$SCRIPT_DIR/live-update-check.ts" capture "$LIVE/packages/cli/lib/index.js" "$DSH_HOME_DIR" "$1" 2>&1 | tee -a "$LOG_FILE" >&2
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
  log "the upgrade checks: health, old runs, migrations, records"
  node24 --disable-warning=ExperimentalWarning "$SCRIPT_DIR/live-update-check.ts" verify "$LIVE/packages/cli/lib/index.js" "$DSH_HOME_DIR" \
    "$ATTEMPT/before.json" "$after" --new-workers "$NEW_WORKERS" 2>&1 | tee -a "$LOG_FILE" >&2 || return 1
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
  if daemon_running; then stop_daemon "$LIVE" || fail "the updated daemon did not stop"; fi
  restore_profile || fail "the profile's files could not be put back"
  if [[ $(git -C "$LIVE" rev-parse HEAD) != "$FROM" || -n $(git -C "$LIVE" status --porcelain --untracked-files=no) ]] || marker_built; then
    checkout "$FROM" || fail "git checkout of ${FROM:0:12} failed"
    build || fail "the previous code did not install or build"
    if marker_built; then fail "the rebuilt $MARKER_FILE still holds '$MARKER'"; fi
  fi
  if (($(phase_index "$from_phase") >= $(phase_index starting))); then
    log "system restore $ATTEMPT/store --yes (the updated code ran on the store)"
    cli "$LIVE" restore "$ATTEMPT/store" --yes 2>&1 | tee -a "$LOG_FILE" >&2 || fail "the store could not be restored"
  fi
  start_daemon || fail "the previous code did not start"
  cli "$LIVE" health 2>&1 | tee -a "$LOG_FILE" >&2 || true
  state_set phase rolled-back
  log "rolled back: the live install runs ${FROM:0:12} again$( (($(phase_index "$from_phase") >= $(phase_index starting))) && echo ', on the store and vault of the backup'); why: $reason"
  log "notes: $ATTEMPT/live-update.log"
  exit 1
}

# --- preflight: read-only, in a dry run too -----------------------------------------------------

preflight() {
  local problems=0 head untracked avail dir tool running=0

  for tool in git setsid nohup flock sha256sum realpath df; do
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
  if git -C "$LIVE" grep -q -F -e "$MARKER" "$FROM" -- "$MARKER_SOURCE"; then
    die "'$MARKER' is in $MARKER_SOURCE at ${FROM:0:12} already: it cannot tell the two builds apart (--marker)"
  fi
  git -C "$LIVE" grep -q -F -e "$MARKER" "$TARGET" -- "$MARKER_SOURCE" || die "'$MARKER' is not in $MARKER_SOURCE at ${TARGET:0:12} (--marker)"
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
    if [[ ! -f $CHECK_WITH/packages/cli/lib/bin.js ]] || ! grep -q -F -e "$MARKER" "$CHECK_WITH/$MARKER_FILE"; then
      die "--check-with $CHECK_WITH is not built (pnpm install --frozen-lockfile && pnpm build there)"
    fi
    log "system check: the profile$([[ -n $PATCH_CANDIDATE ]] && echo ', with the patch candidate,') against the target's code ($CHECK_WITH)"
    check_profile_with "$CHECK_WITH" "${PATCH_CANDIDATE:-$LIVE_PATCH}" || die "the profile does not pass the target's checks: fix the patch, then check again"
  elif ((APPLY)); then
    die "--apply needs --check-with <a built checkout of the target>: the profile is checked against the new code before anything stops"
  else
    log "note: no --check-with: the profile was not checked against the target's code (--apply requires it)"
  fi

  daemon_running || running=$?
  case $running in
    0) log "the daemon runs: pid $DAEMON_PID${WRAPPER_PID:+ (system start: $WRAPPER_PID)}" ;;
    2) die "a process that is not $LIVE's daemon holds $DISCOVERY" ;;
    *) log "the daemon is not running" ;;
  esac
  if ((problems)); then die "$problems problem(s) above"; fi
}

dry_run() {
  local runs='every run'
  if [[ -n $DAEMON_PID ]]; then
    read_start || die "how the running daemon was started cannot be read"
    log "the daemon was started as: cd $START_CWD && $START_NODE packages/cli/lib/bin.js start${START_ARGS:+ $START_ARGS} >> $START_LOG"
    if [[ $HEAD_AT == from ]]; then
      if [[ -z $SCRATCH ]]; then SCRATCH=$(mktemp -d); fi
      capture "$SCRATCH/before.json" || die "the running profile is down, or cannot be captured (above)"
      runs="$(node24 -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runs.length)' "$SCRATCH/before.json") run(s)"
    fi
    log "system health now:"
    cli "$LIVE" health >&2 || true
  elif [[ $HEAD_AT == from ]]; then
    log "note: --apply refuses until the daemon runs: what it answers is captured first"
  fi
  cat >&2 <<EOF

Plan for --apply (this dry run changed nothing):
  1. capture: health, and the explain and result of $runs -> $BACKUPS/<date>-before-base/before.json
  2. system shutdown --deadline $DEADLINE; wait for the daemon and system start to exit (never killed)
  3. system backup <that directory>/store (store and vault, verified by a restore preview);
     $PROFILE_DIR -> <that directory>/profiles
  4. git -C $LIVE checkout --detach $TARGET
     pnpm install --frozen-lockfile && pnpm build (Node 24 first on PATH; pnpm from $PNPM_DIR)
     $MARKER_FILE must hold '$MARKER'; every package of the bundle built
  5. $(if profile_linked; then echo 'the profile links its bundle from the live checkout already;'; else echo "system init: the profile links its bundle from $LIVE;"; fi)
     $(if [[ -n $PATCH_CANDIDATE ]]; then echo "the patch candidate replaces $LIVE_PATCH;"; else echo 'the live patch stays;'; fi) system check must say ok
  6. start as it was started; /healthz within 3 minutes
  7. checks: no health check worse (new Workers '$NEW_WORKERS' may be unavailable), every old run
     explains and answers as before, migrations forward, every record valid, system plugins, mcp-headers
  A failure after step 2 rolls back: the updated daemon stopped, the profile's files put back,
  ${FROM:0:12} checked out, installed, and built, system restore <that directory>/store --yes when the
  updated code started, the daemon started, system health. Exit 1; 2 if the rollback fails too.
EOF
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
if [[ -z $ATTEMPT ]] && ! find_attempt; then
  if [[ $HEAD_AT == target ]]; then
    [[ -n $DAEMON_PID ]] || die "$LIVE is at the target, the daemon is not running, and no unfinished update is recorded: look before going on"
    if (($(started_at "$DAEMON_PID") < $(stat -c %Y "$LIVE/$MARKER_FILE"))); then
      die "the daemon was started before $LIVE was built: it may run the previous code; restart it, or update by hand"
    fi
    log "the live install already runs ${TARGET:0:12}: nothing to update"
    cli "$LIVE" health >&2 || true
    exit 0
  fi
  [[ -n $DAEMON_PID ]] || die "the daemon is not running: start it (system start), so what it answers can be captured, then run this again"
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
  [[ -n $DAEMON_PID ]] || die "the daemon is not running: start it (system start), so what it answers can be captured, then run this again"
  read_start || die "how the running daemon was started cannot be read"
  state_set start_cwd "$START_CWD"
  state_set start_node "$START_NODE"
  state_set start_args "$START_ARGS"
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

STOPPED=1
if ! reached stopped; then
  stop_daemon "$LIVE" || fail "the daemon did not stop"
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
  marker_built || fail "the built $MARKER_FILE does not hold '$MARKER': not the target's code"
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
  log "system check: the profile as it will start, against the built code"
  cli "$LIVE" check 2>&1 | tee -a "$LOG_FILE" >&2 || fail "system check refused the profile"
  set_phase checked
fi

if ! reached started; then
  running=0
  daemon_running || running=$?
  if ((running == 2)); then fail "a process that is not $LIVE's daemon holds $DISCOVERY"; fi
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

set_phase done
log "updated: $LIVE runs ${TARGET:0:12} (pid $DAEMON_PID); backup and notes in $ATTEMPT"
