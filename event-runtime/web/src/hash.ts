/**
 * Hash paths for the control plane. Selection lives in the hash so an
 * operator-pasted `#/runs/:id` survives refresh (OPS-230).
 *
 * `#/overview` `#/events` `#/events?type=` `#/events/:source/:eventId`
 * `#/proposals` `#/proposals/:id` `#/runs` `#/runs/:id` `#/agents`
 * `#/agents/:ref` `#/graph` `#/graph/:nodeId`
 */

function pathAndQuery(hash: string): { path: string; query: string } {
  const trimmed = hash.replace(/^#\/?/, "");
  const i = trimmed.indexOf("?");
  return i >= 0
    ? { path: trimmed.slice(0, i), query: trimmed.slice(i + 1) }
    : { path: trimmed, query: "" };
}

export function parseHash(hash: string): string[] {
  return pathAndQuery(hash)
    .path.split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Query after `?` in the hash (`#/events?type=…`). Empty when none. */
export function hashSearch(hash: string): URLSearchParams {
  return new URLSearchParams(pathAndQuery(hash).query);
}

/** Build a hash path; each id segment is encoded. */
export function hashPath(view: string, ...ids: Array<string | null | undefined>): string {
  const parts = [view];
  for (const id of ids) {
    if (id == null || id === "") continue;
    parts.push(encodeURIComponent(id));
  }
  return parts.join("/");
}

/** Events view hash, optionally with a shareable type filter. */
export function eventsHash(
  source?: string | null,
  eventId?: string | null,
  type?: string | null,
): string {
  const path = hashPath("events", source, eventId);
  return type ? `${path}?type=${encodeURIComponent(type)}` : path;
}
