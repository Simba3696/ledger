import postgres from "postgres";

// postgres.js type OIDs we override (LLD §4.2):
// - date (1082): keep the raw 'YYYY-MM-DD' string. A JS Date would be built
//   at the runtime's UTC/local midnight and shift a calendar day by the
//   offset — the domain code already speaks YYYY-MM-DD strings throughout.
// - numeric (1700): parse to number. Money is numeric(14,2), well inside
//   double precision, and the domain code rounds with round2 anyway.
// - int8 (20): parse to number. Identity ids stay far below 2^53.
const DATE_OID = 1082;
const NUMERIC_OID = 1700;
const INT8_OID = 20;

function createClient(url: string) {
  return postgres(url, {
    // Supabase's transaction pooler (port 6543, used in production) can't
    // keep prepared statements across pooled connections.
    prepare: false,
    // One connection per process / function instance; the pooler fans in.
    max: 1,
    idle_timeout: 20,
    types: {
      date: {
        to: DATE_OID,
        from: [DATE_OID],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
      numeric: {
        to: NUMERIC_OID,
        from: [NUMERIC_OID],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
      bigint: {
        to: INT8_OID,
        from: [INT8_OID],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
}

export type Sql = ReturnType<typeof createClient>;

let client: Sql | null = null;

/** Lazily created so modules can be imported (e.g. by tests that set
 * DATABASE_URL first) without connecting at import time. */
export function getSql(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = createClient(url);
  }
  return client;
}

/** Closes the shared connection — tests call this in afterAll so vitest
 * doesn't hang on an open socket. */
export async function closeSql(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    await c.end({ timeout: 5 });
  }
}
