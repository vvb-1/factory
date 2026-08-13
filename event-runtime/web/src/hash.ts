/**
 * Hash paths for the control plane. Selection lives in the hash so an
 * operator-pasted `#/runs/:id` survives refresh (OPS-230).
 *
 * `#/overview` `#/events` `#/events/:source/:eventId` `#/proposals`
 * `#/proposals/:id` `#/runs` `#/runs/:id` `#/agents` `#/agents/:ref`
 * `#/graph` `#/graph/:nodeId`
 */

export function parseHash(hash: string): string[] {
  return hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
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
