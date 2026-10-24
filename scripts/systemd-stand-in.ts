// For the live update's tests: a stand-in `systemctl --user` for system.service, and a fake daemon
// it can run (a `system start` wrapper and a `dsh` child that answers /healthz), so a stop and a
// start through the unit run with no real profile, systemd, or build.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface StandInUnit {
  /** The stand-in's state: one file per `show` property, `state` for is-active, `calls` for the actions. */
  dir: string
  set: (property: string, value: string) => void
  /** The actions asked of it (start, stop, reset-failed), in order. */
  calls: () => string[]
  /** Stop the fake daemon if it runs (a test's cleanup; never by a pattern). */
  cleanup: () => void
}

const WRAPPER = `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const [, , , dsh, unit, discovery] = process.argv
const child = spawn(process.execPath, [dsh, '--profile', 'system', discovery], { stdio: 'inherit' })
writeFileSync(unit + '/MainPID', String(process.pid))
writeFileSync(unit + '/state', 'active')
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', () => {
  writeFileSync(unit + '/MainPID', '0')
  writeFileSync(unit + '/state', 'inactive')
  process.exit(0)
})
`

const DSH = `const { createServer } = require('node:http')
const { rmSync, writeFileSync } = require('node:fs')
const discovery = process.argv[4]
const server = createServer((req, res) => res.end(req.url === '/healthz' ? 'ok' : ''))
server.listen(0, '127.0.0.1', () => {
  writeFileSync(discovery, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:' + server.address().port + '/' }))
})
process.on('SIGTERM', () => {
  rmSync(discovery, { force: true })
  process.exit(0)
})
`

/**
 * `systemctl` in `bin`, for a unit that runs `live` with `envFile`. Its start runs the fake daemon:
 * the wrapper under the root, its `dsh` child inside the live checkout's node_modules, as a real
 * install's is; the discovery file in `home`.
 */
export function standInUnit(root: string, bin: string, live: string, home: string, envFile: string): StandInUnit {
  const dir = join(root, 'systemd')
  mkdirSync(dir, { recursive: true })
  const set = (property: string, value: string): void => writeFileSync(join(dir, property), `${value}\n`)
  set('LoadState', 'loaded')
  set('WorkingDirectory', realpathSync(live))
  set('EnvironmentFiles', `${envFile} (ignore_errors=no)`)
  set('MainPID', '0')
  set('state', 'inactive')

  const wrapper = join(root, 'fake', 'packages', 'cli', 'lib', 'bin.js')
  mkdirSync(join(wrapper, '..'), { recursive: true })
  writeFileSync(wrapper, WRAPPER)
  const dsh = join(realpathSync(live), 'node_modules', '.pnpm', 'fake', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(dsh, '..'), { recursive: true })
  writeFileSync(dsh, DSH)
  const discovery = join(home, 'system', 'mcp.json')
  writeFileSync(join(dir, 'start'), `nohup '${process.execPath}' '${wrapper}' start '${dsh}' '${dir}' '${discovery}' >/dev/null 2>&1 &\n`)

  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
d='${dir}'
[ "$1" = --user ] && shift
case "$1" in
  show) cat "$d/$3" 2>/dev/null ;;
  is-active) s=$(cat "$d/state"); echo "$s"; [ "$s" = active ] ;;
  start) echo "start $2" >>"$d/calls"; sh "$d/start" ;;
  stop)
    echo "stop $2" >>"$d/calls"
    pid=$(cat "$d/MainPID")
    if [ "$pid" != 0 ]; then
      kill "$pid"
      while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    fi
    echo inactive >"$d/state" ;;
  reset-failed) echo "reset-failed $2" >>"$d/calls" ;;
  *) echo "systemctl stand-in: $*" >&2; exit 1 ;;
esac
`)
  chmodSync(join(bin, 'systemctl'), 0o755)

  return {
    dir,
    set,
    calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []),
    cleanup: () => {
      const pid = Number(readFileSync(join(dir, 'MainPID'), 'utf8'))
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Gone already.
        }
      }
    },
  }
}

/** A daemon environment file, owner-only, naming `home`. */
export function daemonEnv(root: string, home: string): string {
  const path = join(root, 'daemon.env')
  writeFileSync(path, `PATH=/usr/local/bin:/usr/bin:/bin\nDSH_HOME=${realpathSync(home)}\n`)
  chmodSync(path, 0o600)
  return path
}
