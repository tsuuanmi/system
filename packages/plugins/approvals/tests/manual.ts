// The store-backed provider with its own clock off, for tests that sweep and batch at the times
// they name. Production has no such switch: `sweepSeconds` is at least 1, so every request expires.
import StoreApprovals from '../src/index.ts'

export class ManualApprovals extends StoreApprovals {
  protected override clock(): void {}
}
