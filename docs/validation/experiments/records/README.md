# Experiment records

The records of the [experiments](../README.md): plain JSON documents, one per record.

| File | Record | State |
|---|---|---|
| [lead-agnosticism-1.record.json](lead-agnosticism-1.record.json) | the [lead-agnosticism](../lead-agnosticism.md) run: a pass/fail check, outside PROP-0011 (no objective contract) | planned |

- **Append-only once frozen.** A change to a frozen record is a new revision (`revision` + 1,
  `supersedes` naming the old one), never an edit.
- **Evidence stays outside the repository.** Raw run exports and session transcripts are kept in
  the experiment's directory on the host; a record names each file with its sha256.
