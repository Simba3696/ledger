import { createElement, useEffect } from "react";
import type { ModuleName } from "../api";
import type { LedgerTab, LedgerView, LedgerViewSlot } from "../App";

// The open tab and month of the shared Ledger, kept across the remounts
// GitHub mode causes (#7): SyncHost re-keys the Ledger when another
// device's changes are joined, and Settings unmounts it. Without this, each
// one dropped the person back on the Dashboard. App.tsx reads the slot
// only in its GitHub branches (arguments[0], as for headerActions), so the
// default build is unchanged.

/** The section each tab after the Dashboard belongs to: App.tsx's NAV_TABS
 * (ledgerView.test.ts checks they match). */
export const TAB_MODULE: Record<Exclude<LedgerTab, "dashboard">, ModuleName> = {
  expenses: "expenses",
  creditCards: "credit-cards",
  debts: "debts",
  emi: "emi",
  subscriptions: "subscriptions",
  finances: "finances",
};

/** Commits the view on screen, after each render that is committed. */
function ReportView({ commit }: { commit: () => void }) {
  useEffect(commit);
  return null;
}

/** What the Ledger last showed, for the ledger open now. */
export class LedgerViewMemory {
  #scope: string | null = null;
  #view: LedgerView | null = null;

  /** The slot for the Ledger of `scope` (owner/repo): another ledger starts
   * afresh. `modules` reads the sections turned on now, or null when they
   * can't be read; a tab whose section is off opens the Dashboard. */
  slot(scope: string, modules: () => readonly ModuleName[] | null): LedgerViewSlot {
    if (scope !== this.#scope) {
      this.#scope = scope;
      this.#view = null;
    }
    const initial = (): LedgerView | null => {
      const view = this.#view;
      if (view === null || view.tab === "dashboard") return view;
      return modules()?.includes(TAB_MODULE[view.tab]) ? view : { ...view, tab: "dashboard" };
    };
    const commit = (view: LedgerView) => () => {
      if (this.#scope === scope) this.#view = view;
    };
    return {
      get initial() {
        return initial();
      },
      report: (view) => createElement(ReportView, { commit: commit(view) }),
    };
  }

  /** This device was forgotten: nothing of the ledger is kept, and a
   * report from the Ledger still on screen as it goes is ignored. */
  forget(): void {
    this.#scope = null;
    this.#view = null;
  }

  /** The next Ledger opens on the Dashboard (same month). */
  goHome(): void {
    if (this.#view) this.#view = { ...this.#view, tab: "dashboard" };
  }
}
