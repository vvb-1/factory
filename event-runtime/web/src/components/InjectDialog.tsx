import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Button, Dialog, VerbError } from "./ui";

const TEMPLATE = JSON.stringify(
  {
    schemaVersion: "factory.event/v1",
    eventId: "manual-001",
    type: "factory.status-report.requested",
    source: "web-inject",
    subject: "factory",
    occurredAt: new Date().toISOString(),
    correlationId: "manual-001",
    payload: { repos: [] },
  },
  null,
  2,
);

const REQUIRED = ["schemaVersion", "eventId", "type", "source", "occurredAt"];

/** Inject dialog (webui spec §4.4) — same admission path as `cli.mjs inject`. */
export function InjectDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState(TEMPLATE);
  const [clientError, setClientError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const inject = useMutation({
    mutationFn: (envelope: unknown) => api.replay(envelope),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  function submit() {
    setClientError(null);
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(text);
    } catch (err) {
      setClientError(`not valid JSON: ${(err as Error).message}`);
      return;
    }
    const missing = REQUIRED.filter((k) => typeof envelope[k] !== "string" || !envelope[k]);
    if (missing.length) {
      setClientError(`missing required string field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
      return;
    }
    inject.mutate(envelope);
  }

  const outcome = inject.data;
  return (
    <Dialog title="Inject event" onClose={onClose} wide>
      <div className="mb-2 text-[12px] text-(--text-dim)">
        Replays an envelope through the same intake as the webhook. Duplicate delivery is safe —
        one admission, one proposal, one run.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={14}
        className="mono w-full resize-y rounded-md border border-(--border) bg-(--surface-0) p-3 text-(--text) outline-none focus:border-(--border-strong)"
      />
      {clientError && <VerbError error={new Error(clientError)} />}
      <VerbError error={inject.error} />
      {outcome && (
        <div
          className="mt-2 rounded-md px-2.5 py-1.5 text-[12px]"
          style={{
            color: outcome.duplicate ? "var(--hue-warn)" : "var(--hue-ok)",
            background: `color-mix(in oklch, ${outcome.duplicate ? "var(--hue-warn)" : "var(--hue-ok)"} 10%, transparent)`,
          }}
        >
          {outcome.duplicate
            ? `duplicate — event ${outcome.eventId} was already admitted (dedup working as designed)`
            : `admitted event ${outcome.eventId}`}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={submit} disabled={inject.isPending}>
          Inject
        </Button>
      </div>
    </Dialog>
  );
}
