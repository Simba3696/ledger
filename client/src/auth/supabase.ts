import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The browser's Supabase client, used only for Auth (LLD §6): email +
// password sign-in, keeping the session in localStorage and refreshing its
// access token. Data never goes through it; every read and write is a call
// to this app's own /api, which checks the token.

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** Set when the build is missing its Supabase settings, so <SignIn/> can say
 * so instead of the page failing to load (createClient throws without them). */
export const authConfigError: string | null =
  url && anonKey ? null : "Sign-in isn't configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (client/.env.example).";

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        // No magic links or OAuth redirects, so there is never a session in
        // the URL to pick up.
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;
