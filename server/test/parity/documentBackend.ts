// DocumentBackend over an in-memory host, set up the way the SQL side is:
// the same fixture, modules and time zone, and the clock vitest pins.
import type { ModuleName } from "../../../client/src/api";
import { DocumentBackend, type DocumentHost } from "../../../client/src/backend/document/DocumentBackend";
import { monthKey, type LedgerDocument } from "../../../client/src/backend/document/types";
import { ALL_MODULES, emptyIds, seedDocument, type Fixture, type SeedIds } from "./seed";

/** The simplest host: holds the latest document, and `replace` swaps it the
 * way a sync would. */
class MemoryHost implements DocumentHost {
  #doc: LedgerDocument;
  constructor(doc: LedgerDocument) {
    this.#doc = doc;
  }
  current(): LedgerDocument {
    return this.#doc;
  }
  async commit(next: LedgerDocument): Promise<void> {
    this.#doc = next;
  }
  replace(next: LedgerDocument): void {
    this.#doc = next;
  }
}

export interface DocumentSide {
  backend: DocumentBackend;
  ids: SeedIds;
  setModules(modules: ModuleName[] | undefined): void;
}

/** Seeds the document, reads every seeded record back once (which issues
 * its row handle, in document order) and only then applies the fixture's
 * modules, which may hide the sections those reads went through. */
export async function documentSide(fixture: Fixture, timeZone: string): Promise<DocumentSide> {
  const host = new MemoryHost(seedDocument(fixture, timeZone, () => crypto.randomUUID()));
  const backend = new DocumentBackend({ host, now: () => Date.now(), actor: "parity", newId: () => crypto.randomUUID() });

  const ids = emptyIds();
  for (const m of fixture.expenses ?? []) {
    ids.expenses.set(monthKey(m.year, m.month), (await backend.getMonth(m.year, m.month)).map((e) => e.row));
  }
  if (fixture.debts?.length) ids.debts = (await backend.getDebts()).map((d) => d.row);
  if (fixture.emis?.length) ids.emis = (await backend.getEmis()).map((e) => e.row);
  if (fixture.subscriptions?.length) ids.subscriptions = (await backend.getSubscriptions()).map((s) => s.row);

  const setModules = (modules: ModuleName[] | undefined) => {
    const doc = host.current();
    host.replace({ ...doc, settings: { ...doc.settings, modules: modules ?? ALL_MODULES } });
  };
  setModules(fixture.modules);
  return { backend, ids, setModules };
}
