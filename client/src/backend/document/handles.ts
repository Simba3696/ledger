/** The numeric `row` the UI addresses records by (api.ts's `row: number`),
 * mapped to the uuid a document record really has. One per DocumentBackend
 * and never persisted: handles are positive safe integers from a single
 * counter, assigned when a record is first listed (in document order) or
 * created, and kept for as long as the backend lives, so a row the UI holds
 * still names the same record after a sync replaces the host's document. */
export class RowHandles {
  #rowById = new Map<string, number>();
  #idByRow = new Map<number, string>();
  #next = 1;

  /** The record's handle, assigning the next one on first sight. */
  rowFor(id: string): number {
    let row = this.#rowById.get(id);
    if (row === undefined) {
      row = this.#next++;
      this.#rowById.set(id, row);
      this.#idByRow.set(row, id);
    }
    return row;
  }

  /** The record a handle names, if this backend ever issued it. */
  idFor(row: number): string | undefined {
    return this.#idByRow.get(row);
  }
}
