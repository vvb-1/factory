import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useListKeys } from "../hooks";
import type { AgentDef } from "../types";
import { Button, DetailPane, Disclosure, FilterInput, JsonBlock, KV, ListEmpty, ListPane, Section, copyText, copyLink } from "../components/ui";
import { setContextActions } from "../palette";

const caps = (a: AgentDef) =>
  [a.capabilities.filesystem, ...(a.capabilities.services ?? [])].filter(Boolean).join(", ") || "none";

/**
 * Agents (webui doc §10.6) — the registry, fully readable. An operator
 * approving "factory-status-report@1" can read exactly what that ref means —
 * prompt, schemas, pins, routing — without opening the repo. Read-only:
 * the registry has no mutation surface, by design.
 */
export function Agents({
  focusAgentRef,
  onSelectAgent,
}: {
  focusAgentRef: string | null;
  onSelectAgent: (ref: string | null) => void;
}) {
  const query = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 2000 });
  const rows = query.data?.agents ?? [];
  const contracts = query.data?.contracts ?? {};

  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((a) =>
      [a.ref, a.id, a.outputContract, caps(a), ...a.eventTypes.map((t) => t.type)].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [rows, filter]);
  const selectedRef = focusAgentRef;
  const selectedIndex = useMemo(() => visible.findIndex((a) => a.ref === selectedRef), [visible, selectedRef]);
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusAgentRef) setFilter("");
  }, [focusAgentRef]);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectAgent(visible[i]?.ref ?? null),
    onClose: () => {
      if (selectedRef) onSelectAgent(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => sel && copyText(sel.ref, "agent ref"),
    },
  });

  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      setContextActions([
        { label: `Copy ${sel.ref}`, hint: "c", run: () => copyText(sel.ref, "agent ref") },
        { label: "Copy link to this agent", run: copyLink },
      ]);
    }
    return () => setContextActions([]);
  }, [sel?.ref]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Agents</h1>
        <div className="mb-3">
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter ref, contract, event type…"
            label="Filter agents"
          />
        </div>
          </>
        }
      >

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Ref</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Contract</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Mutating</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Capabilities</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Timeout</th>
              <th className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a, i) => (
              <tr
                key={a.ref}
                onClick={() => onSelectAgent(a.ref)}
                aria-selected={i === selectedIndex}
                className={`cursor-pointer hover:bg-(--surface-1) ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className="mono border-b border-(--border) px-3 py-1.5">{a.ref}</td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">{a.outputContract}</td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <span style={{ color: a.mutating ? "var(--hue-err)" : "var(--text-faint)" }}>
                    {a.mutating ? "mutating" : "read-only"}
                  </span>
                </td>
                <td className="max-w-64 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                  {caps(a)}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                  {a.limits.timeout_seconds != null ? `${a.limits.timeout_seconds}s` : "-"}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                  {a.limits.attempts ?? "-"}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={6}
                query={query}
                filtered={rows.length > 0}
                noun="agents"
                empty="No registered agents."
              />
            )}
          </tbody>
        </table>

        <div className="mt-6">
          <Section title="Shared contracts">
            <div className="mb-1.5 text-[11px] text-(--text-faint)">
              Every agent&apos;s input arrives as a factory.event/v1 envelope and its output must
              validate against factory.agent-result/v1 — these schemas are the runtime&apos;s edges.
            </div>
            {Object.entries(contracts).map(([name, schema]) => (
              <Disclosure key={name} label={name}>
                <JsonBlock value={schema} />
              </Disclosure>
            ))}
          </Section>
        </div>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[520px]"
          title={
            <span className="mono" title={sel.ref}>
              {sel.ref}
            </span>
          }
          actions={
            <>
              <Button onClick={() => copyText(sel.ref, "agent ref")}>Copy ref</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectAgent(null)}>Close</Button>
            </>
          }
        >

          <Section title="Definition">
            <KV k="id" v={sel.id} />
            <KV k="version" v={String(sel.version)} />
            <KV k="outputContract" v={sel.outputContract} />
            <KV
              k="mutating"
              v={
                <span style={{ color: sel.mutating ? "var(--hue-err)" : "var(--text-faint)" }}>
                  {sel.mutating ? "yes" : "no"}
                </span>
              }
            />
            <KV
              k="workspace"
              v={`${sel.workspace.type}${sel.workspace.retainOnFailure ? " · retain on failure" : ""}`}
            />
            <KV k="capabilities" v={caps(sel)} />
            <KV k="timeout" v={sel.limits.timeout_seconds != null ? `${sel.limits.timeout_seconds}s` : "-"} />
            <KV k="attempts" v={String(sel.limits.attempts ?? "-")} />
          </Section>

          <Section title={`Prompt · ${sel.promptFile}`}>
            <div className="mb-1.5 flex justify-end">
              <Button onClick={() => copyText(sel.prompt, "prompt")}>Copy prompt</Button>
            </div>
            <pre className="mono max-h-96 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 leading-relaxed whitespace-pre-wrap">
              {sel.prompt}
            </pre>
          </Section>

          <Section title="Schemas">
            <Disclosure label={`input — ${sel.inputSchemaFile}`}>
              <JsonBlock value={sel.inputSchema} />
            </Disclosure>
            <Disclosure label={`output — ${sel.outputSchemaFile}`}>
              <JsonBlock value={sel.outputSchema} />
            </Disclosure>
          </Section>

          <Section title="Pins">
            <div className="mb-1.5 text-[11px] text-(--text-faint)">
              Content-hash pins over the prompt and schema files: if a pinned file&apos;s bytes
              drift from its hash, the registry fails closed at load — versions are bumped and
              re-pinned, never edited in place.
            </div>
            {Object.entries(sel.pins).map(([file, hash]) => (
              <KV key={file} k={file} v={hash} />
            ))}
          </Section>

          <Section title="Event routing">
            {sel.eventTypes.length === 0 ? (
              <div className="text-(--text-faint)">No event types route to this agent.</div>
            ) : (
              <div className="rounded-md border border-(--border) px-3 py-1">
                {sel.eventTypes.map((r) => (
                  <div key={r.type} className="border-b border-(--border) py-1.5 last:border-0">
                    <div className="mono">{r.type}</div>
                    <div className="text-[11px] text-(--text-faint)">
                      adapter {r.adapter} · idempotency {r.idempotencyScope}
                      {r.proposalTtlSeconds != null ? ` · proposal TTL ${r.proposalTtlSeconds}s` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </DetailPane>
      )}
    </div>
  );
}
