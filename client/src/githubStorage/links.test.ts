import { describe, expect, it } from "vitest";
import {
  inviteLink,
  isGitHubName,
  newOrgUrl,
  newRepoUrl,
  newTokenUrl,
  orgInvitationUrl,
  orgPendingTokensUrl,
  orgPeopleUrl,
  orgTokenPolicyUrl,
  readInvite,
  repoAccessUrl,
} from "./links";

const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe("github.com links (#8)", () => {
  it("creates a private ledger-data repo for the signed-in person", () => {
    const url = newRepoUrl("me");
    expect(url.startsWith("https://github.com/new?")).toBe(true);
    expect(params(url)).toMatchObject({ name: "ledger-data", visibility: "private" });
    // The form's default owner is the signed-in person; "@me" isn't documented.
    expect(params(url).owner).toBeUndefined();
  });

  it("creates the repo in a household's organization", () => {
    expect(params(newRepoUrl({ org: "smith-household" }))).toMatchObject({ owner: "smith-household", name: "ledger-data", visibility: "private" });
  });

  it("prefills a fine-grained token: a year, Contents read and write, no organization", () => {
    const url = newTokenUrl();
    expect(url.startsWith("https://github.com/settings/personal-access-tokens/new?")).toBe(true);
    const p = params(url);
    expect(p).toMatchObject({ name: "Ledger", expires_in: "366", contents: "write" });
    expect(p.target_name).toBeUndefined();
  });

  it("makes the organization the token's resource owner", () => {
    expect(params(newTokenUrl("smith-household")).target_name).toBe("smith-household");
  });

  it("keeps a token name within GitHub's 40 characters", () => {
    expect(params(newTokenUrl(undefined, "L".repeat(60))).name).toHaveLength(40);
  });

  it("links the organization pages: new, people, invitation, token policy, pending requests", () => {
    expect(newOrgUrl()).toBe("https://github.com/account/organizations/new?plan=free");
    expect(orgPeopleUrl("smith-household")).toBe("https://github.com/orgs/smith-household/people");
    expect(orgInvitationUrl("smith-household")).toBe("https://github.com/orgs/smith-household/invitation");
    expect(orgTokenPolicyUrl("smith-household")).toBe("https://github.com/organizations/smith-household/settings/personal-access-tokens");
    expect(orgPendingTokensUrl("smith-household")).toBe("https://github.com/organizations/smith-household/settings/personal-access-token-requests");
  });

  it("links the repo's access page and encodes names", () => {
    expect(repoAccessUrl("smith-household")).toBe("https://github.com/smith-household/ledger-data/settings/access");
    expect(orgPeopleUrl("a/b")).toBe("https://github.com/orgs/a%2Fb/people");
  });

  it("builds the invite link from the page's own address, with only the owner and repo", () => {
    const link = inviteLink({ origin: "https://alex.github.io", pathname: "/ledger/" }, "smith-household");
    expect(link).toBe("https://alex.github.io/ledger/?owner=smith-household&repo=ledger-data");
    expect(Object.keys(params(link)).sort()).toEqual(["owner", "repo"]);
    expect(link).not.toMatch(/github_pat_|token|passphrase/i);
  });

  it("reads an invite back, and nothing that isn't a GitHub name", () => {
    expect(readInvite("?owner=smith-household&repo=ledger-data&token=x")).toEqual({ owner: "smith-household", repo: "ledger-data" });
    expect(readInvite("?owner=smith-household")).toBeNull();
    expect(readInvite("?owner=a%20b&repo=ledger-data")).toBeNull();
    expect(readInvite("?owner=..&repo=ledger-data")).toBeNull();
    expect(isGitHubName("smith.household_2")).toBe(true);
  });
});
