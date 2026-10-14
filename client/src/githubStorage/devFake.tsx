import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { createFakeGitHub } from "../backend/github/fakeGitHub";
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
//
// Tokens: github_pat_alex (alex's repo and the household's),
// github_pat_sam (the household's only), github_pat_stranger (none).

const PASSPHRASE = "correct horse battery staple";

const fake = createFakeGitHub({
  repos: [
    { owner: "alex", name: "ledger-data", private: true },
    { owner: "smith-household", name: "ledger-data", private: true },
  ],
  tokens: {
    github_pat_alex: { login: "alex", repos: ["alex/ledger-data", "smith-household/ledger-data"], permission: "write" },
    github_pat_sam: { login: "sam", repos: ["smith-household/ledger-data"], permission: "write" },
    github_pat_stranger: { login: "stranger", repos: [], permission: "write" },
  },
});

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

document.documentElement.dataset.storage = "github";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GitHubGate deps={{ fetch: fetchAfterSeed }} />
  </StrictMode>,
);
