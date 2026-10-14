import type { ModuleName } from "../../api";

// Create's rules (#8): what the form must hold before anything is sent.
// Pure, so each refusal is tested without a DOM.

export const MIN_PASSPHRASE = 12;

/** Why the Create form can't be sent yet, or null. At least 12 characters
 * and no other composition rules; both fields the same; the "I've saved
 * it" box ticked (there is no recovery); at least one section, since an
 * empty list would mean every section, as ENABLED_MODULES reads it. */
export function createProblem(fields: { passphrase: string; confirm: string; saved: boolean; sections: readonly ModuleName[]; timeZone: string }): string | null {
  if (fields.passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters for the passphrase.`;
  if (fields.confirm !== fields.passphrase) return "The two passphrases don't match.";
  if (!fields.saved) return "Tick the box once you've saved the passphrase somewhere safe.";
  if (fields.sections.length === 0) return "Choose at least one section.";
  if (fields.timeZone.trim() === "") return "Choose a time zone.";
  return null;
}
