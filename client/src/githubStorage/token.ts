import {
  classifyToken,
  GitHubAuthError,
  GitHubForbiddenError,
  GitHubNetworkError,
  GitHubRateLimitError,
  PublicRepoError,
  RepoNotFoundError,
} from "../backend/github/contents";

// The token paste field and the words for what GitHub answers while
// connecting (#8). Pure, so every message is tested without a network.

export const CLASSIC_TOKEN = "This is a classic token. Create a fine-grained token instead: it can be limited to just your ledger-data repo.";
export const NOT_A_TOKEN = "That doesn't look like a GitHub fine-grained token.";
export const TOKEN_REFUSED = "GitHub didn't accept this token. Check you copied all of it.";
export const READ_ONLY_TOKEN = "This token can read but not save. Set Contents to Read and write.";
export const OTHER_REPO = "This token reaches a different repository than this ledger.";
export const OFFLINE = "Couldn't reach GitHub. Check your connection and try again.";

/** A pasted token, trimmed, or why it's refused. Only fine-grained tokens
 * pass: #6's classifyToken also accepts GitHub App user tokens (ghu_), but
 * only #10's sign-in makes those, so the paste field refuses them. Nothing
 * here makes a request. */
export function checkPastedToken(raw: string): { ok: true; token: string } | { ok: false; message: string } {
  const token = raw.trim();
  const check = classifyToken(token);
  if (check.ok && check.kind === "fine-grained") return { ok: true, token };
  return { ok: false, message: token.startsWith("ghp_") ? CLASSIC_TOKEN : NOT_A_TOKEN };
}

/** Owner and repo were missing or the token can't reach them. */
function repoNotFound(owner: string, repo: string): string {
  return `Can't find ${owner}/${repo}, or this token wasn't given access to it.`;
}

/** An organization's token may still wait for an owner's approval: until
 * then it reads only public resources, so the private repo answers 404. */
function approvalHint(org: string): string {
  return `Your token may be waiting for approval by an owner of ${org}.`;
}

function publicRepo(owner: string, repo: string): string {
  return `${owner}/${repo} is public. Ledger only stores data in a private repository.`;
}

export interface ConnectTarget {
  owner: string;
  repo: string;
  /** The owner is an organization (a household), which may require an
   * owner's approval for tokens. */
  ownerIsOrg: boolean;
}

/** What to tell the person when connecting failed, and whether the
 * approval hint (with "Check again") applies. `write` is the first save. */
export function connectError(err: unknown, target: ConnectTarget, { write = false }: { write?: boolean } = {}): { message: string; awaitingApproval: boolean } {
  const plain = (message: string) => ({ message, awaitingApproval: false });
  if (err instanceof GitHubAuthError) return plain(TOKEN_REFUSED);
  if (err instanceof RepoNotFoundError) {
    const message = repoNotFound(target.owner, target.repo);
    return target.ownerIsOrg ? { message: `${message} ${approvalHint(target.owner)}`, awaitingApproval: true } : plain(message);
  }
  if (err instanceof PublicRepoError) return plain(publicRepo(target.owner, target.repo));
  if (err instanceof GitHubForbiddenError && write) return plain(READ_ONLY_TOKEN);
  if (err instanceof GitHubRateLimitError) return plain(err.message);
  if (err instanceof GitHubNetworkError || err instanceof TypeError) return plain(OFFLINE);
  if (err instanceof Error && err.message) return plain(err.message);
  return plain(OFFLINE);
}
