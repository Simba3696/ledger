# Ledger on GitHub (no server)

This guide is for anyone who wants to use Ledger with nothing but a free
GitHub account. You don't need to know how to code. Each step says what to
press, in the words the screens use.

If you'd rather run your own copy of Ledger on Netlify and Supabase, that's
a different edition with its own guide: [DEPLOY.md](DEPLOY.md).

Contents:

1. [What this is](#1-what-this-is)
2. [One person](#2-one-person)
3. [A household](#3-a-household)
4. [Your passphrase](#4-your-passphrase)
5. [More devices, forgetting a device, and tokens that expire](#5-more-devices-forgetting-a-device-and-tokens-that-expire)
6. [Backups](#6-backups)
7. [Privacy and security](#7-privacy-and-security)
8. [Your own copy (a fork)](#8-your-own-copy-a-fork)
9. [Sign in with GitHub (optional)](#9-sign-in-with-github-optional)
10. [Troubleshooting](#10-troubleshooting)

## 1. What this is

Ledger keeps track of your expenses, income and savings, debts, loans
(EMIs), credit card bills and subscriptions. In this edition, the app is a
website that runs entirely in your browser, and your data lives in a
**private repository** on GitHub that only you (and your household) can
reach. A repository is GitHub's name for a folder of files kept online.

Before your data leaves your phone or computer, Ledger **encrypts** it
(scrambles it so it can't be read) with a **passphrase** that only you know.
GitHub stores the scrambled files; it never sees your passphrase or your
numbers.

What it is not:

- It is not the Netlify and Supabase edition of Ledger. The two don't share
  data, and there's no way to move data from one to the other.
- There is no Ledger server and no Ledger account. Nobody but you can reset
  your passphrase or get your data back for you.

What you need:

- A free GitHub account ([github.com/signup](https://github.com/signup)).
- A phone or computer with a current browser (Chrome, Edge, Firefox or
  Safari).
- The address of a Ledger site. It starts with `https://`, for example
  `https://<someone>.github.io/ledger/`.

## 2. One person

Open the Ledger site. The first screen, **Set up Ledger**, offers three ways
in. Press **Just me**. Ledger then shows three steps; each one opens a page
on GitHub in a new tab and says exactly what to press there. Do the step on
GitHub, come back to the Ledger tab and press **Next**.

1. **Create your data repository.** Press **Open GitHub: new repository**.
   On GitHub, check the name is **ledger-data** and **Private** is
   selected, then press **Create repository**. Leave it empty: Ledger fills
   it.
2. **Create a token for Ledger.** A token is a password just for Ledger
   that can reach this one repository and nothing else. It never shows
   Ledger your GitHub password. Press **Open GitHub: new token**. On GitHub:
   1. Under **Repository access**, choose **Only select repositories**,
      then pick **ledger-data**.
   2. Under **Permissions**, **Contents** is already set to **Read and
      write**. GitHub adds **Metadata** (read-only) by itself. Leave
      everything else as it is.
   3. Press **Generate token** and copy it. It starts with `github_pat_`,
      and GitHub shows it only once.

   The token's **Resource owner** is you, which is what GitHub picks when
   you open the page from Ledger.
3. **Paste your token.** Paste it into **Token** and press **Connect**.
   (The **Different repository?** link is only for a repository with
   another name or owner.)

Ledger checks the token with GitHub and opens **Create your ledger**:

- Type a **Passphrase**, and the same again in **Passphrase again**. Read
  [part 4](#4-your-passphrase) first: there is no way to recover it.
- Tick **I've saved this passphrase somewhere safe**.
- Under **Sections**, untick anything you won't use. The Dashboard is always
  on. You can change this later in Settings.
- **Time zone** decides what "today" means. It starts as your device's.
- Press **Create ledger**.

Ledger saves its first file to your repository and opens on the Dashboard.
That's it.

## 3. A household

A household shares one ledger: everyone sees and edits the same data, from
their own GitHub account and their own devices. The data lives in a free
GitHub **organization** (a shared account a group of people can belong
to), so nobody has to hand out their own password or token.

### The person setting it up

Open the Ledger site and press **My household (I'm setting it up)**. Ledger
shows six steps:

1. **Create a free organization for your household.** Press **Open GitHub:
   new organization**, choose the **Free** plan, give it a name (for
   example `smith-household`) and finish creating it. Type the name into
   **Your organization's name** and press **Next**.
2. **Create your data repository.** As in [part 2](#2-one-person), but GitHub
   opens it inside your organization: check the name is **ledger-data** and
   **Private** is selected, press **Create repository**, and leave it empty.
3. **Token approval.** Your organization can require an owner's approval
   before each member's token works. Turn that on (or leave it on): nobody
   can then reach your household's data without you saying yes. Press
   **Open GitHub: token policy**, and under **Fine-grained personal access
   tokens** choose **Require administrator approval** and save. Later,
   approve each member's token under your organization's **Settings**, then
   **Personal access tokens**, then **Pending requests**. GitHub also
   emails owners about tokens waiting each day.
4. **Invite your household.** Press **Open GitHub: people**, then **Invite
   member** for each person, by their GitHub username or email (an email
   invite works only if it matches an email they've verified on GitHub).
   Then give each of them **Write** on **ledger-data**: on the repository's
   access page, press **Add people** and choose **Write**. Members only get
   Read otherwise. You can also do this later.
5. **Create a token for Ledger.** As in [part 2](#2-one-person), step 2, with
   one difference: the token's **Resource owner** is your **organization**,
   not you. Opening the page from Ledger picks it for you. Pick
   **ledger-data** under **Only select repositories**, and keep **Contents**
   on **Read and write**. If GitHub asks for a reason, write something like
   "Ledger, our household's money".
6. **Paste your token** and press **Connect**.

Then **Create your ledger**, as in part 2. Everyone in the household types
this same passphrase on their own devices, so share it in person, never in
a chat or an email.

Once the ledger exists, **Settings** (the gear at the top right) has a
**Household** part with an invite link to send to each member. The link
holds only the organization and repository names: never the token or the
passphrase.

### Each member

Open the invite link (or the Ledger site, and press **Join a household
someone set up**). Ledger shows three steps:

1. **Accept the invitation.** GitHub emailed you an invitation. If you don't
   have a GitHub account yet, create one first, with that email. Type the
   organization's name (the invite link fills it in), press **Open GitHub:
   the invitation**, press **Join** there, and come back.
2. **Create a token for Ledger**, with the organization as **Resource
   owner** and only **ledger-data** selected. Your token may wait for an
   owner's approval; you can paste it now either way.
3. **Paste your token** and press **Connect**.

Ledger finds the household's ledger and asks **Enter your passphrase**.
Type the household passphrase and press **Open ledger**.

## 4. Your passphrase

- Your passphrase never leaves your device. It isn't sent to GitHub, to the
  people who made Ledger, or anywhere else.
- **There is no recovery.** If every person who knows it forgets it, the
  data can't be opened by anyone, ever. Your backups (part 6) use the same
  passphrase, so they're lost too.
- Write it down somewhere safe (a password manager, or on paper kept at
  home) before you tick the box on **Create your ledger**.
- Each device remembers a key made from it, so you type it once per device.

## 5. More devices, forgetting a device, and tokens that expire

**Another phone or computer.** Open the Ledger site there and go through the
same path you used before (**Just me** or **My household**; a household
member uses **Join a household someone set up**). You can paste the same
token or make a new one. Ledger finds your ledger and asks for the
passphrase once. Changes sync between your devices through GitHub: when
you're offline, Ledger keeps them on the device and sends them once you're
back online.

**Forget this device.** In **Settings**, under **This device**, press
**Forget this device**. Ledger removes its copy of your data, the key and
the token from this browser and returns to the **Set up Ledger** screen.
Nothing on GitHub changes. If this device has changes that haven't reached
GitHub yet, Ledger asks first and offers to sync them. To use Ledger on the
device again, connect with a token as before; it asks for the passphrase
again.

**Tokens expire.** A token made from Ledger's link lasts a year. When GitHub
stops accepting it, Ledger shows **Replace your token**: make a new token
(part 2, step 2, or part 3, step 5), paste it and press **Use this token**.
Nothing on the device is lost, unsynced changes included. You can also
replace a token any time in **Settings**, under **Connection**.

## 6. Backups

In **Settings**, under **Backup**:

- **Export encrypted backup** saves a file named like
  `ledger-backup-2026-10-14.enc` with everything this device shows. It's
  encrypted with the passphrase you use today. Keep it somewhere other than
  GitHub (your computer, a USB stick, another cloud drive).
- **Restore from a backup file** replaces the whole ledger with the backup,
  after asking you. Every device switches to the restored ledger, and
  GitHub keeps the old version in the repository's history. A backup made
  under another passphrase asks for that passphrase.
- Starting fresh on an empty repository, **Create your ledger** has **Have a
  backup file? Start from it instead**: the new ledger holds the backup and
  uses its passphrase.

## 7. Privacy and security

What is encrypted: every number, name, note and setting you enter. Each
file is compressed, then encrypted with AES-GCM-256, with a key made from
your passphrase by PBKDF2-SHA256 at 600,000 rounds. Ledger's code on
GitHub Pages holds no data at all.

What GitHub (and anyone you give access to the repository) can still see:
the repository's name, how many files it has and how big they are, and
when each change was saved and by which GitHub account.

The site's address matters:

- Sites on `*.github.io` that share one address (for example
  `someone.github.io/ledger` and `someone.github.io/other-app`) also share
  the browser's storage. Ledger names everything it stores with a `ledger:`
  prefix so it doesn't clash. A custom domain (part 8) avoids the sharing
  entirely, but is optional.
- Ledger only works over `https://`. On a plain `http://` address the
  browser won't encrypt, and Ledger says it needs HTTPS.

## 8. Your own copy (a fork)

You can run your own copy of the site instead of using someone else's. A
**fork** is your own copy of Ledger's code on GitHub.

1. On Ledger's GitHub page, press **Fork**, then **Create fork**.
2. In your fork, open **Settings**, then **Pages**. Under **Build and
   deployment**, set **Source** to **GitHub Actions**.
3. Open **Actions**. If GitHub asks, press the button to enable workflows.
   Pick the **Pages** workflow and press **Run workflow**. It builds the
   site and publishes it at `https://<your-username>.github.io/<fork-name>/`.
   The site's path follows the fork's name by itself, so there's no
   setting to change if you rename it.

Optional settings:

- **Which sections a new ledger starts with.** `VITE_DEFAULT_MODULES` sets
  the sections ticked on **Create your ledger**, for example `expenses` for
  an expenses-only copy. In your fork, press **Add file**, then **Create
  new file**, name it `client/.env.github`, write
  `VITE_DEFAULT_MODULES=expenses` (or a comma-separated list from
  `expenses, finances, debts, emi, credit-cards, subscriptions`), and commit
  it. Leave it out to tick every section. An unknown name makes the site
  show a "misconfigured" screen until you fix it. Everyone can still change
  sections in Settings.
- **A custom domain.** Under **Settings**, then **Pages**, enter it in
  **Custom domain** and follow GitHub's steps. Then run the Pages workflow
  again, so the site is built for the new address.

**Keeping your fork up to date.** On your fork's main page, press **Sync
fork**, then **Update branch**. The Pages workflow publishes the new version
by itself.

**Switching it off.** Under **Settings**, then **Pages**, press **Unpublish
site** (or disable the Pages workflow under **Actions**). Your data stays in
your private `ledger-data` repository; it never lived in the fork.

## 9. Sign in with GitHub (optional)

In this build, every person connects by pasting a token, as in
[part 2](#2-one-person).

## 10. Troubleshooting

| What Ledger shows | What it means | What to do |
|---|---|---|
| "Ledger needs a secure (HTTPS) address to encrypt your data. Open it from an https:// link." | The site was opened over plain `http://`. | Open the `https://` address. |
| "Wrong passphrase" | The passphrase doesn't open this ledger (or this backup). | Check capitals and spaces. A backup made before a passphrase change needs the old one. |
| "GitHub didn't accept this token. Check you copied all of it." (401) | GitHub doesn't know the token: it was cut short when copied, or it was deleted. | Copy the whole token again (it starts with `github_pat_`), or make a new one. |
| "Replace your token": "GitHub no longer accepts this token (it expired or was revoked)." (401) | The token expired or was deleted. | Make a new token and paste it (part 5). |
| "Can't find *owner*/ledger-data, or this token wasn't given access to it." (404) | The token can't reach the repository: the token's **Resource owner** is wrong (you instead of the organization, or the other way round), **ledger-data** wasn't picked under **Only select repositories**, or an organization owner hasn't approved the token yet ("Your token may be waiting for approval"). | Check the token's settings on GitHub, or ask an owner to approve it under the organization's **Settings**, **Personal access tokens**, **Pending requests**, then press **Check again**. |
| "This token can read but not save. Set Contents to Read and write." or "Resource not accessible by personal access token" (403) | The token's permissions, or the organization's token policy, don't allow saving. | Edit the token on GitHub so **Contents** is **Read and write**, or check the organization's policy allows fine-grained tokens (part 3, step 3). |
| "1 to review" next to the sync status, and a note like "*Sam* changed Groceries · amount to 160.00; your 150.00 was replaced." | Two devices changed the same thing before syncing. Every device settles on the same one, the same way, without asking; the device whose change was replaced gets this note. | Press **1 to review**. Press **Use 150.00** (the button names your value) to put yours back, or **Dismiss** to keep theirs. |
| "Offline, 2 changes not saved yet" with **Try again** | Ledger couldn't reach GitHub, or GitHub kept refusing its saves for now. Your changes are kept on this device. | Check your connection, then press **Try again**. Ledger also tries again by itself when you come back online or reopen the app. |
| "Ledger is open in another tab. Close it there to use it here." | Only one tab per browser can use Ledger at a time. | Close the other tab. |
