import { beforeEach, describe, expect, it } from "vitest";
import { createGitHubClient, GitHubNetworkError, ShaConflictError } from "./contents";
import { createFakeGitHub, type FakeGitHub } from "./fakeGitHub";

// The fake's own fault and assertion knobs (design section 16.3): what the
// sync engine's tests will lean on, beyond the recorded behaviour that
// fakeGitHub.fidelity.test.ts checks. Fictional owner, repo and tokens.

const REPO = "alex/ledger-data";
const WRITE = "github_pat_write";
const EPOCH = "e000001-9c1f22aa";
const ME = "d0123456789abcdef";
const OTHER = "dfedcba9876543210";
const MY_LOG = `ledger/${EPOCH}.${ME}.log.enc`;
const OTHER_LOG = `ledger/${EPOCH}.${OTHER}.log.enc`;

let fake: FakeGitHub;

beforeEach(() => {
  fake = createFakeGitHub({
    repos: [{ owner: "alex", name: "ledger-data", private: true }],
    tokens: { [WRITE]: { login: "alex", repos: [REPO], permission: "write" } },
  });
});

function client(fetchFn: typeof fetch = fake.fetch) {
  return createGitHubClient({ token: WRITE, owner: "alex", repo: "ledger-data", fetch: fetchFn });
}

const sync = "Sync 01234567" as const;

describe("fake GitHub faults", () => {
  it("landThenDropResponse: the write lands, the caller sees a network failure", async () => {
    fake.landThenDropResponse({ method: "PUT" });
    await expect(client().putFile({ path: MY_LOG, text: "v1", sha: null, message: sync })).rejects.toBeInstanceOf(GitHubNetworkError);
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v1");
    expect(fake.commits).toHaveLength(1);
  });

  it("landLater: the write times out at once and lands after N more requests, against the head then", async () => {
    const gh = client();
    const v1 = await gh.putFile({ path: MY_LOG, text: "v1", sha: null, message: sync });
    fake.landLater(2, { method: "PUT", path: MY_LOG });
    const late = await gh.putFile({ path: MY_LOG, text: "v2", sha: v1.sha, message: sync }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(GitHubNetworkError);
    expect((late as GitHubNetworkError).message).toBe("GitHub did not answer in time.");
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v1");

    // Another device commits meanwhile; the late PUT still lands on top.
    await gh.putFile({ path: OTHER_LOG, text: "other", sha: null, message: "Sync fedcba98" });
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v1");
    await gh.readFile(MY_LOG);
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v2");
    expect(fake.commits.map((c) => c.path)).toEqual([MY_LOG, OTHER_LOG, MY_LOG]);

    // landPending lands what is still held, without waiting for requests.
    const v2 = fake.file(REPO, MY_LOG)!.sha;
    fake.landLater(100, { method: "PUT" });
    await expect(gh.putFile({ path: MY_LOG, text: "v3", sha: v2, message: sync })).rejects.toBeInstanceOf(GitHubNetworkError);
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v2");
    fake.landPending();
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v3");
  });

  it("duplicateRequest: GitHub applies the PUT once and answers the repeat with 409", async () => {
    const gh = client();
    const v1 = await gh.putFile({ path: MY_LOG, text: "v1", sha: null, message: sync });
    fake.duplicateRequest({ method: "PUT" });
    const err = await gh.putFile({ path: MY_LOG, text: "v2", sha: v1.sha, message: sync }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShaConflictError);
    expect((err as ShaConflictError).reason).toBe("stale-sha");
    expect(fake.file(REPO, MY_LOG)?.text).toBe("v2");
    expect(fake.commits).toHaveLength(2);
  });

  it("failNext by path fails only the matching request", async () => {
    const gh = client();
    fake.failNext({ status: 500, path: OTHER_LOG });
    await gh.putFile({ path: MY_LOG, text: "mine", sha: null, message: sync });
    await expect(gh.putFile({ path: OTHER_LOG, text: "x", sha: null, message: sync })).rejects.toMatchObject({ status: 500 });
    expect(fake.file(REPO, OTHER_LOG)).toBeNull();
    fake.failNext({ network: true, path: /\/git\/ref\// });
    await expect(gh.getRef("main")).rejects.toBeInstanceOf(GitHubNetworkError);
    expect((await gh.getRef("main")).kind).toBe("head");
  });

  it("staleReads: branch-named reads lag, reads by sha never do", async () => {
    const gh = client();
    const v1 = await gh.putFile({ path: MY_LOG, text: "v1", sha: null, message: sync });
    const v2 = await gh.putFile({ path: MY_LOG, text: "v2", sha: v1.sha, message: sync });
    fake.staleReads(1);
    expect(await gh.getRef("main")).toMatchObject({ kind: "head", commitSha: v1.commitSha });
    expect(await gh.readFile(MY_LOG)).toEqual({ text: "v1", sha: v1.sha });
    expect((await gh.listDir(v2.commitSha)).files.map((f) => f.sha)).toEqual([v2.sha]);
    expect(await gh.readBlob(v2.sha)).toBe("v2");
    fake.staleReads(2);
    expect(await gh.getRef("main")).toEqual({ kind: "empty" });
    fake.staleReads(0);
    expect(await gh.getRef("main")).toMatchObject({ kind: "head", commitSha: v2.commitSha });
  });
});

describe("fake GitHub path ownership (AC10)", () => {
  it("lets a device write its own log and snap and create a genesis, and refuses and records anything else", async () => {
    const mine = client(fake.fetchAs(ME));
    await mine.putFile({ path: MY_LOG, text: "log", sha: null, message: sync });
    await mine.putFile({ path: `ledger/${EPOCH}.${ME}.snap.enc`, text: "snap", sha: null, message: "Snapshot 01234567" });
    const genesis = await mine.putFile({ path: `ledger/${EPOCH}.genesis.enc`, text: "g", sha: null, message: "Create ledger" });
    expect(fake.violations).toEqual([]);

    const refused = [
      { path: OTHER_LOG, sha: null },
      { path: `ledger/${EPOCH}.genesis.enc`, sha: genesis.sha },
      { path: "ledger.json.enc", sha: null },
      { path: `ledger/nested/${EPOCH}.${ME}.log.enc`, sha: null },
    ];
    for (const { path, sha } of refused) {
      await expect(mine.putFile({ path, text: "x", sha, message: sync }), path).rejects.toMatchObject({ status: 403 });
    }
    expect(fake.violations).toEqual(refused.map(({ path }) => `${ME} wrote ${path}`));
    expect(fake.file(REPO, OTHER_LOG)).toBeNull();

    // A plain fetch is not checked; a DELETE is always recorded.
    await client().putFile({ path: OTHER_LOG, text: "seeded", sha: null, message: sync });
    await fake.fetch(`https://api.github.com/repos/${REPO}/contents/${MY_LOG}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${WRITE}` },
    });
    expect(fake.violations.at(-1)).toBe(`DELETE /repos/${REPO}/contents/${MY_LOG}`);
    expect(fake.requests.at(-1)?.device).toBeUndefined();
  });
});
