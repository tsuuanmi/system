#!/usr/bin/env bash
# The stage of a live update (T323): the target's code on the `system-test` profile, checked by a
# canary, before the live profile is touched. scripts/live-update.sh --stage runs it, and updates
# `system` only when it exits 0.
#
# What it does, with the CLI of a built checkout of the target (--check-with), on the same DSH home:
#   1. `system init --profile system-test`: the profile beside `system`, composing the live profile's
#      bundles (its manifest copied: its preset and every bundle added), with its own data directory
#      (<home>/system-test) and port; its patch is then written from the patch to ship (--patch, or the
#      live one): every entry of it but what signs in to an account (inserted rows included), then
#      its own (scripts/canary.ts patch); an entry it cannot reproduce stops the stage;
#   2. `system check --profile system-test`, with the unit's environment file;
#   3. `system start --profile system-test` in the background, and wait for its health;
#   4. the canary (scripts/canary.ts run): health, a board task on a canary project through
#      algorithm-development (its attempt, its dossier's evidence, its result on the board), an ask,
#      and a research run, on the fake Workers; then the removability smoke (T317, `pnpm test:removability`)
#      in that checkout, under --removability: `warn` (the default while the matrix is not yet green) logs
#      a failure and goes on, `on` stops the stage on it;
#   5. `system shutdown --profile system-test`; the daemon is never killed.
# It never reads or writes the live profile's data directory, profile, port, or unit. Exit 0: the
# canary passed; 1: a step failed (named); 2: usage.
set -Eeuo pipefail
umask 077

usage() {
  echo 'usage: scripts/live-stage.sh --check-with <built checkout of the target> --dsh-home <dir> --node-dir <dir> --pnpm-dir <dir> --env-file <file> [--patch <candidate cordis.patch.yml>] [--wait <seconds>] [--removability warn|on]' >&2
  exit 2
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK_WITH='' HOME_DIR='' NODE_DIR='' PNPM_DIR='' ENV_FILE='' PATCH='' WAIT=180 REMOVABILITY=warn
while (($#)); do
  case $1 in
    --check-with | --dsh-home | --node-dir | --pnpm-dir | --env-file | --patch | --wait | --removability)
      if (($# < 2)); then usage; fi
      case $1 in
        --check-with) CHECK_WITH=$2 ;;
        --dsh-home) HOME_DIR=$2 ;;
        --node-dir) NODE_DIR=$2 ;;
        --pnpm-dir) PNPM_DIR=$2 ;;
        --env-file) ENV_FILE=$2 ;;
        --patch) PATCH=$2 ;;
        --removability)
          if [[ $2 != warn && $2 != on ]]; then usage; fi
          REMOVABILITY=$2 ;;
        --wait)
          if [[ ! $2 =~ ^[0-9]+$ ]]; then usage; fi
          WAIT=$2 ;;
      esac
      shift ;;
    *) usage ;;
  esac
  shift
done
if [[ -z $CHECK_WITH || -z $HOME_DIR || -z $NODE_DIR || -z $PNPM_DIR || -z $ENV_FILE ]]; then usage; fi

PROFILE=system-test
STATE=$HOME_DIR/$PROFILE
PROFILE_DIR=$HOME_DIR/profiles/$PROFILE
RUN_PATH=$NODE_DIR:$PATH
BUILD_PATH=$RUN_PATH:$PNPM_DIR
LIB=$CHECK_WITH/packages/cli/lib
DAEMON=''

log() { printf '%s  stage: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
fail() { trap - ERR; log "FAILED: $*"; exit 1; }
trap 'fail "unexpected error (exit $?) at line $LINENO"' ERR

# The target's CLI, acting on the test profile only.
cli() { PATH=$BUILD_PATH DSH_HOME=$HOME_DIR "$NODE_DIR/node" "$LIB/bin.js" "$@" --profile "$PROFILE"; }
canary() { PATH=$RUN_PATH "$NODE_DIR/node" --disable-warning=ExperimentalWarning "$SCRIPT_DIR/canary.ts" "$@"; }

stop_daemon() {
  local pid=$DAEMON until
  DAEMON=''
  [[ -n $pid ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    cli shutdown --deadline 30 >&2 || true
    until=$((SECONDS + 60))
    while kill -0 "$pid" 2>/dev/null && ((SECONDS < until)); do sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then log "the test daemon ($pid) has not exited (it is never killed)"; fi
  fi
}
trap stop_daemon EXIT

[[ -f $LIB/bin.js && -f $LIB/index.js ]] || fail "$CHECK_WITH is not built (no $LIB/bin.js)"
[[ -f $ENV_FILE ]] || fail "no environment file $ENV_FILE"
LIVE_PATCH=${PATCH:-$HOME_DIR/profiles/system/cordis.patch.yml}
[[ -f $LIVE_PATCH ]] || fail "no patch to stage at $LIVE_PATCH"

log "system init --profile $PROFILE (data in $STATE)"
cli init >&2 || fail "system init --profile $PROFILE failed"
canary patch "$LIB/index.js" "$HOME_DIR" "$LIVE_PATCH" "$PROFILE_DIR/cordis.patch.yml" || fail "the test profile's patch could not be made from $LIVE_PATCH"

log "system check --profile $PROFILE"
cli check --env-file "$ENV_FILE" >&2 || fail "system check refused the test profile"

log "system start --profile $PROFILE"
(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  exec "$NODE_DIR/node" "$LIB/bin.js" start --profile "$PROFILE"
) >"$HOME_DIR/$PROFILE.log" 2>&1 &
DAEMON=$!
until=$((SECONDS + WAIT))
while :; do
  kill -0 "$DAEMON" 2>/dev/null || { tail -n 40 "$HOME_DIR/$PROFILE.log" >&2; fail "the test daemon exited at start (log: $HOME_DIR/$PROFILE.log)"; }
  code=0
  cli health >/dev/null 2>&1 || code=$?
  if ((code < 2)); then break; fi
  if ((SECONDS >= until)); then tail -n 40 "$HOME_DIR/$PROFILE.log" >&2; fail "the test daemon did not answer within $WAIT s"; fi
  sleep 3
done

log "the canary"
canary run "$LIB/index.js" "$HOME_DIR" >&2 || fail "the canary failed on the test profile"

log "the removability smoke (T317, $REMOVABILITY)"
removable=passed
if ! (cd "$CHECK_WITH" && PATH=$BUILD_PATH pnpm test:removability) >&2; then
  [[ $REMOVABILITY == on ]] && fail "the removability smoke failed"
  log "WARN: the removability smoke failed (above); --removability warn goes on"
  removable="failed (warn)"
fi

stop_daemon
log "the stage passed: the test profile took ${CHECK_WITH}'s code, and the canary passed; the removability smoke $removable"
