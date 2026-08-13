import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
 * Inject dialog (webui spec §4.4, templates per OPS-214, confirm per OPS-230, format OPS-361, 2-column sidebar OPS-363).
 *
 * Left sidebar lists registered templates with instant search, right side houses the JSON editor and formatting tools.
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

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(initialEnvelope ? "__given__" : null);
  const [text, setText] = useState(() => pretty(initialEnvelope ?? blankEnvelope(openedAt)));
  const [clientError, setClientError] = useState<string | null>(null);
  const [unregisteredAck, setUnregisteredAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.eventType.toLowerCase().includes(q) ||
        t.agent.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q),
    );
  }, [templates, search]);

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

  function applySelection(next: string | null) {
    if (next === selected) return;
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

  function templateIds(): Array<string | null> {
    return [
      ...(initialEnvelope ? ["__given__"] : []),
      ...filteredTemplates.map((t) => t.eventType),
      null,
    ];
  }

  const checkedId = templateIds().includes(selected) ? selected : null;

  function radioA11y(id: string | null) {
    const checked = checkedId === id;
    return {
      role: "radio" as const,
      "aria-checked": checked,
      tabIndex: checked ? 0 : -1,
    };
  }

  function onTemplateKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "radio") return;
    e.preventDefault();
    const ids = templateIds();
    const idx = checkedId === null ? ids.length - 1 : Math.max(ids.indexOf(checkedId), 0);
    const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const nextIdx = (idx + delta + ids.length) % ids.length;
    applySelection(ids[nextIdx]);
    listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[nextIdx]?.focus();
  }

  function formatJson() {
    try {
      const parsed = JSON.parse(text);
      setText(pretty(parsed));
      setClientError(null);
      notify("Formatted JSON envelope", "info");
    } catch (err) {
      setClientError(`Cannot format: ${(err as Error).message}`);
    }
  }

  const formatJsonRef = useRef(formatJson);
  formatJsonRef.current = formatJson;

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

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
      ?.setAttribute("autofocus", "");
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        formatJsonRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submitRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isValidJson = useMemo(() => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }, [text]);

  const outcome = inject.data;
  const seeded = Boolean(initialEnvelope);
  return (
    <Dialog
      title={seeded ? "Trigger again — inject with a fresh event id" : "Inject event"}
      onClose={onClose}
      extraWide
    >
      <div className="mb-3 text-[12px] text-(--text-dim)">
        {seeded
          ? "Trigger again copies this envelope with a new event id so intake admits it as a new event."
          : "Templates come from the agent registry. Select an event type on the left to load its required schema skeleton, or paste a custom envelope."}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Left Column: Template Selection Sidebar */}
        <div className="md:col-span-5 flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-(--border) pb-3 md:pb-0 md:pr-3">
          <div className="mb-2">
            <input
              type="text"
              placeholder="Search event types / agents…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-(--border) bg-(--surface-0) px-2.5 py-1.5 text-[12px] text-(--text) outline-none focus:border-(--border-strong)"
            />
          </div>

          {registry.isPending && !registry.data && (
            <div className="py-2 text-[12px] text-(--text-faint)">Loading templates…</div>
          )}
          {registry.isError && !registry.data && (
            <div className="py-2 text-[12px] text-(--text-faint)">
              Cannot reach control API — templates will appear when it is up.
            </div>
          )}

          <div
            ref={listRef}
            className="max-h-[380px] overflow-y-auto space-y-1 pr-1"
            role="radiogroup"
            aria-label="Event type templates"
            onKeyDown={onTemplateKeyDown}
          >
            {initialEnvelope && (
              <button
                type="button"
                {...radioA11y("__given__")}
                onClick={() => applySelection("__given__")}
                className={`w-full rounded-md border p-2 text-left transition-colors ${
                  checkedId === "__given__"
                    ? "border-(--accent) bg-(--surface-3) text-(--text)"
                    : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <div className="font-medium text-[12px]">this envelope</div>
                <div className="text-[11px] text-(--text-faint) truncate">original triggering payload</div>
              </button>
            )}

            {filteredTemplates.map((t) => (
              <button
                key={t.eventType}
                type="button"
                {...radioA11y(t.eventType)}
                onClick={() => applySelection(t.eventType)}
                className={`w-full rounded-md border p-2 text-left transition-colors ${
                  checkedId === t.eventType
                    ? "border-(--accent) bg-(--surface-3) text-(--text)"
                    : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <div className="mono font-medium text-[12px] truncate">{t.eventType}</div>
                <div className="mt-0.5 flex items-center justify-between text-[11px] text-(--text-faint)">
                  <span className="truncate">{t.agent}</span>
                  <span className="ml-1 shrink-0 opacity-75">{t.summary || "no params"}</span>
                </div>
              </button>
            ))}

            {filteredTemplates.length === 0 && search && (
              <div className="py-3 text-center text-[12px] text-(--text-faint)">
                No templates matching &quot;{search}&quot;
              </div>
            )}

            <button
              type="button"
              {...radioA11y(null)}
              onClick={() => applySelection(null)}
              className={`w-full rounded-md border p-2 text-left transition-colors ${
                checkedId === null
                  ? "border-(--accent) bg-(--surface-3) text-(--text)"
                  : "border-(--border) text-(--text-faint) hover:bg-(--surface-2)"
              }`}
            >
              <div className="font-medium text-[12px]">blank envelope</div>
              <div className="text-[11px] text-(--text-faint)">empty starter envelope</div>
            </button>
          </div>
        </div>

        {/* Right Column: JSON Editor & Controls */}
        <div className="md:col-span-7 flex flex-col min-h-0">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[11px]">
              <span
                className="size-1.5 rounded-full"
                style={{ background: isValidJson ? "var(--hue-ok)" : "var(--hue-err)" }}
              />
              <span className="text-(--text-faint)">{isValidJson ? "Valid JSON" : "Invalid JSON syntax"}</span>
            </div>
            <button
              type="button"
              onClick={formatJson}
              className="text-[11px] text-(--text-dim) hover:text-(--accent)"
              title="Format JSON (⌘⇧F)"
            >
              Format JSON <span className="mono opacity-70">⌘⇧F</span>
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
            rows={15}
            aria-label="Event envelope JSON"
            className="mono w-full resize-y rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px] leading-relaxed text-(--text) outline-none focus:border-(--border-strong)"
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
        </div>
      </div>
    </Dialog>
  );
}
