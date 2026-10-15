/**
 * Reading an answer the way every website driver does (REQ-PRV-5): its rendered text with code
 * indentation kept, its Markdown from the page's own Copy control, kept only when its words are
 * the rendered answer's (the clipboard may be shared), and the targets of its links, which
 * rendered text drops.
 */
import { sameWords, withMissingSources } from '@tsuuanmi/system-provider-core'
import type { Locator } from 'patchright-core'
import type { UiEngine } from './engine.ts'

/** An element's text under `white-space: pre-wrap`, so runs of spaces (code indentation) survive; trimmed. */
export async function preWrapText(locator: Locator): Promise<string> {
  return (await locator.evaluate((el) => {
    ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
    return (el as HTMLElement).innerText
  }).catch(() => '')).trim()
}

/** The http(s) links in an element that leave the site (href → text, first text wins); empty when it cannot be read. */
export async function linksIn(locator: Locator): Promise<Map<string, string>> {
  const anchors = await locator.locator('a[href^="http"]').evaluateAll((links) => links
    .filter((a) => new URL((a as HTMLAnchorElement).href).origin !== location.origin)
    .map((a) => [(a as HTMLAnchorElement).href, (a.textContent ?? '').trim()]))
    .catch(() => [] as string[][])
  const links = new Map<string, string>()
  for (const [href, text] of anchors) if (href && !links.has(href)) links.set(href, text ?? '')
  return links
}

/**
 * The answer's Markdown from its Copy control, tidied by the site's own rule; the rendered text
 * when there is no control, nothing was copied, the words differ, or anything fails. Either way,
 * the links of the answer element that the text does not carry follow it as its sources, so a
 * cited answer keeps its URLs.
 */
export async function copiedMarkdown(engine: UiEngine, rendered: string, control: () => Promise<Locator | undefined>, tidy: (markdown: string) => string | Promise<string>, answer?: () => Promise<Locator | undefined>): Promise<string> {
  const text = await (async () => {
    try {
      const copy = await control()
      const markdown = copy ? await engine.copied(copy) : ''
      if (!markdown || !sameWords(markdown, rendered)) return rendered
      return await tidy(markdown)
    } catch {
      return rendered
    }
  })()
  const element = answer ? await answer().catch(() => undefined) : undefined
  return element ? withMissingSources(text, await linksIn(element)) : text
}
