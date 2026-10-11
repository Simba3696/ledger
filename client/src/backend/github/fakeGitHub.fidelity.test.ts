import { beforeEach, describe, expect, it } from "vitest";
import recorded from "./__fixtures__/github-behaviour.json";
import { ShaConflictError } from "./contents";
import { BROWSER_VISIBLE_HEADERS, createFakeGitHub, PREFLIGHT_ALLOWED_HEADERS, type FakeGitHub } from "./fakeGitHub";

// Fidelity: the fake against what the real GitHub API did when probed
// (docs/architecture/github-api-behaviour.md, recorded in
// __fixtures__/github-behaviour.json). Each test sends the requests the
// probe sent, through the fake as a browser sees it, and asserts the
// fake's answer equals the recorded one. The expected values come from the
// fixture wherever it holds them, so re-recording it re-checks the fake.
// Fictional owner, repo, tokens and content only.

const API = "https://api.github.com";
const REPO = "alex/ledger-data";
const R = `/repos/${REPO}`;
const WRITE = "github_pat_write";
const JSON_ACCEPT = "application/vnd.github+json";
const RAW = "application/vnd.github.raw";
const RAW_JSON = "application/vnd.github.raw+json";
/** The probe's file names, reused so recorded messages compare verbatim. */
const LOG = "ledger/e000001-9c1f22aa.d7c41e0a95b2d4f1.log.enc";
const OTHER_LOG = "ledger/e000001-9c1f22aa.d03ab9e2c1f4a702.log.enc";
const GENESIS = "ledger/e000001-9c1f22aa.genesis.enc";

let fake: FakeGitHub;

/** git's blob id, computed here with Web Crypto rather than taken from the
 * fake or the client under test. */
async function gitBlobSha(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const data = new Uint8Array([...new TextEncoder().encode(`blob ${bytes.length}\0`), ...bytes]);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", data)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newFake(options: Parameters<typeof createFakeGitHub>[0] = {}): FakeGitHub {
  return createFakeGitHub({
    repos: [{ owner: "alex", name: "ledger-data", private: true }],
    tokens: { [WRITE]: { login: "alex", repos: [REPO], permission: "write" } },
    ...options,
  });
}

beforeEach(() => {
  fake = newFake();
});

interface Answer {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null for an empty or non-JSON body. */
  body: any;
  bytes: Uint8Array;
}

interface CallOptions {
  accept?: string;
  body?: unknown;
  ifNoneMatch?: string;
  token?: string | null;
  version?: boolean;
  via?: FakeGitHub;
}

/** One request as a browser app would send it. `path` is under the API
 * base; "{r}" stands for this repo's /repos/{owner}/{name}. */
async function call(method: string, path: string, options: CallOptions = {}): Promise<Answer> {
  const { accept = JSON_ACCEPT, body, ifNoneMatch, token = WRITE, version = true, via = fake } = options;
  const headers: Record<string, string> = { Accept: accept };
  if (version) headers["X-GitHub-Api-Version"] = "2022-11-28";
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (ifNoneMatch !== undefined) headers["If-None-Match"] = ifNoneMatch;
  const res = await via.fetch(`${API}${path.replace("{r}", R)}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let parsed: unknown = null;
  try {
    parsed = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, bytes };
}

const b64 = (text: string) => btoa(text);
const put = (path: string, text: string, sha?: string, options: CallOptions = {}) =>
  call("PUT", `{r}/contents/${path}`, { ...options, body: { message: "Sync d7c41e0a", content: b64(text), ...(sha ? { sha } : {}) } });
const used = (a: Answer) => Number(a.headers.get("x-ratelimit-used"));
const sorted = (keys: Iterable<string>) => [...keys].sort();
const keysOf = (value: object) => sorted(Object.keys(value));
/** The fixture's path template, for this repo. */
const here = (path: string) => path.replace("/repos/{o}/{r}", R);

/** Lines of GitHub's base64: 60 characters each, the last shorter, and a
 * trailing newline. */
function expectWrapped60(content: string) {
  expect(content.endsWith("\n")).toBe(true);
  const lines = content.slice(0, -1).split("\n");
  for (const line of lines.slice(0, -1)) expect(line).toHaveLength(recorded.contents.file.base64.lineLength);
  expect(lines.at(-1)!.length).toBeLessThanOrEqual(60);
}

describe("fake GitHub fidelity: empty repository (section 1)", () => {
  it("answers every recorded empty-repo request as GitHub did", async () => {
    // The plural git/refs is not modelled: Ledger reads the singular
    // git/ref, because the plural does a prefix match (section 5).
    const unmodelled = ["/repos/{o}/{r}/git/refs/heads"];
    for (const expected of recorded.emptyRepo.responses) {
      const got = await call(expected.method, here(expected.path));
      if (unmodelled.includes(expected.path)) {
        expect(got.status, expected.path).toBe(501);
        continue;
      }
      expect(got.status, expected.path).toBe(expected.status);
      if (expected.path.endsWith("(no Authorization)")) {
        expect(got.headers.get("x-ratelimit-limit"), expected.path).toBe(String(recorded.rateLimit.unauthenticatedLimit));
      }
      expect(got.body, expected.path).toEqual({
        message: expected.message,
        documentation_url: expected.documentation_url,
        status: expected.statusField,
      });
    }
  });

  it("creates the first commit, with no parents, from a PUT without a sha", async () => {
    const got = await put(GENESIS, "genesis v1");
    expect(got.status).toBe(recorded.emptyRepo.firstPut.status);
    expect(got.body.commit.parents).toEqual(recorded.emptyRepo.firstPut.commitParents);
    expect(got.body.content.sha === (await gitBlobSha("genesis v1"))).toBe(recorded.emptyRepo.firstPut.contentShaIsGitBlobSha);
    expect(fake.file(REPO, GENESIS)?.text).toBe("genesis v1");
  });
});

describe("fake GitHub fidelity: PUT (sections 2 and 3)", () => {
  it("answers with GitHub's response shape", async () => {
    const first = await put(LOG, "log v1");
    const got = await put(LOG, "log v2", first.body.content.sha);
    expect(keysOf(got.body)).toEqual(sorted(recorded.put.responseKeys.top));
    expect(keysOf(got.body.content)).toEqual(sorted(recorded.put.responseKeys.content));
    expect(keysOf(got.body.commit)).toEqual(sorted(recorded.put.responseKeys.commit));
    // "array of {sha, url, html_url}; [] for the repo's first commit"
    expect(got.body.commit.parents).toHaveLength(1);
    expect(keysOf(got.body.commit.parents[0])).toEqual(keysOf(recorded.samples.putCreated.commit.parents[0]));
    expect(got.body.commit.parents[0].sha).toBe(first.body.commit.sha);
    expect(keysOf(got.body.commit.tree)).toEqual(keysOf(recorded.samples.putCreated.commit.tree));
    expect(got.body.content.sha === (await gitBlobSha("log v2"))).toBe(recorded.put.contentShaIsGitBlobSha);
  });

  // Each recorded case, by its name in the fixture. A case added to the
  // fixture fails here until the fake models it.
  const cases: Record<string, () => Promise<{ got: Answer; sentSha?: string; check?: (got: Answer) => void | Promise<void> }>> = {
    "create, no sha, path absent": async () => ({ got: await put(LOG, "v1") }),
    "create, no sha, path exists": async () => {
      await put(LOG, "v1");
      return { got: await put(LOG, "v2") };
    },
    "update, well-formed but wrong sha": async () => {
      await put(LOG, "v1");
      return { got: await put(LOG, "v2", "6abd7d5cdfbf9c44a806872d2e0f200e39cf70c5") };
    },
    "update, malformed sha ('abc')": async () => {
      await put(LOG, "v1");
      return { got: await put(LOG, "v2", "abc") };
    },
    "update, current sha": async () => {
      const v1 = await put(LOG, "v1");
      return { got: await put(LOG, "v2", v1.body.content.sha) };
    },
    "update, current sha, byte-identical content": async () => {
      const v1 = await put(LOG, "same bytes");
      const got = await put(LOG, "same bytes", v1.body.content.sha);
      return {
        got,
        check: (g) => {
          // A new commit that moves the ref, with the same blob and tree.
          expect(g.body.commit.sha).not.toBe(v1.body.commit.sha);
          expect(g.body.content.sha).toBe(v1.body.content.sha);
          expect(g.body.commit.tree.sha).toBe(v1.body.commit.tree.sha);
          expect(fake.head(REPO)).toBe(g.body.commit.sha);
        },
      };
    },
    "resend after the first landed (old sha, same content)": async () => {
      const v1 = await put(LOG, "v1");
      await put(LOG, "v2", v1.body.content.sha);
      return { got: await put(LOG, "v2", v1.body.content.sha), sentSha: v1.body.content.sha };
    },
    "create, path absent, a sha supplied anyway": async () => {
      await put(OTHER_LOG, "something else");
      return { got: await put(LOG, "v1", "6abd7d5cdfbf9c44a806872d2e0f200e39cf70c5") };
    },
    "content base64 wrapped at 60 chars with \\n": async () => {
      const text = "wrapped content ".repeat(20);
      const wrapped = btoa(text).replace(/.{60}/g, "$&\n");
      const got = await call("PUT", `{r}/contents/${LOG}`, { body: { message: "Sync d7c41e0a", content: wrapped } });
      return { got, check: async (g) => expect(g.body.content.sha).toBe(await gitBlobSha(text)) };
    },
    "content not valid base64": async () => ({
      got: await call("PUT", `{r}/contents/${LOG}`, { body: { message: "Sync d7c41e0a", content: "not base64!" } }),
    }),
  };

  it("models every recorded PUT case", () => {
    expect(sorted(Object.keys(cases))).toEqual(sorted(recorded.put.cases.map((c) => c.name)));
  });

  for (const expected of recorded.put.cases) {
    it(`${expected.name}: ${expected.status}`, async () => {
      const scenario = cases[expected.name];
      expect(scenario, expected.name).toBeDefined();
      const { got, sentSha, check } = await scenario();
      expect(got.status).toBe(expected.status);
      if ("message" in expected && expected.message) {
        // The resent sha is the probe's own blob sha; ours stands in for it.
        const message = sentSha ? expected.message.replace(/[0-9a-f]{40}$/, sentSha) : expected.message;
        expect(got.body.message).toBe(message);
        expect(keysOf(got.body)).toEqual(sorted(recorded.put.errorBodyShape.keys));
        expect(typeof got.body.status === "string").toBe(recorded.put.errorBodyShape.statusFieldIsString);
      }
      if ("contentShaIsGitBlobSha" in expected) expect(got.status).toBeLessThan(300);
      await check?.(got);
    });
  }
});

describe("fake GitHub fidelity: PUTs git can't hold (not recorded)", () => {
  // Git can't hold a file and a directory at one path, so GitHub must refuse
  // these, but its status was never probed (github-api-behaviour.md section
  // 19). The fake answers 501 and records the request in `unhandled` rather
  // than guessing a status or committing a tree that contradicts its files.
  it("refuses a PUT onto a directory, leaving the branch where it was", async () => {
    await put(LOG, "log v1");
    const head = fake.head(REPO);
    const got = await put("ledger", "a file where a directory is");
    expect(got.status).toBe(501);
    expect(fake.unhandled.map((r) => r.path)).toEqual(["/repos/alex/ledger-data/contents/ledger"]);
    expect(fake.head(REPO)).toBe(head);
    const tree = await call("GET", "{r}/git/trees/main?recursive=1");
    expect(tree.body.tree.map((e: { path: string }) => e.path)).toEqual(["ledger", LOG]);
  });

  it("refuses a PUT under a path that is a file", async () => {
    await put(LOG, "log v1");
    const head = fake.head(REPO);
    const got = await put(`${LOG}/inside`, "a file under a file");
    expect(got.status).toBe(501);
    expect(fake.unhandled).toHaveLength(1);
    expect(fake.head(REPO)).toBe(head);
    expect(fake.file(REPO, LOG)?.text).toBe("log v1");
  });
});

describe("fake GitHub fidelity: concurrent PUTs race on the branch ref (section 4)", () => {
  const race = new RegExp(recorded.concurrency.branchRaceMessagePattern);

  /** One round: each path's current sha, then one PUT per path at once. */
  async function round(paths: string[], via = fake) {
    const shas = await Promise.all(paths.map(async (p) => (await call("GET", `{r}/contents/${p}`, { via })).body.sha as string));
    const base = via.head(REPO);
    const answers = await Promise.all(paths.map((p, i) => put(p, `${p} ${Math.random()}`, shas[i], { via })));
    return { base, shas, answers };
  }

  async function seedLogs(via: FakeGitHub, n: number): Promise<string[]> {
    const paths = Array.from({ length: n }, (_, i) => `ledger/e000001-9c1f22aa.d${String(i).padStart(16, "0")}.log.enc`);
    await via.seedFiles(REPO, Object.fromEntries(paths.map((p) => [p, `${p} v0`])));
    return paths;
  }

  it("two paths at once: one wins, the other gets 409 'is at <head> but expected <base>'", async () => {
    const recordedRun = recorded.concurrency.differentPaths2;
    const paths = await seedLogs(fake, 2);
    let conflicts = 0;
    for (let r = 0; r < recordedRun.rounds; r++) {
      const { base, answers } = await round(paths);
      const winners = answers.filter((a) => a.status === 200);
      const losers = answers.filter((a) => a.status === 409);
      expect(winners).toHaveLength(1);
      conflicts += losers.length;
      expect(winners[0].body.commit.parents[0].sha).toBe(base);
      for (const loser of losers) {
        expect(loser.body.message).toMatch(race);
        expect(loser.body.message).toBe(`is at ${winners[0].body.commit.sha} but expected ${base}`);
      }
    }
    expect(conflicts).toBe(recordedRun.conflicts409);
  });

  it("three paths at once: never kinder than GitHub, and can chain two winners as GitHub once did", async () => {
    const recordedRun = recorded.concurrency.differentPaths3;
    const paths = await seedLogs(fake, 3);
    let conflicts = 0;
    for (let r = 0; r < recordedRun.rounds; r++) {
      const { answers } = await round(paths);
      expect(answers.filter((a) => a.status === 200).length).toBeGreaterThanOrEqual(1);
      conflicts += answers.filter((a) => a.status === 409).length;
    }
    expect(conflicts).toBeGreaterThanOrEqual(recordedRun.conflicts409);
    expect(conflicts).toBeLessThanOrEqual(recordedRun.puts - recordedRun.rounds);

    // "branchRace: rebase" is the round where GitHub applied a second PUT
    // on top of the first: its parent is the first winner's commit.
    expect(recordedRun.roundsWithTwoWinnersChained).toBeGreaterThan(0);
    const rebasing = newFake({ branchRace: "rebase" });
    const twoPaths = await seedLogs(rebasing, 2);
    const { base, answers } = await round(twoPaths, rebasing);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(answers[0].body.commit.parents[0].sha).toBe(base);
    expect(answers[1].body.commit.parents[0].sha).toBe(answers[0].body.commit.sha);
  });

  it("the same path twice at once: one wins, and the loser gets the branch-race message, not 'does not match'", async () => {
    const recordedRun = recorded.concurrency.samePath2;
    const [path] = await seedLogs(fake, 1);
    let conflicts = 0;
    for (let r = 0; r < recordedRun.rounds; r++) {
      const { shas, answers } = await round([path, path]);
      expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
      for (const loser of answers.filter((a) => a.status === 409)) {
        expect(loser.body.message).toMatch(race);
        // The loser's sha is no longer current: the winner changed the file.
        // Resending the identical PUT gets "does not match", so a branch
        // race does not prove the sha still holds.
        const resent = await put(path, "resent", shas[0]);
        expect(resent.status).toBe(409);
        expect(resent.body.message).toBe(`${path} does not match ${shas[0]}`);
        expect(new ShaConflictError(409, resent.body.message).reason).toBe("stale-sha");
      }
      conflicts += answers.filter((a) => a.status === 409).length;
    }
    expect(conflicts).toBe(recordedRun.conflicts409);
  });

  it("without putLatencyMs only PUTs sent in the same tick race; with it, PUTs sent 1 ms apart race as on GitHub", async () => {
    const recordedRun = recorded.concurrency.differentPaths2;
    const staggered = async (via: FakeGitHub) => {
      const paths = await seedLogs(via, 2);
      let conflicts = 0;
      for (let r = 0; r < recordedRun.rounds; r++) {
        const shas = await Promise.all(paths.map(async (p) => (await call("GET", `{r}/contents/${p}`, { via })).body.sha as string));
        const first = put(paths[0], `a ${r}`, shas[0], { via });
        await new Promise((resolve) => setTimeout(resolve, 1));
        const second = put(paths[1], `b ${r}`, shas[1], { via });
        const answers = await Promise.all([first, second]);
        for (const a of answers.filter((a) => a.status === 409)) expect(a.body.message).toMatch(race);
        conflicts += answers.filter((a) => a.status === 409).length;
      }
      return conflicts;
    };
    expect(await staggered(fake)).toBe(0);
    expect(await staggered(newFake({ putLatencyMs: 20 }))).toBe(recordedRun.conflicts409);
  });

  it("two first commits at once on an empty repo: the loser gets the recorded branch-race shape", async () => {
    const answers = await Promise.all([put(GENESIS, "g1"), put("ledger/e000001-77aa77aa.genesis.enc", "g2")]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    const loser = answers.find((a) => a.status === 409)!;
    expect(loser.body.message).toMatch(race);
    expect(new ShaConflictError(409, loser.body.message).reason).toBe("branch-race");
  });
});

describe("fake GitHub fidelity: ref (section 5)", () => {
  it("answers with GitHub's body, a weak 64-hex ETag that varies with Accept, and max-age=60", async () => {
    const v1 = await put(LOG, "v1");
    const got = await call("GET", "{r}/git/ref/heads/main");
    expect(got.status).toBe(200);
    expect(keysOf(got.body)).toEqual(keysOf(recorded.ref.body));
    expect(keysOf(got.body.object)).toEqual(keysOf(recorded.ref.body.object));
    expect(got.body.ref).toBe(recorded.ref.body.ref);
    expect(got.body.object).toMatchObject({ sha: v1.body.commit.sha, type: recorded.ref.body.object.type });
    expect(got.headers.get("cache-control")).toBe(recorded.ref.cacheControl);

    const etagShape = /^W\/"[0-9a-f]{64}"$/;
    expect(recorded.ref.etagByAccept.vnd).toMatch(etagShape);
    expect(got.headers.get("etag")).toMatch(etagShape);
    const byAccept = {
      json: (await call("GET", "{r}/git/ref/heads/main", { accept: "application/json" })).headers.get("etag"),
      vnd: got.headers.get("etag"),
      vndVersion: (await call("GET", "{r}/git/ref/heads/main", { version: false })).headers.get("etag"),
    };
    const { json, vnd, vndVersion } = recorded.ref.etagByAccept;
    expect(byAccept.json === byAccept.vnd).toBe(json === vnd);
    expect(byAccept.vndVersion === byAccept.vnd).toBe(vndVersion === vnd);
  });

  it("answers 404 Not Found for a branch that doesn't exist", async () => {
    await put(LOG, "v1");
    const expected = recorded.errors.find((e) => e.path.endsWith("git/ref/heads/nobranch"))!;
    const got = await call("GET", "{r}/git/ref/heads/nobranch");
    expect(got.status).toBe(expected.status);
    expect(got.body.message).toBe(expected.message);
  });
});

describe("fake GitHub fidelity: conditional requests (section 5)", () => {
  const series = recorded.conditional.series;

  for (const [name, recordedSeries] of Object.entries(series)) {
    it(`${name}: 304 while unchanged, uncounted, then a counted 200`, async () => {
      const v1 = await put(LOG, "v1");
      const commit = v1.body.commit.sha as string;
      const blob = v1.body.content.sha as string;
      // The probe's path with this fake's shas in place of the probe's.
      const path = `{r}/${recordedSeries.path.replace(/[0-9a-f]{40}/, recordedSeries.path.includes("blobs") ? blob : commit)}`;
      const accept = name === "blobRaw" ? RAW : JSON_ACCEPT;

      const first = await call("GET", path, { accept });
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag")!;
      expect(etag).toBeTruthy();
      const statuses: number[] = [];
      const usedOn304s: number[] = [];
      for (let i = 0; i < recordedSeries.statuses.length; i++) {
        const got = await call("GET", path, { accept, ifNoneMatch: etag });
        statuses.push(got.status);
        usedOn304s.push(used(got));
        expect(got.bytes).toHaveLength(0);
      }
      const after = await call("GET", path, { accept });

      expect(statuses).toEqual(recordedSeries.statuses);
      // The recorded counter, relative to its value before the series.
      expect(usedOn304s.map((u) => u - used(first))).toEqual(recordedSeries.usedOn304s.map((u) => u - recordedSeries.usedBefore));
      expect(used(after) - used(first)).toBe(recordedSeries.usedAfterNext200 - recordedSeries.usedBefore);
    });
  }

  it("matches weak and strong forms and *, answers a mismatch with 200, and sends rate headers and the strong ETag on a 304", async () => {
    await put(LOG, "v1");
    const etag = (await call("GET", "{r}/git/ref/heads/main")).headers.get("etag")!;
    const status = async (ifNoneMatch: string) => (await call("GET", "{r}/git/ref/heads/main", { ifNoneMatch })).status;
    expect(await status(etag.replace(/^W\//, ""))).toBe(recorded.conditional.weakSentAsStrong);
    expect(await status(`W/"${"0".repeat(64)}"`)).toBe(recorded.conditional.mismatched);
    expect(await status("*")).toBe(recorded.conditional.star);

    const notModified = await call("GET", "{r}/git/ref/heads/main", { ifNoneMatch: etag });
    expect(notModified.status).toBe(304);
    expect(new TextDecoder().decode(notModified.bytes)).toBe(recorded.conditional.response304.body);
    expect(notModified.headers.has("x-ratelimit-used")).toBe(recorded.conditional.response304.hasRateLimitHeaders);
    // Visible to a browser (the fake answers as one sees it).
    expect(notModified.headers.has("etag")).toBe(recorded.conditional.response304.exposesETag);
    expect(notModified.headers.get("etag")).toBe(etag.replace(/^W\//, ""));
  });

  it("changes the ref's ETag as soon as a write lands", async () => {
    const v1 = await put(LOG, "v1");
    let etag = (await call("GET", "{r}/git/ref/heads/main")).headers.get("etag")!;
    let sha = v1.body.content.sha as string;
    for (let i = 0; i < recorded.readAfterWrite.iterations; i++) {
      const next = await put(LOG, `v${i + 2}`, sha);
      sha = next.body.content.sha;
      const got = await call("GET", "{r}/git/ref/heads/main", { ifNoneMatch: etag });
      expect(got.status).toBe(200);
      expect(got.body.object.sha).toBe(next.body.commit.sha);
      etag = got.headers.get("etag")!;
    }
  });
});

describe("fake GitHub fidelity: contents (sections 7, 8 and 10)", () => {
  it("reads a file with GitHub's keys, its blob sha as a strong ETag, wrapped base64, and old versions by ?ref", async () => {
    const v1 = await put(LOG, "version one ".repeat(30));
    await put(LOG, "version two", v1.body.content.sha);
    const got = await call("GET", `{r}/contents/${LOG}`);
    expect(keysOf(got.body)).toEqual(sorted(recorded.contents.file.keys));
    expect(got.headers.get("etag")).toBe(`"${got.body.sha}"`);
    expect(got.headers.get("cache-control")).toBe(recorded.contents.file.cacheControl);
    expectWrapped60(got.body.content);

    const old = await call("GET", `{r}/contents/${LOG}?ref=${v1.body.commit.sha}`);
    expect(atob(old.body.content.replace(/\n/g, "")) === "version one ".repeat(30)).toBe(recorded.contents.file.refCommitShaReturnsHistoricVersion);
  });

  it("inlines content only below 1 MiB; raw and blob reads work at every recorded size", async () => {
    for (const observed of recorded.contents.inline.observed) {
      const path = `big/${observed.bytes}.enc`;
      const sha = await fake.seedFile(REPO, path, "x".repeat(observed.bytes));
      const asJson = await call("GET", `{r}/contents/${path}`);
      expect(asJson.body.encoding, String(observed.bytes)).toBe(observed.encoding);
      expect(asJson.body.content.length, String(observed.bytes)).toBe(observed.contentLength);
      expect(observed.bytes < recorded.contents.inline.inlineIffSizeBelow).toBe(observed.encoding === "base64");

      const raw = await call("GET", `{r}/contents/${path}`, { accept: RAW });
      expect(raw.bytes.length === observed.bytes).toBe(observed.rawOk);
      const blobJson = await call("GET", `{r}/git/blobs/${sha}`);
      expect(atob(blobJson.body.content.replace(/\n/g, "")).length === observed.bytes).toBe(observed.blobJsonOk);
      const blobRaw = await call("GET", `{r}/git/blobs/${sha}`, { accept: RAW });
      expect(blobRaw.bytes.length === observed.bytes).toBe(observed.blobRawOk);
    }
    // About 1 s alone (six files of up to 1.5 MB, four reads each); more
    // while the rest of the suite runs in parallel.
  }, 60_000);

  it("labels raw contents with the raw media type asked for", async () => {
    await put(LOG, "v1");
    for (const accept of recorded.contents.raw.accepts) {
      const got = await call("GET", `{r}/contents/${LOG}`, { accept });
      expect(got.headers.get("content-type")).toBe(recorded.contents.raw.contentType[accept as keyof typeof recorded.contents.raw.contentType]);
      expect(new TextDecoder().decode(got.bytes)).toBe("v1");
    }
  });


  it("lists a directory sorted by name, with the root tree sha as a strong ETag, at the branch or a commit", async () => {
    const listing = recorded.contents.listing;
    const first = await put(OTHER_LOG, "other v1");
    const second = await put(LOG, "log v1");
    const third = await put(GENESIS, "genesis");
    const got = await call("GET", "{r}/contents/ledger");
    expect(got.status).toBe(200);
    for (const entry of got.body) expect(keysOf(entry)).toEqual(sorted(listing.keys));
    const names: string[] = got.body.map((e: { name: string }) => e.name);
    expect(names).toEqual([...names].sort());
    expect(names).toHaveLength(3);
    expect(got.headers.get("etag")).toBe(`"${third.body.commit.tree.sha}"`);
    expect(got.headers.get("cache-control")).toBe(listing.cacheControl);

    const atSecond = await call("GET", `{r}/contents/ledger?ref=${second.body.commit.sha}`);
    expect(atSecond.body.length === 2).toBe(listing.refCommitShaWorks);
    expect(atSecond.headers.get("etag")).toBe(`"${second.body.commit.tree.sha}"`);
    const atFirst = await call("GET", `{r}/contents/ledger?ref=${first.body.commit.sha}`);
    expect(atFirst.body.map((e: { name: string }) => e.name)).toEqual([OTHER_LOG.slice("ledger/".length)]);
    expect(((await call("GET", "{r}/contents/ledger/")).body as unknown[]).length === names.length).toBe(listing.trailingSlashSame);
  });

  it("silently lists only the first 1,000 entries of a larger directory, ignoring paging", async () => {
    const cap = recorded.contents.listing.cap;
    const names = Array.from({ length: cap.entriesInDir }, (_, i) => `e000001-9c1f22aa.d${i.toString(16).padStart(16, "0")}.log.enc`);
    await fake.seedFiles(REPO, Object.fromEntries(names.map((n) => [`cap/${n}`, n])));
    const got = await call("GET", "{r}/contents/cap");
    expect(got.status).toBe(200);
    expect(got.body).toHaveLength(cap.returned);
    expect(got.headers.get("link")).toBe(cap.linkHeader);
    expect(got.body.map((e: { name: string }) => e.name)).toEqual([...names].sort().slice(0, cap.returned));
    const paged = await call("GET", "{r}/contents/cap?per_page=100&page=11");
    expect(paged.body.length === cap.returned).toBe(cap.perPageAndPageIgnored);
  });
});

describe("fake GitHub fidelity: git trees (section 9)", () => {
  it("hashes trees exactly as git does", async () => {
    // `git write-tree` of these four files gives these ids.
    await fake.seedFiles(REPO, {
      "ledger/e000001-9c1f22aa.genesis.enc": "first version",
      "ledger/e000001-9c1f22aa.d0123456789abcdef.log.enc": "log",
      "README.md": "readme",
      "notes/a.txt": "x",
    });
    const root = await call("GET", "{r}/git/trees/main");
    expect(root.body.sha).toBe("676a9c6097465cd0b047d381dd071c09f7368328");
    expect(root.body.tree.map((e: { path: string; sha: string }) => [e.path, e.sha])).toEqual([
      ["README.md", "ea786ff2cf69cdc0e487ad1cea3b8bd361eb66a3"],
      ["ledger", "8ae420af164dea4c82fe8965d23373bd4199cb02"],
      ["notes", "9375a50d54bf5374615a3378349e298761a4b116"],
    ]);
  });

  it("answers by commit sha, branch or tree sha with GitHub's keys, and caches by sha for a day", async () => {
    const v1 = await put(LOG, "log v1");
    await put("README.md", "readme");
    const head = fake.head(REPO)!;
    const byCommit = await call("GET", `{r}/git/trees/${head}?recursive=1`);
    expect(keysOf(byCommit.body)).toEqual(sorted(recorded.trees.keys));
    expect(byCommit.body.truncated).toBe(false);
    const blob = byCommit.body.tree.find((e: { type: string }) => e.type === "blob");
    const dir = byCommit.body.tree.find((e: { type: string }) => e.type === "tree");
    expect(keysOf(blob)).toEqual(sorted(recorded.trees.entryKeys.blob));
    expect(keysOf(dir)).toEqual(sorted(recorded.trees.entryKeys.tree));
    expect(blob.mode).toBe(recorded.samples.treeBlobEntry.mode);
    expect(dir.mode).toBe("040000");
    expect(byCommit.body.tree.map((e: { path: string }) => e.path)).toEqual(["README.md", "ledger", LOG]);
    expect(byCommit.headers.get("cache-control")).toBe(recorded.trees.cacheControl.byTreeOrCommitSha);

    expect(recorded.trees.acceptsBranchName && recorded.trees.acceptsCommitSha).toBe(true);
    const byBranch = await call("GET", "{r}/git/trees/main?recursive=1");
    expect(byBranch.body).toEqual(byCommit.body);
    expect(byBranch.headers.get("cache-control")).toBe(recorded.trees.cacheControl.byBranch);
    const byTree = await call("GET", `{r}/git/trees/${byCommit.body.sha}`);
    expect(byTree.body.tree.map((e: { path: string }) => e.path)).toEqual(["README.md", "ledger"]);
    const old = await call("GET", `{r}/git/trees/${v1.body.commit.sha}?recursive=1`);
    expect(old.body.tree.map((e: { path: string }) => e.path)).toEqual(["ledger", LOG]);
  });

  it("fails loudly on the commitSha:path form, which GitHub accepts but the fake doesn't model (section 17)", async () => {
    expect(recorded.trees.acceptsCommitColonPath).toBe(true);
    await put(LOG, "log v1");
    for (const ref of [`${fake.head(REPO)}%3Aledger`, `${fake.head(REPO)}:ledger`]) {
      const got = await call("GET", `{r}/git/trees/${ref}`);
      expect(got.status, ref).toBe(501);
    }
    expect(fake.unhandled).toHaveLength(2);
  });

  it("lists all 1,005 entries of a directory the contents API cuts at 1,000, each with its size", async () => {
    const recordedDir = recorded.trees.dirOf1005;
    const names = Array.from({ length: recordedDir.entries }, (_, i) => `e000001-9c1f22aa.d${i.toString(16).padStart(16, "0")}.log.enc`);
    await fake.seedFiles(REPO, Object.fromEntries(names.map((n) => [`cap/${n}`, `${n} body`])));
    const got = await call("GET", `{r}/git/trees/${fake.head(REPO)}?recursive=1`);
    const inCap = got.body.tree.filter((e: { path: string; type: string }) => e.type === "blob" && e.path.startsWith("cap/"));
    expect(inCap).toHaveLength(recordedDir.entries);
    expect(got.body.truncated).toBe(recordedDir.truncated);
    const paths: string[] = inCap.map((e: { path: string }) => e.path);
    expect(JSON.stringify(paths) === JSON.stringify([...paths].sort())).toBe(recordedDir.sortedByName);
    expect(inCap.every((e: { size?: number }) => typeof e.size === "number")).toBe(recordedDir.everyBlobHasSize);
  });

  it("sets truncated past its entry limit (100,000 on GitHub; a knob here)", async () => {
    const small = newFake({ treeEntryLimit: 3 });
    await small.seedFiles(REPO, { "ledger/a": "a", "ledger/b": "b", "ledger/c": "c" });
    const got = await call("GET", `{r}/git/trees/${small.head(REPO)}?recursive=1`, { via: small });
    expect(got.body.truncated).toBe(true);
    expect(got.body.tree).toHaveLength(3);
  });
});

describe("fake GitHub fidelity: blobs (section 11)", () => {
  it("answers JSON with GitHub's keys and wrapped base64, raw as text/plain, and a weak ETag per Accept", async () => {
    const v1 = await put(LOG, "blob body ".repeat(20));
    const sha = v1.body.content.sha;
    const asJson = await call("GET", `{r}/git/blobs/${sha}`);
    expect(keysOf(asJson.body)).toEqual(sorted(recorded.blobs.jsonKeys));
    expectWrapped60(asJson.body.content);
    expect(asJson.headers.get("cache-control")).toBe(recorded.blobs.cacheControl);
    const raw = await call("GET", `{r}/git/blobs/${sha}`, { accept: RAW });
    expect(raw.headers.get("content-type")).toBe(recorded.blobs.rawContentType);
    expect(new TextDecoder().decode(raw.bytes)).toBe("blob body ".repeat(20));
    const rawJson = await call("GET", `{r}/git/blobs/${sha}`, { accept: RAW_JSON });
    expect(rawJson.headers.get("content-type")).toBe(recorded.blobs.rawPlusJsonContentType);
    expect(asJson.headers.get("etag")).toMatch(/^W\//);
    expect(raw.headers.get("etag")).not.toBe(asJson.headers.get("etag"));
  });

  it("keeps a superseded version readable, and answers a malformed, missing or tree sha as GitHub does", async () => {
    const v1 = await put(LOG, "v1");
    const v2 = await put(LOG, "v2", v1.body.content.sha);
    const old = await call("GET", `{r}/git/blobs/${v1.body.content.sha}`, { accept: RAW });
    expect(new TextDecoder().decode(old.bytes) === "v1").toBe(recorded.blobs.supersededBlobStillReadable);
    const malformed = await call("GET", "{r}/git/blobs/xyz");
    expect(malformed.status).toBe(recorded.blobs.malformedSha.status);
    expect(malformed.body.message).toBe(recorded.blobs.malformedSha.message);
    expect((await call("GET", `{r}/git/blobs/${v2.body.commit.tree.sha}`)).status).toBe(404);
    expect((await call("GET", `{r}/git/blobs/${"0".repeat(40)}`)).status).toBe(404);
  });
});

describe("fake GitHub fidelity: read after write (section 13)", () => {
  it("shows a write at once to all eight reads, as observed", async () => {
    expect(recorded.readAfterWrite.staleReadsObserved).toBe(0);
    let refEtag: string | null = null;
    let listEtag: string | null = null;
    for (let i = 0; i < 6; i++) {
      const path = i % 2 ? LOG : OTHER_LOG;
      const current = (await call("GET", `{r}/contents/${path}`)).body?.sha as string | undefined;
      const written = await put(path, `v${i}`, current);
      const sha = written.body.content.sha as string;
      const commit = written.body.commit.sha as string;
      const [ref, refInm, list, listInm, listAtCommit, file, blob, tree]: Answer[] = await Promise.all([
        call("GET", "{r}/git/ref/heads/main"),
        call("GET", "{r}/git/ref/heads/main", refEtag ? { ifNoneMatch: refEtag } : {}),
        call("GET", "{r}/contents/ledger"),
        call("GET", "{r}/contents/ledger", listEtag ? { ifNoneMatch: listEtag } : {}),
        call("GET", `{r}/contents/ledger?ref=${commit}`),
        call("GET", `{r}/contents/${path}`),
        call("GET", `{r}/git/blobs/${sha}`, { accept: RAW }),
        call("GET", `{r}/git/trees/${commit}?recursive=1`),
      ]);
      expect(ref.body.object.sha).toBe(commit);
      expect(refInm.status).toBe(200);
      for (const listing of [list, listInm, listAtCommit]) {
        expect(listing.body.find((e: { path: string }) => e.path === path).sha).toBe(sha);
      }
      expect(file.body.sha).toBe(sha);
      expect(new TextDecoder().decode(blob.bytes)).toBe(`v${i}`);
      expect(tree.body.tree.find((e: { path: string }) => e.path === path).sha).toBe(sha);
      refEtag = ref.headers.get("etag");
      listEtag = list.headers.get("etag");
    }
  });
});

describe("fake GitHub fidelity: rate limits (section 14)", () => {
  it("sends the rate headers on every authenticated answer, counts reads and writes apart, and counts errors", async () => {
    const v1 = await put(LOG, "v1");
    const firstGet = await call("GET", "{r}/git/ref/heads/main");
    const notModified = await call("GET", "{r}/git/ref/heads/main", { ifNoneMatch: firstGet.headers.get("etag")! });
    const missing = await call("GET", "{r}/contents/nope");
    const conflict = await put(LOG, "v2", "6abd7d5cdfbf9c44a806872d2e0f200e39cf70c5");
    const unsupplied = await put(LOG, "v2");
    for (const a of [v1, firstGet, notModified, missing, conflict, unsupplied]) {
      for (const header of recorded.rateLimit.headersOnEveryAuthenticatedResponse) {
        expect(a.headers.has(header), `${a.status} ${header}`).toBe(true);
      }
      expect(a.headers.get("x-ratelimit-limit")).toBe(String(recorded.rateLimit.limit));
      expect(a.headers.get("x-ratelimit-resource")).toBe(recorded.rateLimit.resource);
    }
    // Writes 1, 2, 3, the two refused PUTs included; reads 1, 1 (the 304
    // is free), 2 (the 404 is not).
    expect(recorded.rateLimit.readsAndWritesReportSeparateCounters).toBe(true);
    expect(recorded.rateLimit.errorsCount).toBe(true);
    expect(recorded.rateLimit.notModifiedCounts).toBe(false);
    expect([v1, conflict, unsupplied].map(used)).toEqual([1, 2, 3]);
    expect([firstGet, notModified, missing].map(used)).toEqual([1, 1, 2]);
  });

  it("counts injected failures and sends them the rate headers, as GitHub does for errors", async () => {
    expect(recorded.rateLimit.errorsCount).toBe(true);
    const v1 = await put(LOG, "v1");
    expect(used(v1)).toBe(1);
    fake.failNext({ method: "PUT", status: 409 });
    const injected = await put(LOG, "v2", v1.body.content.sha);
    expect(injected.status).toBe(409);
    for (const header of recorded.rateLimit.headersOnEveryAuthenticatedResponse) expect(injected.headers.has(header), header).toBe(true);
    expect(used(injected)).toBe(2);
    fake.failNext({ method: "GET", status: 404 });
    const missing = await call("GET", "{r}/git/ref/heads/main");
    expect(missing.status).toBe(404);
    expect(used(missing)).toBe(1);
    const organic = await put(LOG, "v3", "6abd7d5cdfbf9c44a806872d2e0f200e39cf70c5");
    expect(organic.status).toBe(409);
    expect(used(organic)).toBe(3);
    // A secondary limit leaves requests in the hour; a primary one none.
    fake.failNext({ method: "PUT", status: 403, rateLimit: "secondary" });
    const secondary = await put(LOG, "v4", v1.body.content.sha);
    expect(used(secondary)).toBe(4);
    expect(secondary.headers.get("x-ratelimit-remaining")).toBe(String(recorded.rateLimit.limit - 4));
    expect(secondary.headers.get("retry-after")).toBe("60");
    fake.failNext({ method: "GET", status: 403, rateLimit: "primary" });
    expect((await call("GET", "{r}")).headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("sends anonymous requests the unauthenticated limit, on a counter of their own", async () => {
    await call("GET", "{r}/git/ref/heads/main");
    const first = await call("GET", "{r}/git/ref/heads/main", { token: null });
    const second = await call("GET", "{r}/contents/nope", { token: null });
    for (const a of [first, second]) {
      expect(a.status).toBe(404);
      for (const header of recorded.rateLimit.headersOnEveryAuthenticatedResponse) expect(a.headers.has(header), header).toBe(true);
      expect(a.headers.get("x-ratelimit-limit")).toBe(String(recorded.rateLimit.unauthenticatedLimit));
    }
    expect([first, second].map(used)).toEqual([1, 2]);
    expect(second.headers.get("x-ratelimit-remaining")).toBe(String(recorded.rateLimit.unauthenticatedLimit - 2));
    // The token's counter is untouched.
    expect(used(await call("GET", "{r}/git/ref/heads/main"))).toBe(2);
  });

  it("answers a spent hourly limit with 403 and remaining 0, and a burst of writes with a secondary limit", async () => {
    const tight = newFake({ rateLimit: 2 });
    await call("GET", "{r}", { via: tight });
    await call("GET", "{r}", { via: tight });
    const spent = await call("GET", "{r}", { via: tight });
    expect(spent.status).toBe(403);
    expect(spent.headers.get("x-ratelimit-remaining")).toBe("0");
    // Writes keep their own counter.
    expect((await put(LOG, "v1", undefined, { via: tight })).status).toBe(201);

    let sha: string | undefined;
    let last: Answer | undefined;
    for (let i = 0; i < 81; i++) {
      last = await put(LOG, `v${i}`, sha);
      if (last.status < 300) sha = last.body.content.sha;
    }
    expect(last!.status).toBe(403);
    expect(last!.headers.get("retry-after")).toBe("60");
  });
});

describe("fake GitHub fidelity: CORS (section 15)", () => {
  it("shows a browser exactly GitHub's exposed headers plus the safelisted ones", () => {
    const safelisted = ["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"];
    const exposed = [...BROWSER_VISIBLE_HEADERS].filter((h) => !safelisted.includes(h));
    expect(sorted(exposed)).toEqual(sorted(recorded.cors.responses.exposeHeaders.map((h) => h.toLowerCase())));
  });

  it("allows exactly the request headers GitHub's preflight allows, and fails fetch for any other", async () => {
    expect(sorted(PREFLIGHT_ALLOWED_HEADERS)).toEqual(sorted([...recorded.cors.preflight.allowHeaders, "Accept"].map((h) => h.toLowerCase())));
    for (const header of recorded.cors.preflight.notAllowedRequestHeaders) {
      const sent = fake.fetch(`${API}${R}`, { headers: { Authorization: `Bearer ${WRITE}`, [header]: "no-cache" } });
      await expect(sent, header).rejects.toBeInstanceOf(TypeError);
    }
    // Outside a browser there is no preflight.
    const direct = newFake({ cors: false });
    const res = await direct.fetch(`${API}${R}`, { headers: { Authorization: `Bearer ${WRITE}`, "Cache-Control": "no-cache" } });
    expect(res.status).toBe(200);
  });
});

describe("fake GitHub fidelity: errors (section 16)", () => {
  it("answers every recorded error as GitHub did", async () => {
    const v1 = await put(LOG, "v1");
    const treeSha = v1.body.commit.tree.sha as string;
    // git/commits is not modelled: Ledger reads trees by commit sha and
    // never needs the commit object (section 6).
    const unmodelled = ["/repos/{o}/{r}/git/commits/0000000000000000000000000000000000000000"];
    for (const expected of recorded.errors) {
      let got: Answer;
      if (expected.path.startsWith("/user")) got = await call("GET", "/user", { token: "github_pat_FICTIONAL" });
      else if (expected.path.endsWith("(no Authorization)")) got = await call("GET", "{r}/git/ref/heads/main", { token: null });
      else got = await call("GET", here(expected.path).replace("{a tree sha}", treeSha).replace("/{missing-repo}", "/missing"));
      if (unmodelled.includes(expected.path)) {
        expect(got.status, expected.path).toBe(501);
        continue;
      }
      expect(got.status, expected.path).toBe(expected.status);
      if (expected.path.endsWith("(no Authorization)")) {
        expect(got.headers.get("x-ratelimit-limit"), expected.path).toBe(String(recorded.rateLimit.unauthenticatedLimit));
      }
      expect(got.body, expected.path).toEqual({
        message: expected.message,
        documentation_url: expected.documentation_url,
        status: expected.statusField,
      });
    }
  });
});
