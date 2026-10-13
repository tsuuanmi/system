/**
 * Reading an answer the way every website driver does (REQ-PRV-5): its rendered text with code
 * indentation kept, and its Markdown from the page's own Copy control, kept only when its words
 * are the rendered answer's (the clipboard may be shared).
 */
import { sameWords } from '@tsuuanmi/system-provider-core'
import type { Locator } from 'patchright-core'
import type { UiEngine } from './engine.ts'

/** An element's text under `white-space: pre-wrap`, so runs of spaces (code indentation) survive; trimmed. */
export async function preWrapText(locator: Locator): Promise<string> {
  return (await locator.evaluate((el) => {
    ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
    return (el as HTMLElement).innerText
  }).catch(() => '')).trim()
}

/**
 * The answer's Markdown from its Copy control, tidied by the site's own rule; the rendered text
 * when there is no control, nothing was copied, the words differ, or anything fails.
 */
export async function copiedMarkdown(engine: UiEngine, rendered: string, control: () => Promise<Locator | undefined>, tidy: (markdown: string) => string | Promise<string>): Promise<string> {
  try {
    const copy = await control()
    const markdown = copy ? await engine.copied(copy) : ''
    if (!markdown || !sameWords(markdown, rendered)) return rendered
    return await tidy(markdown)
  } catch {
    return rendered
  }
}
