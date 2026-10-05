import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { authConfigError, supabase } from "./supabase";

export type SessionState =
  // Still reading the stored session (normally one tick, from localStorage).
  | { status: "loading" }
  // `notice` explains an involuntary sign-out, e.g. an expired session.
  | { status: "signedOut"; notice: string | null }
  | { status: "signedIn"; session: Session };

// Why the next SIGNED_OUT happened, when it wasn't the user's own choice.
// Set just before expireSession's signOut, read once by the hook.
let pendingNotice: string | null = null;

/** The current access token, or null when signed out. Always asks
 * supabase-js, which hands back a refreshed token once the old one is near
 * expiry, rather than holding on to one. Throws when that refresh failed:
 * after a temporary failure (Auth unreachable, a 5xx) supabase-js keeps the
 * stored session but returns none, and sending the call without a token
 * would earn a 401 and sign the owner out over a network blip. */
export async function currentAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error("Couldn't refresh your sign-in. Check your connection and try again.");
  return data.session?.access_token ?? null;
}

/** Forgets the session in this browser only (the API already refused it,
 * so there's nothing to revoke) and shows `notice` on the sign-in screen. */
export async function expireSession(notice: string): Promise<void> {
  if (!supabase) return;
  pendingNotice = notice;
  await supabase.auth.signOut({ scope: "local" });
}

/** The user's own sign-out. Local scope: other devices stay signed in. */
export async function signOut(): Promise<void> {
  if (!supabase) return;
  pendingNotice = null;
  await supabase.auth.signOut({ scope: "local" });
}

/** Tracks the Supabase session. onAuthStateChange reports the stored
 * session first (INITIAL_SESSION), then every sign-in, refresh and sign-out. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(
    supabase ? { status: "loading" } : { status: "signedOut", notice: authConfigError },
  );

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setState({ status: "signedIn", session });
      } else {
        const notice = pendingNotice;
        pendingNotice = null;
        // Requests in flight together can each get the 401 and each sign
        // out; a later SIGNED_OUT without a notice mustn't wipe the first's.
        setState((prev) => (prev.status === "signedOut" && !notice ? prev : { status: "signedOut", notice }));
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return state;
}
