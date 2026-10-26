// For the live update's tests: a stand-in `systemctl --user` for system.service, and a fake daemon
// it can run (a `system start` wrapper and a `dsh` child that answers /healthz), so a stop and a
// start through the unit run with no real profile, systemd, or build.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  // As the unit runs it: in its WorkingDirectory, its output appended to a file (StandardOutput=append:).
  writeFileSync(join(dir, 'start'), `cd '${realpathSync(live)}' && nohup '${process.execPath}' '${wrapper}' start '${dsh}' '${dir}' '${discovery}' >>'${join(root, 'daemon.log')}' 2>&1 &\n`)

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

/** A running step: in the store, and in the roster's `work` when it runs on a Worker. */
export interface FakeWork { runId: string; nodeId: string; worker?: string; since: string; taskId?: string; template?: string }

export interface FakeSystem {
  /** The steps each read of the roster finds, in turn; the last one stays. */
  work: (...reads: FakeWork[][]) => void
  /** Dispatch as `dispatch_status` answers it. */
  dispatch: (status: { enabled: boolean; paused?: { since: string; reason?: string } }) => void
  /** The tools called, in order. */
  calls: () => string[]
}

const FAKE_SYSTEM = (dir: string, db: string): string => `const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const dir = ${JSON.stringify(dir)}
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
const ok = (structured) => ({ isError: false, text: '', structured })
// The engine's store holds what runs as its roster does: each roster read writes its steps there.
const store = (items) => {
  const db = new DatabaseSync(${JSON.stringify(db)})
  try {
    db.exec('DELETE FROM workflow_runs; DELETE FROM workflow_nodes; DELETE FROM workflow_tasks; DELETE FROM events')
    for (const i of items) {
      db.prepare("INSERT OR IGNORE INTO workflow_runs (run_id, template, status, created_at) VALUES (?, ?, 'running', ?)").run(i.runId, i.template ?? 'algorithm-development', i.since)
      db.prepare("INSERT INTO workflow_nodes (run_id, node_id, state, worker) VALUES (?, ?, 'RUNNING', ?)").run(i.runId, i.nodeId, i.worker ?? null)
      if (i.taskId) db.prepare('INSERT INTO workflow_tasks (run_id, task_id) VALUES (?, ?)').run(i.runId, i.taskId)
      db.prepare("INSERT INTO events (at, type, run_id, node_id) VALUES (?, 'workflow.node.started', ?, ?)").run(i.since, i.runId, i.nodeId)
    }
  } finally {
    db.close()
  }
}
exports.callTool = async (name, args) => {
  fs.appendFileSync(path.join(dir, 'calls'), name + '\\n')
  if (name === 'status') return ok({ health: { state: 'ok', checks: [] } })
  if (name === 'roster') {
    const reads = read('work.json')
    const n = fs.existsSync(path.join(dir, 'reads')) ? Number(fs.readFileSync(path.join(dir, 'reads'), 'utf8')) : 0
    fs.writeFileSync(path.join(dir, 'reads'), String(n + 1))
    const all = reads[Math.min(n, reads.length - 1)]
    store(all)
    const items = all.filter((i) => i.worker)
    const workers = [...new Set(['agent:codex-main/develop', ...items.map((i) => i.worker)])].map((worker) => {
      const mine = items.filter((i) => i.worker === worker).map((i) => ({ runId: i.runId, template: i.template ?? 'algorithm-development', nodeId: i.nodeId, attempt: 1,
        ...(i.taskId ? { task: { taskId: i.taskId } } : {}), since: { value: i.since } }))
      return { worker, availability: mine.length ? { state: 'busy', summary: 'busy 1 of 1' } : { state: 'ready', summary: 'ready' }, work: { value: { items: mine, more: 0 } } }
    })
    return ok({ asOf: new Date().toISOString(), workers: { value: workers }, unlisted: 0 })
  }
  if (name === 'dispatch_status') return ok(read('dispatch.json'))
  if (name === 'dispatch_pause') {
    fs.writeFileSync(path.join(dir, 'dispatch.json'), JSON.stringify({ ...read('dispatch.json'), paused: { since: new Date().toISOString(), reason: args.reason } }))
    return ok(read('dispatch.json'))
  }
  if (name === 'dispatch_resume') {
    const { paused, ...rest } = read('dispatch.json')
    fs.writeFileSync(path.join(dir, 'dispatch.json'), JSON.stringify(rest))
    return ok(rest)
  }
  return { isError: true, text: 'fake system: no tool ' + name, structured: undefined }
}
`

/**
 * A fake `system` for the live update's wait (T234): the CLI module the update's checks import
 * (`packages/cli/lib/index.js` of the live checkout), whose `callTool` answers `status`, `roster`
 * (each read the next steps given, those on a Worker; every one of them is written to the store
 * too, which the wait reads next), and dispatch's status, pause, and resume; with a store the
 * capture can read (no run until the first roster read, no migration).
 */
export function fakeSystem(root: string, live: string, home: string): FakeSystem {
  const dir = join(root, 'fake-system')
  mkdirSync(dir, { recursive: true })
  const lib = join(live, 'packages', 'cli', 'lib')
  mkdirSync(lib, { recursive: true })
  const path = join(home, 'system', 'system.db')
  writeFileSync(join(lib, 'index.js'), FAKE_SYSTEM(dir, path))
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (run_id TEXT PRIMARY KEY, template TEXT, status TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS workflow_nodes (run_id TEXT, node_id TEXT, state TEXT, worker TEXT);
    CREATE TABLE IF NOT EXISTS workflow_tasks (run_id TEXT, task_id TEXT);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, type TEXT, run_id TEXT, node_id TEXT);
    CREATE TABLE IF NOT EXISTS system_migrations (owner TEXT, version INTEGER)`)
  db.close()
  const work = (...reads: FakeWork[][]): void => writeFileSync(join(dir, 'work.json'), JSON.stringify(reads))
  const dispatch = (status: { enabled: boolean; paused?: { since: string; reason?: string } }): void => writeFileSync(join(dir, 'dispatch.json'), JSON.stringify(status))
  work([])
  dispatch({ enabled: true })
  return { work, dispatch, calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []) }
}

/** A daemon environment file, owner-only, naming `home`. */
export function daemonEnv(root: string, home: string): string {
  const path = join(root, 'daemon.env')
  writeFileSync(path, `PATH=/usr/local/bin:/usr/bin:/bin\nDSH_HOME=${realpathSync(home)}\n`)
  chmodSync(path, 0o600)
  return path
}
