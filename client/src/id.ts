/** A client-side-only unique id for React list keys (e.g. unsaved editable
 * rows that don't have a real server-assigned row number yet). Deliberately
 * not `crypto.randomUUID()` — that's only available in secure contexts
 * (HTTPS or localhost), so it silently breaks over a plain-HTTP LAN/Tailscale
 * address, which is exactly how this app gets reached from a phone. Nothing
 * here needs to be cryptographically random, just unique within one render. */
export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
