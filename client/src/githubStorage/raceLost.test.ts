import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EngineState } from "../backend/sync/SyncEngine";
import { RACE_LOST, RACE_LOST_BACKUP, RaceLostPanel } from "./RaceLostPanel";
import { SyncLayers } from "./sync/SyncHost";
import type { SyncStateValue } from "./sync/syncContext";

// The bar's way on for the loser of a racing create (ADR-0008, D32).
// Server-rendered: the client tests have no DOM. Fictional data only.

function value(raceLost: EngineState["raceLost"]): SyncStateValue {
  return {
    status: "needsPassphrase",
    hasDocument: true,
    needsInit: false,
    unreadable: null,
    revision: 0,
    pendingCount: 1,
    deviceSaveFailed: false,
    volatile: false,
    noticeCount: 0,
    noticeRevision: 0,
    leftBehindCount: 0,
    leftBehindOwnCount: 0,
    damagedFile: raceLost ? { path: `ledger/${raceLost.winner}.genesis.enc`, epoch: raceLost.winner, reason: "foreignKey" } : null,
    epochGone: null,
    raceLost,
    keyNeeded: null,
    restore: null,
    notices: [],
    leftBehind: [],
    syncNow: async () => {},
    noticeAction: async () => {},
    dismissNotice: async () => {},
    reapply: async () => ({ applied: [], skipped: [] }),
    discard: async () => {},
  };
}

const render = (raceLost: EngineState["raceLost"]) =>
  renderToString(SyncLayers({ value: value(raceLost), revision: 0, bar: createElement(RaceLostPanel, { onJoin: () => {}, onBackup: async () => {}, onForget: async () => null }) }));

describe("RaceLostPanel (D32)", () => {
  it("says what happened and offers the join, and the backup-and-forget way for two different passphrases", () => {
    const html = render({ winner: "e000001-0000000b", joinable: true });
    expect(html).toContain(RACE_LOST.replaceAll("'", "&#x27;"));
    expect(html).toContain('data-testid="gh-join-race"');
    expect(html).toContain('data-testid="gh-race-backup"');
    expect(html).toContain('data-testid="gh-race-forget"');
  });

  it("for a ledger started from a backup, says the backup way and offers no join (review of D32)", () => {
    const html = render({ winner: "e000001-0000000b", joinable: false });
    expect(html).toContain(RACE_LOST_BACKUP.replaceAll("'", "&#x27;"));
    expect(html).not.toContain('data-testid="gh-join-race"');
    expect(html).toContain('data-testid="gh-race-backup"');
    expect(html).toContain('data-testid="gh-race-forget"');
  });

  it("shows nothing otherwise", () => {
    expect(render(null)).not.toContain("gh-join-race");
  });
});
