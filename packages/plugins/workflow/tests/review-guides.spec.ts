import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { commandsIn, commandsText, DOSSIER_LIMITS, evidenceProblem, keepCommand, RECORDED, type StepCommands } from '../src/dossiers.ts'
import { GUIDE_DIR, GUIDE_LIMITS, GUIDE_SECTIONS, guidesTouching, loadGuides, parseGuide, renderGuides } from '../src/review-guides.ts'
import { type NodeTemplate, preflight } from '../src/spec.ts'

// Review guides (docs/design/handbook.md#review-guides-reviewmd, T267): the format, the selection of
// the areas a change touches, and what a repository's `docs/review/` yields. The brief a review step
// gets is tested where the engine runs one (profile-software-development `algorithm-development.spec.ts`).

const guide = (paths: string[], extra: { owner?: string | null; version?: string | null; sections?: readonly string[] } = {}): string => [
  '---', 'paths:', ...paths.map((p) => `  - ${p}`),
  ...(extra.owner === null ? [] : [`owner: ${extra.owner ?? 'lead'}`]), ...(extra.version === null ? [] : [`version: ${extra.version ?? '1'}`]), '---',
  '# Review guide: an area', '', ...(extra.sections ?? GUIDE_SECTIONS).flatMap((s) => [`## ${s}`, `Text of ${s}.`, '']),
].join('\n')

describe('a review guide\'s format', () => {
  it('parses front matter (paths, owner, version) and the six sections', () => {
    const read = parseGuide('docs/review/a.REVIEW.md', guide(['packages/a/', 'docs/x.md']))
    expect(read).toMatchObject({ ok: true, guide: { paths: ['packages/a/', 'docs/x.md'], owner: 'lead', version: 1 } })
    expect((read as { guide: { sha256: string } }).guide.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a guide with no front matter, no paths, no owner, no version, a bad pattern, a missing section, or too many characters, naming why', () => {
    const problem = (text: string): string => (parseGuide('g', text) as { problem: string }).problem
    expect(problem('# a guide\n')).toMatch(/no front matter/)
    expect(problem('---\nowner: lead\n')).toMatch(/never closed/)
    expect(problem(guide([]))).toMatch(/names no paths/)
    expect(problem(guide(['a/'], { owner: null }))).toMatch(/names no owner/)
    expect(problem(guide(['a/'], { version: null }))).toMatch(/names no version/)
    expect(problem(guide(['a/'], { version: '0' }))).toMatch(/the version is a positive integer/)
    expect(problem(guide(['../etc']))).toMatch(/is not a repository-relative path|has a \. or \.\./)
    expect(problem(guide(['a/'], { sections: GUIDE_SECTIONS.slice(0, 4) }))).toBe('missing sections: Evidence rule, Summary rule')
    expect(problem(`${guide(['a/'])}${'x'.repeat(GUIDE_LIMITS.chars)}`)).toMatch(/longer than 6000 characters/)
    expect(problem(guide(['a/']).replace('owner: lead', 'author: me'))).toMatch(/is not paths, owner, or version/)
  })
})

describe('the guides a change touches', () => {
  const all = ['packages/a/', 'packages/b/', 'docs/'].map((p, i) => {
    const read = parseGuide(`docs/review/${i}.REVIEW.md`, guide([p]))
    if (!read.ok) throw new Error(read.problem)
    return read.guide
  })

  it('selects the guides whose area a changed path is in, and counts the rest left out', () => {
    expect(guidesTouching(all, { paths: ['packages/a/src/x.ts', 'README.md'], unreadable: [] })).toMatchObject({ selected: [{ paths: ['packages/a/'] }], left: 2, all: false })
    expect(guidesTouching(all, { paths: ['docs/x.md', 'packages/b/y.ts'], unreadable: [] }).selected.map((g) => g.paths[0])).toEqual(['packages/b/', 'docs/'])
    expect(guidesTouching(all, { paths: ['elsewhere/z.ts'], unreadable: [] })).toMatchObject({ selected: [], left: 3 })
  })

  it('gives every guide when the change\'s paths are unknown or some part could not be read: an unknown path is no reason to leave a rule out (INV-2)', () => {
    expect(guidesTouching(all, { paths: [], unreadable: [] })).toMatchObject({ left: 0, all: true })
    expect(guidesTouching(all, { paths: ['packages/a/x.ts'], unreadable: ['a part could not be read'] }).selected).toHaveLength(3)
  })

  it('renders the selected guides without their front matter, and names a guide that could not be used', () => {
    const picked = guidesTouching(all, { paths: ['docs/x.md'], unreadable: [] })
    const rendered = renderGuides(picked.selected, picked.left, picked.all, ['docs/review/bad.REVIEW.md: no front matter'])!
    expect(rendered.text).toContain('1 of 3; 2 left out')
    expect(rendered.text).toContain('## What failure looks like here')
    expect(rendered.text).not.toContain('paths:')
    expect(rendered.text).toContain('Guides not used: docs/review/bad.REVIEW.md: no front matter')
    expect(rendered.body).toMatchObject({ schema: 'review-guides@1.0', left: 2, guides: [{ file: 'docs/review/2.REVIEW.md', version: 1, owner: 'lead' }] })
    expect(renderGuides([], 0, false, [])).toBeUndefined()
  })
})

describe('the guides of a repository', () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'system-guides-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  it('has none without a docs/review directory, and reads each *.REVIEW.md in name order', () => {
    expect(loadGuides(repo())).toEqual({ guides: [], problems: [] })
    const dir = repo()
    mkdirSync(join(dir, GUIDE_DIR), { recursive: true })
    writeFileSync(join(dir, GUIDE_DIR, 'b.REVIEW.md'), guide(['b/']))
    writeFileSync(join(dir, GUIDE_DIR, 'a.REVIEW.md'), guide(['a/']))
    writeFileSync(join(dir, GUIDE_DIR, 'README.md'), '# not a guide\n')
    expect(loadGuides(dir).guides.map((g) => g.file)).toEqual(['docs/review/a.REVIEW.md', 'docs/review/b.REVIEW.md'])
  })

  it('names a malformed guide and a link, never reading through one, and keeps the others', () => {
    const dir = repo()
    mkdirSync(join(dir, GUIDE_DIR), { recursive: true })
    writeFileSync(join(dir, GUIDE_DIR, 'a.REVIEW.md'), guide(['a/']))
    writeFileSync(join(dir, GUIDE_DIR, 'bad.REVIEW.md'), 'nothing\n')
    writeFileSync(join(dir, 'secret.txt'), guide(['x/']))
    symlinkSync(join(dir, 'secret.txt'), join(dir, GUIDE_DIR, 'link.REVIEW.md'))
    const loaded = loadGuides(dir)
    expect(loaded.guides.map((g) => g.file)).toEqual(['docs/review/a.REVIEW.md'])
    expect(loaded.problems).toEqual(['docs/review/bad.REVIEW.md: no front matter (it opens with a --- line)', 'docs/review/link.REVIEW.md is not a regular file'])
  })

  it('reads this repository\'s own guides: every one parses, and they name the areas the system repository is made of', () => {
    const loaded = loadGuides(fileURLToPath(new URL('../../../../', import.meta.url)))
    expect(loaded.problems).toEqual([])
    expect(loaded.guides.map((g) => g.file.replace(/^docs\/review\//, '').replace(/\.REVIEW\.md$/, ''))).toEqual(['agent-workers', 'board-and-dispatch', 'docs', 'gate-and-approvals', 'web-ui', 'workflow-engine'])
    const touching = (path: string): string[] => guidesTouching(loaded.guides, { paths: [path], unreadable: [] }).selected.map((g) => g.file.replace(/^docs\/review\//, '').replace(/\.REVIEW\.md$/, ''))
    expect(touching('packages/plugins/workflow/src/engine.ts')).toEqual(['workflow-engine'])
    expect(touching('packages/plugins/workflow/src/tasks.ts')).toEqual(['board-and-dispatch', 'workflow-engine'])
    expect(touching('packages/plugins/agent-workers/src/gate.ts')).toEqual(['agent-workers'])
    expect(touching('packages/plugins/web-ui/src/index.ts')).toEqual(['web-ui'])
    expect(touching('docs/design/handbook.md')).toEqual(['docs'])
  })
})

describe('the shape of an author\'s evidence (T267)', () => {
  it('passes the commands with their exit codes and output, each command check the criteria name named', () => {
    expect(evidenceProblem(['$ npm test\nexit 0\nTests: 3 passed, 0 failed'], ['tests'])).toBeUndefined()
    expect(evidenceProblem(['$ corepack pnpm lint\nexit code: 0\nFound 0 warnings', '$ corepack pnpm typecheck\nexited 0\ntsc --noEmit: no errors'], ['lint', 'typecheck', 'review'])).toBeUndefined()
  })

  it('passes a Worker whose shell tool prints no exit code, and one that says a check could not run and why (T274, 2026-10-26)', () => {
    expect(evidenceProblem(['Command: corepack pnpm lint\nOutput: "$ oxlint scripts packages", no diagnostics; exit codes were not printed by the tool.'], ['lint'])).toBeUndefined()
    expect(evidenceProblem(['Command: corepack pnpm lint -> output "$ oxlint scripts packages", no diagnostics, no error.\nNot run: the tests (layout.spec.ts), not on the allowed command list.'], ['lint', 'tests'])).toBeUndefined()
    expect(evidenceProblem(['$ corepack pnpm lint\nclean', '$ corepack pnpm test\nTests 12 passed'], ['lint', 'tests'])).toBeUndefined()
  })

  it('refuses none, a bare word, no command, an unnamed check, and commands with no output', () => {
    expect(evidenceProblem([], ['tests'])).toMatch(/no evidence entry/)
    expect(evidenceProblem(['done'], [])).toMatch(/shows no command it ran/)
    expect(evidenceProblem(['all checks passed'], ['lint'])).toMatch(/shows no command it ran/)
    expect(evidenceProblem(['$ corepack pnpm lint\nexit 0\nclean'], ['lint', 'tests'])).toMatch(/does not name the check tests/)
    expect(evidenceProblem(['Command: corepack pnpm lint'], ['lint'])).toMatch(/no output line/)
    expect(evidenceProblem(['$ make\nexit 0\nok', '$ make again\nexit 0\nok'], ['lint', 'tests'])).toMatch(/does not name the checks tests, lint/)
    expect(evidenceProblem(['$ npm test\nexit 0'], ['tests'])).toMatch(/no output line/)
  })

  it('counts a check as shown by a command the System recorded, whatever the Worker wrote (T284)', () => {
    const lint = { command: 'corepack pnpm lint', exitCode: 0, isError: false, tail: '' }
    expect(evidenceProblem([], ['lint'], [lint])).toBeUndefined()
    expect(evidenceProblem(['done'], ['lint', 'review'], [lint])).toBeUndefined()
    // A check that failed is shown too: the gate asks that the check ran, the run's own checks judge it.
    expect(evidenceProblem([], ['lint'], [{ ...lint, exitCode: 1, isError: true }])).toBeUndefined()
    // A check no recorded command runs is refused, naming it, unless the Worker says why it could not run.
    expect(evidenceProblem([], ['lint', 'tests'], [lint])).toMatch(/no command the System recorded runs the check tests/)
    expect(evidenceProblem(['Command: corepack pnpm test -> not allowed on the command list, so not run'], ['lint', 'tests'], [lint])).toBeUndefined()
  })

  it('never takes a command its runtime reported no end of (a background launch) for a check that ran (T284)', () => {
    const launched = { command: 'corepack pnpm lint', isError: false, unfinished: true as const, tail: '' }
    expect(evidenceProblem([], ['lint'], [launched])).toMatch(/launched in the background or interrupted.*run it in the foreground/)
    const step: StepCommands = { checks: [], others: [], dropped: { checks: 0, others: 0 }, next: 0 }
    keepCommand(step, launched)
    const [text] = commandsText(step)
    expect(text).toContain('$ corepack pnpm lint')
    expect(text).toContain('no end reported')
    expect(text).not.toMatch(/exit 0/)
  })

  it('keeps the record that shows a check however many other commands follow it, and lists it in entries the dossier never cuts (T284)', () => {
    const step: StepCommands = { checks: [], others: [], dropped: { checks: 0, others: 0 }, next: 0 }
    keepCommand(step, { command: 'corepack pnpm lint', exitCode: 0, isError: false, tail: 'Found 0 warnings' })
    for (let i = 0; i < 200; i++) keepCommand(step, { command: `git status --short ${'x'.repeat(i % 7)}`, exitCode: 0, isError: false, tail: 'M a.ts\n'.repeat(50) })
    // More runs of the check than its bound keeps: older runs go, a run that shows lint stays.
    for (let i = 0; i < RECORDED.checks + 5; i++) keepCommand(step, { command: 'corepack pnpm test:affected', isError: true, exitCode: 1, tail: 'x'.repeat(2000) })
    const commands = commandsIn(step)
    expect(commands.length).toBe(RECORDED.checks + RECORDED.others)
    expect(evidenceProblem([], ['lint', 'tests'], commands)).toBeUndefined()
    const parts = commandsText(step)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect([...part].length).toBeLessThanOrEqual(DOSSIER_LIMITS.text)
    const all = parts.join('\n')
    expect(all).toContain('$ corepack pnpm lint\nexit 0\nFound 0 warnings')
    expect(all.split('$ corepack pnpm test:affected').length - 1).toBe(RECORDED.checks - 1)
    expect(all).toContain(`${200 - RECORDED.others} earlier not kept`)
    expect(parts[0]).toContain(`(part 1 of ${parts.length})`)
  })

  it('lists the exit code of a command longer than its bound: the command alone is cut, its end follows whole (T284)', () => {
    const step: StepCommands = { checks: [], others: [], dropped: { checks: 0, others: 0 }, next: 0 }
    const long = `node scripts/build.mjs ${'--flag '.repeat(70)}`
    keepCommand(step, { command: long, exitCode: 1, isError: true, tail: 'boom' })
    keepCommand(step, { command: `corepack pnpm lint ${'--fix '.repeat(60)}`, exitCode: 2, isError: true, tail: 'error' })
    keepCommand(step, { command: `make ${'target '.repeat(60)}`, isError: false, unfinished: true, tail: '' })
    const text = commandsText(step).join('\n')
    expect(text).toMatch(/^\$ node scripts\/build\.mjs .*… — exit 1$/m)
    expect(text).toMatch(/^\$ corepack pnpm lint .*…\nexit 2$/m)
    expect(text).toMatch(/^\$ make .*… — no end reported/m)
  })
})

describe('the template fields behind the author\'s checks and self-review (T267)', () => {
  const step = (nodeId: string, extra: Partial<NodeTemplate>): NodeTemplate => ({ nodeId, objective: nodeId, prompt: 'x', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra })

  it('takes showsEvidence on a writing step only, and selfReview on a review that depends on the writing step it names and has no differentFrom', () => {
    const develop = step('develop', { capabilities: ['develop'], showsEvidence: true })
    const review = step('self', { capabilities: ['review'], dependsOn: ['develop'], selfReview: 'develop' })
    expect(preflight([develop, review])).toEqual(['develop', 'self'])
    expect(() => preflight([step('develop', { showsEvidence: true })])).toThrow(/showsEvidence is true, on a writing step/)
    expect(() => preflight([develop, { ...review, dependsOn: [] }])).toThrow(/selfReview names a writing step it depends on/)
    expect(() => preflight([develop, { ...review, selfReview: 'self' }])).toThrow(/selfReview names a writing step it depends on/)
    expect(() => preflight([develop, { ...review, capabilities: ['reason'] }])).toThrow(/selfReview names a writing step it depends on/)
    expect(() => preflight([develop, { ...review, differentFrom: ['develop'] }])).toThrow(/selfReview names a writing step it depends on/)
  })
})
