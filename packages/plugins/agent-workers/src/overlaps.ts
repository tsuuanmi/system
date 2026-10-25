/**
 * The runs in flight on each account, and the other runs each one overlapped (PROP-0015 E2): a run's
 * quota draw is `confounded` when another run on the same account ran at some time while it did, from
 * its reading before to its reading after, since the rise of a shared window is then not its alone.
 * In memory, as the runs are: a run a restart interrupted gets no reading after, so no draw (INV-4).
 */
export class Overlaps {
  /** By account, each run in flight and the other runs it has overlapped so far. */
  readonly #running = new Map<string, Map<string, Set<string>>>()

  /**
   * A run on `account` starts being watched: every run in flight there overlaps it, and it them. The
   * returned function ends it, once, and gives how many other runs it overlapped; calling it again
   * gives the same count.
   */
  begin(account: string, runId: string): () => number {
    const runs = this.#running.get(account) ?? this.#running.set(account, new Map()).get(account)!
    const mine = new Set<string>()
    for (const [other, theirs] of runs) {
      if (other === runId) continue
      theirs.add(runId)
      mine.add(other)
    }
    runs.set(runId, mine)
    let ended: number | undefined
    return () => {
      if (ended !== undefined) return ended
      ended = mine.size
      runs.delete(runId)
      if (!runs.size) this.#running.delete(account)
      return ended
    }
  }
}
