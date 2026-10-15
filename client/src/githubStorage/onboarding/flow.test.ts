import { describe, expect, it } from "vitest";
import { OTHER_REPO } from "../token";
import { CREATE_UNKNOWN, flow, initialScreen, LISTING_CUT, NEEDS_UPDATE, STEPS, WRONG_PASSPHRASE, type FlowEvent, type Screen, type Target } from "./flow";

const alex: Target = { owner: "alex", repo: "ledger-data", ownerIsOrg: false };
const household: Target = { owner: "smith-household", repo: "ledger-data", ownerIsOrg: true };
const ok = { ok: true } as const;
const start = (over: Partial<Extract<FlowEvent, { type: "start" }>> = {}): FlowEvent => ({ type: "start", environment: ok, defaults: ok, saved: null, invite: null, ...over });
const run = (events: FlowEvent[], from: Screen = initialScreen()) => events.reduce(flow, from);
const walk = (path: "personal" | "household" | "member") => {
  const events: FlowEvent[] = [start(), { type: "choose", path }];
  if (path !== "personal") events.push({ type: "org", org: "smith-household" });
  for (let i = 1; i < STEPS[path].length; i++) events.push({ type: "next" });
  return run(events);
};

describe("the GitHub gate's flow (#8)", () => {
  it("an unsupported browser stops before anything else", () => {
    expect(run([start({ environment: { ok: false, message: "Ledger needs a secure (HTTPS) address" }, saved: { target: alex, hasKey: true } })])).toEqual({
      kind: "unsupported",
      message: "Ledger needs a secure (HTTPS) address",
    });
  });

  it("a misconfigured copy shows its message instead of onboarding", () => {
    expect(run([start({ defaults: { ok: false, message: "Unknown module in VITE_DEFAULT_MODULES: bogus." } })]).kind).toBe("misconfigured");
  });

  it("just me: repo, token, then the connect card", () => {
    const at = run([start(), { type: "choose", path: "personal" }]);
    expect(at).toMatchObject({ kind: "step", path: "personal", step: "repo" });
    expect(walk("personal")).toMatchObject({ kind: "step", path: "personal", step: "connect", owner: null, repo: "ledger-data" });
  });

  it("a household: the organization's name is needed before going on", () => {
    const stuck = run([start(), { type: "choose", path: "household" }, { type: "next" }]);
    expect(stuck).toMatchObject({ step: "org" });
    expect(walk("household")).toMatchObject({ kind: "step", path: "household", step: "connect", org: "smith-household", owner: "smith-household" });
  });

  it("joining a household: accept, token, connect; Back walks back to Welcome", () => {
    const at = walk("member");
    expect(at).toMatchObject({ step: "connect" });
    expect(run([{ type: "back" }, { type: "back" }, { type: "back" }], at)).toEqual({ kind: "welcome" });
  });

  it("an invite link opens on the joining path with its repo filled in", () => {
    expect(run([start({ invite: { owner: "org-a", repo: "ledger-data" } })])).toMatchObject({ kind: "step", path: "member", step: "accept", org: "org-a", owner: "org-a", repo: "ledger-data" });
  });

  it("no ledger in the repo goes to Create; one goes to Unlock", () => {
    const at = walk("personal");
    expect(run([{ type: "found", target: alex, found: { kind: "none" } }], at)).toEqual({ kind: "create", target: alex, path: "personal", error: null });
    expect(run([{ type: "found", target: alex, found: { kind: "ledger" } }], at)).toEqual({ kind: "unlock", target: alex, path: "personal", reason: "existing", error: null });
  });

  it("a newer ledger, a damaged genesis or a cut listing blocks, with a retry where it can help", () => {
    const at = walk("personal");
    expect(run([{ type: "found", target: alex, found: { kind: "needsUpdate" } }], at)).toEqual({ kind: "blocked", target: alex, path: "personal", message: NEEDS_UPDATE, retry: false });
    expect(run([{ type: "found", target: alex, found: { kind: "damaged", message: "Delete ledger/e000002-1.genesis.enc" } }], at)).toMatchObject({ kind: "blocked", retry: true });
    const cut = run([{ type: "found", target: alex, found: { kind: "unknown" } }], at);
    expect(cut).toEqual({ kind: "blocked", target: alex, path: "personal", message: LISTING_CUT, retry: true });
    expect(run([{ type: "retry" }], cut)).toMatchObject({ kind: "step", step: "connect", owner: "alex" });
  });

  it("creating: created opens the app; a create that lost a race, or found one made meanwhile, goes to Unlock", () => {
    const create = run([{ type: "found", target: household, found: { kind: "none" } }], walk("household"));
    expect(run([{ type: "created", created: { kind: "created" } }], create)).toEqual({ kind: "app", target: household });
    expect(run([{ type: "created", created: { kind: "replaced" } }], create)).toEqual({ kind: "unlock", target: household, path: "household", reason: "raceLost", error: null });
    expect(run([{ type: "created", created: { kind: "exists" } }], create)).toMatchObject({ kind: "unlock", reason: "createdMeanwhile" });
    expect(run([{ type: "created", created: { kind: "unknown" } }], create)).toEqual({ kind: "blocked", target: household, path: "household", message: CREATE_UNKNOWN, retry: true });
  });

  it("a wrong passphrase stays on Unlock; the right one opens the app", () => {
    const unlock = run([{ type: "found", target: alex, found: { kind: "ledger" } }], walk("personal"));
    const wrong = run([{ type: "wrongPassphrase" }], unlock);
    expect(wrong).toEqual({ kind: "unlock", target: alex, path: "personal", reason: "existing", error: WRONG_PASSPHRASE });
    expect(run([{ type: "unlocked" }], wrong)).toEqual({ kind: "app", target: alex });
  });

  it("a later start: a saved key opens the app, none asks for the passphrase, a key that no longer fits asks again", () => {
    expect(run([start({ saved: { target: alex, hasKey: true } })])).toEqual({ kind: "app", target: alex });
    expect(run([start({ saved: { target: alex, hasKey: false } })])).toMatchObject({ kind: "unlock", reason: "existing" });
    expect(run([start({ saved: { target: alex, hasKey: true } }), { type: "keyChanged" }])).toMatchObject({ kind: "unlock", reason: "keyChanged" });
  });

  it("a 401 goes to Replace token; a token for another repo is refused, the same repo's returns to the app", () => {
    const replace = run([start({ saved: { target: alex, hasKey: true } }), { type: "tokenRejected" }]);
    expect(replace).toEqual({ kind: "replaceToken", target: alex, error: null });
    expect(run([{ type: "tokenReplaced", target: { ...alex, repo: "other" } }], replace)).toEqual({ kind: "replaceToken", target: alex, error: OTHER_REPO });
    expect(run([{ type: "tokenReplaced", target: { ...alex, owner: "ALEX" } }], replace)).toEqual({ kind: "app", target: alex });
    expect(run([{ type: "forgotten" }], replace)).toEqual({ kind: "welcome" });
  });
  it("Back from Create, Unlock or a blocked screen returns to the connect card of the path that led there", () => {
    const create = run([{ type: "found", target: household, found: { kind: "none" } }], walk("household"));
    expect(run([{ type: "back" }], create)).toMatchObject({ kind: "step", path: "household", step: "connect", org: "smith-household" });
    const later = run([start({ saved: { target: household, hasKey: true } }), { type: "found", target: household, found: { kind: "unknown" } }]);
    expect(run([{ type: "back" }], later)).toMatchObject({ kind: "step", path: "member", step: "connect", owner: "smith-household" });
  });

  it("joining a household without an invite link waits for the organization's name", () => {
    const accept = run([start(), { type: "choose", path: "member" }]);
    expect(run([{ type: "next" }], accept)).toMatchObject({ step: "accept" });
    expect(run([{ type: "org", org: "smith-household" }, { type: "next" }], accept)).toMatchObject({ step: "token", org: "smith-household", owner: "smith-household" });
  });

  it("a refusal while Replace token already shows keeps its error; the gate opening the ledger goes to the app", () => {
    const shown = run([start({ saved: { target: alex, hasKey: true } }), { type: "tokenRejected" }, { type: "connectFailed", message: OTHER_REPO, awaitingApproval: false }]);
    expect(run([{ type: "tokenRejected" }], shown)).toEqual(shown);
    const blocked = run([{ type: "found", target: alex, found: { kind: "unknown" } }], run([start({ saved: { target: alex, hasKey: true } })]));
    expect(run([{ type: "opened", target: alex }], blocked)).toEqual({ kind: "app", target: alex });
  });

  it("back from signing in with GitHub (#10): the connect card of the path it started on, with the error if it failed", () => {
    const back = { type: "signInReturned", path: "household", org: "smith-household", owner: "smith-household", repo: "ledger-data" } as const;
    expect(run([start(), { ...back, error: null }])).toEqual({
      kind: "step",
      path: "household",
      step: "connect",
      org: "smith-household",
      owner: "smith-household",
      repo: "ledger-data",
      error: null,
      awaitingApproval: false,
    });
    expect(run([start(), { ...back, path: "personal", org: null, owner: null, error: "Sign-in didn't complete. Try again." }])).toMatchObject({
      path: "personal",
      step: "connect",
      error: "Sign-in didn't complete. Try again.",
    });
    // A device that already opened something isn't moved.
    expect(run([start({ saved: { target: alex, hasKey: true } }), { ...back, error: null }])).toEqual({ kind: "app", target: alex });
  });
});
