/**
 * Entity resolution (WM-700): one place that knows how a ticket, pull request,
 * artifact sha, agent, run, or event turns into a label and a route.
 *
 * Hover cards, chips, and jump links all name the same six things, and each
 * one used to build its own `#/…` string. A single resolver keeps the routes
 * in `hash.ts` honest: when a route moves, it moves here once.
 *
 * `href` is always the in-app hash route, so a caller can link without asking
 * what kind it holds. A pull request additionally carries `externalHref` — the
 * `github.com/<owner>/<repo>/pull/<n>` URL — which leaves the control plane and
 * therefore never becomes `href`.
 */
import { hashPath } from "./hash";

export type EntityKind = "ticket" | "pr" | "sha" | "agent" | "run" | "event";

export interface ResolvedEntity {
  kind: EntityKind;
  /** Canonical id: ticket keys upper-cased, shas lower-cased, PRs bare digits. */
  id: string;
  /** Short human label for a chip, a hover-card header, or a link body. */
  label: string;
  /** Hash path without the leading `#/` — what `hashPath` produces. */
  path: string;
  /** In-app target: `#/${path}`. */
  href: string;
  /** GitHub URL when one is known. Only pull requests ever have one. */
  externalHref: string | null;
}

export interface ResolveEntityOptions {
  /** Event source (`github`, `web`, …) when the id does not carry it. */
  source?: string | null;
  /** `owner/repo`, used to build a pull request's GitHub URL from a number. */
  repo?: string | null;
}

/** Ticket keys as Linear writes them: `WM-700`, `CLNT-616`. */
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
/** Git shas (7+) through a full sha256 artifact digest (64). */
const SHA_RE = /^[0-9a-f]{7,64}$/;
const PR_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function entity(
  kind: EntityKind,
  id: string,
  label: string,
  path: string,
  externalHref: string | null = null,
): ResolvedEntity {
  return { kind, id, label, path, href: `#/${path}`, externalHref };
}

function resolveTicket(raw: string): ResolvedEntity | null {
  const id = raw.toUpperCase();
  if (!TICKET_RE.test(id)) return null;
  return entity("ticket", id, id, hashPath("tickets", id));
}

/**
 * Accepts a number, `#541`, `541`, or a full GitHub pull URL. The URL form
 * also supplies the repo, so a pasted link resolves to both routes at once.
 */
function resolvePr(
  raw: string,
  options: ResolveEntityOptions,
): ResolvedEntity | null {
  const url = raw.match(PR_URL_RE);
  const repo =
    url?.[1] ?? (REPO_RE.test(text(options.repo)) ? text(options.repo) : null);
  const number = url?.[2] ?? raw.replace(/^#/, "");
  if (!/^\d+$/.test(number)) return null;
  const n = Number(number);
  if (n < 1) return null;
  const id = String(n);
  return entity(
    "pr",
    id,
    `PR #${id}`,
    hashPath("prs", id),
    repo ? `https://github.com/${repo}/pull/${id}` : null,
  );
}

function resolveSha(raw: string): ResolvedEntity | null {
  const sha = raw.replace(/^sha256:/i, "").toLowerCase();
  if (!SHA_RE.test(sha)) return null;
  // Artifacts print 12 characters everywhere else; a shorter git sha stays whole.
  const label = sha.length > 12 ? sha.slice(0, 12) : sha;
  return entity("sha", sha, label, hashPath("artifacts", sha));
}

/**
 * Events are keyed by source *and* id (`#/events/:source/:eventId`). An id of
 * `github/evt_1` or `github:evt_1` carries its own source; otherwise pass one.
 * Without a source there is no addressable event, so this resolves to null
 * rather than to a route that would read the id as the source.
 */
function resolveEvent(
  raw: string,
  options: ResolveEntityOptions,
): ResolvedEntity | null {
  const split = raw.match(/^([^/:]+)[/:](.+)$/);
  const source = split?.[1] ?? text(options.source);
  const eventId = split?.[2]?.trim() ?? raw;
  if (!source || !eventId) return null;
  return entity("event", eventId, eventId, hashPath("events", source, eventId));
}

/**
 * Resolve an entity reference to its canonical label and routes.
 * Returns null for anything that is not addressable — an empty id, a malformed
 * ticket key, a sha that is not hex, an event with no source.
 */
export function resolveEntity(
  kind: EntityKind,
  id: string | number | null | undefined,
  options: ResolveEntityOptions = {},
): ResolvedEntity | null {
  const raw = typeof id === "number" ? String(id) : text(id);
  if (!raw) return null;
  switch (kind) {
    case "ticket":
      return resolveTicket(raw);
    case "pr":
      return resolvePr(raw, options);
    case "sha":
      return resolveSha(raw);
    case "agent":
      return entity("agent", raw, raw, hashPath("agents", raw));
    case "run":
      // `#/run/:id` (singular) is the full-page run view, not the list row.
      return entity("run", raw, raw, hashPath("run", raw));
    case "event":
      return resolveEvent(raw, options);
    default:
      return null;
  }
}
