export type Category = "food" | "transportation" | "rent" | "other";

export interface CategoryOption {
  id: Category;
  label: string;
}

export interface LedgerEntry {
  row: number;
  amount: number;
  remarks: string;
  isCard: boolean;
  cardNote: string | null;
  category: Category | null;
}

export interface NewEntry {
  year: number;
  month: number; // 1-12
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export interface EntryEdits {
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

const BASE = "/api";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function getCategories(): Promise<CategoryOption[]> {
  return fetch(`${BASE}/categories`).then((r) => handle(r));
}

export function getMonth(year: number, month: number): Promise<LedgerEntry[]> {
  return fetch(`${BASE}/months/${year}/${month}`).then((r) => handle(r));
}

export function addEntry(entry: NewEntry): Promise<LedgerEntry> {
  return fetch(`${BASE}/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  }).then((r) => handle(r));
}

export function updateEntry(
  year: number,
  month: number,
  row: number,
  edits: EntryEdits,
): Promise<LedgerEntry> {
  return fetch(`${BASE}/entries/${year}/${month}/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  }).then((r) => handle(r));
}

export function deleteEntry(year: number, month: number, row: number): Promise<void> {
  return fetch(`${BASE}/entries/${year}/${month}/${row}`, { method: "DELETE" }).then((r) => handle(r));
}

export function moveEntry(year: number, month: number, fromRow: number, toRow: number): Promise<void> {
  return fetch(`${BASE}/entries/${year}/${month}/${fromRow}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toRow }),
  }).then((r) => handle(r));
}
