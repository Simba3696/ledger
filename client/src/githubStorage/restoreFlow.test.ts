import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../backend/ApiError";
import { createEmptyDocument } from "../backend/document/createDocument";
import { GitHubAuthError, GitHubForbiddenError, GitHubNetworkError } from "../backend/github/contents";
import { RESTORE_UNKNOWN, type RestoreResult } from "../backend/sync/SyncEngine";
import { NOT_RESTORED, restoreWithQuestions, type Question } from "./restoreFlow";
import { READ_ONLY_TOKEN } from "./token";

// #9's restore over the open ledger: the questions before anything is
// written, and what each answer or error means. A stand-in engine records
// every restore call. Fictional data only.

const doc = createEmptyDocument({ modules: ["expenses"], timeZone: "UTC" });
const context = { repo: { owner: "alex", repo: "ledger-data", ownerIsOrg: false }, summary: "1 expense" };

function engineAnswering(...answers: (RestoreResult | Error)[]) {
  const calls: { discardUnsynced?: boolean }[] = [];
  return {
    calls,
    syncNow: vi.fn(async () => {}),
    restore: vi.fn(async (_doc: unknown, options: { discardUnsynced?: boolean } = {}) => {
      calls.push(options);
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

function asking(...replies: boolean[]) {
  const asked: Question[] = [];
  return { asked, ask: async (q: Question) => (asked.push(q), replies.shift() ?? false) };
}

describe("restoring a backup over the open ledger (#9)", () => {
  it("cancelling the confirmation restores nothing (AC 10)", async () => {
    const engine = engineAnswering();
    const { asked, ask } = asking(false);
    expect(await restoreWithQuestions(engine as never, doc, context, ask)).toEqual({ kind: "cancelled" });
    expect(engine.calls).toEqual([]);
    expect(asked[0]).toMatchObject({ destructive: true, message: expect.stringContaining("Replace all data in alex/ledger-data") });
  });

  it("with unsynced changes it offers Sync now, then restores; nothing is discarded unasked (AC 15)", async () => {
    const engine = engineAnswering({ kind: "unsynced", pendingCount: 2, leftBehindOwnCount: 0 }, { kind: "restored", epoch: "e2" });
    const { asked, ask } = asking(true, true);
    expect(await restoreWithQuestions(engine as never, doc, context, ask)).toEqual({ kind: "landed" });
    expect(engine.syncNow).toHaveBeenCalledOnce();
    expect(engine.calls).toEqual([{}, {}]);
    expect(asked[1]).toMatchObject({ confirmLabel: "Sync now", message: expect.stringContaining("2 changes on this device haven't reached GitHub yet") });
  });

  it("changes still unsynced are discarded only after a second warning that says they're lost", async () => {
    const engine = engineAnswering({ kind: "unsynced", pendingCount: 0, leftBehindOwnCount: 1 }, { kind: "restored", epoch: "e2" });
    const { asked, ask } = asking(true, true);
    expect(await restoreWithQuestions(engine as never, doc, context, ask)).toEqual({ kind: "landed" });
    expect(engine.calls).toEqual([{}, { discardUnsynced: true }]);
    expect(asked[1]).toMatchObject({ destructive: true, confirmLabel: "Restore anyway", message: expect.stringContaining("will be lost") });
    // Declining keeps them, and nothing more is sent.
    const again = engineAnswering({ kind: "unsynced", pendingCount: 0, leftBehindOwnCount: 1 });
    expect(await restoreWithQuestions(again as never, doc, context, asking(true, false).ask)).toEqual({ kind: "cancelled" });
    expect(again.calls).toEqual([{}]);
  });

  it("a restore another beat with a file this device can't open waits before reloading", async () => {
    const damagedFile = { path: "ledger/e000003-1.genesis.enc", epoch: "e000003-1", reason: "malformed" } as const;
    const engine = engineAnswering({ kind: "replaced", epoch: "e2", winner: "e000003-1", damagedFile });
    expect(await restoreWithQuestions(engine as never, doc, context, asking(true).ask)).toMatchObject({ kind: "waitDamaged" });
    // Without a damaged file, a replaced restore reloads like a landed one.
    const plain = engineAnswering({ kind: "replaced", epoch: "e2", winner: "e3" });
    expect(await restoreWithQuestions(plain as never, doc, context, asking(true).ask)).toEqual({ kind: "landed" });
  });

  it("says what went wrong, and only offline says nothing reached GitHub", async () => {
    const run = (answer: RestoreResult | Error) => restoreWithQuestions(engineAnswering(answer) as never, doc, context, asking(true).ask);
    expect(await run(new GitHubNetworkError())).toEqual({ kind: "failed", message: NOT_RESTORED });
    expect(await run(new GitHubAuthError())).toEqual({ kind: "tokenRefused" });
    expect(await run(new GitHubForbiddenError("Resource not accessible by personal access token"))).toEqual({ kind: "failed", message: READ_ONLY_TOKEN });
    // A restore already on its way says so, never "nothing was restored".
    expect(await run(new ApiError(503, RESTORE_UNKNOWN))).toEqual({ kind: "failed", message: RESTORE_UNKNOWN });
    expect(await run({ kind: "unknown", epoch: "e2" })).toEqual({ kind: "failed", message: RESTORE_UNKNOWN });
    expect(await run({ kind: "failed", detail: "GitHub refused it." })).toEqual({ kind: "failed", message: "GitHub refused it." });
  });
});
