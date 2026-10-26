import { describe, expect, it } from 'vitest'
import { finalTreeReview } from '../src/risk.ts'

// A result's review verdict is the last review's of its final tree (T287). The reviews are the
// run's gates in run order: a review's earlier-round gate, and the verification gate that re-judged
// it, are of the tree before the fix.
const OLD = { ref: 'repo', version: 'aaa' }
const FINAL = { ref: 'repo', version: 'bbb' }
const gate = (node: string, verdict: string, subject: { ref: string; version: string }) => ({ node, verdict, subject })

describe('finalTreeReview (T287)', () => {
  it('reads approve when the final tree was approved after a verified changes-requested first round', () => {
    const reviews = [
      gate('review:1', 'changes-requested', OLD),
      gate('review:1:review:2', 'approve', FINAL),
      gate('review:1:second:review:2', 'approve', FINAL),
      // the verification gate of round one lands on review:1 after the rest in run order
      gate('review:1', 'changes-requested', OLD),
    ]
    expect(finalTreeReview(reviews, { type: 'git-head', ...FINAL })).toMatchObject({ node: 'review:1:second:review:2', verdict: 'approve' })
  })

  it('reads changes-requested when the last review of the final tree requests changes', () => {
    const reviews = [
      gate('review:1', 'changes-requested', OLD),
      gate('review:1:review:2', 'approve', FINAL),
      gate('review:1:review:3', 'changes-requested', FINAL),
      gate('review:1', 'approve', OLD),
    ]
    expect(finalTreeReview(reviews, { type: 'git-head', ...FINAL })).toMatchObject({ node: 'review:1:review:3', verdict: 'changes-requested' })
  })

  it('falls back to the last review when none is of the tree, or the result names no tree', () => {
    const reviews = [gate('review:1', 'approve', OLD), gate('review:2', 'changes-requested', OLD)]
    expect(finalTreeReview(reviews, FINAL)?.node).toBe('review:2')
    expect(finalTreeReview(reviews)?.node).toBe('review:2')
    expect(finalTreeReview([])).toBeUndefined()
  })
})
