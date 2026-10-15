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
 */
function renderedWords(markdown: string): { prose: string[]; linkWords: number; links: number } {
  let links = 0
  let linkWords = 0
  const link = (_: string, text: string): string => {
    links++
    linkWords += words(text).length
    return ' '
  }
  const definition = /^ {0,3}\[([^\]\n]+)\]:[ \t]*\S+.*$/gm
  const defined = new Set([...markdown.matchAll(definition)].map((m) => m[1]!.toLowerCase()))
  const plain = markdown
    .replace(/^```[^\n]*$/gm, ' ')
    .replace(definition, ' ')
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, link)
    .replace(/\[([^\]\n]+)\]/g, (marker, id: string) => defined.has(id.toLowerCase()) ? link(marker, id) : marker)
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ' ')
  return { prose: words(plain), linkWords, links }
}

/**
 * Whether Markdown is the rendered answer: its prose words appear in the rendered words in order,
 * and rendering added only labels: a code block's language and its Copy button, and for each link
 * its text and a chip's count.
 */
export function sameWords(markdown: string, rendered: string): boolean {
  const { prose, linkWords, links } = renderedWords(markdown)
  const shown = words(rendered)
  const blocks = Math.ceil((markdown.match(/^```/gm) ?? []).length / 2)
  if (!prose.length || shown.length - prose.length > 2 + 3 * blocks + linkWords + 2 * links) return false
  let at = 0
  for (const word of shown) if (at < prose.length && word === prose[at]) at++
  return at === prose.length
}
