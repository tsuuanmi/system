/**
 * A Worker's description in the operator's words (`capability-descriptor@1.7`): an optional field of
 * every configuration row that defines Workers (agent-workers `workers[]` and `roles[]`, models
 * `models[]`, accounts `accounts[]`), shown to people by the roster and never read by routing.
 * Shared by those rows' configuration schemas, so each refuses the same text. An account's display
 * label is the same kind of text, shorter.
 */

/** The most characters a configured description holds. */
export const MAX_DESCRIPTION = 200
/** A configured description: plain text on one line, 1 to {@link MAX_DESCRIPTION} characters, no control character. */
export const DESCRIPTION = /^[^\p{Cc}]{1,200}$/u

/** The most characters of an account's display label in the operator's words (agent-workers `assignments[].label`). */
export const MAX_LABEL = 64
/** A configured display label: plain text on one line, 1 to {@link MAX_LABEL} characters, no control character; for people only. */
export const LABEL = /^[^\p{Cc}]{1,64}$/u
