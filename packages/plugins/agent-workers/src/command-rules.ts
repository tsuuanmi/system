/**
 * The matcher of the autonomy policy's structured command rules (`autonomy-policy@1.4`,
 * docs/design/approvals.md#command-rules). A command is its argv, split on single spaces by the gate
 * after it refused every empty word and shell metacharacter; a rule allows it only when the program,
 * its literal words, every option, and every positional word are ones the rule names. Nothing is
 * guessed: a word no rule part accepts, an option cut short of its value, a count of positional words
 * out of bounds, or a path outside its scope fails the rule. Which rule matched is the caller's to
 * give the policy, which judges the command as `workspace-write` and records the rule's id.
 * Paths are judged by the caller's {@link CommandEnv}, which knows the worktree and the repository.
 * @module @tsuuanmi/system-agent-workers/command-rules
 */
import type { CommandPathScope, CommandRule, CommandValueKind } from '@tsuuanmi/system-approvals-core'

/**
 * A ref name, a hex id, or one with `^` suffixes: `/`-separated segments, each starting with a letter,
 * a digit, or `_`, holding no `..` and no segment that starts with `.`. So it can never name a path
 * that climbs out of the directory git runs in (`src/../../etc/passwd`): `git diff` takes two words
 * outside the repository for files, diffing them with no index (T276).
 */
export const REF_NAME = '[A-Za-z0-9_](?:[A-Za-z0-9_-]|\\.(?![./])|/(?=[A-Za-z0-9_]))*\\^*'
const TOKEN = `${REF_NAME}(?:~\\d{1,4})?`
/** A revision: a hex id, `HEAD`, `HEAD~N`, a branch name, or a range `a..b` / `a...b` of those. */
const REVISION = new RegExp(`^${TOKEN}(?:\\.\\.\\.?${TOKEN})?$`)
/** `<revision>:<path>`: a revision token, the path relative to the repository root. */
const REVISION_PATH = new RegExp(`^${TOKEN}:([A-Za-z0-9_.][A-Za-z0-9_./-]*)$`)
const NUMBER = /^\d{1,6}$/
const WORD_MAX = 200
/** The words a command has at most (INV-9). */
const ARGV_MAX = 80

/** How a rule's path words are judged: whether the word names a path allowed under `scope`. */
interface CommandEnv {
  path(word: string, scope: CommandPathScope): Promise<boolean>
}

interface Shape { kind: CommandValueKind; oneOf?: string[] | undefined; atMost?: number | undefined; pattern?: string | undefined; scope?: CommandPathScope | undefined }

/** Whether a word that starts with `-` could be read as an option by the program: a value or path never does. */
const optionLike = (word: string): boolean => word.startsWith('-')

async function accepts(shape: Shape, word: string, env: CommandEnv): Promise<boolean> {
  if (word.length === 0 || word.length > WORD_MAX) return false
  if (shape.oneOf) return shape.oneOf.includes(word)
  if (shape.pattern !== undefined && !new RegExp(shape.pattern).test(word)) return false
  switch (shape.kind) {
    case 'any': return true
    case 'word': return !optionLike(word)
    case 'number': return NUMBER.test(word) && (shape.atMost === undefined || Number(word) <= shape.atMost)
    case 'revision': return REVISION.test(word)
    case 'revision-path': {
      const path = REVISION_PATH.exec(word)?.[1]
      return path !== undefined && !path.split('/').some((segment) => segment === '..' || segment.toLowerCase() === '.git')
    }
    case 'path': return !optionLike(word) && shape.scope !== undefined && await env.path(word, shape.scope)
  }
}

/** Whether `argv` is exactly what `rule` allows. */
async function matchesRule(rule: CommandRule, argv: readonly string[], env: CommandEnv): Promise<boolean> {
  if (argv.length === 0 || argv.length > ARGV_MAX || argv[0] !== rule.program) return false
  // A word starting with `#` begins a shell comment: the shell drops it and every word after it, so the
  // command that runs is not the one matched (`vitest run #a.spec.ts` runs the whole suite). No rule allows one.
  if (argv.some((word) => word.startsWith('#'))) return false
  const words = rule.words ?? []
  if (argv.length < 1 + words.length || words.some((word, i) => argv[1 + i] !== word)) return false
  const rest = argv.slice(1 + words.length)
  const flags = new Set(rule.flags ?? [])
  const letters = rule.flagLetters !== undefined ? new RegExp(`^-[${rule.flagLetters}]+$`) : undefined
  const seen = new Set<string>()
  const groups = (rule.positionals ?? []).map((group) => ({ group, count: 0 }))
  let counted = false
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!
    if (flags.has(word)) {
      seen.add(word)
      continue
    }
    if (rule.countFlag === true && /^-\d{1,4}$/.test(word)) {
      if (counted) return false
      counted = true
      continue
    }
    if (letters?.test(word)) continue
    const option = (rule.options ?? []).find((o) => (o.name.endsWith('=') ? word.startsWith(o.name) : word === o.name))
    if (option) {
      const joined = option.name.endsWith('=')
      const value = joined ? word.slice(option.name.length) : rest[i + 1]
      if (value === undefined || !await accepts(option, value, env)) return false
      seen.add(option.name)
      if (!joined) i += 1
      continue
    }
    let placed = false
    for (const slot of groups) {
      if (slot.count < (slot.group.max ?? 1) && await accepts(slot.group, word, env)) {
        slot.count += 1
        placed = true
        break
      }
    }
    if (!placed) return false
  }
  return (rule.required ?? []).every((flag) => seen.has(flag)) && groups.every((slot) => slot.count >= (slot.group.min ?? 0))
}

/** The first of `rules` that allows `argv`, or undefined: the command stays a `command`. */
export async function matchCommandRule(rules: readonly CommandRule[], argv: readonly string[], env: CommandEnv): Promise<CommandRule | undefined> {
  for (const rule of rules) if (await matchesRule(rule, argv, env)) return rule
  return undefined
}
