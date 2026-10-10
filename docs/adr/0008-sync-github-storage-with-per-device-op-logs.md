# ADR-0008: Sync GitHub storage through per-device op logs joined into registers

**Status:** Accepted (2026-10-10). Amends [ADR-0007](0007-serverless-github-storage-mode.md)'s storage layout and the epic's T5, #8 and #9. ADR-0007 itself is unchanged.

## Context
ADR-0007 stores a household's data as one shared `ledger.json.enc`. The first sync engine for it (#7) merged each device's copy three ways against a remembered base and wrote it back with a sha-guarded PUT. Six review rounds found 32 data-loss bugs. Most came from four sources: the shared file, the remembered base going stale when a PUT's response is lost, replaying in-flight edits, and treating timestamps as intent. Each fix added state, and that state opened the next hole. That branch was not merged.

The redesign (the spec in #7, accepted by the owner on 2026-10-10) removes those four sources rather than adding rules around them. GitHub mode is unreleased, so there is nothing to migrate.

Issue #10 had reserved ADR-0008 for its sign-in helper. This decision takes 0008, and #10 takes the next free number.

## Decision
These deviations from ADR-0007, the epic and its children (the spec's Appendix A) apply:
1. **Files.** The shared `ledger.json.enc` becomes one `genesis` per epoch plus per-device `log` and `snap` files, all in one `ledger/` folder: `<epochKey>.genesis.enc` and `<epochKey>.<deviceId>.<log|snap>.enc`. A device writes only its own files and a genesis it creates. Nothing is ever deleted. Every file uses ADR-0007's encryption format unchanged.
2. **Merge.** The three-way merge against a base, with a blocking prompt, becomes a join of registers. Every document part is a register `{value, tag}`, and the tag is `[Lamport L, deviceId]`. A join keeps the register with the greater tag, so conflicts resolve the same way on every device without blocking. The losing device gets a notice afterwards. The `conflict` status is removed.
3. **Deletes.** 90-day tombstones keyed by `deletedAt` become a deleted set that only grows during an epoch, and delete wins over a concurrent edit (remove-wins). The rule that a later `updatedAt` survives a tombstone and the restore re-stamp rule are removed. Wall-clock time orders nothing.
4. **Retry.** The sha-guarded retry on the shared file becomes a sha-guarded retry on the device's own file, still at most 4 PUTs a cycle.
5. **Restore (#9)** writes a new epoch genesis. The greatest epoch key with a listed genesis wins, and changes the restore left out are offered for re-apply. Export is the materialised document in the same encrypted format. Sync does not use the `restoredAt` marker.
6. `LedgerDocument.tombstones` stays in the type for `DocumentBackend`, and is always `[]` in GitHub mode.
7. **#8.** "Is there a ledger?" means "does a listing of `ledger/` contain a genesis?". Create is one genesis PUT.

Format details settled while building the core (stage 1):
- An equal tag can happen only after a fork. It is broken by comparing the values' canonical JSON, which is a total order with no collision risk, instead of comparing hashes of the values.
- A new list record's order key pads L to 16 digits. Every L below 2^50 has at most 16 digits, so the keys compare as strings in L order.
- Record ids are `crypto.randomUUID()` uuids. A genesis or backup must pass the deep `isWritableDocument` check, which uses the same field checks as the op validator.
- The structural validator is versioned by the per-file format version `fv`. Within one `fv` it may only be loosened, never tightened.
- `DocumentBackend`, `LedgerBackend` and `DocumentHost` do not change. A write that the diff can't represent as an op fails closed, with a 500 and the document untouched, instead of being dropped.

## Alternatives considered
- **Keep the shared file and fix the merge:** each of the 6 rounds tried this, and each fix created new bugs.
- **A CRDT library (Automerge, Yjs):** it adds a large dependency to the GitHub bundle. Its opaque binary history would sit inside our encryption, and it still needs our own rules for deletes, restores and one-writer files.
- **Edit wins over delete:** this needs a resurrection rule that depends on timestamps, which caused the earlier B2, B3 and B25 bugs. Remove-wins keeps the edit recoverable as "Add it back as a new entry".

## Consequences
- Convergence rests on one tested property: the join is commutative, associative and idempotent. `client/src/backend/sync/` holds the pure core and its law and convergence tests, and nothing in the app imports it yet.
- The repo grows by about 60-80 MB a year per active device, and nothing is pruned. A "start a fresh repo" procedure goes into `docs/DEPLOY-github.md` (#11).
- Two offline payments on one EMI keep one result (payments are state, not increments). Locks are not enforced across offline concurrency. Per-field merge can combine two people's edits to one expense.
- A future write path that the diff can't represent fails in tests, so it can't silently lose data. Adding one means extending the op format under a new `fv`.
