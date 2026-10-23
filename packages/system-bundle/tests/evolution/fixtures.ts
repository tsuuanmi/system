/**
 * The raw artifacts the evolution test digests under each composition: synthetic, shaped like what
 * an `algorithm-development` attempt leaves (docs/operations/pilot.md): a test runner's log, a
 * benchmark's output, the developer's and the validator's final messages, and a review's assessment
 * (a body with no text, read as its canonical JSON). Deterministic, so each composition stores the
 * same artifacts, with the same content ids.
 */

/** One raw artifact: a Worker's answer (its text), or a record body with no text. */
export type Source = { name: string; text: string } | { name: string; kind: 'assessment'; body: Record<string, unknown> }

/** A digest request of the fixture set: what it is, and its sources in order. */
export interface Fixture { name: string; sources: Source[] }

const cases = ['identical', 'single-mismatch', 'leading-gap', 'inner-gap', 'affine-open', 'affine-extend', 'unicode-names', 'empty-query', 'empty-target', 'long-equal', 'band-edge', 'reverse']

/** A vitest run of 120 tests in 12 files: two failures, a slow test, and its totals (its double spaces are vitest's own). */
const VITEST = [
  ' RUN  v4.1.11 /work/align',
  '',
  ...cases.flatMap((name, f) => Array.from({ length: 10 }, (_, i) => (f === 3 && i < 2 ? undefined : ` ✓ tests/align/${name}.spec.ts > case ${i + 1} of ${name} ${(f * 7 + i * 3) % 19 + 1}ms`)).filter((l): l is string => !!l)),
  ' × tests/align/end-gaps.spec.ts > scores a gap at the end 12ms',
  '   → expected -3 to be -2 // Object.is equality',
  ' × tests/align/end-gaps.spec.ts > scores gaps at both ends 9ms',
  '   → expected -5 to be -4 // Object.is equality',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/align/end-gaps.spec.ts > scores a gap at the end',
  'AssertionError: expected -3 to be -2 // Object.is equality',
  ' ❯ tests/align/end-gaps.spec.ts:14:27',
  "     12|   it('scores a gap at the end', () => {",
  "     13|     const score = align('ACGT', 'ACG').score",
  '     14|     expect(score).toBe(-2)',
  '       |                   ^',
  '',
  ' FAIL  tests/align/end-gaps.spec.ts > scores gaps at both ends',
  'AssertionError: expected -5 to be -4 // Object.is equality',
  ' ❯ tests/align/end-gaps.spec.ts:21:27',
  '',
  'WARN tests/align/long-equal.spec.ts took 4.2 s, over the 2 s slow-test threshold',
  '',
  ' Test Files  1 failed | 11 passed (12)',
  '      Tests  2 failed | 118 passed (120)',
  '   Start at  09:14:02',
  '   Duration  6.41s (transform 812ms, setup 0ms, collect 1.20s, tests 4.38s)',
].join('\n')

/** A pytest run of 80 tests: two failures, one an assertion on the benchmark's speed-up. */
const PYTEST = [
  '============================= test session starts ==============================',
  'platform linux -- Python 3.14.2, pytest-9.1.0, pluggy-1.6.0',
  'rootdir: /work/align',
  'collected 80 items',
  '',
  'tests/test_align.py ........................................F.........  [ 62%]',
  'tests/test_bench.py .........................F....                         [100%]',
  '',
  '=================================== FAILURES ===================================',
  '_________________________________ test_end_gap _________________________________',
  '',
  '    def test_end_gap():',
  '>       assert align("ACGT", "ACG").score == -2',
  'E       assert -3 == -2',
  "E        +  where -3 = Alignment(score=-3, cigar='3M1D').score",
  '',
  'tests/test_align.py:41: AssertionError',
  '______________________________ test_band_speedup _______________________________',
  '',
  '    def test_band_speedup():',
  '        ratio = bench("reference") / bench("banded")',
  '>       assert ratio >= 1.5',
  'E       assert 1.38 >= 1.5',
  '',
  'tests/test_bench.py:27: AssertionError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_align.py::test_end_gap - assert -3 == -2',
  'FAILED tests/test_bench.py::test_band_speedup - assert 1.38 >= 1.5',
  '========================= 2 failed, 78 passed in 4.21s =========================',
].join('\n')

/** A criterion benchmark of both kernels on three sizes. */
const BENCH = [
  '     Running benches/align.rs (target/release/deps/align-1f2e3d4c5b6a7980)',
  'Gnuplot not found, using plotters backend',
  ...[['100', '41.502 µs', '17.188 µs', '-58.584%'], ['1000', '4.1937 ms', '1.7302 ms', '-58.743%'], ['10000', '419.88 ms', '173.41 ms', '-58.701%']].flatMap(([n, ref, band, change]) => [
    `align/reference/${n}     time:   [${ref} ${ref} ${ref}]`,
    `align/banded/${n}        time:   [${band} ${band} ${band}]`,
    `                        change: [${change} ${change} ${change}] (p = 0.00 < 0.05)`,
    '                        Performance has improved.',
    'Found 3 outliers among 100 measurements (3.00%)',
    '  2 (2.00%) high mild',
    '  1 (1.00%) high severe',
  ]),
].join('\n')

/** The validation step's report: each command, its exit code, and what it measured. */
const VALIDATION = [
  'npm test: exit 1',
  'Tests  2 failed | 118 passed (120)',
  'npm run bench: exit 0',
  'Median speed-up of the banded kernel over the reference: 2.42x (n=100, sizes 100 to 10000).',
  'Criterion a1: not met (npm test fails 2 end-gap tests).',
  'Criterion speed: met (npm run bench reports at least 1.5x).',
].join('\n')

/** The developer's final message: its hypothesis, its changes, and its risks. */
const DEVELOP = [
  'Hypothesis: restricting the inner loop to a band of width 2k+1 keeps every optimal alignment of the test set, so scores stay identical while the work drops from O(nm) to O(nk).',
  '',
  'Changes:',
  '- src/align/banded.ts: a new banded kernel; the reference kernel is unchanged.',
  '- src/align/index.ts: align() takes the banded kernel when |n - m| <= k.',
  '- tests/align/banded.spec.ts: 14 cases comparing both kernels.',
  '',
  'Risks:',
  "- End gaps are scored by the reference's rule; I did not check sequences whose optimal path leaves the band.",
  '- The band width k = 32 is a constant, so a long indel needs a wider band.',
  '',
  'Criterion a1: npm test should pass. Criterion speed: npm run bench should report at least 1.5x.',
].join('\n')

/** The exact-subject review of the change, as an assessment record. */
const ASSESSMENT = {
  schema: 'assessment@1.0',
  subject: { type: 'git-head', ref: '4f1c2e9a0b3d5c7e9f1a2b4c6d8e0f1a3b5c7d9e', version: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9' },
  verdict: 'changes-requested',
  findings: [
    { severity: 'blocking', title: 'align() takes the banded path when |n - m| <= k, but an optimal path may leave the band', detail: 'A sequence pair with a long indel near one end scores worse banded than with the reference kernel.', file: 'src/align/index.ts' },
    { severity: 'warning', title: 'k = 32 is hardcoded', detail: 'Make the band width a parameter with the reference kernel as the fallback above it.', file: 'src/align/banded.ts' },
    { severity: 'info', title: 'The tests compare both kernels on 14 cases' },
  ],
  reviewer: 'agent:reviewer',
}

/** The digest requests, each over the sources a lead would ask about together. */
export const FIXTURES: Fixture[] = [
  { name: 'vitest-run', sources: [{ name: 'vitest log', text: VITEST }] },
  { name: 'pytest-run', sources: [{ name: 'pytest log', text: PYTEST }] },
  { name: 'benchmark', sources: [{ name: 'benchmark output', text: BENCH }, { name: 'validation report', text: VALIDATION }] },
  { name: 'attempt', sources: [{ name: 'developer answer', text: DEVELOP }, { name: 'review assessment', kind: 'assessment', body: ASSESSMENT }, { name: 'validation report', text: VALIDATION }] },
  { name: 'validation-only', sources: [{ name: 'validation report', text: VALIDATION }] },
]
