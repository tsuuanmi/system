/**
 * Brainstorm (PLAN.md B1, and the B2 recovery checks that need no model) on
 * the real profile: the bundle's own accounts, with only their CLI pointed at
 * the fake (packages/agents/tests/fake-agent.mjs). Two proposals from the
 * brief alone on different providers, then a synthesis of both exact
 * proposal Artifacts; no verifier.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli, type Running } from '../test-support/cli.ts'

const cli = systemCli('system-brainstorm')
const { home } = cli
const BRAINSTORM = join(repo, 'workflows', 'brainstorm.yaml')
const system = (args: string[], input?: string) => cli.run(args, { input })

type Account = { ref: string; runtime: string; capabilities: string[]; command?: string }
const yaml = createRequire(join(repo, 'packages', 'work', 'package.json'))('yaml') as { parse(text: string, options: { logLevel: 'error' }): unknown }
const bundle = yaml.parse(readFileSync(join(repo, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as { insert: { id: string; config?: { accounts?: Account[] } }[] }[]
const accounts = bundle[0]!.insert.find((row) => row.id === 'agents')!.config!.accounts!

type Event = { type: string; seq: number; at: string; stepId?: string; selected?: string; inputs?: Record<string, string>; status?: string; outputs?: Record<string, string> }
type WorkView = { events: Event[]; state: { status: string; reason?: string; specId: string; steps: Record<string, { state: string; outputs: Record<string, string> }> } }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as WorkView
/** Who produced an Artifact, in which Work: its recorded occurrences. */
const producers = (id: string) => (JSON.parse(system(['artifact', 'show', id]).stdout) as { occurrences: { producer: { ref: string }; workId?: string }[] }).occurrences.map((o) => [o.producer.ref, o.workId])
const text = (id: string) => system(['artifact', 'cat', id]).stdout
const dispatched = (record: WorkView) => record.events.filter((e) => e.type === 'dispatched')

function brief(markers: string) {
  const out = system(['task', 'new', '--text', `How should System schedule Work? ${markers}`])
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.trim().split('\n').at(-1)!
}

before(async () => {
  assert.equal(system(['init']).status, 0)
  // JSON is YAML: the bundle's accounts as they are, each running the fake CLI.
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents\n  config: ${JSON.stringify({ $patch: 'replace', accounts: accounts.map((a) => ({ ...a, command: fakeAgent })) })}\n`)
  mkdirSync(join(home, 'system', 'codex', 'default'), { recursive: true })
  writeFileSync(join(home, 'system', 'codex', 'default', 'auth.json'), '{}')
  // The Host reads its credentials when it starts: store the token, then start it again.
  await cli.start()
  assert.equal(system(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], 'fake-token\n').status, 0)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

/** Start a following `work submit` of the Brainstorm Workflow and wait for the Work ID it prints. */
async function submitting(input: string): Promise<{ workId: string; submit: Running }> {
  const submit = cli.runAsync(['work', 'submit', '--workflow', BRAINSTORM, '--input', input])
  let workId = ''
  for (let i = 0; i < 200 && !workId; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (submit.stdout().trim()) workId = submit.stdout().trim().split('\n')[0]!
  }
  assert.ok(workId, 'the submit printed its Work ID')
  return { workId, submit }
}

test('the bundle gives each Brainstorm role to one provider: the two proposals never share one', () => {
  const holders = (role: string) => accounts.filter((a) => a.capabilities.includes(role)).map((a) => a.runtime)
  assert.deepEqual(holders('brainstorm.idea-a'), ['claude-code'])
  assert.deepEqual(holders('brainstorm.idea-b'), ['codex'])
  assert.equal(holders('brainstorm.synthesis').length, 1)
})

test('a brief yields two independent proposals and a synthesis of exactly those two, by three attempts', () => {
  const input = brief('FAKE:outputs FAKE:sign')
  const ran = system(['work', 'submit', '--workflow', BRAINSTORM, '--input', input])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  assert.equal(record.state.status, 'succeeded')
  assert.deepEqual(dispatched(record).map((e) => [e.stepId, e.selected]), [
    ['idea-a', 'claude-code/default'], ['idea-b', 'codex/default'], ['synthesis', 'claude-code/default'],
  ])
  const a = record.state.steps['idea-a']!.outputs.proposal!
  const b = record.state.steps['idea-b']!.outputs.proposal!
  const summary = record.state.steps.synthesis!.outputs.summary!
  assert.notEqual(a, b)
  assert.deepEqual(dispatched(record).map((e) => e.inputs), [
    { brief: input }, { brief: input }, { brief: input, 'proposal-a': a, 'proposal-b': b },
  ])
  const workId = ran.stdout.trim()
  assert.deepEqual([a, b, summary].map(producers), [[['claude-code/default', workId]], [['codex/default', workId]], [['claude-code/default', workId]]])
  assert.equal(text(a), '# proposal by claude')
  assert.equal(text(b), '# proposal by codex')
  assert.equal(text(summary), `# summary by claude\n## proposal-a\n${text(a)}\n## proposal-b\n${text(b)}`)
  assert.ok(record.events.every((e) => e.type !== 'verified'), 'no verifier runs')
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('the two proposals overlap in time: both are dispatched before either is observed, and the synthesis waits for both', { timeout: 120_000 }, () => {
  const input = brief('FAKE:outputs FAKE:sign FAKE:delay=1500')
  const ran = system(['work', 'submit', '--workflow', BRAINSTORM, '--input', input])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  assert.equal(record.state.status, 'succeeded')
  const at = (type: string, stepId: string) => Date.parse(record.events.find((e) => e.type === type && e.stepId === stepId)!.at)
  const proposals = ['idea-a', 'idea-b']
  const lastDispatched = Math.max(...proposals.map((s) => at('dispatched', s)))
  const firstObserved = Math.min(...proposals.map((s) => at('observed', s)))
  assert.ok(lastDispatched < firstObserved, `the proposals ran one after the other: dispatched at ${proposals.map((s) => at('dispatched', s))}, observed at ${proposals.map((s) => at('observed', s))}`)
  assert.ok(at('dispatched', 'synthesis') >= Math.max(...proposals.map((s) => at('observed', s))), 'the synthesis started before both proposals were observed')
  assert.equal(system(['work', 'replay', ran.stdout.trim()]).status, 0)
})

test('without a Codex account the Work is refused before any Worker runs: no same-provider substitute', { timeout: 120_000 }, async () => {
  const noCodex = join(home, 'no-codex.yml')
  writeFileSync(noCodex, `- id: agents\n  config: ${JSON.stringify({ $patch: 'replace', accounts: accounts.filter((a) => a.runtime !== 'codex').map((a) => ({ ...a, command: fakeAgent })) })}\n`)
  const before = system(['work', 'list']).stdout.trim().split('\n').filter(Boolean).length
  const input = brief('FAKE:outputs')
  await cli.start({ args: ['--patch', noCodex] })
  const ran = system(['work', 'submit', '--workflow', BRAINSTORM, '--input', input])
  await cli.start()
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /step idea-b needs Worker capability brainstorm\.idea-b, which no enabled Worker provides/)
  assert.equal(ran.stdout.trim(), '')
  assert.equal(system(['work', 'list']).stdout.trim().split('\n').filter(Boolean).length, before, 'no Work was admitted')
})

test('a stop after the first proposal reuses it: the retry runs only the second proposal and the synthesis', { timeout: 120_000 }, async () => {
  const marker = join(home, `hang-${Date.now()}`)
  const input = brief(`FAKE:outputs FAKE:sign FAKE:hang=idea-b:${marker}`)
  const { workId, submit } = await submitting(input)
  for (let i = 0; i < 300 && !dispatched(show(workId)).some((e) => e.stepId === 'idea-b'); i++) await new Promise((r) => setTimeout(r, 100))
  for (let i = 0; i < 300 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100))
  assert.ok(existsSync(marker), 'idea-b started')
  const first = show(workId).state.steps['idea-a']!.outputs.proposal!
  assert.ok(first, 'idea-a finished before idea-b started')

  assert.equal(system(['work', 'cancel', workId, '--reason', 'stop after the first idea', '--wait']).status, 0)
  assert.equal((await submit.done).status, 5)
  assert.equal(show(workId).state.status, 'cancelled')

  const retried = system(['work', 'retry', workId, '--reason', 'resume'])
  assert.equal(retried.status, 0, retried.stderr)
  const done = show(workId)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(dispatched(done).map((e) => [e.stepId, e.selected]), [
    ['idea-a', 'claude-code/default'], ['idea-b', 'codex/default'], ['idea-b', 'codex/default'], ['synthesis', 'claude-code/default'],
  ])
  assert.equal(done.state.steps['idea-a']!.outputs.proposal, first, 'the first proposal is the same Artifact, not generated again')
  assert.equal(dispatched(done).at(-1)!.inputs!['proposal-a'], first)
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('after the Host is killed mid-step, four runs asked for at once dispatch the lost step once, losing no event', { timeout: 120_000 }, async () => {
  const marker = join(home, `hang-kill-${Date.now()}`)
  const input = brief(`FAKE:outputs FAKE:sign FAKE:hang=idea-b:${marker}`)
  const { workId, submit } = await submitting(input)
  for (let i = 0; i < 300 && !dispatched(show(workId)).some((e) => e.stepId === 'idea-b'); i++) await new Promise((r) => setTimeout(r, 100))
  // Kill only once the agent is inside idea-b: it creates the marker when it starts to hang.
  for (let i = 0; i < 300 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100))
  assert.ok(existsSync(marker), 'idea-b started')
  // idea-a runs beside it on the other Account: the kill comes once it is recorded, so only idea-b is lost.
  for (let i = 0; i < 300 && !show(workId).events.some((e) => e.type === 'observed' && e.stepId === 'idea-a'); i++) await new Promise((r) => setTimeout(r, 100))
  process.kill(await cli.pid(), 'SIGKILL')
  assert.notEqual((await submit.done).status, 0, 'the killed Host did not finish the Work')
  // The hanging agent outlived the Host, so its attempt keeps the Account's slot: stop it, as an operator would.
  const attempts = join(home, 'system', 'attempts')
  for (const file of readdirSync(attempts).filter((f) => f.endsWith('.pid'))) process.kill(Number(readFileSync(join(attempts, file), 'utf8')), 'SIGKILL')
  await cli.start()

  const runs = await Promise.all([0, 1, 2, 3].map(() => cli.runAsync(['work', 'run', workId]).done))
  const winners = runs.filter((r) => r.status === 0)
  assert.equal(winners.length, 1, JSON.stringify(runs))
  for (const loser of runs.filter((r) => r.status !== 0)) assert.match(loser.stderr, /is already being run/)
  const done = show(workId)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(dispatched(done).map((e) => e.stepId), ['idea-a', 'idea-b', 'idea-b', 'synthesis'])
  assert.deepEqual(done.events.filter((e) => e.type === 'attempt-lost').map((e) => e.stepId), ['idea-b'])
  assert.deepEqual(done.events.map((e) => e.seq), done.events.map((_, i) => i), 'every event kept, in order')
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('editing the Workflow file after admission changes nothing for an admitted Work', () => {
  const copy = join(home, 'brainstorm-copy.yaml')
  writeFileSync(copy, readFileSync(BRAINSTORM, 'utf8'))
  const ran = system(['work', 'submit', '--workflow', copy, '--input', brief('FAKE:outputs FAKE:fail')])
  assert.equal(ran.status, 1)
  const workId = ran.stdout.trim()
  const pinned = show(workId).state.specId
  writeFileSync(copy, readFileSync(BRAINSTORM, 'utf8').replace('id: synthesis', 'id: merge'))
  system(['work', 'retry', workId, '--reason', 'again'])
  const after = show(workId)
  assert.equal(after.state.specId, pinned)
  assert.deepEqual(Object.keys(after.state.steps), ['idea-a', 'idea-b', 'synthesis'])
})
