/**
 * M5 gate on the real profile: the Software Engineering Workflow publishes the
 * exact checked commit as one draft pull request (or, with `merge: true` onto
 * an allowlisted base, merges it), and a host killed on either side of the
 * remote effect is reconciled without a duplicate. Remote: a real
 * bare git repository (file://) and a fake GitHub API in its own process.
 * Workers run on the fake CLI, in a Host that the tests kill and start again.
 * Approval needs a human at a real terminal.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-publish')
const { home, env } = cli
/** The process ID of the running Host, for a fake remote or a hook to kill. */
const hostPid = join(home, 'host.pid')
const SE_MERGE = join(repo, 'workflows', 'software-engineering.yaml')
/** The Software Engineering Workflow publishing a draft pull request: its `merge: true` removed. */
const SE = join(home, 'software-engineering-draft.yaml')
const servers: ChildProcess[] = []


const system = (args: string[]) => cli.run(args)

/** Start the Host again, for a profile written since it started; its process ID is where the killers look. */
async function restart() {
  await cli.start()
  writeFileSync(hostPid, String(await cli.pid()))
}

async function github(...args: string[]): Promise<{ url: string; state: () => Promise<{ pulls: { number: number; head: string; draft: boolean; merged?: boolean; mergeCommit?: string }[]; calls: string[] }> }> {
  const server = spawn(process.execPath, [join(repo, 'tests', 'fake-github.mjs'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  servers.push(server)
  const port = await new Promise<string>((r) => server.stdout!.once('data', (d) => r(String(d).trim())))
  const url = `http://127.0.0.1:${port}`
  return { url, state: async () => (await fetch(`${url}/_state`)).json() as never }
}

function profile(apiUrl: string, mergeInto = '[]') {
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        capabilities: [code-write]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
- id: effects
  config:
    remote: origin
    base: main
    mergeInto: ${mergeInto}
    apiUrl: ${apiUrl}
    repository: tester/scratch
    tokenRef: GITHUB_TOKEN
`)
}

/** A repository with required checks, its bare `origin`, and a task on it. */
function project() {
  const bare = mkdtempSync(join(home, 'remote-'))
  execFileSync('git', ['init', '--bare', '--quiet', bare])
  const work = mkdtempSync(join(home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', work, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' }).trim()
  git('init', '--quiet', '-b', 'main')
  mkdirSync(join(work, '.system'))
  writeFileSync(join(work, '.system', 'checks.yaml'), 'checks:\n  - name: note-exists\n    run: test -f NOTE.md\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  git('remote', 'add', 'origin', `file://${bare}`)
  git('push', '--quiet', 'origin', 'main')
  const task = system(['task', 'new', '--text', 'FAKE:edit', '--repo', work]).stdout.trim().split('\n').at(-1)!
  return { bare, work, task, branchOf: (workId: string) => execFileSync('git', ['-C', bare, 'rev-parse', `refs/heads/system/${workId.replace('work:', '')}`], { encoding: 'utf8' }).trim() }
}

type Event = { type: string; state?: string; reason?: string; detail?: Record<string, string>; subject?: string }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as { events: Event[]; state: { status: string; reason?: string; steps: Record<string, { outputs: Record<string, string> }> } }
/** What the Host's start leaves of a Work it was killed in: the effect was intended, and its outcome has been read from the remote, but nothing runs on until `work run`. */
function assertRecovered(workId: string) {
  const record = show(workId)
  assert.ok(record.events.some((e) => e.type === 'effect-intended'))
  assert.equal(record.state.status, 'running')
  assert.notEqual(record.events.at(-1)?.type, 'terminal')
}
const commitOf = (artifactId: string) => (JSON.parse(system(['artifact', 'show', artifactId]).stdout) as { envelope: { content: { commit: string } } }).envelope.content.commit

before(async () => {
  assert.equal(system(['init']).status, 0)
  await restart()
  const merging = readFileSync(SE_MERGE, 'utf8')
  assert.ok(merging.includes('      params: { merge: true }\n'))
  writeFileSync(SE, merging.replace('      params: { merge: true }\n', ''))
  copyFileSync(join(repo, 'workflows', 'code-checks.yaml'), join(home, 'code-checks.yaml'))
  for (const [name, value] of [['CLAUDE_CODE_OAUTH_TOKEN', 'fake'], ['GITHUB_TOKEN', 'ghs_test']]) {
    assert.equal(cli.run(['credentials', 'set', name!], { input: `${value}\n` }).status, 0)
  }
})

after(async () => {
  await cli.stop()
  for (const s of servers) s.kill()
  rmSync(home, { recursive: true, force: true })
})

test('the exact checked commit is pushed to system/<work> and one draft pull request opened; running again changes nothing', async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const ran = system(['work', 'submit', '--workflow', SE, '--input', p.task])
  assert.equal(ran.status, 0, ran.stderr)
  const workId = ran.stdout.trim()
  const record = show(workId)
  const verified = record.events.find((e) => e.type === 'verified')!
  const published = record.events.find((e) => e.type === 'effect-observed')!
  assert.equal(published.state, 'applied')
  assert.equal(p.branchOf(workId), commitOf(verified.subject!))
  assert.deepEqual((await gh.state()).pulls.map((pr) => [pr.head, pr.draft]), [[`system/${workId.replace('work:', '')}`, true]])
  assert.equal(published.detail!.pullRequest, '1')
  const events = record.events.length
  assert.equal(system(['work', 'run', workId]).status, 0)
  assert.equal(show(workId).events.length, events)
  assert.equal((await gh.state()).pulls.length, 1)
  assert.ok((await gh.state()).calls.every((c) => !/merge/i.test(c)))
})

const mainOf = (bare: string) => execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()

test('a Work with merge: true moves main to exactly the checked commit through the merge queue; running again changes nothing', async () => {
  const p = project()
  const gh = await github('--bare', p.bare)
  profile(gh.url, '[main]')
  await restart()
  const ran = system(['work', 'submit', '--workflow', SE_MERGE, '--input', p.task])
  assert.equal(ran.status, 0, ran.stderr)
  const workId = ran.stdout.trim()
  const record = show(workId)
  const commit = commitOf(record.events.find((e) => e.type === 'verified')!.subject!)
  const published = record.events.find((e) => e.type === 'effect-observed')!
  assert.equal(published.state, 'applied')
  assert.equal(p.branchOf(workId), commit)
  assert.equal(mainOf(p.bare), commit, 'main is the checked commit: it already held the tip, so nothing new to check')
  assert.deepEqual([published.detail!.merged, published.detail!.mergeCommit], ['true', commit])
  const { pulls, calls } = await gh.state()
  assert.deepEqual(pulls.map((pr) => [pr.head, pr.draft]), [[`system/${workId.replace('work:', '')}`, false]])
  assert.equal(calls.filter((c) => c.startsWith('PUT ')).length, 0, 'GitHub\'s merge endpoint is not used')
  const events = record.events.length
  assert.equal(system(['work', 'run', workId]).status, 0)
  assert.equal(show(workId).events.length, events)
  assert.equal(mainOf(p.bare), commit)
})

test('a profile whose base is not in mergeInto refuses a Workflow that merges, at admission', async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const refused = system(['work', 'submit', '--workflow', SE_MERGE, '--input', p.task])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stdout + refused.stderr, /base main is not in mergeInto \[\]/)
  assert.equal((await gh.state()).pulls.length, 0)
})

test('a host killed once main moved but before it heard back is reconciled as applied: nothing merged twice', async () => {
  const p = project()
  // The remote kills the Host as soon as main moves, before the push returns.
  writeFileSync(join(p.bare, 'hooks', 'post-receive'), `#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && kill -9 "$(cat ${hostPid})"; done\nexit 0\n`, { mode: 0o755 })
  const gh = await github('--bare', p.bare)
  profile(gh.url, '[main]')
  await restart()
  const crashed = system(['work', 'submit', '--workflow', SE_MERGE, '--input', p.task])
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  rmSync(join(p.bare, 'hooks', 'post-receive'))
  const moved = mainOf(p.bare)
  await restart()
  assertRecovered(workId)
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  const observed = show(workId).events.filter((e) => e.type === 'effect-observed')
  assert.deepEqual(observed.map((e) => e.state), ['applied'])
  assert.match(observed[0]!.reason!, /main holds/)
  assert.equal(mainOf(p.bare), moved, 'main did not move again')
  assert.equal(moved, commitOf(show(workId).state.steps.implement!.outputs.change!))
})

test('a host killed after the pull request was created but before it heard back is reconciled: no second pull request', async () => {
  const gh = await github('--kill-host-on-create', hostPid)
  profile(gh.url)
  await restart()
  const p = project()
  const crashed = system(['work', 'submit', '--workflow', SE, '--input', p.task])
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  await restart()
  assertRecovered(workId)
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  const observed = show(workId).events.filter((e) => e.type === 'effect-observed')
  assert.deepEqual(observed.map((e) => e.state), ['applied'])
  assert.match(observed[0]!.reason!, /pull request #1 is open/)
  assert.equal((await gh.state()).pulls.length, 1)
})

test('a host killed during the push, before the remote took it, is reconciled as absent and published once', async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const marker = join(home, `killed-${Date.now()}`)
  const hook = join(p.bare, 'hooks', 'pre-receive')
  writeFileSync(hook, `#!/bin/sh\nif [ ! -f ${marker} ]; then touch ${marker}; kill -9 "$(cat ${hostPid})"; exit 1; fi\nexit 0\n`)
  chmodSync(hook, 0o755)
  const crashed = system(['work', 'submit', '--workflow', SE, '--input', p.task])
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  await restart()
  assertRecovered(workId)
  assert.equal((await gh.state()).pulls.length, 0)
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.deepEqual(show(workId).events.filter((e) => e.type === 'effect-observed').map((e) => e.state), ['absent', 'applied'])
  assert.equal((await gh.state()).pulls.length, 1)
  assert.equal(p.branchOf(workId), commitOf(show(workId).state.steps.implement!.outputs.change!))
})

const hasScript = spawnSync('script', ['--version']).status === 0

/** Run `system` on a real pseudo-terminal, typing `input`. */
function onTerminal(args: string[], input: string) {
  const command = [process.execPath, join(repo, 'bin', 'system'), ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  return spawnSync('script', ['-qec', command, '/dev/null'], { env: { ...env, SYSTEM_CALLER: '' }, input, encoding: 'utf8', timeout: 180_000 })
}

test('marking the pull request ready waits for a human at a terminal; an agent or a pipe cannot approve', { skip: !hasScript && 'needs script(1) for a pseudo-terminal' }, async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const ready = join(home, 'ready.yaml')
  writeFileSync(ready, readFileSync(SE, 'utf8').replace('      requires: [checks.checks]\n  - id: accept', '      requires: [checks.checks]\n      params:\n        ready: true\n  - id: accept'))
  const held = system(['work', 'submit', '--workflow', ready, '--input', p.task])
  assert.equal(held.status, 3, held.stderr)
  const workId = held.stdout.trim()
  assert.match(show(workId).state.reason!, /publish awaits operator approval: marking the pull request ready for review/)
  assert.equal((await gh.state()).pulls.length, 0)

  const piped = system(['approve', workId, '--reason', 'ok'])
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /needs a human at a terminal/)
  const wrong = onTerminal(['approve', workId, '--reason', 'ok'], 'not-the-id\n')
  assert.notEqual(wrong.status, 0)
  assert.match(wrong.stdout, /Nothing is decided unless you type exactly [0-9a-f]{8}/)
  assert.match(wrong.stdout, /system: the confirmation did not match; nothing was decided\r?\n/)
  assert.doesNotMatch(wrong.stdout, /\n\s+at /, 'a mistyped confirmation prints one line, not a stack')
  assert.equal(show(workId).state.status, 'held')

  const approved = onTerminal(['approve', workId, '--reason', 'reviewed'], `${workId.slice(5, 13)}\n`)
  assert.equal(approved.status, 0, approved.stdout)
  assert.equal(show(workId).state.status, 'succeeded')
  assert.deepEqual((await gh.state()).pulls.map((pr) => pr.draft), [false])
  const decided = show(workId).events.find((e) => e.type === 'decided') as Event & { caller: { type: string; operatorId: string } }
  assert.deepEqual([decided.caller.type, decided.caller.operatorId], ['human', 'tester'])
})

test('a human can deny instead; the Work fails and nothing is published', { skip: !hasScript && 'needs script(1) for a pseudo-terminal' }, async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const ready = join(home, 'ready-deny.yaml')
  writeFileSync(ready, readFileSync(SE, 'utf8').replace('      requires: [checks.checks]\n  - id: accept', '      requires: [checks.checks]\n      params:\n        ready: true\n  - id: accept'))
  const workId = system(['work', 'submit', '--workflow', ready, '--input', p.task]).stdout.trim()
  const denied = onTerminal(['deny', workId, '--reason', 'not now'], `${workId.slice(5, 13)}\n`)
  assert.equal(denied.status, 1, denied.stdout)
  assert.match(show(workId).state.reason!, /publish denied by tester: not now/)
  assert.equal((await gh.state()).pulls.length, 0)
})
