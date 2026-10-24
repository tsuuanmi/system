/**
 * The UI engine for website drivers (ADR-0021, docs/design/ui-operations.md).
 * @module @tsuuanmi/system-ui-ops
 */
export { copiedMarkdown, linksIn, preWrapText } from './answers.ts'
export { type ActArgs, type ActOptions, type CandidateMatches, type CopyRefusedEvent, type DriftEvent, type EngineOptions, type HealEvent, type ReadbackDiff, type Resolved, type StallEvent, UiEngine, readbackDiff } from './engine.ts'
export { type HealThresholds, type Scored, type SnapshotNode, choose, parseAiSnapshot, scoreNodes } from './heal.ts'
export { candidateFromLocator, localizedRegex, toLocator } from './locate.ts'
export { type ActionSpec, type Candidate, type Condition, type ElementSpec, type ErrorRule, type Fingerprint, type Localized, type NetworkPattern, type SideEffect, type SourcedCandidate, type UiMap, appendOverlay, loadUiMap, unverifiedEntries } from './map.ts'
export { NetworkObserver } from './network.ts'
export { driftData, evidenceData, type EvidenceStore, OUTLINE_LIMITS, type OutlineNode, outlineOf, type UiOutline } from './outline.ts'
