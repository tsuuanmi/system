import { describe, expect, it } from 'vitest'
import { AGENT_REVIEW, ALGORITHM_DEVELOPMENT, REVIEW_PROMPT } from '../../packages/plugins/profile-software-development/src/index.ts'
import {
  belowBar, boardReviewer, type Call, configurationProblems, driftOf, executionKey, changeOf, type EvalCase, type EvalSet, findingsOfAssessment, fingerprintOf, fingerprintParts, gateProblems, type GateRecord, type Git, INPUT_MAX, judge, loadSet, nextRecord, renderReport,
  REVIEW_TEMPLATE, reviewInput, reviewOnSystem, score, setProblems,
} from './reviewer-eval.ts'

const AT = new Date('2026-10-26T12:00:00Z')
const base = { task: 'T', title: 't', request: 'Do the task.' }
/** A fixture set: two escapes and two clean changes, so each count has a numerator that is neither 0 nor all. */
const fixture = (): EvalSet => ({
  setId: 'fixture', version: 1, repository: 'x', important: ['important'],
  cases: [
    { ...base, caseId: 'esc-env', kind: 'escape', change: { rev: 'aaaaaaa' }, fix: { rev: 'bbbbbbb' }, expected: { path: 'src/setup\\.ts', claim: 'npm_config|pnpm 12' } },
    { ...base, caseId: 'esc-fd', kind: 'escape', change: { revertOf: 'ccccccc', paths: ['src/'] }, fix: { rev: 'ccccccc' }, expected: { path: 'src/', claim: '/proc|reopen' } },
    { ...base, caseId: 'ok-docs', kind: 'clean', change: { rev: 'ddddddd' }, fix: null, expected: null },
    { ...base, caseId: 'ok-code', kind: 'clean', change: { rev: 'eeeeeee' }, fix: null, expected: null },
  ],
})
const f = (severity: string, claim: string, path?: string) => ({ severity, claim, ...(path ? { path } : {}) })

describe('the reviewer eval counts recall and false-important findings on a fixture set', () => {
  it('counts an escape found only when an important finding names its file and claim, and a clean change wrong only when it got an important finding', () => {
    const r = score(fixture(), {
      'esc-env': [f('important', 'npm_config_ names are ignored by pnpm 12', 'src/setup.ts')],
      'esc-fd': [f('nit', 'the /proc channel cannot be reopened', 'src/a.ts')],
      'ok-docs': [f('nit', 'a nit')],
      'ok-code': [f('important', 'a mistaken important finding', 'src/b.ts')],
    })
    expect(r.recall).toEqual({ found: 1, of: 2, rate: 0.5 })
    expect(r.falseImportant).toEqual({ cases: 1, of: 2, rate: 0.5 })
    expect(r.verdicts.map((v) => [v.caseId, v.found, v.falseImportant])).toEqual([['esc-env', true, null], ['esc-fd', false, null], ['ok-docs', null, false], ['ok-code', null, true]])
    expect(renderReport(r)).toContain('MISSED')
    expect(renderReport(r)).toContain('FALSE IMPORTANT')
  })

  it('does not accept the right words in the wrong file, or the right file with other words, or findings below the important severity', () => {
    const set = fixture()
    const esc = set.cases[0]!
    expect(judge(esc, [f('important', 'npm_config is ignored', 'src/other.ts')], set.important).found).toBe(false)
    expect(judge(esc, [f('important', 'a naming nit', 'src/setup.ts')], set.important).found).toBe(false)
    expect(judge(esc, [f('nit', 'npm_config is ignored', 'src/setup.ts')], set.important).found).toBe(false)
    // A finding that names no file is read by its claim alone.
    expect(judge(esc, [f('important', 'pnpm 12 ignores the npm_config_ name')], set.important).found).toBe(true)
  })

  it('leaves a case that did not run out of both counts, says why, and never reports a rate of nothing as 0', () => {
    const r = score(fixture(), { 'esc-env': [f('important', 'npm_config', 'src/setup.ts')], 'ok-docs': 'the change is not had: ddddddd is not a commit of this repository' })
    expect(r.notRun.map((n) => n.caseId)).toEqual(['esc-fd', 'ok-docs', 'ok-code'])
    expect(r.recall).toEqual({ found: 1, of: 1, rate: 1 })
    expect(r.falseImportant).toEqual({ cases: 0, of: 0, rate: null })
    expect(belowBar(r, { maxFalseImportant: 0 })).toEqual(['false-important rate not measured is above 0'])
    expect(belowBar(score(fixture(), {}), { minRecall: 0.5 })).toEqual(['recall not measured is below 0.5'])
  })

  it('holds a review below a bar: recall under the minimum, or false-important findings over the maximum', () => {
    const r = score(fixture(), { 'esc-env': [f('important', 'npm_config', 'src/setup.ts')], 'esc-fd': [], 'ok-docs': [], 'ok-code': [f('important', 'x')] })
    expect(belowBar(r, { minRecall: 0.5, maxFalseImportant: 0.5 })).toEqual([])
    expect(belowBar(r, { minRecall: 1 })).toEqual(['recall 1/2 is below 1'])
    expect(belowBar(r, { maxFalseImportant: 0 })).toEqual(['false-important rate 1/2 is above 0'])
  })
})

describe('the change a case reviews introduces the defect, on the defect\'s paths', () => {
  /** A git that knows a few commits and records each diff it was asked for. */
  const fakeGit = (asked: string[][]): Git => (args) => {
    asked.push(args)
    if (args[0] === 'rev-parse') {
      const rev = args.at(-1)!.replace('^{commit}', '')
      if (rev.startsWith('missing')) throw new Error('unknown revision')
      return rev.endsWith('^') ? `${rev.slice(0, -1)}-parent\n` : `${rev}-full\n`
    }
    if (args[0] === 'diff') return args.includes('src/empty/') ? '' : `diff of ${args.slice(3, 5).join(' -> ')}\n`
    throw new Error(`unexpected git ${args.join(' ')}`)
  }

  it('a commit against its parent, narrowed to the case\'s paths', () => {
    const asked: string[][] = []
    const c: EvalCase = { ...base, caseId: 'c', kind: 'escape', change: { rev: 'abc1234', paths: ['src/a/'] }, fix: { rev: 'fff1234' }, expected: { path: 'x', claim: 'y' } }
    expect(changeOf(c, fakeGit(asked))).toEqual({ base: 'abc1234-full-parent', diff: 'diff of abc1234-full-parent -> abc1234-full\n' })
    expect(asked.at(-1)).toEqual(['diff', '--no-color', '--no-ext-diff', 'abc1234-full-parent', 'abc1234-full', '--', 'src/a/'])
  })

  it('a fix reverted against the fixed tree, when the defect was a state no single commit introduced', () => {
    const asked: string[][] = []
    const c: EvalCase = { ...base, caseId: 'c', kind: 'escape', change: { revertOf: 'f1x0000', paths: ['src/checks/'] }, fix: { rev: 'f1x0000' }, expected: { path: 'x', claim: 'y' } }
    expect(changeOf(c, fakeGit(asked))).toEqual({ base: 'f1x0000-full', diff: 'diff of f1x0000-full -> f1x0000-full^\n' })
    expect(asked.at(-1)).toEqual(['diff', '--no-color', '--no-ext-diff', 'f1x0000-full', 'f1x0000-full^', '--', 'src/checks/'])
  })

  it('is not run, saying why, for a commit the clone lacks or a change that is empty on its paths: never an empty or other review', () => {
    const c = (change: EvalCase['change']): EvalCase => ({ ...base, caseId: 'c', kind: 'clean', change, fix: null, expected: null })
    expect(changeOf(c({ rev: 'missing1' }), fakeGit([]))).toEqual({ why: expect.stringMatching(/is not a commit of this repository \(fetch the run branch/) })
    expect(changeOf(c({ rev: 'abc1234', paths: ['src/empty/'] }), fakeGit([]))).toEqual({ why: expect.stringMatching(/^the change is empty on src\/empty\//) })
  })

  it('gives the reviewer the board review\'s own instructions, the task, and the engine\'s subject block with the change, never the case\'s title or its expected finding', () => {
    const set = loadSet()
    const t253 = set.cases.find((c) => c.caseId === 't253-home-filter-lists-other-projects')!
    const change = changeOf(t253, () => { throw new Error('a patch needs no git') })
    expect('why' in change).toBe(false)
    const input = reviewInput(t253, change as { base: string; diff: string })
    expect(input.startsWith(REVIEW_PROMPT)).toBe(true)
    expect(input).toContain(`Task: ${t253.request}`)
    expect(input).toContain('## The exact subject of this review')
    expect(input).toContain('-    const recent = homeProject ? runs.filter(')
    expect(input).toContain('+    const recent = runs')
    expect(input).not.toContain(t253.title)
    expect(input).not.toContain(t253.expected!.claim)
  })
})

describe('System\'s reviewer, through the host\'s MCP tools', () => {
  const answer = '```json\n{"subject": "reviewer-eval:c", "verdict": "changes-requested", "findings": [{"severity": "important", "title": "pnpm 12 ignores npm_config_", "detail": "set pnpm_config_offline", "file": "packages/plugins/agent-workers/src/setup.ts", "line": 12, "evidence": "only npm_config_offline is set"}, {"severity": "important", "title": "an important finding with no evidence"}, {"severity": "nit", "title": "a note"}]}\n```'
  /** A host that serves `run` and then `result`, recording the calls. */
  const host = (views: Array<Record<string, unknown>>, calls: Array<[string, Record<string, unknown>]>): Call => async (tool, args) => {
    calls.push([tool, args])
    const view = views.shift()
    return view ? { isError: false, text: '', structured: view } : { isError: true, text: 'no more' }
  }

  const board = boardReviewer()
  const served = { nodeId: 'review:1', worker: 'agent:runtime:1', minTier: board.tier, tier: board.tier, model: 'model-x' }

  it('runs the case as the board\'s review:1 (agent-review at the board reviewer\'s tier, the same routing), polls result until it ends, and reads the assessment with the engine\'s parser', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const got = await reviewOnSystem(host([
      { runId: 'run_1', status: 'running', nodes: [] },
      { runId: 'run_1', status: 'completed', answer, nodes: [served] },
    ], calls), 'the input', 'key-1', board)
    // The engine's parser reads the severities (ADR-0075): an important finding without file, line, and evidence is a nit.
    expect(got).toEqual({ findings: [
      { severity: 'important', claim: 'pnpm 12 ignores npm_config_: set pnpm_config_offline', evidence: 'only npm_config_offline is set', path: 'packages/plugins/agent-workers/src/setup.ts' },
      { severity: 'nit', claim: 'an important finding with no evidence' },
      { severity: 'nit', claim: 'a note' },
    ], workers: [`agent:runtime:1 at ${board.tier}`] })
    expect(calls).toEqual([
      ['run', { template: REVIEW_TEMPLATE, input: 'the input', tier: board.tier, classification: 'operator-shared', clientRequestId: 'key-1', waitSeconds: 55 }],
      ['result', { runId: 'run_1', waitSeconds: 55 }],
    ])
    expect(REVIEW_TEMPLATE).toBe('agent-review')
    // A board reviewer whose tier changed is run at that tier.
    const frontier: Array<[string, Record<string, unknown>]> = []
    await reviewOnSystem(host([{ runId: 'r', status: 'completed', answer, nodes: [{ ...served, minTier: 'frontier', tier: 'frontier' }] }], frontier), 'x', 'k', { ...board, tier: 'frontier' })
    expect(frontier[0]![1]).toMatchObject({ tier: 'frontier' })
  })

  it('does not count a review the host served at another configuration than the board reviewer\'s: another minimum tier, or no review:1 on a Worker', async () => {
    expect(await reviewOnSystem(host([{ runId: 'r', status: 'completed', answer, nodes: [{ ...served, minTier: 'economy' }] }], []), 'x', 'k', board))
      .toMatch(/^r: the host served review:1 at minimum tier economy, not the board reviewer's standard: it does not serve this reviewer configuration/)
    expect(await reviewOnSystem(host([{ runId: 'r', status: 'completed', answer, nodes: [] }], []), 'x', 'k', board)).toMatch(/served no review:1 step on a Worker/)
  })

  it('says why a case has no review: an input over the run tool\'s bound, a refused, failed, blocked, or unfinished run, an answer that is no assessment', async () => {
    expect(await reviewOnSystem(host([], []), 'x'.repeat(INPUT_MAX + 1), 'k', board)).toMatch(/over the run tool's 32000/)
    expect(await reviewOnSystem(host([], []), 'x', 'k', board)).toMatch(/^the run was refused/)
    expect(await reviewOnSystem(host([{ runId: 'r', status: 'failed', error: { kind: 'timeout', message: 'slow' } }], []), 'x', 'k', board)).toMatch(/^r ended failed: timeout slow/)
    expect(await reviewOnSystem(host([{ runId: 'r', status: 'running', blocked: { kind: 'tool-call' } }], []), 'x', 'k', board)).toMatch(/waits on the operator \(tool-call\)/)
    // One minute is two polls of 55 s: still running after both, it is not waited on longer.
    expect(await reviewOnSystem(host([{ runId: 'r', status: 'running' }, { runId: 'r', status: 'running' }, { runId: 'r', status: 'running' }], []), 'x', 'k', board, 1)).toMatch(/did not finish within 1 minutes/)
    expect(await reviewOnSystem(host([{ runId: 'r', status: 'completed', answer: 'looks fine', nodes: [served] }], []), 'x', 'k', board)).toMatch(/is not an assessment: the review has no JSON assessment/)
    expect(findingsOfAssessment(answer)).toHaveLength(3)
  })

  it('keys each case\'s run by its execution: two executions never share a run, a retry within one does', () => {
    expect(executionKey('e1', 'c')).toBe(executionKey('e1', 'c'))
    expect(executionKey('e1', 'c')).not.toBe(executionKey('e2', 'c'))
    expect(executionKey('e1', 'c')).not.toBe(executionKey('e1', 'd'))
  })

  it('runs only a configuration agent-review can serve as the board reviewer: the same capabilities, the caller\'s tier taken, no tier above the board\'s', () => {
    expect(configurationProblems()).toEqual([])
    type Step = (typeof ALGORITHM_DEVELOPMENT)[number]
    const boardWith = (over: Partial<Step>) => ALGORITHM_DEVELOPMENT.map((n) => (n.nodeId === 'review:1' ? { ...n, ...over } : n))
    expect(configurationProblems(boardWith({ capabilities: ['review', 'local-data', 'browser'] }))).toEqual([expect.stringMatching(/asks for local-data, review, the board reviewer for browser, local-data, review: change them together/)])
    expect(configurationProblems(boardWith({ tier: 'economy' }))).toEqual([expect.stringMatching(/asks for standard, above the board reviewer's economy/)])
    expect(configurationProblems(undefined, [{ ...AGENT_REVIEW[0]!, callerTier: false }])).toEqual([expect.stringMatching(/does not take the caller's tier/)])
    // Raising the board reviewer's tier is servable: the eval asks agent-review for it.
    expect(configurationProblems(boardWith({ tier: 'frontier' }))).toEqual([])
    expect(boardReviewer(boardWith({ tier: 'frontier' }))).toEqual({ capabilities: ['local-data', 'review'], tier: 'frontier' })
  })
})

describe('the gate: a change to the reviewer fails the check until the eval runs on it', () => {
  const parts = fingerprintParts()
  const measured = (recall: number, wrong: number): GateRecord => ({
    record: 'reviewer-eval-gate', fingerprint: fingerprintOf(parts), parts,
    run: { execution: 'e0', at: AT.toISOString(), reviewer: boardReviewer(), recall: { found: recall, of: 5, rate: recall / 5 }, falseImportant: { cases: wrong, of: 3, rate: Math.round((wrong / 3) * 1000) / 1000 }, workers: ['w'] },
  })

  it('passes the reviewer the record names, and names each part that changed otherwise: its instructions, subject block, parser, steps, the set', () => {
    expect(gateProblems(measured(4, 0), parts)).toEqual([])
    expect(gateProblems(undefined, parts)).toEqual([expect.stringMatching(/has never been recorded/)])
    const changed = { ...parts, instructions: 'sha256:other', set: 'sha256:other' }
    expect(gateProblems(measured(4, 0), changed)).toEqual(['the reviewer\'s instructions changed since the recorded run', 'the reviewer\'s set changed since the recorded run'])
    expect(gateProblems({ ...measured(4, 0), fingerprint: 'sha256:forged' }, parts)).toEqual([expect.stringMatching(/not its parts' fingerprint/)])
    // A board reviewer the eval cannot run fails the gate too, recorded or not.
    expect(gateProblems(measured(4, 0), parts, ['agent-review\'s review:1 asks for review, the board reviewer for x'])).toEqual([expect.stringMatching(/^the eval cannot run the board reviewer's configuration: /)])
    expect(Object.keys(parts).sort()).toEqual(['boardStep', 'evalStep', 'instructions', 'parser', 'runner', 'set', 'subjectBlock'])
  })

  it('records a run only when every case ran and it is no worse than the last: recall not lower, false-important not higher', () => {
    const set = fixture()
    const all = score(set, { 'esc-env': [f('important', 'npm_config', 'src/setup.ts')], 'esc-fd': [f('important', 'reopen /proc', 'src/x.ts')], 'ok-docs': [], 'ok-code': [] })
    const reviewer = boardReviewer()
    const recorded = nextRecord(undefined, parts, all, { execution: 'e1', reviewer, workers: ['w2', 'w1'] }, AT)
    expect(recorded).toMatchObject({ fingerprint: fingerprintOf(parts), run: { execution: 'e1', at: AT.toISOString(), reviewer, recall: { rate: 1 }, falseImportant: { rate: 0 }, workers: ['w1', 'w2'] } })
    const partial = score(set, { 'esc-env': [] })
    expect(nextRecord(undefined, parts, partial, { execution: 'e2', reviewer, workers: [] }, AT)).toEqual({ refused: [expect.stringMatching(/^3 case\(s\) did not run/)] })
    const worse = score(set, { 'esc-env': [], 'esc-fd': [f('important', 'reopen /proc', 'src/x.ts')], 'ok-docs': [f('important', 'x')], 'ok-code': [] })
    expect(nextRecord(recorded as GateRecord, parts, worse, { execution: 'e2', reviewer, workers: [] }, AT)).toEqual({ refused: ['recall fell from 2/2 to 1/2', 'the false-important rate rose from 0/2 to 1/2'] })
    // The execution already recorded is never recorded again as a new measurement.
    expect(nextRecord(recorded as GateRecord, parts, all, { execution: 'e1', reviewer, workers: [] }, AT)).toEqual({ refused: [expect.stringMatching(/^execution e1 is the one already recorded/)] })
  })

  it('before the first measured run reports what changed and never fails on it; from a measured run on, the same change fails', () => {
    const unmeasured: GateRecord = { ...measured(4, 0), run: null }
    const changed = { ...parts, instructions: 'sha256:other' }
    expect(gateProblems(unmeasured, changed)).toEqual([])
    expect(driftOf(unmeasured, changed)).toEqual(['instructions'])
    expect(gateProblems(measured(4, 0), changed)).toEqual(['the reviewer\'s instructions changed since the recorded run'])
    // A board reviewer the eval cannot run still fails an unmeasured record.
    expect(gateProblems(unmeasured, parts, ['x'])).toEqual([expect.stringMatching(/^the eval cannot run the board reviewer's configuration: /)])
  })

  it('the recorded gate passes on this tree', async () => {
    const { readFileSync } = await import('node:fs')
    const record = JSON.parse(readFileSync(new URL('../../docs/validation/experiments/records/reviewer-eval-gate.json', import.meta.url), 'utf8')) as GateRecord
    expect(gateProblems(record, parts)).toEqual([])
  })
})

describe('the recorded set', () => {
  it('is well formed and holds the five escapes of 2026-10-26, each a fix commit and a change that introduces the defect, and clean changes', () => {
    const set = loadSet()
    expect(setProblems(set)).toEqual([])
    // What counts is what the engine's parser writes for a defect of the change (ADR-0075).
    expect(set.important).toEqual(['important'])
    const escapes = set.cases.filter((c) => c.kind === 'escape')
    expect(escapes.map((c) => c.caseId)).toEqual(['t235-npm-config-name', 'check-starts-install-in-confinement', 'regenerate-without-no-install-environment', 't247-proc-fd-report-channel', 't253-home-filter-lists-other-projects'])
    expect(escapes.map((c) => [c.change, c.fix?.rev])).toEqual([
      [{ rev: '479ce7e2', paths: ['packages/plugins/agent-workers/src/checks.ts'] }, '5332fecd'],
      [{ revertOf: '5332fecd', paths: ['packages/plugins/agent-workers/src/checks.ts'] }, '5332fecd'],
      [{ revertOf: '8eb36439', paths: ['packages/plugins/agent-workers/src/regenerate.ts'] }, '8eb36439'],
      [expect.objectContaining({ rev: 'effbbc75' }), '096d6b6d'],
      [{ patch: 'reviewer-eval-t253-defective.patch' }, '20fe4c45'],
    ])
    expect(set.cases.filter((c) => c.kind === 'clean').length).toBeGreaterThanOrEqual(2)
    // The reviewer is told the task, never the defect.
    for (const c of set.cases) expect(c.request, c.caseId).not.toBe(c.title)
  })

  it('is refused when it is malformed: an escape with no fix or finding, a change naming none or two of its kinds, a reverted fix with no paths, a missing patch, a bad pattern, no clean case', () => {
    const set = fixture()
    set.cases[0]!.fix = null
    set.cases[1]!.expected = { path: '(', claim: 'x' }
    set.cases[2]!.change = { rev: 'ddddddd', patch: 'p.patch' } as unknown as EvalCase['change']
    set.cases[3]!.change = { patch: '../outside.patch' }
    set.cases.push({ ...set.cases[2]!, change: { revertOf: 'abcdef1', paths: [] } })
    const problems = setProblems(set, () => false).join('\n')
    expect(problems).toContain('an escape names its fix')
    expect(problems).toContain('is not a regular expression')
    expect(problems).toContain('names one of rev, revertOf, or patch')
    expect(problems).toContain('is not a file of the records directory')
    expect(problems).toContain('a reverted fix names the paths the defect is in')
    expect(problems).toContain('a second case with this id')
    set.cases = set.cases.filter((c) => c.kind === 'escape')
    expect(setProblems(set, () => true).join('\n')).toContain('no clean case')
    // A severity the engine's parser never writes (assessment@1.0's `blocking` is read as `important`) would count no finding.
    expect(setProblems({ ...fixture(), important: ['blocking'] }, () => true)).toEqual([expect.stringMatching(/^severity blocking is not one the engine's parser writes \(important, nit, pre-existing\)/)])
  })
})
