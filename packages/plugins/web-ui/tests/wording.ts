/**
 * The page's decision wording (T191): a button is labelled by its concept's one wording (Approve / Deny,
 * Accept / Send back, Confirm / Cancel, ...), and what it does is its accessible description
 * (aria-describedby). These read both as assistive technology gets them.
 */
import type { Locator } from 'patchright-core'

/** A button's accessible description: the text of every element its aria-describedby names, in order ('' when none, or one is missing). */
export const descriptionOf = (button: Locator): Promise<string> =>
  button.evaluate((b) => {
    const ids = (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    const parts = ids.map((id) => document.getElementById(id))
    return parts.length && parts.every((p) => p !== null) ? parts.map((p) => p!.textContent ?? '').join(' ').trim() : ''
  })

/** Every enabled decision button in `scope`: its visible label and its accessible description. */
export const decisionsIn = (scope: Locator): Promise<{ label: string, description: string }[]> =>
  scope.locator('button[aria-describedby]').evaluateAll((buttons) => buttons.map((b) => ({
    label: (b.textContent ?? '').trim(),
    description: (b.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim(),
  })))
