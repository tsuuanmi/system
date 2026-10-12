import { describe, expect, it } from 'vitest'
import { choose, parseAiSnapshot, scoreNodes } from '../src/heal.ts'

// Shape produced by patchright-core 1.63 `ariaSnapshot({ mode: 'ai' })` (pinned by engine.spec.ts).
const SNAPSHOT = `- generic [ref=e1]:
  - textbox "Message" [ref=e2]
  - button "Voice mode" [ref=e3]: 🎤
  - button "Send message" [ref=e4]: ↑
- button "Send feedback" [ref=e5]`

describe('self-heal matcher', () => {
  it('parses refs, roles, names, and parents', () => {
    const nodes = parseAiSnapshot(SNAPSHOT)
    expect(nodes.map((n) => [n.ref, n.role, n.name, n.parent])).toEqual([
      ['e1', 'generic', '', undefined], ['e2', 'textbox', 'Message', 0], ['e3', 'button', 'Voice mode', 0],
      ['e4', 'button', 'Send message', 0], ['e5', 'button', 'Send feedback', undefined],
    ])
  })

  it('prefers the role and name match next to the composer, and needs a clear lead', () => {
    const scored = scoreNodes(parseAiSnapshot(SNAPSHOT), { role: 'button', name: { en: 'send' }, nearRole: 'textbox' }, ['en'])
    expect(scored[0]).toMatchObject({ ref: 'e4', score: 1 })
    expect(scored.find((s) => s.ref === 'e5')!.score).toBe(0.9)
    expect(choose(scored)).toBeUndefined() // e4 (1.0) vs e5 (0.9): not a clear winner
    expect(choose(scored, { margin: 0.05 })?.ref).toBe('e4')
  })

  it('never scores a node of another role', () => {
    const scored = scoreNodes(parseAiSnapshot(SNAPSHOT), { role: 'link', name: { en: 'send' } }, ['en'])
    expect(scored).toEqual([])
  })
})
