/**
 * The UI engine for website drivers (ADR-0021, docs/design/ui-operations.md).
 * @module @tsuuanmi/system-ui-ops
 */
export { type ActArgs, type ActOptions, type DriftEvent, type EngineOptions, type HealEvent, type Resolved, UiEngine } from './engine.ts'
export { type HealThresholds, type Scored, type SnapshotNode, choose, parseAiSnapshot, scoreNodes } from './heal.ts'
export { candidateFromLocator, localizedRegex, toLocator } from './locate.ts'
export { type ActionSpec, type Candidate, type Condition, type ElementSpec, type ErrorRule, type Fingerprint, type Localized, type NetworkPattern, type SideEffect, type SourcedCandidate, type UiMap, appendOverlay, loadUiMap } from './map.ts'
export { NetworkObserver } from './network.ts'
