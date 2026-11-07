/**
 * M4 gate on the real profile: both repository Workflow files run through one
 * controller with Workers on a fake CLI and the real verifiers
 * (code.required-checks on a real git repository, research.citation-check
 * against a local HTTP server). Verdicts are Artifacts bound to exact IDs.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-verify')
const home = cli.home
let server: ChildProcess
let site = ''

/** The test process blocks in spawnSync while the Host fetches, so the site runs in its own process. */
const SITE = `
const { createServer } = require('node:http')
const server = createServer((req, res) => {
  res.writeHead(req.url === '/article' ? 200 : 404, { 'content-type': 'text/html' })
  res.end(req.url === '/article' ? '<p>System <i>verifies</i> citations exactly.</p>' : 'gone')
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
`

const system = (args: string[]) => cli.run(args)

type Verified = { type: string; stepId?: string; subject?: string; criteria?: string; verdict?: string; verdictId?: string; evidence?: string[] }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as { events: Verified[]; state: { status: string; reason?: string; criteria: Record<string, string>; steps: Record<string, { outputs: Record<string, string> }> } }
const artifact = (id: string) => JSON.parse(system(['artifact', 'show', id]).stdout) as { envelope: { kind: string; content: Record<string, unknown> } }

function gitRepo(checks?: string): string {
  const dir = mkdtempSync(join(home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  if (checks) {
    mkdirSync(join(dir, '.system'))
    writeFileSync(join(dir, '.system', 'checks.yaml'), checks)
  }
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  return dir
}

before(async () => {
  server = spawn(process.execPath, ['-e', SITE], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<string>((r) => server.stdout!.once('data', (d) => r(String(d).trim())))
  site = `http://127.0.0.1:${port}`
  assert.equal(system(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        capabilities: [code-write, research, web-search]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
`)
  // The Host reads its credentials when it starts: store the token, then start it again.
  await cli.start()
  const set = cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake\n' })
  assert.equal(set.status, 0, set.stderr)
  await cli.start()
})

after(async () => {
  await cli.stop()
  server.kill()
  rmSync(home, { recursive: true, force: true })
})

const task = (text: string, repository?: string) => system(['task', 'new', '--text', text, ...(repository ? ['--repo', repository] : [])]).stdout.trim().split('\n').at(-1)!
/** The Software Engineering file without its publish step: these tests are about verification (tests/publish.test.ts covers the whole file). */
const SE = join(home, 'software-engineering-checks.yaml')
writeFileSync(SE, readFileSync(join(repo, 'workflows', 'software-engineering.yaml'), 'utf8').replace(/  - id: publish[\s\S]*?(?=  - id: accept)/, '').replace('dependsOn: [publish]', 'dependsOn: [checks]'))
writeFileSync(join(home, 'code-checks.yaml'), readFileSync(join(repo, 'workflows', 'code-checks.yaml')))
const RESEARCH = join(repo, 'workflows', 'research.yaml')

test('Software Engineering: the exact changed commit passes the base commit\'s pinned checks', () => {
  const repository = gitRepo('checks:\n  - name: note-exists\n    run: test -f NOTE.md\n')
  const ran = system(['work', 'submit', '--workflow', SE, '--input', task('FAKE:edit', repository)])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  const verified = record.events.find((e) => e.type === 'verified')!
  assert.equal(verified.subject, record.state.steps.implement!.outputs.change)
  assert.equal(verified.criteria, record.state.criteria['checks.checks'])
  const verdict = artifact(verified.verdictId!)
  assert.equal(verdict.envelope.kind, 'verdict')
  assert.deepEqual([verdict.envelope.content.subject, verdict.envelope.content.criteria, verdict.envelope.content.verdict], [verified.subject, verified.criteria, 'pass'])
  const run = artifact(verified.evidence![0]!)
  assert.deepEqual([run.envelope.kind, run.envelope.content.name, run.envelope.content.exitCode], ['check-run', 'note-exists', 0])
  assert.equal(artifact(record.state.criteria['checks.checks']!).envelope.kind, 'checks')
})

test('Software Engineering: a change failing a check fails the Work with the check named', () => {
  const repository = gitRepo('checks:\n  - name: note-exists\n    run: test -f NOTE.md\n')
  const ran = system(['work', 'submit', '--workflow', SE, '--input', task('nothing to do', repository)])
  assert.equal(ran.status, 1)
  const record = show(ran.stdout.trim())
  assert.match(record.events.find((e) => e.type === 'verified')!.verdict!, /^fail$/)
  assert.match(record.state.reason!, /checks=fail/)
})

test('Software Engineering: a check failed by the environment is verified again with work retry --step checks.checks, on the same change', () => {
  const marker = join(home, 'environment-fixed')
  rmSync(marker, { force: true })
  const repository = gitRepo(`checks:\n  - name: environment\n    run: test -f ${marker}\n`)
  const ran = system(['work', 'submit', '--workflow', SE, '--input', task('FAKE:edit', repository)])
  assert.equal(ran.status, 1)
  const workId = ran.stdout.trim()
  writeFileSync(marker, '')
  const again = system(['work', 'retry', workId, '--step', 'checks.checks', '--reason', 'the environment is fixed'])
  assert.equal(again.status, 0, again.stderr)
  const record = show(workId)
  const verified = record.events.filter((e) => e.type === 'verified')
  assert.deepEqual(verified.map((e) => e.verdict), ['fail', 'pass'], 'the failed verdict is kept')
  assert.equal(verified[0]!.subject, verified[1]!.subject)
  assert.equal(record.events.filter((e) => e.type === 'dispatched' && e.stepId === 'implement').length, 1, 'no new implement attempt')
  assert.equal(record.state.status, 'succeeded')
})

test('code-checks.yaml on its own checks the base commit of its input task, as it is', () => {
  const repository = gitRepo('checks:\n  - name: readme-exists\n    run: test -f README.md\n')
  const ran = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'code-checks.yaml'), '--input', task('check it', repository)])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  const verified = record.events.find((e) => e.type === 'verified')!
  assert.equal(verified.verdict, 'pass')
  const base = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(artifact(verified.evidence![0]!).envelope.content.commit, base)
})

test('Software Engineering: a base commit with no .system/checks.yaml is refused at admission', () => {
  const ran = system(['work', 'submit', '--workflow', SE, '--input', task('FAKE:edit', gitRepo())])
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /cannot pin criteria repo-checks-v1: no \.system\/checks\.yaml at commit/)
})

test('Research: cited quotes found at their URLs pass, through the same controller', () => {
  const ran = system(['work', 'submit', '--workflow', RESEARCH, '--input', task(`FAKE:outputs FAKE:cite=${site}/article`)])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  const verified = record.events.find((e) => e.type === 'verified')!
  assert.equal(verified.subject, record.state.steps.investigate!.outputs.sources)
  const evidence = artifact(verified.evidence![0]!)
  assert.equal(evidence.envelope.kind, 'citation-check')
  assert.deepEqual((evidence.envelope.content.results as { found: boolean }[]).map((r) => r.found), [true])
})

test('Research: a quote that cannot be confirmed now holds the Work for the operator', () => {
  const ran = system(['work', 'submit', '--workflow', RESEARCH, '--input', task(`FAKE:outputs FAKE:cite=${site}/gone`)])
  assert.equal(ran.status, 3)
  assert.match(show(ran.stdout.trim()).state.reason!, /inconclusive verification needs an operator decision: citations/)
})

test('Research: an empty sources file fails', () => {
  const ran = system(['work', 'submit', '--workflow', RESEARCH, '--input', task('FAKE:outputs')])
  assert.equal(ran.status, 1)
  assert.match(show(ran.stdout.trim()).events.find((e) => e.type === 'verified')!.verdict!, /^fail$/)
})
