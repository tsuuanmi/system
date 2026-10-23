/**
 * Answer text shared by website drivers (REQ-PRV-5): a site's
 * Copy button yields the answer's Markdown, which is kept only when its words are the words the
 * page rendered, since the clipboard may be shared.
 */

const words = (text: string): string[] => text.match(/[\p{L}\p{N}]+/gu) ?? []

/**
 * The prose words of a Markdown text as it renders (fences, emphasis, and markers dropped), and
 * its links apart: a site may render a link's text, or show it as a citation chip that stands for
 * several sources ("Name +2"), so a link's words may or may not appear. Reference definitions
 * (`[1]: url "title"`) never render, and a bare marker of a defined reference (`[1]`) is a link.
 * Footnotes (`[^1]: text`) do render, so they stay prose.
 */
function renderedWords(markdown: string): { prose: string[]; linkWords: number; links: number } {
  let links = 0
  let linkWords = 0
  const link = (_: string, text: string): string => {
    links++
    linkWords += words(text).length
    return ' '
  }
  const definition = /^ {0,3}\[([^\]\n^][^\]\n]*)\]:[ \t]*\S.*$/gm
  const defined = new Set([...markdown.matchAll(definition)].map((m) => m[1]!.toLowerCase()))
  const plain = markdown
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(definition, ' ')
  const linked = replaceLinks(plain, link)
  const marked = replaceMarkers(linked, (marker, id) => defined.has(id.toLowerCase()) ? link(marker, id) : marker)
  return { prose: words(marked.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ' ')), linkWords, links }
}

/**
 * For each position of a text, the index of the next of `chars` at or after it (`-1` for none).
 * A link or marker scan looks its closing bracket up here, so it reads the text once: a
 * `\[[^\]]*\]` regex instead rescans to the end from every `[` of a run that is never closed,
 * which takes quadratic time on page text.
 */
function nextOf(text: string, chars: string): Int32Array {
  const next = new Int32Array(text.length + 1).fill(-1)
  for (let i = text.length - 1; i >= 0; i--) next[i] = chars.includes(text[i]!) ? i : next[i + 1]!
  return next
}

/**
 * Text with each link replaced, scanning left to right: `[label](target)` or `[label][id]`, an
 * image's `![label](target)` too, where the label runs to the first `]` and the target or id to
 * the first `)` or `]` after it (none of them nest).
 */
function replaceLinks(text: string, replace: (link: string, label: string) => string): string {
  const bracket = nextOf(text, ']')
  const paren = nextOf(text, ')')
  let out = ''
  let copied = 0
  for (let i = 0; i < text.length; i++) {
    const open = text[i] === '[' ? i : text[i] === '!' && text[i + 1] === '[' ? i + 1 : -1
    if (open < 0) continue
    const close = bracket[open + 1]!
    if (close < 0) continue
    const end = text[close + 1] === '(' ? paren[close + 2]! : text[close + 1] === '[' ? bracket[close + 2]! : -1
    if (end < 0) continue
    out += text.slice(copied, i) + replace(text.slice(i, end + 1), text.slice(open + 1, close))
    copied = end + 1
    i = end
  }
  return out + text.slice(copied)
}

/** Text with each bracketed marker on one line (`[1]`, `[name]`, not `[]`) replaced, scanning left to right. */
function replaceMarkers(text: string, replace: (marker: string, id: string) => string): string {
  const stop = nextOf(text, ']\n')
  let out = ''
  let copied = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue
    const close = stop[i + 1]!
    if (close <= i + 1 || text[close] !== ']') continue
    out += text.slice(copied, i) + replace(text.slice(i, close + 1), text.slice(i + 1, close))
    copied = close + 1
    i = close
  }
  return out + text.slice(copied)
}

/**
 * Whether Markdown is the rendered answer: its prose words appear in the rendered words in order,
 * and rendering added only labels: a code block's language and its Copy button, and for each link
 * its text and a chip's count.
 */
export function sameWords(markdown: string, rendered: string): boolean {
  return compareWords(markdown, rendered).same
}

/**
 * How Markdown compares with the rendered answer, as counts only (never words): its prose words,
 * the rendered words, how many prose words were found in order, its links and their words, and
 * how many extra rendered words are allowed. A refused Copy is recorded with them.
 */
export interface WordsComparison {
  same: boolean
  prose: number
  shown: number
  matched: number
  links: number
  linkWords: number
  allowance: number
}

export function compareWords(markdown: string, rendered: string): WordsComparison {
  const { prose, linkWords, links } = renderedWords(markdown)
  const shown = words(rendered)
  const blocks = Math.ceil((markdown.match(/^```/gm) ?? []).length / 2)
  const allowance = 2 + 3 * blocks + linkWords + 2 * links
  let matched = 0
  for (const word of shown) if (matched < prose.length && word === prose[matched]) matched++
  const same = prose.length > 0 && shown.length - prose.length <= allowance && matched === prose.length
  return { same, prose: prose.length, shown: shown.length, matched, links, linkWords, allowance }
}
