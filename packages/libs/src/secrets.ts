/**
 * The paths that hold this process's secrets, outside the places that are always hidden: each
 * plugin that owns one (a vault and its key, a store, login profiles, a display cookie)
 * registers it for as long as it exists, and agent Workers never see a registered path
 * (ADR-0024). One registry per process: the host runs every plugin, and starts every agent
 * Worker, in one process, so only that process's registrations count; the CLI, a separate
 * process, registers nothing and starts no agent.
 */
import { resolve } from 'node:path'

const registered = new Map<string, number>()

/** Register `path` as secret; the returned function unregisters it (call it from a disposer). */
export function registerSecretPath(path: string): () => void {
  const key = resolve(path)
  registered.set(key, (registered.get(key) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const count = (registered.get(key) ?? 1) - 1
    if (count > 0) registered.set(key, count)
    else registered.delete(key)
  }
}

/** Every registered secret path, sorted. */
export function secretPaths(): string[] {
  return [...registered.keys()].sort()
}
