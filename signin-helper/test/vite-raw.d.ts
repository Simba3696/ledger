// The two Vite features envDocs.test.ts reads files with, typed without
// pulling in vite/client or Node.

declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob<T>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>;
}
