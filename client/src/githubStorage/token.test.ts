import { describe, expect, it } from "vitest";
import { GitHubAuthError, GitHubForbiddenError, GitHubNetworkError, GitHubRateLimitError, PublicRepoError, RepoNotFoundError } from "../backend/github/contents";
import { CLASSIC_TOKEN, checkPastedToken, connectError, NOT_A_TOKEN, OFFLINE, READ_ONLY_TOKEN, TOKEN_REFUSED } from "./token";

const user = { owner: "alex", repo: "ledger-data", ownerIsOrg: false };
const org = { owner: "smith-household", repo: "ledger-data", ownerIsOrg: true };

describe("the token paste field (#8)", () => {
  it("accepts a fine-grained token", () => {
    expect(checkPastedToken("github_pat_11ABC")).toEqual({ ok: true, token: "github_pat_11ABC" });
  });

  it("trims what was pasted", () => {
    expect(checkPastedToken("  github_pat_11ABC\n")).toEqual({ ok: true, token: "github_pat_11ABC" });
  });

  it("refuses a classic token with its own message", () => {
    expect(checkPastedToken("ghp_abc")).toEqual({ ok: false, message: CLASSIC_TOKEN });
  });

  it("refuses a GitHub App user token on the paste field: only sign-in makes those", () => {
    expect(checkPastedToken("ghu_abc")).toEqual({ ok: false, message: NOT_A_TOKEN });
  });

  it("refuses anything else, an OAuth token included", () => {
    expect(checkPastedToken("my passphrase")).toEqual({ ok: false, message: NOT_A_TOKEN });
    expect(checkPastedToken("gho_abc")).toEqual({ ok: false, message: NOT_A_TOKEN });
    expect(checkPastedToken("")).toEqual({ ok: false, message: NOT_A_TOKEN });
  });
});

describe("what connecting tells the person (#8)", () => {
  it("a 401: the token wasn't accepted", () => {
    expect(connectError(new GitHubAuthError(), user)).toEqual({ message: TOKEN_REFUSED, awaitingApproval: false });
  });

  it("a 404 for a personal repo: not found or not given access", () => {
    expect(connectError(new RepoNotFoundError(), user)).toEqual({ message: "Can't find alex/ledger-data, or this token wasn't given access to it.", awaitingApproval: false });
  });

  it("a 404 for an organization's repo adds the approval hint", () => {
    expect(connectError(new RepoNotFoundError(), org)).toEqual({
      message: "Can't find smith-household/ledger-data, or this token wasn't given access to it. Your token may be waiting for approval by an owner of smith-household.",
      awaitingApproval: true,
    });
  });

  it("a public repo is refused", () => {
    expect(connectError(new PublicRepoError(200), user).message).toBe("alex/ledger-data is public. Ledger only stores data in a private repository.");
  });

  it("a 403 on the first save: read-only token; elsewhere GitHub's own words; offline and rate limits", () => {
    expect(connectError(new GitHubForbiddenError("Resource not accessible by personal access token"), user, { write: true }).message).toBe(READ_ONLY_TOKEN);
    expect(connectError(new GitHubForbiddenError("Resource not accessible by personal access token"), user).message).toBe("Resource not accessible by personal access token");
    expect(connectError(new GitHubNetworkError(), user).message).toBe(OFFLINE);
    expect(connectError(new GitHubRateLimitError(403, null), user).message).toBe("GitHub's rate limit was reached. Try again in a few minutes.");
  });
});
