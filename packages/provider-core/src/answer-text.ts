/**
 * Answer text shared by website drivers (REQ-PRV-5): a site's
 * Copy button yields the answer's Markdown, which is kept only when its words are the words the
 * page rendered, since the clipboard may be shared.
 */

/** The words of a Markdown text as it renders: fences, emphasis, link targets, and markers dropped. */
export function renderedWords(markdown: string): string[] {
  const plain = markdown
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ' ')
  return plain.match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Whether Markdown is the rendered answer: its words appear in the rendered words in order, and
 * rendering added only labels (a code block's language and its Copy button), nothing else.
 */
export function sameWords(markdown: string, rendered: string): boolean {
  const md = renderedWords(markdown)
  const shown = rendered.match(/[\p{L}\p{N}]+/gu) ?? []
  const blocks = Math.ceil((markdown.match(/^```/gm) ?? []).length / 2)
  if (!md.length || shown.length - md.length > 2 + 3 * blocks) return false
  let at = 0
  for (const word of shown) if (at < md.length && word === md[at]) at++
  return at === md.length
}

