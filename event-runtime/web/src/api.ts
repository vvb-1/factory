import type { AdmittedEvent, ApproveOutcome, Proposal, RunDetail, RunListItem, StatusView } from "./types";

// Same contract as lib/client.mjs: one function per endpoint, an Error with
// `.status` on non-2xx, no status at all on connection failure.

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      json?.error ?? (Array.isArray(json?.errors) ? json.errors.join("; ") : `HTTP ${res.status}`);
    throw new ApiError(message, res.status);
  }
  return json as T;
}

export const api = {
  health: () => call<{ ok: boolean; policyVersion: string }>("GET", "/health"),
  status: () => call<StatusView>("GET", "/status"),
  events: (status?: string) =>
    call<{ events: AdmittedEvent[] }>("GET", `/events${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  proposals: () => call<{ proposals: Proposal[] }>("GET", "/proposals"),
  approve: (id: string) => call<ApproveOutcome>("POST", `/proposals/${encodeURIComponent(id)}/approve`, {}),
  reject: (id: string, reason: string) =>
    call<{ rejected: boolean }>("POST", `/proposals/${encodeURIComponent(id)}/reject`, { reason }),
  runs: (state?: string) =>
    call<{ runs: RunListItem[] }>("GET", `/runs${state ? `?state=${encodeURIComponent(state)}` : ""}`),
  run: (id: string) => call<RunDetail>("GET", `/runs/${encodeURIComponent(id)}`),
  cancel: (id: string, reason?: string) =>
    call<{ cancelled: boolean }>("POST", `/runs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
  retry: (id: string, force = false) =>
    call<{ queued: boolean }>("POST", `/runs/${encodeURIComponent(id)}/retry`, { force }),
  replay: (envelope: unknown) =>
    call<{ admitted: boolean; duplicate: boolean; eventId: string }>("POST", "/replay", envelope),
};
