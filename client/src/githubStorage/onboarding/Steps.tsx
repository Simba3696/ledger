import { useState, type ReactNode } from "react";
import {
  newOrgUrl,
  newRepoUrl,
  newTokenUrl,
  orgInvitationUrl,
  orgPendingTokensUrl,
  orgPeopleUrl,
  orgTokenPolicyUrl,
  repoAccessUrl,
  isGitHubName,
} from "../links";
import { Card, ErrorText, GitHubLink } from "../Shell";
import { STEPS, type Screen } from "./flow";

// The walkthrough's cards before the token is pasted (#8): each opens one
// GitHub page in a new tab and says exactly what to press there. Every
// link comes from links.ts.

type StepScreen = Extract<Screen, { kind: "step" }>;

function Nav({ onBack, onNext, nextLabel = "Next", nextDisabled = false }: { onBack: () => void; onNext: () => void; nextLabel?: string; nextDisabled?: boolean }) {
  return (
    <div className="gh-actions">
      <button type="button" className="gh-secondary" onClick={onBack} data-testid="gh-step-back">
        Back
      </button>
      <button type="button" className="submit-btn" onClick={onNext} disabled={nextDisabled} data-testid="gh-step-next">
        {nextLabel}
      </button>
    </div>
  );
}

function OrgName({ screen, onOrg }: { screen: StepScreen; onOrg: (org: string) => void }) {
  const [value, setValue] = useState(screen.org ?? "");
  const name = value.trim();
  const valid = isGitHubName(name);
  return (
    <>
      <label>
        {screen.path === "member" ? "The organization's name" : "Your organization's name"}
        <input
          name="org"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          data-testid="gh-org-name"
          onChange={(e) => {
            setValue(e.target.value);
            // An unfinished or invalid name clears it, so Next waits for a
            // real one.
            const next = e.target.value.trim();
            onOrg(isGitHubName(next) ? next : "");
          }}
        />
      </label>
      {name !== "" && !valid && <ErrorText>That isn't a GitHub organization name: letters, digits and dashes only.</ErrorText>}
    </>
  );
}

const TOKEN_STEPS = (repo: string) => (
  <ol>
    <li>
      Under <strong>Repository access</strong>, choose <strong>Only select repositories</strong>, then pick <strong>{repo}</strong>.
    </li>
    <li>
      Under <strong>Permissions</strong>, <strong>Contents</strong> is already set to <strong>Read and write</strong>. GitHub adds <strong>Metadata</strong> (read-only) by itself. Leave everything else as it is.
    </li>
    <li>
      Press <strong>Generate token</strong> and copy it. It starts with <code>github_pat_</code>, and GitHub shows it only once.
    </li>
  </ol>
);

/** One walkthrough card, for every step but "connect". */
export function StepCard({ screen, onOrg, onBack, onNext }: { screen: StepScreen; onOrg: (org: string) => void; onBack: () => void; onNext: () => void }) {
  const steps = STEPS[screen.path];
  const at = steps.indexOf(screen.step);
  const org = screen.org ?? "";
  const repo = screen.repo;
  const count = <p className="gh-step-count">{`Step ${at + 1} of ${steps.length}`}</p>;
  const card = (title: string, body: ReactNode, nav: ReactNode = <Nav onBack={onBack} onNext={onNext} />) => (
    <Card title={title} focusKey={`${screen.path}-${screen.step}`}>
      {count}
      {body}
      {nav}
    </Card>
  );

  switch (screen.step) {
    case "org":
      return card(
        "Create a free organization for your household",
        <>
          <p>A GitHub organization lets everyone in your household reach the same private repository with their own account.</p>
          <GitHubLink href={newOrgUrl()} testId="gh-open-org">
            Open GitHub: new organization
          </GitHubLink>
          <ol>
            <li>Choose the <strong>Free</strong> plan.</li>
            <li>Give it a name, for example <code>smith-household</code>, and finish creating it.</li>
            <li>Type the name below.</li>
          </ol>
          <OrgName screen={screen} onOrg={onOrg} />
        </>,
        <Nav onBack={onBack} onNext={onNext} nextDisabled={!screen.org} />,
      );
    case "repo":
      return card(
        "Create your data repository",
        <>
          <GitHubLink href={screen.path === "household" ? newRepoUrl({ org }) : newRepoUrl("me")} testId="gh-open-repo">
            Open GitHub: new repository
          </GitHubLink>
          <ol>
            <li>
              Check the name is <strong>{repo}</strong> and <strong>Private</strong> is selected.
            </li>
            <li>
              Press <strong>Create repository</strong>. Leave it empty: Ledger fills it.
            </li>
          </ol>
        </>,
      );
    case "policy":
      return card(
        "Token approval",
        <>
          <p>
            A new organization asks an owner to approve each member's token before it works. Keep that on: it means nobody can reach your household's data without you saying yes.
          </p>
          <p>
            You approve tokens on GitHub under your organization's <strong>Settings</strong>, then <strong>Personal access tokens</strong>, then <strong>Pending requests</strong>.
          </p>
          <GitHubLink href={orgPendingTokensUrl(org)} testId="gh-open-pending">
            Open GitHub: pending token requests
          </GitHubLink>
          <p className="gh-note">
            To check the setting itself: <a href={orgTokenPolicyUrl(org)} target="_blank" rel="noopener noreferrer">token policy</a>.
          </p>
        </>,
      );
    case "members":
      return card(
        "Invite your household",
        <>
          <GitHubLink href={orgPeopleUrl(org)} testId="gh-open-people">
            Open GitHub: people
          </GitHubLink>
          <ol>
            <li>
              Press <strong>Invite member</strong> for each person, by their GitHub username or email.
            </li>
            <li>
              Then give each of them <strong>Write</strong> on <strong>{repo}</strong>: on the{" "}
              <a href={repoAccessUrl(org, repo)} target="_blank" rel="noopener noreferrer">
                repository's access page
              </a>
              , press <strong>Add people</strong> and choose <strong>Write</strong>. Members only get Read otherwise.
            </li>
          </ol>
          <p className="gh-note">You can do this later too. Once the ledger exists, Ledger gives you a link to send them.</p>
        </>,
      );
    case "accept":
      // Without an invite link the organization isn't known yet: the
      // member types it, as the owner did, before any link is shown.
      return card(
        "Accept the invitation",
        <>
          <p>Someone in your household invited you to their GitHub organization. If you don't have a GitHub account yet, create one first.</p>
          <OrgName screen={screen} onOrg={onOrg} />
          {screen.org && (
            <>
              <GitHubLink href={orgInvitationUrl(org)} testId="gh-open-invitation">
                Open GitHub: the invitation
              </GitHubLink>
              <p>
                Press <strong>Join {org}</strong>.
              </p>
            </>
          )}
        </>,
        <Nav onBack={onBack} onNext={onNext} nextDisabled={!screen.org} />,
      );
    case "token":
      return card(
        "Create a token for Ledger",
        <>
          <p>A token lets Ledger reach just this one repository for you. It never sees your GitHub password.</p>
          <GitHubLink href={newTokenUrl(screen.path === "personal" ? undefined : org)} testId="gh-open-token">
            Open GitHub: new token
          </GitHubLink>
          {TOKEN_STEPS(repo)}
          {screen.path !== "personal" && (
            <p className="gh-note">
              <strong>{org}</strong> may need an owner to approve your token first. You can paste it now either way.
            </p>
          )}
        </>,
      );
    case "connect":
      // Rendered by ConnectStep.
      return null;
  }
}
