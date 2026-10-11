import type { DocumentHost, HostWrite } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import type { SyncEngine } from "./SyncEngine";

/** DocumentBackend's host (#5) over the sync engine. `current()` is the
 * document the engine materialised from its state; `commit(next)` turns the
 * write into one op, saves it on the device and only then shows it (design
 * section 3.5). `begin()` pins each DocumentBackend write to the revision
 * on screen when it was submitted, so the stale-UI fence (section 3.4)
 * judges it by what the user saw, however long it waits in the queue.
 * `amend(run)` is the same write pattern for notice actions and re-apply
 * (sections 4.1 and 9.4), which don't go through DocumentBackend; it takes
 * its turn among DocumentBackend's writes, which wait for it through the
 * handle's `ready`. */
export class SyncedHost implements DocumentHost {
  readonly #engine: SyncEngine;

  constructor(engine: SyncEngine) {
    this.#engine = engine;
  }

  current(): LedgerDocument {
    return this.#engine.current();
  }

  commit(next: LedgerDocument): Promise<void> {
    return this.#engine.commit(next);
  }

  begin(): HostWrite {
    return this.#engine.beginWrite();
  }

  amend(run: (doc: LedgerDocument) => void): Promise<void> {
    return this.#engine.amend(run);
  }
}
