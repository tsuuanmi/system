import { describe, expect, it } from 'vitest'
import { renderedWords, sameWords } from '../src/index.ts'

describe('Markdown from a Copy button is kept only when it is the rendered answer (REQ-PRV-5)', () => {
  it('reads the words a Markdown text renders to', () => {
    expect(renderedWords('## Plan\n* **First** item\n\nSee [example.com](https://example.com).\n```python\nx = 1\n```')).toEqual(['Plan', 'First', 'item', 'See', 'example', 'com', 'x', '1'])
  })

  it('matches Markdown to its rendering, and refuses another answer', () => {
    expect(sameWords('A **bold** claim with `code`, and [a source](https://src.example/a).', 'A bold claim with code, and a source.')).toBe(true)
    expect(sameWords('```ts\nconst x = 1\n```\n- one\n- two', 'ts\nCopy code\nconst x = 1\none\ntwo')).toBe(true)
    expect(sameWords('Another account\'s answer.', 'A bold claim with code, and a source.')).toBe(false)
    expect(sameWords('', 'anything')).toBe(false)
  })
})
