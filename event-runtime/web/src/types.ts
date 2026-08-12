// Shapes mirror event-runtime/lib/api.mjs views verbatim — this app renders
// what the control API says, it does not reinterpret it.

export type RunState =
  | "PROPOSED"
  | "APPROVED"
  | "QUEUED"
  | "LEASED"
  | "RUNNING"
  | "VERIFYING"
  | "COMPLETED"
  | "REFUSED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface RunSpec {
  schemaVersion: string;
  runId: string;
  agent: string;
  input: unknown;
  inputHash: string;
  workspace: { type: string; retainOnFailure?: boolean };
  adapter: string;
  promptVersion: string;
  policyVersion: string;
  outputContract: string;
  capabilities: string[];
  timeoutSeconds: number;
  maxAttempts: number;
  idempotencyKey: string;
}

export interface Proposal {
  id: string;
  decision: string;
  status: string;
  expired: boolean;
  created_at: string;
  ttl_seconds: number;
  reason: string | null;
  runId: string | null;
  agent: string | null;
  spec: RunSpec | null;
}

export interface AdmittedEvent {
  source: string;
  eventId: string;
  type: string;
  subject: string | null;
  status: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: string | null;
  planFailures: number;
  lastPlanError: string | null;
  admittedAt: string;
  envelope: Record<string, unknown>;
}

export interface RunListItem {
  runId: string;
  state: RunState;
  attempts: number;
  agent: string;
  created_at: string;
  updated_at: string;
}

export interface LifecycleEvent {
  seq: number;
  run_id: string;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  attempt: number | null;
  at: string;
}

export interface Attempt {
  run_id: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  terminal_state: string | null;
  reason_code: string | null;
  workspace_path: string | null;
}

export interface RunDetail {
  run: {
    runId: string;
    state: RunState;
    attempts: number;
    idempotencyKey: string;
    specHash: string;
    created_at: string;
    updated_at: string;
    spec: RunSpec;
  };
  lifecycle: LifecycleEvent[];
  attempts: Attempt[];
  result: {
    terminalState: string;
    reasonCode: string | null;
    artifact?: unknown;
    artifactHash?: string;
    evidence?: unknown;
  } | null;
  receipt: Record<string, string | null> | null;
  workspace: string | null;
}

export interface StatusView {
  events: Record<string, number>;
  proposals: { open: number; expired: number };
  runs: { byState: Partial<Record<RunState, number>> };
  anomalies: {
    expiredOpenProposals: string[];
    staleLeases: number;
    unpublishedOutbox: number;
    deadLettered: { source: string; eventId: string; lastError: string | null }[];
  };
}

export interface ApproveOutcome {
  approved: boolean;
  runId?: string;
  replanned?: boolean;
  proposal?: Proposal;
}
