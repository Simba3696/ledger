# GitHub REST API behaviour, as probed (2026-10-11)

**Why this exists.** The sync design (#7, ADR-0008, "per-device op logs over a join-only register state") depends on a set of GitHub behaviours. Several were marked "verify" in the design, and §17 names them as the largest risk to the estimate. This document turns each one into a recorded fact: the exact request, what GitHub answered, and what the client should do.

**Companion fixture.** [`client/src/backend/github/__fixtures__/github-behaviour.json`](../../client/src/backend/github/__fixtures__/github-behaviour.json) holds the same observations in machine-readable form, so `fakeGitHub.ts` fidelity tests (design §16.3) can assert against them.

**Method.**
- **Target.** `Simba3696/ledger-sync-probe`: a private, throwaway repo. It started empty, with default branch `main`. All content was fictional. Files had Ledger's names (`ledger/e000001-9c1f22aa.<device>.log.enc` and so on), and their bodies were a fake crypto header line followed by base64 of random bytes.
- **Client.** `gh api -i` (gh 2.102.0) with `X-GitHub-Api-Version: 2022-11-28` and `Accept: application/vnd.github+json` unless stated. The token was an OAuth user token with the `repo` scope. No fine-grained token was available, so fine-grained permissions are untested (see §19).
- **Preflights.** CORS preflights were sent with unauthenticated `curl -X OPTIONS` and `Origin: https://someone.github.io`.
- **Edge region.** GitHub reported `x-github-edge-region: centralindia`.
- **Budget.** 410 authenticated calls (328 GET, 78 PUT, 2 POST) and 15 unauthenticated curl calls.
- **Repo state afterwards.** The `main` ref moved only through contents-API PUTs. The 1,005-entry listing test (§9) used one unreferenced commit, so `main` never pointed at it.

**Verdict key.** CONFIRMED: GitHub behaves as the design assumes. CONTRADICTED: it does not; the impact and the fallback are given. UNTESTABLE: this probe could not establish it. NEW: something the design does not mention but the code must handle.

---

## 0. Summary: design assumptions against observations

| # | Design assumption (section) | Verdict | Fact |
|---|---|---|---|
| A1 | A conditional `GET git/ref/heads/{branch}` returns 304 while nothing changed (§7 step 1) | CONFIRMED | §5 |
| A2 | That 304 does not count against the rate limit (§7 step 1, §16.5 item 1) | CONFIRMED | §5 |
| A3 | `If-None-Match` passes CORS from a browser origin (§7 step 1, §16.5 item 2) | CONFIRMED on the server side. NEW for the client: browser `fetch` hands the 304 to script with `ok === false` | §5, §16 |
| A4 | The ref ETag changes as soon as a write lands, so a 304 never hides a commit | CONFIRMED (20 of 20, read at once after the PUT) | §5, §13 |
| A5 | `contents/ledger?ref={commitSha}` works (§7 step 2, §16.5 item 3) | CONFIRMED, including for older and unreferenced commits | §7 |
| A6 | One listing of `ledger/` returns every file's blob sha and size (§6, §7 step 2, §8.3) | CONFIRMED up to 1,000 files. **CONTRADICTED above 1,000:** the contents API silently returns only the first 1,000 by name | §8, §9 |
| A7 | `git/blobs/{sha}` with `Accept: application/vnd.github.raw` returns the bytes (§7 step 4) | CONFIRMED, including above 1 MiB | §11 |
| A8 | A blob read by sha is never stale (§7 step 4, §12) | CONFIRMED | §11, §13 |
| A9 | A PUT 2xx returns `content.sha` and `commit.parents[0]` (§7 step 6) | CONFIRMED. `parents[0]` is an object, so compare `parents[0].sha`. The repo's first commit has `parents: []` | §2 |
| A10 | `content.sha` equals `gitBlobSha(sent text)`, so `lastSentLogSha` can be computed before sending (§7 steps 5–6, §8.1 step 3, §9.2 step 5) | CONFIRMED (every PUT, including content sent as wrapped base64) | §2, §12 |
| A11 | A stale sha gives 409 or 422 (§12) | CONFIRMED: a wrong or malformed sha gives 409 "… does not match …"; a missing sha on an existing file gives 422 | §3 |
| A12 | A lost-response resend (old sha, already landed) gives 409, not a duplicate (§12, B26) | CONFIRMED | §3 |
| A13 | Concurrent PUTs to **different** paths can 409 (§12, §16.5 item 4) | CONFIRMED, and common: 22 of 35 truly concurrent PUTs lost. The message says which kind of 409 it is | §4 |
| A14 | Re-sending unconfirmed ops is idempotent (§12) | CONFIRMED for the content. But a PUT with the current sha and **identical** bytes still makes a new, empty commit and moves the ref | §3 |
| A15 | Creating with `sha` omitted creates; a 422 on a fresh random name is effectively impossible (§9.2 step 5, §9.5) | CONFIRMED. NEW: a `sha` sent for a path that does not exist is ignored (201) | §3 |
| A16 | GitHub eventual consistency (a stale ref, listing or content) is harmless (§12) | No staleness seen in 160 reads straight after 20 writes. Whether stale reads are harmless can only be tested in the fake | §13 |
| A17 | Budget: 5,000 requests an hour (§7) | CONFIRMED (`x-ratelimit-limit: 5000`). NEW: reads and writes each report their own counter | §14 |
| A18 | Secondary limits: 80 content-creating requests a minute, 500 an hour (§7) | UNTESTABLE: not provoked. 80 writes in about 25 minutes, with bursts of 3 at once, drew no 403 or 429 | §14 |
| A19 | Rate-limit detection reads `x-ratelimit-remaining` and `retry-after` (contents.ts, reused per §12) | CONFIRMED: both are exposed to cross-origin script. NEW: `GET /rate_limit` disagreed with the headers, so don't use it | §14, §15 |
| A20 | `cache: "no-store"` is needed, because GitHub's responses are cacheable (contents.ts) | CONFIRMED: ref and listing carry `max-age=60`; reads by sha carry `max-age=86400` | §5, §10 |
| A21 | Files of 1 MB or more come back without inline content, so they are read as blobs (contents.ts `readFile`) | CONFIRMED in the client. The fake is off by one: real GitHub inlines only below 1,048,576 bytes | §10 |
| A22 | An empty repo means "no ledger yet" (§9.5) | NEW: `git/*` endpoints on an empty repo answer **409** "Git Repository is empty.", which `contents.ts` today maps to `ShaConflictError` | §1 |
| A23 | A fine-grained token with Contents read/write can call ref, listing, trees and blobs (§16.5 item 6) | CONFIRMED in stage 8d (2026-10-14) with a `github_pat_` token limited to one repo and Contents read/write: repo, ref (including the uncounted 304), tree, raw blob, and the contents PUT (create, update and both kinds of 409), all through the engine | §19 |
| A24 | A keepalive PUT on `pagehide` lands from iOS Safari and Android Chrome (§7, §16.5 item 5) | UNTESTABLE (needs real devices). The PUT is preflighted; see §19 | §15, §19 |
| A25 | Repo size after a simulated year (§16.5 item 7) | UNTESTABLE here. `size` stayed `0` because GitHub computes it lazily | §19 |
| A26 | The §7 fallback (list on every cycle if the conditional ref GET is unusable) | Not needed. The listing also answers 304 when nothing changed, at no cost | §5 |

### Changes this implies for step 2 of the plan (contents.ts and the fake)

1. **List with git trees, not the contents API.** Use `GET /repos/{o}/{r}/git/trees/{commitSha}?recursive=1` and keep the entries under `ledger/`, checking `truncated === false`. This is one request, the same as now. It has no 1,000-entry cap (the documented limit is 100,000 entries or 7 MB, flagged by `truncated`). It is about 5 times smaller per entry. Being addressed by sha, it can never be a stale view of that commit. It answers 200 with no `ledger/` entries when the directory doesn't exist yet. (`git/trees/{commitSha}:ledger` also works and returns only the directory, but that `sha:path` form is undocumented.) If the contents listing is kept, treat a result of exactly 1,000 entries as possibly truncated and switch to trees.
2. **`getRef(etag)`:**
   - Treat a 304 as success ("unchanged") before the `res.ok` check.
   - Map 409 with message "Git Repository is empty." to "no ledger yet", not to `ShaConflictError`.
   - Send the same `Accept` header on every poll, because the ETag varies with it.
3. **Before a PUT,** skip it when `gitBlobSha(text)` equals the listed own sha. Otherwise each re-send makes an empty commit, which moves the ref and costs every other device a listing.
4. **Optional:** tell the two kinds of 409 apart by message (§4). A branch race means the PUT was checked against a head that has since moved. The sha is usually still current, so the same PUT with the same sha may be retried, but a same-path race gives the same message with a stale sha, so a retry that then gets "does not match" re-runs steps 1, 2 and 5. A stale sha needs steps 1, 2 and 5 re-run.
5. **Fake fidelity:** fix the gaps in §17.

---

## 1. Empty repository

| Request | Status | Body `message` |
|---|---|---|
| `GET /repos/{o}/{r}/contents/` | 404 | `This repository is empty.` |
| `GET …/contents/ledger` (and `?ref=main`) | 404 | `This repository is empty.` |
| `GET …/git/ref/heads/main` | **409** | `Git Repository is empty.` |
| `GET …/git/refs/heads` | **409** | `Git Repository is empty.` |
| `GET …/git/trees/main?recursive=1` | **409** | `Git Repository is empty.` |
| `GET …/git/blobs/0000…0000` | **409** | `Git Repository is empty.` |

The first `PUT …/contents/ledger/e000001-9c1f22aa.genesis.enc` without a `sha` answered **201**. It created the `ledger/` directory and the first commit, with `commit.parents: []`.

**Design should:** treat the 409 "Git Repository is empty." from the ref poll as "no ledger" (onboarding: Create, §9.5). Today `toError` maps every 409 to `ShaConflictError`. The fake should return this 409 from every `git/*` route while the repo has no files.

## 2. PUT response shape

Request: `PUT /repos/{o}/{r}/contents/ledger/e000001-9c1f22aa.d7c41e0a95b2d4f1.log.enc` with body `{"message":"Sync d7c41e0a","content":"<base64>"}`.

Observed: 201 (create) or 200 (update) with `{content, commit}`.
- `content`: `{name, path, sha, size, url, html_url, git_url, download_url, type, _links}`.
- `commit`: `{sha, node_id, url, html_url, author, committer, tree: {sha, url}, message, parents: [{sha, url, html_url}], verification}`.
- `content.sha` equalled the git blob SHA-1 of the sent bytes on every PUT.
- `download_url` carries a short-lived `?token=` for the private repo. The client must never store or log it.

**Design should:** set `ownLogSha = content.sha`, and advance `lastSeenCommit` when `commit.parents[0].sha === lastSeenCommit` (§7 step 6). `parents[0]` is the head GitHub applied the write on top of (§4).

## 3. PUT sha semantics

All against `ledger/e000001-9c1f22aa.d7c41e0a95b2d4f1.log.enc` unless noted:

| Case | Status | `message` |
|---|---|---|
| Create, no `sha`, path absent | 201 | |
| Create, no `sha`, path exists | 422 | `Invalid request.\n\n"sha" wasn't supplied.` |
| Update with a well-formed but wrong sha | 409 | `ledger/…log.enc does not match 6abd7d5c…` (the sha that was sent) |
| Update with a malformed sha (`"abc"`) | 409 | `ledger/…log.enc does not match abc` |
| Update with the current sha | 200 | |
| Update with the current sha and **byte-identical** content | 200 | A **new commit**: same `content.sha`, same tree, the ref moves |
| Resend of a landed update (old sha, same content) | 409 | `… does not match ec088b22…` |
| Create a path that doesn't exist, **with** a `sha` | 201 | The `sha` is ignored |
| `content` base64 wrapped at 60 characters with `\n` | 201 | Accepted. Same blob sha as unwrapped |
| `content` not valid base64 | 422 | `content is not valid Base64` |

Error bodies are `{message, documentation_url, status}`, and `status` is a **string** (`"409"`).

**Design should:**
- Keep `toError`'s rule for the contents PUT: 409, or 422 whose message mentions `sha`, means `ShaConflictError`. Apply it to writes only: a read by a malformed sha gets a 422 that mentions `sha` too (§16), and a read writes nothing, so it is a plain `GitHubError`.
- Not treat a 201 as proof that the path was new. A stale `sha` on a missing path still creates it.
- Avoid identical re-PUTs (summary item 3).

## 4. Concurrent PUTs: the branch-ref race

Request: the same moment (within about 30 ms), two or three PUTs to **different** files, each with its own current sha. Separately, two PUTs to the **same** file with the same sha.

| Scenario | Rounds | PUTs | 409s |
|---|---|---|---|
| 2 different paths | 10 | 20 | 10 (exactly one winner every round) |
| 3 different paths | 5 | 15 | 9 (one round had two winners) |
| Same path, same sha | 3 | 6 | 3 |

- **The 409 message for a lost race** is `is at <40-hex new head> but expected <40-hex head the request started from>`. The same-path loser got this message too, not "does not match", because its file sha was still current at the head it was checked against. By the time it got the 409 that sha was stale: the winner had changed the file, so resending the identical PUT gets "does not match".
- **The "two winners" round:** GitHub applied the second PUT on top of the first. Its `commit.parents[0].sha` was the first winner's commit, not the head the client had seen.

**Design should:**
- Expect this 409 routinely whenever two devices push in the same second. The §12 retry policy (250/500/1000 ms plus jitter, at most 4 PUTs a cycle) fits.
- On `is at … but expected …`, know that the PUT was checked against a head that has since moved. The own file's sha is usually still current (another path moved the branch), but not always: a same-path race gives the same message, and the design reaches one when an own lost or late PUT lands beside the next cycle's retry (§12 row B26) or a forked profile writes the same own log (§10.3). A retry of the identical PUT is allowed. The re-list is not optional: if the retry gets `… does not match …`, re-run steps 1, 2 and 5.
- On `… does not match …`, re-list as §12 says.
- Have the fake's branch-level ref (§16.3) produce exactly this message.

## 5. Ref read, ETag and 304

Request: `GET /repos/{o}/{r}/git/ref/heads/main`.

Observed:
- 200 with body `{ref: "refs/heads/main", node_id, url, object: {sha, type: "commit", url}}`.
- `ETag: W/"<64 hex>"` (weak), `Cache-Control: private, max-age=60, s-maxage=60`, and `Last-Modified`.
- `Vary: Accept, Authorization, Cookie, X-GitHub-OTP, Accept-Encoding, …`.
- The ETag **differs per `Accept`**: `application/json` gave a different value from `application/vnd.github+json`. Adding `X-GitHub-Api-Version` didn't change it.
- The plural `git/refs/heads/mai` does a **prefix match** and returns an array, so use the singular `git/ref/`.

**Conditional requests.** Each series was one 200, then 5 requests with `If-None-Match: <that ETag>`, then another 200. Every request carried `Origin: https://someone.github.io`.

| Endpoint | 5 conditional requests | `x-ratelimit-used` on the 304s | Used, 200 before and after |
|---|---|---|---|
| `git/ref/heads/main` (run twice) | 304 ×5 | unchanged | +1 (just the second 200) |
| `contents/ledger` | 304 ×5 | unchanged | +1 |
| `contents/ledger?ref={commitSha}` | 304 ×5 | unchanged | +1 |
| `git/trees/{commitSha}?recursive=1` | 304 ×5 | unchanged | +1 |
| `git/blobs/{sha}` (raw) | 304 ×5 | unchanged | +1 |

- A 304 has an empty body. It still carries the `x-ratelimit-*` headers, `Access-Control-Allow-Origin: *` and the full `Access-Control-Expose-Headers` (ETag included).
- On a 304 the ETag comes back in strong form (`"…"`, without `W/`).
- `If-None-Match` matched in either form (with or without `W/`) and with `*`. A mismatching value gave 200.
- **After a write the ETag changed at once.** In 20 of 20 tries, a conditional ref GET sent straight after a PUT answered 200 with the new commit (§13).

**Design should:**
- Keep step 1 as designed. It costs 0 against the limit while idle.
- Store `refEtag` as received and send the same `Accept` every time.
- In `getRef`, check for 304 **before** `res.ok`.
- The browser side, from the Fetch standard and not probed: the request uses `cache: "no-store"` and sets `If-None-Match` itself, so the browser does not answer from its own cache. It passes GitHub's 304 to script as a `Response` with `status 304`, `ok false` and a null body.
- The §7 fallback is unnecessary. If it were ever needed, the listing is also cheap: it answers 304 and is not counted.

## 6. Commit

Request: `GET /repos/{o}/{r}/git/commits/{sha}`.

Observed: 200 with `{sha, tree: {sha, url}, parents: [{sha, url, html_url}], message, …}`.

**Design should:** not need this endpoint. A tree can be fetched by the commit sha directly (§10).

## 7. Contents listing

Request: `GET /repos/{o}/{r}/contents/ledger`, with `?ref=main`, with `?ref={commitSha}`, and with a trailing slash.

Observed:
- 200 with an array of `{name, path, sha, size, url, html_url, git_url, download_url, type: "file", _links}`.
- The array is sorted by name, ascending.
- `ETag` is strong and equals the quoted **root tree sha** of the commit, so it changes whenever anything in the repo changes.
- `Cache-Control: private, max-age=60`.
- `?ref={commitSha}` works. It also works for an older commit, which returns the historic listing (2 files), and for a commit no branch points at.
- About 1.26 KB of JSON per entry.
- A missing directory gives 404 `Not Found`. A missing branch gives 404 `No commit found for the ref nobranch`.

**Design should:** see §8 and the recommendation in the summary.

## 8. Contents listing caps at 1,000 entries, silently

Request:
1. `POST git/trees`, with `base_tree` = the head's tree, adding 1,005 files `cap/e000001-9c1f22aa.<16 hex>.log.enc`.
2. `POST git/commits` with that tree; no ref was moved.
3. `GET contents/cap?ref={thatCommit}`.

Observed:
- 200 with **exactly 1,000** entries: the first 1,000 by name.
- No `Link` header, no flag and no error.
- `?per_page=100&page=11` was ignored (1,000 again).

**Impact.** Epoch keys and device ids sort by name, and a newer epoch's genesis sorts **after** every older epoch's files. Past 1,000 files in `ledger/`, a listing would silently drop:
- the newest epoch, so §9.1 would never switch to a restore;
- the newest devices' logs, so §8.3 would never join them.

Nothing is ever deleted (§6). Today's arithmetic (1 genesis plus 2 files per device per epoch) keeps a household far below 1,000. But the cap gives no warning when it bites.

**Fallback.** The git trees endpoint (§9). The design states none.

## 9. Git trees

Requests:
- `GET git/trees/{treeSha}`
- `GET git/trees/{commitSha}?recursive=1`
- `GET git/trees/main?recursive=1`
- `GET git/trees/{commitSha}:ledger`

Observed:
- 200 with `{sha, url, tree: [...], truncated: false}`.
- A blob entry is `{path, mode: "100644", type: "blob", sha, size, url}`. A directory entry is `{path, mode: "040000", type: "tree", sha, url}`.
- A commit sha, a branch name and the `commitSha:path` form are all accepted.
- `Cache-Control` is `max-age=86400` when addressed by sha, but `max-age=60` by branch or by `sha:path`.
- On the 1,005-file directory, `git/trees/{commit}:cap` returned **all 1,005** entries, sorted by name, each with `size`, `truncated: false`, at about 258 bytes per entry. The recursive tree returned all 1,018 entries, `truncated: false`.
- The documented limit (100,000 entries or 7 MB, flagged by `truncated: true`) was not reached.

**Design should:** use `git/trees/{commitSha}?recursive=1`, filtered to `ledger/`, for step 2 and cold start. It gives the same `{name, sha, size}` facts with no cap, it is sha-addressed, and it answers 304 (uncounted) when re-asked with its ETag. If `truncated` is ever true, show `needsAttention`. That is unreachable at Ledger's sizes.

## 10. Reading one file through the contents API, and the 1 MiB boundary

Request: `GET contents/{path}`, with `Accept` set to the default JSON, `application/vnd.github.object`, `application/vnd.github.raw` and `application/vnd.github.raw+json`.

Observed below 1 MiB:
- JSON and object: `{name, path, sha, size, url, html_url, git_url, download_url, type: "file", content, encoding: "base64", _links}`.
- `content` is base64 with a `\n` every 60 characters and a trailing `\n`.
- `ETag` is strong and equals the quoted blob sha.
- `?ref={oldCommit}` returns the old version.

| File size (bytes) | JSON `encoding` | inline `content` | raw | blob (JSON and raw) |
|---|---|---|---|---|
| 1,000,000 | base64 | yes | OK | OK |
| 1,000,001 | base64 | yes | OK | OK |
| 1,048,575 | base64 | yes | OK | OK |
| **1,048,576** | **none** | `""` | OK | OK |
| 1,048,577 | none | `""` | OK | OK |
| 1,500,000 | none | `""` | OK | OK |

- Raw media types answer with the exact bytes at every size tested.
- `Content-Type` is `application/vnd.github.raw; charset=utf-8`, or `…raw+json…` when that was asked for.
- The documented 100 MB ceiling was not tested. Ledger's files are far below it (a snapshot is about 330 KB).

**Design should:**
- Keep `readFile`'s blob fallback when `encoding` is `none`.
- Fix the fake: it inlines when `bytes.length <= 1024 * 1024`, but GitHub inlines only when `size < 1,048,576`.

## 11. Blobs

Request: `GET git/blobs/{sha}` with the default JSON `Accept`, `application/vnd.github.raw` and `application/vnd.github.raw+json`.

Observed:
- JSON: `{sha, node_id, size, url, content, encoding: "base64"}`. `content` is wrapped at 60 characters with a trailing `\n`, at every size tested (up to 1.5 MB).
- Raw: the exact bytes, but with `Content-Type: text/plain; charset=utf-8`, not the contents API's `application/vnd.github.raw`.
- `ETag` is weak and differs per `Accept`. `Cache-Control: private, max-age=86400`.
- A superseded version's blob stays readable.
- A blob sha that doesn't exist, or a tree's sha, gives 404 `Not Found`.
- A malformed sha (`xyz`) gives **422** `The sha parameter must be exactly 40 characters and contain only [0-9a-f].`

**Design should:** read other devices' files and own-file checks through `git/blobs/{sha}` raw, as §7 steps 4 and 5 say. Decode as text regardless of `Content-Type`. Never send a sha that wasn't listed, so the 422 can't arise.

## 12. Base64 and encoding

- PUT `content` may be unwrapped or wrapped (`\n` every 60). Both store the same bytes, with the same sha.
- GET `content` is always wrapped at 60 characters with a trailing `\n`. Decoders must ignore whitespace, which `base64ToBytes` already does.
- `content.sha` of every PUT equalled `SHA-1("blob <len>\0" + bytes)` computed locally, as `gitBlobSha` does.

## 13. Read-after-write visibility

Request: 20 iterations, alternating between two device logs:
1. `PUT` the log with its current sha.
2. As soon as it returned, send these 8 reads together:
   - `git/ref/heads/main`, plain and with the previous `If-None-Match`;
   - `contents/ledger`, plain and with the previous `If-None-Match`;
   - `contents/ledger?ref={newCommit}`;
   - `contents/{file}`;
   - `git/blobs/{newBlob}` (raw);
   - `git/trees/{newCommit}?recursive=1`.

Observed: **160 of 160 reads were fresh.**
- The ref showed the new commit.
- Neither conditional request returned a stale 304.
- Every listing and the file showed the new blob sha.
- The blob and the tree were readable at once.

The reads left the probe 1–116 ms after the PUT response, plus gh's start-up of a few hundred ms. So a staleness window shorter than about half a second is not ruled out. All reads came from one client through one edge region.

Medians: PUT 1.49 s; each read about 1.0 s. Both include gh's start-up.

**Design should:** keep §12's tolerance for stale reads (state only grows, and blobs are read by sha). It costs nothing and is still the only defence against replica lag between regions, which one client can't observe. The fake's `staleReads(lagN)` remains the way to test it.

## 14. Rate limits

- **Headers.** Every authenticated response carries `x-ratelimit-limit: 5000`, `-remaining`, `-used`, `-reset` and `-resource: core`, including 304s and errors. The unauthenticated limit is 60.
- **Errors count.** 404, 409 and 422 responses incremented `used`.
- **304s do not count.** See the table in §5.
- **Reads and writes report separate counters.** All 328 GETs shared one window (`reset 1791698255`, `used` 7 → 303). All 80 PUT and POST requests shared another (`reset 1791698856`, `used` 1 → 80). A PUT never moved the GET counter, and the reverse held too. Both claim `resource: core` and a limit of 5,000.
- **`GET /rate_limit` disagreed.** It reported `core.used: 0` and `remaining: 5000` at the start, at the end, and between, while the response headers showed 303 and 80 used.
- **Secondary limits were not hit:** 80 writes in about 25 minutes, with bursts of 3 at once.

**Design should:**
- Keep detecting rate limits from 403 or 429 plus `x-ratelimit-remaining: 0` or `retry-after`, as `contents.ts` does. Also treat a 403 or 429 whose message names a rate limit (`/rate limit/i`) as one, waiting the documented 60 s floor: GitHub's docs allow a secondary limit with neither header ("otherwise, wait at least one minute"), and without this it would read as a token lacking permission.
- Never poll `/rate_limit`.
- Not assume one shared counter. The design's budget is far inside either.
- Leave the secondary-limit handling (`retry-after`, the 60 s floor) as designed. It is still unverified against a real secondary-limit response.

## 15. CORS

**Preflight.** The request was `OPTIONS` with `Origin: https://someone.github.io`, `Access-Control-Request-Method` and `Access-Control-Request-Headers`. It was sent for `/user`, the repo, the ref (with `if-none-match`), the listing (with `if-none-match`), the tree, a blob, a PUT (with `content-type`), a DELETE and a missing repo. Every one answered identically:

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
access-control-allow-methods: GET, POST, PATCH, PUT, DELETE
access-control-allow-headers: Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match,
  If-Unmodified-Since, Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, GraphQL-Features,
  X-Github-Next-Global-ID, X-GitHub-Api-Version, X-Fetch-Nonce, Copilot-Integration-Id, DD-CLIENT-TOKEN,
  X-Client-Application
access-control-max-age: 86400
```

- `Cache-Control` and `Pragma` are **not** in the allowed list. The client must never set them itself. (Browsers add them for `cache: "no-store"` after the preflight decision, which is fine.)
- `Accept` needs no allowance. It is CORS-safelisted for the values used.

**Actual responses.** Every recorded response had `Access-Control-Allow-Origin: *` and no `Allow-Credentials`: statuses 200, 201, 304, 401, 404, 409 and 422. They exposed `ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset, Warning`. That is exactly the list `fakeGitHub.ts` models. `github-authentication-token-expiration` and `Date` are not exposed.

**Design should:** keep the request headers to `Authorization`, `Accept`, `X-GitHub-Api-Version`, `Content-Type` (PUT only) and `If-None-Match` (polls), all allowed. Every authenticated call is preflighted, so the first call after a 24 h preflight cache (browsers cap it lower; Chromium caps it at 2 h) costs one extra round trip. Preflights are unauthenticated and don't touch the rate limit.

## 16. Error shapes

All have the body `{"message": …, "documentation_url": …, "status": "<code as string>"}`.

| Request | Status | `message` |
|---|---|---|
| `GET contents/ledger/nope.enc` | 404 | `Not Found` |
| `GET contents/nodir` | 404 | `Not Found` |
| `GET contents/ledger?ref=nobranch` | 404 | `No commit found for the ref nobranch` |
| `GET contents/ledger?ref=0000…0000` | 404 | `No commit found for the ref 0000…0000` |
| `GET git/ref/heads/nobranch` | 404 | `Not Found` |
| `GET git/blobs/0000…0000` | 404 | `Not Found` |
| `GET git/blobs/{a tree sha}` | 404 | `Not Found` |
| `GET git/blobs/xyz` | 422 | `The sha parameter must be exactly 40 characters and contain only [0-9a-f].` |
| `GET git/trees/0000…0000` | 404 | `Not Found` |
| `GET git/commits/0000…0000` | 404 | `Not Found` |
| `GET /repos/{o}/{missing}` | 404 | `Not Found` |
| `GET /user` with a fictional `github_pat_…` token | 401 | `Bad credentials` |
| `GET git/ref/heads/main` on the private repo, unauthenticated | 404 | `Not Found` (a private repo looks missing) |
| Empty repo: see §1 | 404 / 409 | `This repository is empty.` / `Git Repository is empty.` |
| PUT cases: see §3 and §4 | 409 / 422 | |

**Browser side, not probed.** `fetch` gives script every one of these as a normal `Response`, because `Access-Control-Allow-Origin: *` is present on all of them. Only network failures reject.

## 17. Fake fidelity gaps (for §16.3)

The fake should be corrected or extended to match. **Done in step 2:** `fakeGitHub.ts` models all eight, and `fakeGitHub.fidelity.test.ts` checks it against the fixture. Not modelled, because Ledger never calls them: the plural `git/refs`, `git/commits`, the `commitSha:path` tree form, and commits no branch points at. Each fails with 501 and is recorded in `unhandled`, so a test that reaches one fails loudly instead of seeing a GitHub-shaped 404. So does a PUT whose path is a directory or lies under a file (see §19).

1. **Inline boundary.** Inline content only when `size < 1048576`. Today it inlines when `<= 1048576`.
2. **PUT with a `sha` for an absent path.** Real GitHub gives 201 and ignores the sha. The fake gives 409.
3. **Malformed blob sha.** Real GitHub gives 422 `The sha parameter must be exactly 40 characters…`. The fake gives 404.
4. **Raw blob `Content-Type`.** Real GitHub sends `text/plain; charset=utf-8`. The fake sends `application/vnd.github.raw; charset=utf-8`. The contents API's raw type is correct in the fake.
5. **New routes:**
   - `git/ref/heads/{b}`: weak ETag that varies with `Accept`; 304 with no body and no `x-ratelimit-used` increment; 409 `Git Repository is empty.` on an empty repo.
   - `git/trees/{sha|branch}[?recursive=1]`: `{sha, tree, truncated}`, entries with `size`, names sorted.
   - `contents/{dir}`: sorted array; strong ETag equal to the root tree sha; **silent cap at 1,000**.
   - PUT responses with `commit.sha`, `commit.tree.sha` and `commit.parents: [{sha, …}]`.
6. **Branch race.** Concurrent PUTs to any path give 409 `is at <head> but expected <base>`. A PUT whose file sha is current but whose base head is stale **may** instead be applied on top (GitHub did both). By default the fake keeps a PUT in flight only until the current synchronous section ends, so only PUTs sent in the same tick race; its `putLatencyMs` option keeps each PUT in flight that long, so PUTs sent milliseconds apart race as they did here.
7. **Identical-content PUT** with the current sha: 200 with a new commit and an unchanged blob sha. The fake already does this.
8. **Rate-limit headers:** separate `used` counters for reads and writes; 304s not counted; errors counted, including the fake's injected ones (`failNext`), which carry the same headers.

## 18. What the fixture contains

`client/src/backend/github/__fixtures__/github-behaviour.json` has these sections:

| Section | Contents |
|---|---|
| `emptyRepo` | §1 |
| `put` | response keys, cases with status and message: §2, §3 |
| `concurrency` | counts and message patterns: §4 |
| `contents.file` / `contents.inline` / `contents.raw` / `contents.listing` | including `cap`: §7, §8, §10 |
| `trees` | §9 |
| `blobs` | §11 |
| `ref` | §5 |
| `conditional` | per-endpoint 304 series with `x-ratelimit-used`: §5 |
| `readAfterWrite` | §13 |
| `rateLimit` | §14 |
| `cors` | preflight and response header lists: §15 |
| `errors` | §16 |
| `samples` | real response bodies |

In `samples`, `download_url` tokens, `temp_clone_token` and the committer's identity are redacted.

## 19. Not established by this probe

- **Fine-grained token permissions (§16.5 item 6).** Only an OAuth `repo`-scoped token was available. GitHub's documentation lists "Contents: read" for the refs, trees, blobs and commits endpoints, and "Contents: write" for the contents PUT. *Settled in stage 8d:* a `github_pat_` token with only Contents read/write on one repo (Metadata read is added by GitHub) runs the whole engine, as `realGitHub.smoke.test.ts` shows; the 304 on a conditional ref read stays uncounted with it (`x-ratelimit-used` moved by 1 across a 304 and one 200).
- **Keepalive PUT on `pagehide` (§7, §16.5 item 5).** The PUT needs a CORS preflight (it sends `Authorization` and `Content-Type: application/json` with method `PUT`). Whether a browser will run a preflight for a `keepalive` request while the page unloads has varied between browsers and versions. A cached preflight (`max-age=86400`, capped lower by browsers) usually avoids the question. If it fails, the push is a lost send, and step 5 already recovers it on the next start. Needs iOS Safari and Android Chrome.
- **Secondary rate limits.** Not provoked, on purpose. The response shape `contents.ts` expects (403 or 429 with `retry-after`, or a message naming the rate limit) is as documented, but was not observed.
- **Two first commits at once on an empty repo.** Not probed. The loser presumably gets a 409, but GitHub can't name a head it expected, and its message is unknown. The fake answers `is at <head> but expected 0000000000000000000000000000000000000000` (git's null id), which keeps the recorded branch-race shape, so `ShaConflictError` classifies it as a branch race.
- **A PUT onto a directory, or under a file.** Git can't hold a file and a directory at one path, so GitHub must refuse a PUT to `contents/ledger` while `ledger/` holds files, or to `contents/ledger/x.enc/y` while `ledger/x.enc` is a file. The status and message were not probed. Ledger never sends either (a device writes only its own files). The fake answers 501 and records the request in `unhandled` rather than guess.
- **ETag across token refreshes.** `Vary` includes `Authorization`, so a refreshed GitHub App token may get a different ETag. The cost would be one 200 instead of a 304. Not testable with one token.
- **The 100 MB and 7 MB / 100,000-entry ceilings.** Far above Ledger's sizes. Not exercised.
- **Staleness across regions** (§13). One client, one edge.
- **Repo size after a simulated year (§16.5 item 7).** `size` stays `0` until GitHub recomputes it. Measure it separately over time.
