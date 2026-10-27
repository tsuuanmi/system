---
"@tsuuanmi/system-workflow": patch
---

The workflow test suite is leaner (T300): tests that repeated what another test of the same module already asserts, or that asserted a test fixture, are removed; every requirement and invariant keeps a citing test, and no source changed.
