# @tsuuanmi/system-blobs

**`ctx.blobs`**: content-addressed files for large artifact bodies
([artifacts storage](../../../docs/design/artifacts.md#storage)).

- **Owns:**
  - `put`: deduplicated, written atomically with mode `0600` under
    `<dir>/sha256/<aa>/<hex>`.
  - `get`: verifies the bytes against their address and throws `BlobCorrupted` on
    a mismatch.
  - `has` and `size`.
- **Not reused:** DSH `ctx.attachments`. It normalizes images and binds files to
  sessions, so it is a prompt-attachment store, not a generic one.
- **Config:** `dir`, `maxBytes`.
- **Note:** files are not encrypted at rest. Local-private bodies rely on owner-only
  permissions, as the threat model states.
