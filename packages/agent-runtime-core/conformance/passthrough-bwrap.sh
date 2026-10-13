#!/bin/sh
# A test double for bubblewrap: drops the confinement options up to `--` and execs the
# command, so a runtime's tests drive its scripted agent through the confined command line.
# Tests of the confinement itself use the real bwrap (agent-runtime-core/tests).
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
