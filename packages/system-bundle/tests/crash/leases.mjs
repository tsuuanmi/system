/**
 * The lease cap the crash harnesses run with (`leases.maxTtlMs`, the plugin's own validated
 * setting): a restarted engine waits out the killed process's leases in about 30 s instead of their
 * 60 s. Nothing else about a restart changes: each lease still has to expire before anyone takes it,
 * and the new holder's generation fences the dead one (INV-4). Every lease those harnesses hold asks
 * for 60 s, so the cap keeps them in step; the budget harness, whose board task lease must outlive
 * its run lease, keeps the default cap.
 *
 * Not lower: `leases.hold` renews on a heartbeat every third of the TTL its holder asks for (20 s
 * here), not of the capped TTL it was granted, so under a cap of 20 s or less a lease held longer
 * than the cap lapses between two heartbeats and its holder's commits are fenced. 30 s leaves the
 * heartbeat 10 s to spare.
 */
export const LEASE_CAP_MS = 30_000
