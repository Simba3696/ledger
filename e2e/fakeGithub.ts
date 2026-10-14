/**
 * The GitHub storage e2e's network: a Playwright routing adapter over the
 * ONE in-memory fake of GitHub's REST API that the unit tests use
 * (client/src/backend/github/fakeGitHub.ts, #6). The GitHub behaviour (the
 * tokens, the 404s and 403s, the contents, trees and blobs, the PUT as a
 * compare-and-swap, the headers a browser on another origin can read) all
 * lives there; this file only routes the browser's requests into it and
 * keeps what the checks read:
 *
 *   - a request log: which browser context sent what, and GitHub's answer;
 *   - per-context offline: while a context is flagged offline, its GitHub
 *     requests are aborted as "internetdisconnected", whatever the order of
 *     Playwright's offline emulation and routing;
 *   - Google Fonts answered with an empty 200 (no network, no console error);
 *   - every other host aborted and recorded as a failure.
 *
 * One fake is shared by every context, so two simulated devices really sync
 * through the same repo. No local server and no API-base override: the page
 * talks to https://api.github.com as the Pages build does, and Playwright
 * answers for it. Fictional data only.
 */
import type { BrowserContext, Route } from "playwright";
import {
  BROWSER_VISIBLE_HEADERS,
  PREFLIGHT_ALLOWED_HEADERS,
  createFakeGitHub,
  type FakeGitHub,
  type FakeRepo,
  type FakeToken,
} from "../client/src/backend/github/fakeGitHub.js";
import { parseRepoFileName } from "../client/src/backend/sync/epoch.js";

const API = "https://api.github.com";
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/** What GitHub's API answers every cross-origin request with, so the page
 * may read the response. The header lists are the fake's own (recorded
 * from api.github.com), so the adapter can't drift from them; the fake
 * already left out every header a browser would hide. */
const CORS_RESPONSE_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": [...BROWSER_VISIBLE_HEADERS].join(", "),
};

/** GitHub's answer to a CORS preflight. Chromium answers preflights itself
 * while Playwright intercepts requests, so this runs only if one is ever
 * routed here. */
const PREFLIGHT_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE",
  "access-control-allow-headers": [...PREFLIGHT_ALLOWED_HEADERS].join(", "),
  "access-control-max-age": "86400",
};

/** Headers the browser adds on its own. Only what the page's code set is
 * handed to the fake, whose CORS check refuses any header GitHub's
 * preflight wouldn't allow. */
function isBrowserHeader(name: string): boolean {
  return /^(sec-|referer$|origin$|user-agent$|accept-language$|cookie$|host$|connection$|content-length$)/i.test(name);
}

export interface RoutedRequest {
  /** The browser context (simulated device) that sent it. */
  context: string;
  method: string;
  /** Path and query after https://api.github.com. */
  path: string;
  /** GitHub's status, or how the request failed. */
  status: number | "offline" | "network";
  /** The token's login, when the fake knows the token. */
  login: string | null;
  /** The file a PUT wrote under ledger/, and whether it sent a sha. */
  put?: { path: string; hadSha: boolean };
}

export interface FakeGitHubAdapter {
  readonly fake: FakeGitHub;
  readonly log: RoutedRequest[];
  /** Requests to a host other than the preview origin, GitHub's API and
   * Google Fonts: each was aborted, and each fails the run. */
  readonly strayHosts: string[];
  /** Routes `context` into the fake as device `name`. */
  install(context: BrowserContext, name: string): Promise<void>;
  /** Both the browser's offline emulation and the adapter's own flag. */
  setOffline(context: BrowserContext, name: string, offline: boolean): Promise<void>;
  /** The sync device id the context's PUTs showed, once it wrote one. */
  deviceOf(name: string): string | null;
  /** The context starts again as a new device (Forget this device, a
   * restore's reload): its next own file pins its new id. */
  newDevice(name: string): void;
  addToken(token: string, grant: FakeToken): void;
  /** Everything that must be empty for the run to pass. */
  problems(): string[];
}

export function createFakeGitHubAdapter({
  origin,
  repos,
  tokens,
}: {
  /** The preview server's origin, e.g. http://localhost:5274. */
  origin: string;
  repos: FakeRepo[];
  tokens: Record<string, FakeToken>;
}): FakeGitHubAdapter {
  const fake = createFakeGitHub({ repos, tokens });
  const logins = new Map(Object.entries(tokens).map(([token, grant]) => [token, grant.login]));
  const log: RoutedRequest[] = [];
  const strayHosts: string[] = [];
  const offline = new Set<string>();
  /** Per context and epoch, the sync device id its own files carry, pinned
   * by its first own file. The fake checks each later PUT against it (a
   * device writes only its own files), so a context writing two devices'
   * files in one epoch is a violation. A restore's new epoch starts a new
   * device, so it pins anew. */
  const devices = new Map<string, Map<string, string>>();
  const latest = new Map<string, string>();
  const errors: string[] = [];

  function loginOf(headers: Record<string, string>): string | null {
    const token = headers.authorization?.match(/^(?:Bearer|token)\s+(.+)$/i)?.[1];
    return token === undefined ? null : (logins.get(token) ?? null);
  }

  async function toGitHub(route: Route, name: string): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname + url.search;
    const method = request.method();
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: PREFLIGHT_HEADERS });
      return;
    }
    const all = await request.allHeaders();
    const headers = Object.fromEntries(Object.entries(all).filter(([header]) => !isBrowserHeader(header)));
    const entry: RoutedRequest = { context: name, method, path, status: "network", login: loginOf(headers) };
    log.push(entry);
    if (offline.has(name)) {
      entry.status = "offline";
      await route.abort("internetdisconnected");
      return;
    }
    const body = request.postData() ?? undefined;
    let device = `unpinned:${name}`;
    if (method === "PUT") {
      const filePath = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
      let hadSha = false;
      try {
        hadSha = typeof (JSON.parse(body ?? "{}") as { sha?: unknown }).sha === "string";
      } catch {
        // the fake answers a body it can't parse
      }
      entry.put = { path: filePath, hadSha };
      const file = filePath.startsWith("ledger/") ? parseRepoFileName(filePath.slice("ledger/".length)) : null;
      if (file && file.kind !== "genesis") {
        let byEpoch = devices.get(name);
        if (!byEpoch) devices.set(name, (byEpoch = new Map()));
        if (!byEpoch.has(file.epoch)) {
          byEpoch.set(file.epoch, file.device);
          latest.set(name, file.device);
        }
        device = byEpoch.get(file.epoch)!;
      }
    }
    let res: Response;
    try {
      res = await fake.fetchAs(device)(`${API}${path}`, { method, headers, body });
    } catch (err) {
      // The fake fails a request as the network would only when a check
      // injects that (none does), or when the page sent a header GitHub's
      // CORS preflight refuses: either way a problem for the run.
      entry.status = "network";
      errors.push(`${name}: the fake GitHub refused ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      await route.abort("failed");
      return;
    }
    entry.status = res.status;
    const responseHeaders: Record<string, string> = { ...CORS_RESPONSE_HEADERS };
    res.headers.forEach((value, header) => {
      responseHeaders[header] = value;
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    await route.fulfill({ status: res.status, headers: responseHeaders, body: bytes });
  }

  async function install(context: BrowserContext, name: string): Promise<void> {
    await context.route("**/*", async (route) => {
      try {
        const url = new URL(route.request().url());
        if (url.origin === API) return await toGitHub(route, name);
        if (url.origin === origin) return await route.continue();
        if (FONT_HOSTS.has(url.hostname)) {
          const css = url.hostname === "fonts.googleapis.com";
          return await route.fulfill({
            status: 200,
            headers: { "content-type": css ? "text/css; charset=utf-8" : "font/woff2", "access-control-allow-origin": "*" },
            body: "",
          });
        }
        if (url.protocol === "data:" || url.protocol === "blob:") return await route.continue();
        strayHosts.push(`${name}: ${route.request().method()} ${url.href}`);
        await route.abort("blockedbyclient");
      } catch (err) {
        // A route left unanswered (the page closed mid-request) is no
        // failure of the app; anything else is.
        const message = err instanceof Error ? err.message : String(err);
        if (!/closed|already handled|Target page|has been closed/i.test(message)) errors.push(`${name}: routing failed: ${message}`);
      }
    });
  }

  return {
    fake,
    log,
    strayHosts,
    install,
    async setOffline(context, name, value) {
      if (value) offline.add(name);
      else offline.delete(name);
      await context.setOffline(value);
    },
    deviceOf(name) {
      return latest.get(name) ?? null;
    },
    newDevice(name) {
      devices.delete(name);
      latest.delete(name);
    },
    addToken(token, grant) {
      logins.set(token, grant.login);
      fake.setToken(token, grant);
    },
    problems() {
      return [
        ...fake.unhandled.map((r) => `unhandled endpoint: ${r.method} ${r.path}`),
        ...fake.violations.map((v) => `ownership violation: ${v}`),
        ...strayHosts.map((h) => `request to a host outside the allow-list: ${h}`),
        ...errors,
      ];
    },
  };
}
