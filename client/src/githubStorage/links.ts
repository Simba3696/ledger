// Every github.com link the onboarding walkthrough and Settings open (#8),
// and the household invite link. The only builder of github.com URLs: each
// is a new-tab navigation for the person to finish on GitHub, never a
// request the app makes. Prefilled where GitHub's forms accept it; what a
// form can't take (picking the repository for a token) the walkthrough
// card says in words.

export const DEFAULT_REPO_NAME = "ledger-data";

const GITHUB = "https://github.com";
const REPO_DESCRIPTION = "Encrypted data for Ledger. Only the household passphrase opens it.";
const TOKEN_NAME = "Ledger";
const TOKEN_DESCRIPTION = "Lets Ledger read and save its encrypted data in your ledger-data repository.";
/** GitHub's longest token name. */
const TOKEN_NAME_MAX = 40;
/** Days: GitHub's default maximum lifetime for a token an organization accepts. */
const TOKEN_LIFETIME_DAYS = 366;

function url(path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `${GITHUB}${path}${query ? `?${query}` : ""}`;
}

const segment = (name: string) => encodeURIComponent(name);

/** github.com/new, for a private ledger-data repo owned by the signed-in
 * person or an organization. GitHub documents `owner` as an account name;
 * the person's own is the form's default, so it isn't sent for them
 * (checked against GitHub's docs, 2026-10-14). */
export function newRepoUrl(owner: { org: string } | "me", name = DEFAULT_REPO_NAME): string {
  const params: Record<string, string> = { name, visibility: "private", description: REPO_DESCRIPTION };
  if (owner !== "me") params.owner = owner.org;
  return url("/new", params);
}

/** The fine-grained token form, prefilled with a name, a description, a
 * year's lifetime and Contents read and write. `org` makes the
 * organization its resource owner (`target_name`). Repository access
 * can't be prefilled. */
export function newTokenUrl(org?: string, name = TOKEN_NAME): string {
  const params: Record<string, string> = {
    name: name.slice(0, TOKEN_NAME_MAX),
    description: TOKEN_DESCRIPTION,
    expires_in: String(TOKEN_LIFETIME_DAYS),
    contents: "write",
  };
  if (org !== undefined) params.target_name = org;
  return url("/settings/personal-access-tokens/new", params);
}

/** Creating a free organization for a household. */
export function newOrgUrl(): string {
  return url("/account/organizations/new", { plan: "free" });
}

/** The organization's People page, to invite members. */
export function orgPeopleUrl(org: string): string {
  return url(`/orgs/${segment(org)}/people`);
}

/** Where an invited member accepts the organization's invitation. */
export function orgInvitationUrl(org: string): string {
  return url(`/orgs/${segment(org)}/invitation`);
}

/** The organization's fine-grained token policy (whether tokens need an
 * owner's approval). */
export function orgTokenPolicyUrl(org: string): string {
  return url(`/organizations/${segment(org)}/settings/personal-access-tokens`);
}

/** Tokens waiting for an organization owner's approval. */
export function orgPendingTokensUrl(org: string): string {
  return url(`/organizations/${segment(org)}/settings/personal-access-token-requests`);
}

/** The repo's "Collaborators and teams" page, where members get Write. */
export function repoAccessUrl(owner: string, repo = DEFAULT_REPO_NAME): string {
  return url(`/${segment(owner)}/${segment(repo)}/settings/access`);
}

/** The household invite link: this page, with the repo to join. Only the
 * owner and repo go in it, never a token or the passphrase. The base is
 * the page's own address (wherever the site is served), not a build
 * setting. */
export function inviteLink(page: Pick<Location, "origin" | "pathname">, owner: string, repo = DEFAULT_REPO_NAME): string {
  return `${page.origin}${page.pathname}?${new URLSearchParams({ owner, repo }).toString()}`;
}

/** The repo an invite link names, or null. Only these two parameters are
 * read, and only when both look like GitHub names. */
export function readInvite(search: string): { owner: string; repo: string } | null {
  const params = new URLSearchParams(search);
  const owner = params.get("owner")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";
  return isGitHubName(owner) && isGitHubName(repo) ? { owner, repo } : null;
}

/** A user, organization or repository name as GitHub allows them: letters,
 * digits, '-', '_' and '.', at most 100 characters. */
export function isGitHubName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== "..";
}
