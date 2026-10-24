/**
 * The lease cap the crash harnesses run with (`leases.maxTtlMs`, the plugin's own validated
 * setting): a restarted engine waits out the killed process's leases in about 10 s instead of their
 * 60 s. Nothing else about a restart changes: each lease still has to expire before anyone takes it,
 * and the new holder's generation fences the dead one (INV-4). Every lease those harnesses hold asks
 * for 60 s and is granted 10 s, so the cap keeps them in step; a held lease is renewed at a third of
 * the TTL it was granted (`leases.hold`), so a live holder keeps it however long it runs. The budget
 * harness, whose board task lease must outlive its run lease, keeps the default cap.
 */
export const LEASE_CAP_MS = 10_000
