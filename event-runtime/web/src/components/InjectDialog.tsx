import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { buildTemplates, triggerId, type TriggerTemplate } from "../templates";
import { Button, Dialog, VerbError, notify } from "./ui";

const REQUIRED = ["schemaVersion", "eventId", "type", "source", "occurredAt"];

/** Blank slate for an unregistered/hand-written envelope (the escape hatch). */
function blankEnvelope(nowMs: number) {
  const id = triggerId(nowMs);
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: "",
    source: "web-trigger",
    subject: "factory",
    occurredAt: new Date(nowMs).toISOString(),
    correlationId: id,
    payload: {},
  };
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Inject dialog (webui spec §4.4, templates per OPS-214, confirm per OPS-230).
 *
 * Templates are derived from the registry — one per registered event type,
 * with the payload skeleton built from that event's agent input schema — so
 * they cannot drift from what the runtime will actually accept. Inject is the
 * same intake path as Replay; it is not Requeue (re-plan) and not Trigger
 * again (which only seeds this dialog with a fresh event id).
 */
export function InjectDialog({
  onClose,
  onAdmitted,
  initialEnvelope,
}: {
  onClose: () => void;
  onAdmitted?: (source: string, eventId: string) => void;
  initialEnvelope?: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const registry = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const openedAt = useMemo(() => Date.now(), []);
  const templates = useMemo(
    () => (registry.data ? buildTemplates(registry.data, openedAt) : []),
    [registry.data, openedAt],
  );

  const [selected, setSelected] = useState<string | null>(initialEnvelope ? "__given__" : null);
  const [text, setText] = useState(() => pretty(initialEnvelope ?? blankEnvelope(openedAt)));
  const [clientError, setClientError] = useState<string | null>(null);
  const [unregisteredAck, setUnregisteredAck] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const inject = useMutation({
    mutationFn: (envelope: Record<string, unknown>) => api.replay(envelope),
    onSuccess: (data, envelope) => {
      queryClient.invalidateQueries();
      setConfirming(false);
      notify(
        data.duplicate ? `Duplicate event ${data.eventId}` : `Admitted event ${data.eventId}`,
        data.duplicate ? "info" : "ok",
      );
      const source = typeof envelope.source === "string" ? envelope.source : "web-trigger";
      onAdmitted?.(source, data.eventId);
    },
  });

  function choose(template: TriggerTemplate) {
    setSelected(template.eventType);
    setText(pretty(template.envelope));
    setClientError(null);
    setUnregisteredAck(false);
    setConfirming(false);
    inject.reset();
  }

  function submit() {
    setClientError(null);
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(text);
    } catch (err) {
      setClientError(`not valid JSON: ${(err as Error).message}`);
      setConfirming(false);
      return;
    }
    const missing = REQUIRED.filter((k) => typeof envelope[k] !== "string" || !envelope[k]);
    if (missing.length) {
      setClientError(`missing required string field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
      setConfirming(false);
      return;
    }
    const registered = registry.data?.eventTypes.some((r) => r.type === envelope.type) ?? true;
    if (!registered && !unregisteredAck) {
      setClientError(
        `"${envelope.type}" is not a registered event type — it will be admitted, but planning will park it as human_needed. Confirm inject to proceed.`,
      );
      setUnregisteredAck(true);
      setConfirming(true);
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    inject.mutate(envelope);
  }

  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submitRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement) return;
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const ids: Array<string | null> = [
        ...(initialEnvelope ? ["__given__"] : []),
        ...templates.map((t) => t.eventType),
        null,
      ];
      const idx = selected === null ? ids.length - 1 : Math.max(ids.indexOf(selected), 0);
      const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      const next = ids[(idx + delta + ids.length) % ids.length];
      if (next === null) {
        setSelected(null);
        setText(pretty(blankEnvelope(openedAt)));
        setUnregisteredAck(false);
        setConfirming(false);
        inject.reset();
        return;
      }
      if (next === "__given__" && initialEnvelope) {
        setSelected("__given__");
        setText(pretty(initialEnvelope));
        setUnregisteredAck(false);
        setConfirming(false);
        inject.reset();
        return;
      }
      const t = templates.find((x) => x.eventType === next);
      if (t) choose(t);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [templates, selected, initialEnvelope, openedAt]);

  const outcome = inject.data;
  const seeded = Boolean(initialEnvelope);
  return (
    <Dialog title={seeded ? "Trigger again — inject with a fresh event id" : "Inject event"} onClose={onClose} wide>
      <div className="mb-3 text-[12px] text-(--text-dim)">
        {seeded
          ? "Trigger again copies this envelope with a new event id so intake admits it as a new event. It is not Replay (same id, dedup no-op) and not Requeue (re-plan an already-admitted event)."
          : "Templates come from the registry — payload fields are the ones each agent's input schema requires. Inject sends the envelope through intake, the same path as Replay. Duplicate event ids are a no-op. This is not Requeue."}
      </div>

      {registry.isPending && !registry.data && (
        <div className="mb-3 text-[12px] text-(--text-faint)">Loading templates…</div>
      )}
      {registry.isError && !registry.data && (
        <div className="mb-3 text-[12px] text-(--text-faint)">
          Cannot reach the control API — templates will appear when it is up. You can still paste a raw envelope.
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Event type templates">
        {initialEnvelope && (
          <button
            type="button"
            role="radio"
            aria-checked={selected === "__given__"}
            onClick={() => {
              setSelected("__given__");
              setText(pretty(initialEnvelope));
              setUnregisteredAck(false);
              setConfirming(false);
              inject.reset();
            }}
            className={`rounded-md border px-2 py-1 text-[11.5px] ${
              selected === "__given__"
                ? "border-(--accent) bg-(--surface-3) text-(--text)"
                : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
            }`}
          >
            this envelope
          </button>
        )}
        {templates.map((t) => (
          <button
            key={t.eventType}
            type="button"
            role="radio"
            aria-checked={selected === t.eventType}
            title={`${t.agent} · payload: ${t.summary}`}
            onClick={() => choose(t)}
            className={`rounded-md border px-2 py-1 text-left text-[11.5px] ${
              selected === t.eventType
                ? "border-(--accent) bg-(--surface-3) text-(--text)"
                : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
            }`}
          >
            <span className="mono">{t.eventType}</span>
            <span className="ml-1.5 text-(--text-faint)">{t.summary}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={selected === null}
          onClick={() => {
            setSelected(null);
            setText(pretty(blankEnvelope(openedAt)));
            setUnregisteredAck(false);
            setConfirming(false);
            inject.reset();
          }}
          className={`rounded-md border px-2 py-1 text-[11.5px] ${
            selected === null
              ? "border-(--accent) bg-(--surface-3) text-(--text)"
              : "border-(--border) text-(--text-faint) hover:bg-(--surface-2)"
          }`}
        >
          blank
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setClientError(null);
          setUnregisteredAck(false);
          setConfirming(false);
        }}
        spellCheck={false}
        rows={14}
        aria-label="Event envelope JSON"
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
            : `admitted event ${outcome.eventId} — the planner proposes next`}
        </div>
      )}

      {confirming && !outcome && (
        <div className="mt-2 text-[12px] text-(--text-dim)">
          Confirm sends this envelope through intake. A known event id is reported as a duplicate and
          does nothing — that is Replay&apos;s demo, not a new event. Use Trigger again for a fresh id.
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        {confirming ? (
          <>
            <Button onClick={() => setConfirming(false)}>Back</Button>
            <Button variant="primary" onClick={submit} disabled={inject.isPending} autoFocus>
              Confirm inject
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={submit} disabled={inject.isPending}>
            Inject… <span className="ml-1 font-normal opacity-70">⌘↵</span>
          </Button>
        )}
      </div>
    </Dialog>
  );
}
