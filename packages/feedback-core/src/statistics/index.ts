/**
 * The evaluation engine's statistics library (docs/design/statistics.md): pure, deterministic
 * inference, pinned by version in each experiment (`STATISTICS`). It holds no threshold and decides
 * nothing; the verdict rule of `../evaluations` reads the intervals it gives.
 * @module @tsuuanmi/system-feedback-core/statistics
 */
export * from './method.ts'
export * from './sign-flip.ts'
