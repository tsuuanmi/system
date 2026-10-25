/**
 * The page's decision wording (T191): a button is labelled by its concept's one wording (Approve / Deny,
 * Accept / Send back, Confirm / Cancel, ...), and what it does is its accessible description
 * (aria-describedby). These read both as assistive technology gets them.
 */
import type { Locator } from 'patchright-core'

// Each id is looked up in the button's own tree, not only the document: the page re-renders every few seconds, and a
// button read just as its render is replaced is still described by the span beside it.
/** A button's accessible description: the text of every element its aria-describedby names, in order ('' when none, or one is missing). */
export const descriptionOf = (button: Locator): Promise<string> =>
  button.evaluate((b) => {
    const ids = (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    const root = b.getRootNode() as Document | Element
    const parts = ids.map((id) => 'getElementById' in root ? root.getElementById(id) : root.querySelector('#' + CSS.escape(id)))
    return parts.length && parts.every((p) => p !== null) ? parts.map((p) => p!.textContent ?? '').join(' ').trim() : ''
  })

/** Every enabled decision button in `scope`: its visible label and its accessible description. */
export const decisionsIn = (scope: Locator): Promise<{ label: string, description: string }[]> =>
  scope.locator('button[aria-describedby]').evaluateAll((buttons) => buttons.map((b) => ({
    label: (b.textContent ?? '').trim(),
    description: (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => {
      const root = b.getRootNode() as Document | Element
      return ('getElementById' in root ? root.getElementById(id) : root.querySelector('#' + CSS.escape(id)))?.textContent ?? ''
    }).join(' ').trim(),
  })))
