import { describe, expect, it } from 'vitest'
import { sameWords } from '../src/index.ts'

describe('Markdown from a Copy button is kept only when it is the rendered answer (REQ-PRV-5)', () => {
  it('drops heading, list, and fence markers and link targets, and allows a code block\'s label', () => {
    expect(sameWords('## Plan\n* **First** item\n\nSee [example.com](https://example.com).\n```python\nx = 1\n```', 'Plan\nFirst item\nSee example.com.\nPython\nx = 1')).toBe(true)
  })

  it('matches Markdown to its rendering, and refuses another answer', () => {
    expect(sameWords('A **bold** claim with `code`, and [a source](https://src.example/a).', 'A bold claim with code, and a source.')).toBe(true)
    expect(sameWords('```ts\nconst x = 1\n```\n- one\n- two', 'ts\nCopy code\nconst x = 1\none\ntwo')).toBe(true)
    expect(sameWords('Another account\'s answer.', 'A bold claim with code, and a source.')).toBe(false)
    expect(sameWords('', 'anything')).toBe(false)
  })
})
