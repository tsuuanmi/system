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
  /**
   * The profile serves the hold between steps (T257, `hold_steps`): once held, each read of the
   * roster finds these steps in turn instead (the last one stays), until released. Without it, the
   * profile is one from before the hold: `hold_steps` is no tool of it.
   */
  holds: (...reads: FakeWork[][]) => void
  /** Whether steps are held now. */
  held: () => boolean
  /** Hold steps, then answer `hold_steps` only `ms` later (a request interrupted after the hold is set). */
  holdDelay: (ms: number) => void
  /** Dispatch as `dispatch_status` answers it. */
  dispatch: (status: { enabled: boolean; paused?: { since: string; reason?: string } }) => void
  /** The profile's CLI stops no daemon itself (code from before `shutdownHost`). */
  noShutdown: () => void
  /** The tools called, in order, and each `shutdown <seconds> <home>` of the CLI's shutdownHost. */
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
  fs.appendFileSync(path.join(dir, 'calls'), name + (name === 'hold_steps' && args.release ? ' release' : '') + '\\n')
  if (name === 'status') return ok({ health: { state: 'ok', checks: [] } })
  if (name === 'hold_steps' && !fs.existsSync(path.join(dir, 'holds.json'))) return { isError: true, text: 'MCP error -32602: Tool hold_steps not found', structured: undefined }
  if (name === 'hold_steps') {
    if (args.release) fs.rmSync(path.join(dir, 'held'), { force: true })
    else if (!fs.existsSync(path.join(dir, 'held'))) fs.writeFileSync(path.join(dir, 'held'), String(args.reason))
    // Set, and its answer still on the way: an interruption now leaves the outcome unknown to the caller.
    if (!args.release && fs.existsSync(path.join(dir, 'hold-delay.json'))) await new Promise((resolve) => setTimeout(resolve, read('hold-delay.json')))
    return ok({ ...(fs.existsSync(path.join(dir, 'held')) ? { held: { since: new Date().toISOString(), reason: fs.readFileSync(path.join(dir, 'held'), 'utf8') } } : {}), inFlight: [] })
  }
  if (name === 'roster') {
    // Held, the runs start no next step: the reads go on from the held sequence, when one is given.
    const held = fs.existsSync(path.join(dir, 'held')) && fs.existsSync(path.join(dir, 'holds.json'))
    const reads = read(held ? 'holds.json' : 'work.json')
    const counter = path.join(dir, held ? 'held-reads' : 'reads')
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
    fs.writeFileSync(counter, String(n + 1))
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
// The CLI's shutdownHost (\`system shutdown --deadline\`): its drain finds the steps of the last read
// still running at the deadline, then the daemon is sent SIGTERM and has exited. Absent when the
// profile's CLI is one from before it (no-shutdown).
if (!fs.existsSync(path.join(dir, 'no-shutdown'))) exports.shutdownHost = async (deadlineMs, options) => {
  fs.appendFileSync(path.join(dir, 'calls'), 'shutdown ' + (deadlineMs / 1000) + (options.home ? ' ' + options.home : '') + '\\n')
  const { pid } = JSON.parse(fs.readFileSync(path.join(options.home, 'system', 'mcp.json'), 'utf8'))
  const db = new DatabaseSync(${JSON.stringify(db)})
  let active
  try {
    active = [...new Set(db.prepare("SELECT run_id FROM workflow_runs WHERE status = 'running'").all().map((r) => r.run_id))]
  } finally {
    db.close()
  }
  if (active.length) options.onActive?.(active)
  process.kill(pid, 'SIGTERM')
  for (const until = Date.now() + 10000; Date.now() < until;) {
    try {
      process.kill(pid, 0)
    } catch {
      return { drained: !active.length, active, pid }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('process ' + pid + ' did not exit')
}
`

/**
 * A fake `system` for the live update's wait (T234): the CLI module the update's checks import
 * (`packages/cli/lib/index.js` of the live checkout), whose `callTool` answers `status`, `roster`
 * (each read the next steps given, those on a Worker; every one of them is written to the store
 * too, which the wait reads next), dispatch's status, pause, and resume, and, when given `holds`,
 * the hold between steps (`hold_steps`, set and released); and whose `shutdownHost` stops the
 * daemon (T269), unless `noShutdown`; with a store the capture can read (no run until the first
 * roster read, no migration).
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
  const holds = (...reads: FakeWork[][]): void => writeFileSync(join(dir, 'holds.json'), JSON.stringify(reads))
  work([])
  dispatch({ enabled: true })
  return {
    work, holds, held: () => existsSync(join(dir, 'held')), holdDelay: (ms) => writeFileSync(join(dir, 'hold-delay.json'), JSON.stringify(ms)), dispatch,
    noShutdown: () => writeFileSync(join(dir, 'no-shutdown'), ''),
    calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []),
  }
}

/** A daemon environment file, owner-only, naming `home`. */
export function daemonEnv(root: string, home: string): string {
  const path = join(root, 'daemon.env')
  writeFileSync(path, `PATH=/usr/local/bin:/usr/bin:/bin\nDSH_HOME=${realpathSync(home)}\n`)
  chmodSync(path, 0o600)
  return path
}
