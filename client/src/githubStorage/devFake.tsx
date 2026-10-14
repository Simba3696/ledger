import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { createFakeGitHub, type FakeGitHub } from "../backend/github/fakeGitHub";
import { SECTIONS } from "./defaults";
import { GitHubGate } from "./GitHubGate";
import { connect, createNew } from "./ledgerAccess";

// A development page only (client/fake.html, served by `vite --mode github`
// and never built: the build's one entry is index.html). It runs the real
// gate over an in-memory fake GitHub, so the onboarding screens can be
// clicked through without a GitHub account: the browser check of #8, and
// #11's e2e. Fictional data only; the fake resets on every reload.
//
//   fake.html                  an empty repo: Create
//   fake.html?ledger=existing  a ledger already in it: Unlock, passphrase
//                              "correct horse battery staple"
//   fake.html?owner=smith-household&repo=ledger-data   an invite link
//   fake.html?keep             keep what the last load saved on this origin
//
// Tokens: github_pat_alex and github_pat_alex2 (alex's repo and the
// household's), github_pat_sam (the household's only), github_pat_stranger
// (none). The fake is window.ledgerFake, so a check can revoke a token
// mid-session (ledgerFake.revokeToken("github_pat_alex")) to reach
// Replace token.

const PASSPHRASE = "correct horse battery staple";

const fake = createFakeGitHub({
  repos: [
    { owner: "alex", name: "ledger-data", private: true },
    { owner: "smith-household", name: "ledger-data", private: true },
  ],
  tokens: {
    github_pat_alex: { login: "alex", repos: ["alex/ledger-data", "smith-household/ledger-data"], permission: "write" },
    github_pat_alex2: { login: "alex", repos: ["alex/ledger-data", "smith-household/ledger-data"], permission: "write" },
    github_pat_sam: { login: "sam", repos: ["smith-household/ledger-data"], permission: "write" },
    github_pat_stranger: { login: "stranger", repos: [], permission: "write" },
  },
});

(globalThis as { ledgerFake?: FakeGitHub }).ledgerFake = fake;

const params = new URLSearchParams(location.search);
// A ledger made before the page shows, as another device would have.
const seeded =
  params.get("ledger") === "existing"
    ? connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch }).then((c) => createNew(c, PASSPHRASE, { modules: [...SECTIONS], timeZone: "Asia/Kolkata" }))
    : Promise.resolve();
const fetchAfterSeed: typeof fetch = async (input, init) => {
  await seeded;
  return fake.fetch(input, init);
};

// The fake starts empty on every load, so what this origin saved before
// (a connection, a key, sync state) would point at a ledger that is no
// longer there: each load starts clean, unless ?keep is given (to check a
// reload opens without the passphrase; the fake repo is empty then).
const cleared = params.has("keep")
  ? Promise.resolve()
  : Promise.all(["ledger:github", "ledger:sync"].map((name) => new Promise<void>((done) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => done();
    })));

document.documentElement.dataset.storage = "github";
void cleared.then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <GitHubGate deps={{ fetch: fetchAfterSeed }} />
    </StrictMode>,
  ),
);
