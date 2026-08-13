# Event Runtime Web Control Plane — UX Improvement Proposals & Syntax Highlighting Spec

Tracking: **OPS-355** | Parent specs: [event-runtime-webui.md](event-runtime-webui.md), [event-runtime-webui-roadmap.md](event-runtime-webui-roadmap.md)

This document captures usability evaluations, workflow bottlenecks, design proposals, and implementation options for syntax-highlighted JSON rendering across the **Factory Event Runtime Web Control Plane** (`event-runtime/web/`).

---

## 1. Executive UX Evaluation

The Web Control Plane provides a dense, keyboard-driven interface adhering to Linear's design language, OKLCH perceptual color tokens, and strict concurrency honesty (refusing optimistic state updates).

### 1.1 Architectural & UX Strengths
- **Safety Invariants as First-Class UI**: The interface strictly renders raw immutable `RunSpec` payloads before approval, live countdowns guard against TTL expiration, and expired approvals halt on re-planning to display a line diff ([`SpecDiff.tsx`](../event-runtime/web/src/components/SpecDiff.tsx)) rather than auto-approving.
- **Keyboard Velocity**: Complete single-key navigation (`j`/`k`, `a` approve, `x` reject/cancel, `q` requeue, `i` inject, `/` filter) coupled with chord transitions (`g o/e/p/r/t/w/g`) and `⌘K` command palette.
- **Hash Single-Source-of-Truth**: Deep linkable routes (`#/runs/:id`, `#/events/:source/:eventId`, `#/graph/:nodeId`, `#/workers/:id`) allow seamless handoff between team members, CLI output, and browser tabs.
- **Auditable Failure Modes**: 404/409 concurrency race conditions and unreachable API backends produce explicit inline notices with recovery actions rather than disappearing toasts.

---

## 2. Core Friction Points & Usability Gaps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             UX FRICTION MATRIX                              │
├─────────────────────────┬─────────────────────────┬─────────────────────────┤
│ 1. Information Density  │ 2. Triage & Decisions   │ 3. Deep Observability   │
│ • Stat tile overload    │ • Linear repetitive loop│ • Monolithic trace feed │
│ • Table column squeeze  │ • Plain text JSON inputs│ • Missing CLI bridges   │
│ • Monospace visual fatigue│ • Monochromatic payloads│ • Static graph canvas │
└─────────────────────────┴─────────────────────────┴─────────────────────────┘
```

1. **Overview Glanceability**: 18+ stat cards render in an undifferentiated flat grid in [`Overview.tsx`](../event-runtime/web/src/views/Overview.tsx). Events, proposals, runs, and workers all share identical visual weight.
2. **Master-Detail Table Squeeze**: Opening the slide-over detail pane (440px–520px) heavily truncates 6–8 column tables in `Runs`, `Events`, and `Workers`, cutting off key identifiers, error reason strings, and hostnames.
3. **Monochromatic Monospace Fatigue**: Large raw JSON disclosures render in uniform monospace text without syntax highlighting, increasing cognitive load when reviewing multi-page specs or event payloads.
4. **Trace Stream Navigation**: In [`RunTrace.tsx`](../event-runtime/web/src/components/RunTrace.tsx), all event types (`assistant_text`, `tool_use`, `tool_result`, `usage`, `lifecycle`) stream into one vertical list without filtering, searching, or expand/collapse-all controls.
5. **Inject Editor Ergonomics**: In [`InjectDialog.tsx`](../event-runtime/web/src/components/InjectDialog.tsx), editing event envelopes in a plain `<textarea>` lacks syntax highlighting, bracket matching, formatting, or inline schema validation hints.

---

## 3. Syntax-Highlighted JSON Architecture

Currently, [`JsonBlock`](../event-runtime/web/src/components/ui.tsx) formats JSON via `JSON.stringify(value, null, 2)` inside a plain `<pre>` element.

### 3.1 Design Goals for JSON Highlighting
1. **Zero External Bundle Bloat**: Avoid multi-megabyte highlighter dependencies (e.g. heavy TextMate WASM grammars).
2. **OKLCH Token Harmony**: Token colors must derive from the active theme variables (`var(--accent)`, `var(--hue-ok)`, `var(--hue-info)`, `var(--hue-warn)`, `var(--hue-err)`) across Dark, Light, and High-Contrast modes.
3. **Copy-Paste Fidelity**: Copying text from the rendered JSON must yield clean, unpolluted JSON text.
4. **Sub-millisecond Tokenization**: Fast rendering even with 500+ line payloads.

### 3.2 Evaluation of Implementation Approaches

| Approach | Bundle Impact | Theme Integration | Interactive Features | Assessment |
| :--- | :---: | :---: | :---: | :--- |
| **A. Native Tokenizing Regex Component** | **< 1 KB** (0 deps) | **Native OKLCH** | Hover highlighting, line numbers | **Recommended for General Viewers** |
| **B. Interactive Collapsible AST Tree** | ~3 KB (0 deps) | **Native OKLCH** | Branch collapse, JSONPath copy, search | **Recommended for Large Results/Evidence** |
| **C. Shiki / Prismjs** | ~30 KB – 1.5 MB | Fixed themes (CSS override required) | Full language grammars | Overkill for pure JSON; theme mismatch risk |
| **D. CodeMirror 6 JSON Extension** | ~40 KB (modular) | Custom OKLCH theme | Live editing, linting, bracket match | **Recommended for Inject Dialog Textarea** |

### 3.3 Recommended Strategy

#### Tier 1: Micro Tokenized `JsonBlock` (Read-Only Disclosures)
Implement a zero-dependency tokenizer in `components/JsonBlock.tsx` that transforms structured values into styled spans using standard JSON grammar regex:

```tsx
// Token definitions mapping to existing OKLCH theme tokens:
// Keys:       var(--text) with font-medium (or var(--accent) for top-level keys)
// Strings:    var(--hue-ok) (green/emerald hue)
// Numbers:    var(--hue-info) (accent/cyan hue)
// Booleans:   var(--hue-warn) (amber hue)
// Null:       var(--hue-err) (coral/red hue)
// Brackets:   var(--text-faint)
```

```tsx
export function HighlightedJson({ text }: { text: string }) {
  const html = useMemo(() => {
    return text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
          let cls = "text-[color:var(--hue-info)]"; // number default
          if (/^"/.test(match)) {
            cls = /:$/.test(match)
              ? "text-[color:var(--text)] font-medium" // key
              : "text-[color:var(--hue-ok)]"; // string value
          } else if (/true|false/.test(match)) {
            cls = "text-[color:var(--hue-warn)] font-semibold"; // boolean
          } else if (/null/.test(match)) {
            cls = "text-[color:var(--hue-err)] font-semibold"; // null
          }
          return `<span class="${cls}">${match}</span>`;
        }
      );
  }, [text]);

  return (
    <pre
      className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 leading-relaxed whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
```

#### Tier 2: Interactive Tree Capabilities (Result Evidence & Spec Inspection)
For payloads exceeding 50 lines (e.g. `result.evidence`, `result.artifact`, `envelope`):
- **Click-to-Collapse**: Disclosure chevrons on object/array boundaries.
- **Copy JSONPath**: Hovering a key displays `$.payload.repos[0]` with click-to-copy.
- **Format Toggle**: Raw compact vs Pretty formatted switch.

---

## 4. Prioritized UX Improvement Proposals

### Proposal 1: Overview Triage Cockpit (Pipeline Hierarchy)
**Goal**: Transform [`Overview.tsx`](../event-runtime/web/src/views/Overview.tsx) from a flat stat grid into an operational triage pipeline.

- **Grouped Stages**:
  1. **Intake Queue**: `admitted` $\rightarrow$ `human_needed` $\rightarrow$ `dead_lettered` (highlighted in error/warning tones).
  2. **Approval Gate**: `open proposals` (flagged with countdowns $<5\text{m}$) $\rightarrow$ `expired`.
  3. **Execution Fleet**: `active runs` (`QUEUED` + `RUNNING` + `VERIFYING`) vs `terminal runs` (`COMPLETED`, `FAILED`).
  4. **Worker Capacity**: Live / Busy / Stale health counters.
- **Promoted Doctor Deck**: Place active anomalies at the very top of the page when non-zero, with single-click triage actions (`Requeue all dead letters`, `Jump to stale leases`).

---

### Proposal 2: Watched Approval "Spec Highlights" Card
**Goal**: Accelerate safe proposal review in [`Proposals.tsx`](../event-runtime/web/src/views/Proposals.tsx).

- **Summary Header**: Before the raw JSON disclosure, present an explicit safety card:
  - **Action Target**: Pinned repository, host, issue ID, or target environment.
  - **Risk Profile**: Read-only vs. Mutating (prominent alert badge).
  - **Budget & SLA**: Declared attempts, timeout ceiling, and token limits.
- **Diff Focus**: On re-planned proposals, highlight semantic differences in input/template parameters rather than full-document text diffs.

---

### Proposal 3: Run Trace Controls & CLI Integration
**Goal**: Make long multi-turn agent traces scannable in [`RunTrace.tsx`](../event-runtime/web/src/components/RunTrace.tsx).

- **Stream Filter Chips**:
  - `[All]` (full stream)
  - `[Tools Only]` (tool names & inputs)
  - `[Reasoning]` (`assistant_text` only)
  - `[Errors]` (failed tool executions and runtime error notes)
  - `[Cost & Tokens]` (`usage` metrics)
- **Bulk Expansion**: `Expand all tool outputs` / `Collapse all` toggle (`e`).
- **CLI Bridge**: Provide a one-click `Copy CLI Inspect` button:
  ```bash
  bun event-runtime/cli.mjs inspect <runId>
  ```
  enabling instant transition from browser triage to terminal debugging.

---

### Proposal 4: Faceted Search & Filter Tags
**Goal**: Elevate list search across `Runs`, `Events`, and `Proposals`.

- **Structured Query Syntax**: Support key-value filters in [`FilterInput`](../event-runtime/web/src/components/ui.tsx):
  - `agent:ci-doctor`
  - `state:failed`
  - `source:keephq`
  - `is:stale`
- **Dismissible Tag Bar**: Active filter criteria render as visual tag chips above tables with one-click removal and keyboard clearing (`Esc`).

---

### Proposal 5: Inject & Replay Editor Upgrade
**Goal**: Prevent envelope syntax errors in [`InjectDialog.tsx`](../event-runtime/web/src/components/InjectDialog.tsx).

- **Format JSON Action**: Dedicated format shortcut (`⌘⇧F` / `⌥⇧F`) to beautify pasted envelopes.
- **Form / JSON Dual Mode**: Simple form fields for required template parameters (e.g. selecting repo from dropdown, setting alert ID) with real-time sync to the JSON envelope.
- **Pre-submission Schema Linting**: Live validation showing missing envelope fields before clicking inject.

---

### Proposal 6: Topology Canvas Live State (Graph Phase 2)
**Goal**: Evolve [`Graph.tsx`](../event-runtime/web/src/views/Graph.tsx) into a live runtime health map.

- **Active Load Indicators**: Badges on `eventType` and `agent` nodes showing live admitted events and active worker runs.
- **Failure Heatmap**: Edge color intensity based on recent error or `human_needed` rates.
- **Canvas-Triggered Injection**: Click an event node on canvas $\rightarrow$ quick action to open `InjectDialog` pre-seeded with that event's template.

---

## 5. Implementation Roadmap & Sequencing

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DELIVERY SEQUENCING                               │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 1 (Quick Wins - High Ergonomics)                                  │
│ • Zero-dependency Syntax Highlighted JsonBlock                              │
│ • Run Trace filter pills (Errors, Tools, Reasoning) & Collapse/Expand all   │
│ • CLI inspect command copy helper in Run Detail                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 2 (Triage Velocity)                                               │
│ • Proposal Spec Highlights summary card                                     │
│ • Overview 3-stage pipeline layout                                          │
│ • Format JSON action in InjectDialog                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 3 (Advanced Observability)                                        │
│ • Keyed search filter syntax (agent:, state:, source:)                      │
│ • Graph View Phase 2 live load overlay                                      │
│ • Interactive JSON tree inspector for large evidence blobs                  │
└─────────────────────────────────────────────────────────────────────────────┘
```
