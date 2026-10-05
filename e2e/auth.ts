/**
 * Real sign-in for the e2e and screenshot scripts (LLD §6, §10): the dev
 * server runs with auth on against the LOCAL Supabase stack, and every run
 * signs in as the owner account supabase/seed.sql creates.
 */
import type { Page } from "playwright";
import { CLIENT_PORT, clientEnv, serverEnv } from "./devServer.js";

/** supabase/seed.sql's owner password. Local stack only; it exists nowhere
 * else. The email is server/.env's OWNER_EMAIL. */
export const OWNER_PASSWORD = "local-owner-password";

function assertLocalUrl(name: string, value: string | undefined, file: string): void {
  if (!value) {
    throw new Error(`${name} is not set in ${file}. Point it at the local Supabase stack (http://127.0.0.1:54321).`);
  }
  const host = new URL(value).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run against non-local Supabase host "${host}" (${name} in ${file}).`);
  }
}

/** Refuses to start unless sign-in would go to the LOCAL stack only, as
 * localDb.ts refuses a non-local database. Also refuses AUTH_DISABLED=true,
 * which would let every check here pass without testing sign-in at all.
 * Returns the owner's email. */
export function assertLocalAuth(): string {
  if (serverEnv.AUTH_DISABLED === "true") {
    throw new Error("Remove AUTH_DISABLED=true from server/.env: e2e signs in for real (LLD §6, §10).");
  }
  assertLocalUrl("SUPABASE_URL", serverEnv.SUPABASE_URL, "server/.env");
  assertLocalUrl("VITE_SUPABASE_URL", clientEnv.VITE_SUPABASE_URL, "client/.env");
  if (!clientEnv.VITE_SUPABASE_ANON_KEY) {
    throw new Error("VITE_SUPABASE_ANON_KEY is not set in client/.env (`npx supabase status` prints it).");
  }
  const ownerEmail = serverEnv.OWNER_EMAIL?.trim();
  if (!ownerEmail) {
    throw new Error("OWNER_EMAIL is not set in server/.env. Use the account supabase/seed.sql creates (owner@example.test).");
  }
  return ownerEmail;
}

/** An access token for the owner straight from the local stack's Auth API,
 * for the scripts' own direct API calls (the browser has its own session). */
export async function ownerAccessToken(): Promise<string> {
  const res = await fetch(`${clientEnv.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: clientEnv.VITE_SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: serverEnv.OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `Signing in as the seeded owner failed (${res.status}). Run \`npx supabase db reset\` to (re)create it from supabase/seed.sql.`,
    );
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Fills and submits <SignIn/>. Doesn't wait for the result. */
export async function submitSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.waitForSelector("form.auth-card");
  await page.fill('.auth-card input[type="email"]', email);
  await page.fill('.auth-card input[type="password"]', password);
  await page.click('.auth-card button[type="submit"]');
}

/** Removes every console error mentioning `status`, for checks that provoke
 * that response on purpose. Every match, since the browser may log one
 * failed request more than once. */
export function dropConsoleErrors(consoleErrors: string[], status: string): void {
  for (let i = consoleErrors.length - 1; i >= 0; i--) {
    if (consoleErrors[i].includes(status)) consoleErrors.splice(i, 1);
  }
}

/** The sign-in checks both e2e passes share: opens the app signed out,
 * checks <SignIn/> shows instead of the app, that a wrong password shows an
 * error and stays there, then signs in as the owner and waits for the
 * Dashboard's data. */
export async function checkSignInFlow(
  page: Page,
  ownerEmail: string,
  consoleErrors: string[],
  check: (label: string, ok: boolean) => void,
): Promise<void> {
  await page.goto(`http://localhost:${CLIENT_PORT}`, { waitUntil: "networkidle" });
  check(
    "Signed out: the sign-in screen shows instead of the app",
    (await page.locator("form.auth-card").count()) === 1 && (await page.locator(".tabs").count()) === 0,
  );
  await submitSignIn(page, ownerEmail, "not-the-password");
  await page.waitForSelector('.auth-card [role="alert"]');
  check(
    "Sign-in: a wrong password shows an error and stays on the sign-in screen",
    (await page.locator('.auth-card [role="alert"]').innerText()).toLowerCase().includes("invalid") &&
      (await page.locator(".tabs").count()) === 0,
  );
  // Supabase Auth answers the wrong password with a 400, which the browser
  // logs as a console error. Expected here, so drop it rather than fail the
  // "no console errors" check at the end.
  dropConsoleErrors(consoleErrors, "400");

  await submitSignIn(page, ownerEmail, OWNER_PASSWORD);
  await page.waitForSelector(".tabs");
  await page.waitForSelector(".chart-wrap svg");
  await page.waitForSelector(".loading-overlay", { state: "detached" });
  check("Sign-in: the owner's password opens the app", (await page.locator("form.auth-card").count()) === 0);
}

/** Opens the app (on the sign-in screen) and signs in as the owner, then
 * waits for the app's nav. */
export async function signInAsOwner(page: Page): Promise<void> {
  await page.goto(`http://localhost:${CLIENT_PORT}`, { waitUntil: "networkidle" });
  await submitSignIn(page, serverEnv.OWNER_EMAIL, OWNER_PASSWORD);
  await page.waitForSelector(".tabs");
}
