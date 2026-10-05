import { getSql, type Tx } from "./client.js";

/** Runs `fn` inside one transaction — every multi-statement write goes
 * through here (LLD §4.3), replacing the Excel edition's per-file lock.
 * Any throw rolls the whole thing back. */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await getSql().begin(fn)) as T;
}
