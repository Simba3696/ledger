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

const BASE = "/api";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
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
