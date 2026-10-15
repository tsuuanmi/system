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

  // Shapes of web-cited answers (live, 2026-10-15): a citation renders as a chip with its
  // source's name, and one chip can stand for several sources ("+1"); tables render as cells.
  it('keeps a cited answer: inline citations, merged chips, and a table', () => {
    const markdown = 'Use OIDC trusted publishing. ([GitHub Docs](https://docs.github.com/a)) ([npm Docs](https://docs.npmjs.com/b))\n\n| Option | Assessment |\n|---|---|\n| A | good |'
    expect(sameWords(markdown, 'Use OIDC trusted publishing.\nGitHub Docs\n+1\n\nOption\n\n\t\n\nAssessment\n\nA\n\ngood')).toBe(true)
  })

  it('keeps reference-style citations, whose definitions never render', () => {
    const markdown = 'Pin actions by SHA ([GitHub Docs][1]).\n\n[1]: https://docs.github.com/en/actions/security "Security hardening"'
    expect(sameWords(markdown, 'Pin actions by SHA (GitHub Docs).')).toBe(true)
    expect(sameWords(markdown, 'Pin actions by SHA\nGitHub Docs\n+2')).toBe(true)
  })

  it('still refuses another answer citing the same sources, and more added than its links explain', () => {
    expect(sameWords('Never pin actions. ([GitHub Docs](https://docs.github.com/a))', 'Use OIDC trusted publishing.\nGitHub Docs\n+1')).toBe(false)
    expect(sameWords('Pin by SHA ([GitHub](https://github.com/a)).', 'Pin by SHA\nGitHub\n+1\nand also seven words someone else wrote here')).toBe(false)
  })

  it('keeps a Copy whose citations are bare markers of defined references', () => {
    const markdown = 'Attest the tarballs [1] and the SBOMs [2].\n\n[1]: https://github.com/actions/attest?utm_source=chatgpt.com "attest"\n[2]: https://pnpm.io/cli/sbom?utm_source=chatgpt.com "pnpm sbom"'
    expect(sameWords(markdown, 'Attest the tarballs\nGitHub\nand the SBOMs\npnpm\n+1.')).toBe(true)
    expect(sameWords('See [2] and [3].', 'See and.')).toBe(false)
  })
})
