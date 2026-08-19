/**
 * Figma REST API client.
 *
 * Auth is `X-Figma-Token` (personal access token). OAuth would use
 * `Authorization: Bearer`, but a self-hosted Leo hub has one owner and a PAT
 * needs no redirect URL, so that is the only mode here.
 *
 * https://developers.figma.com/docs/rest-api/
 */

const BASE = "https://api.figma.com";

/**
 * Figma's Tier 1 endpoints (file reads, image renders) allow roughly 10
 * requests per minute on a Pro plan. An agent exploring a design will ask about
 * the same file several times in a row, so identical GETs inside this window
 * are served from memory rather than spent against that budget.
 *
 * Deliberately small and in-process: the server is spawned per session, and a
 * design that changed during one is a design the next call should see.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map();

export class FigmaError extends Error {
  constructor(message, { status = 0, hint = null } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/**
 * A Figma file key, accepted either bare or as any Figma URL.
 *
 * People copy the URL — that is the thing with a share button — so refusing
 * anything but a bare key would make the common case the error case.
 * Both `/file/<key>/` (legacy) and `/design/<key>/` (current) appear in links
 * still in circulation.
 */
export function fileKey(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new FigmaError("A file key or Figma URL is required.");

  const url = raw.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  const key = url ? url[1] : raw;

  if (!/^[A-Za-z0-9]+$/.test(key)) {
    throw new FigmaError(
      `Could not read a file key from ${JSON.stringify(raw)}.`,
      { hint: "Paste the Figma file URL, or the key between /design/ and the file name." },
    );
  }
  return key;
}

/**
 * Normalise a node id to the API's `1:23`.
 *
 * Figma URLs carry `node-id=1-23` while the REST API answers only to `1:23`.
 * Passing the id straight from the address bar is the obvious thing to do and
 * returns an empty result rather than an error, so the mistake is silent —
 * which is exactly why it is corrected here instead of documented.
 */
export function nodeId(input) {
  const raw = String(input ?? "").trim();
  return /^\d+-\d+$/.test(raw) ? raw.replace("-", ":") : raw;
}

export function nodeIds(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(",");
  return list.map((n) => nodeId(n)).filter(Boolean);
}

/** GET a Figma endpoint, with the short-lived cache in front of it. */
export async function get(token, path, params = {}) {
  if (!token) {
    throw new FigmaError("No Figma token configured.", {
      hint:
        "Set your personal access token in Leo under Settings → Packages → Figma. " +
        "Create one at Figma → Settings → Security → Personal access tokens.",
    });
  }

  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;

  let res;
  try {
    res = await fetch(url, { headers: { "X-Figma-Token": token } });
  } catch (cause) {
    throw new FigmaError(`Could not reach api.figma.com: ${cause.message}`);
  }

  if (!res.ok) throw await httpError(res);

  const body = await res.json();
  cache.set(url.href, { at: Date.now(), body });
  return body;
}

/**
 * Turn a non-2xx into an error that says what to do about it.
 *
 * Figma's own message is usually one clause ("Not found"), which for a 403 is
 * indistinguishable between "wrong token", "token lacks the scope" and "this
 * endpoint is Enterprise-only" — three different things to do next.
 */
async function httpError(res) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.err || body?.message || "";
  } catch {
    /* a non-JSON body adds nothing the status doesn't already say */
  }

  const hints = {
    403:
      "The token may be missing a scope, or the endpoint may need an Enterprise plan. " +
      "File reads need file_content:read; variables need file_variables:read and an Enterprise org.",
    404: "Check the file key, and that the token's account can open that file.",
    429: "Figma rate limit. File reads and renders are about 10 requests/minute on Pro — wait a moment.",
  };

  return new FigmaError(
    `Figma returned ${res.status}${detail ? `: ${detail}` : ""}`,
    { status: res.status, hint: hints[res.status] ?? null },
  );
}
