/**
 * Reusable cell renderer for dynamic / custom payload columns (WM-214).
 * Extracts nested path values safely and formats primitives, code badges, and objects.
 *
 * A column can declare what a value *means* with the `x-ui` schema annotation
 * (WM-701): `x-ui: { kind: "ticket" }` says the whole cell is one ticket id, so
 * it renders as a hover-card link rather than as a string that happens to look
 * like one. Everything else is still scanned for embedded ids, because the
 * useful ticket reference is usually buried in a summary line, not in a column
 * anybody thought to annotate.
 */
import { extractRowValue } from "../pathExtractor";
import { TicketHoverCard, TicketText } from "./TicketHoverCard";

/** The `x-ui` annotation a payload schema can attach to a property. */
export interface CellUi {
  kind?: string | null;
}

/**
 * Read `x-ui` off a JSON-schema node. Anything that is not an object with a
 * string `kind` is not an annotation — a schema served mid-migration must not
 * take a table down.
 */
export function readCellUi(schema: unknown): CellUi | null {
  if (!schema || typeof schema !== "object") return null;
  const annotation = (schema as Record<string, unknown>)["x-ui"];
  if (!annotation || typeof annotation !== "object") return null;
  const kind = (annotation as Record<string, unknown>).kind;
  return typeof kind === "string" && kind ? { kind } : null;
}

export interface CellFormat {
  text: string;
  isComplex: boolean;
  title?: string;
  /** The `x-ui` kind this cell can honour, null when the value cannot carry it. */
  kind: string | null;
}

export function formatCellValue(
  value: unknown,
  ui?: CellUi | null,
): CellFormat {
  if (value === undefined || value === null)
    return { text: "—", isComplex: false, kind: null };
  if (typeof value === "boolean")
    return { text: value ? "true" : "false", isComplex: false, kind: null };
  if (typeof value === "number")
    return { text: String(value), isComplex: false, kind: null };
  if (typeof value === "string") {
    // Only a scalar string can be the ticket the schema promised; a column
    // annotated `ticket` whose value arrived as an object is a payload bug,
    // and linking it would hide that.
    if (ui?.kind === "ticket")
      return {
        text: value.trim().toUpperCase(),
        isComplex: false,
        title: value,
        kind: "ticket",
      };
    return { text: value, isComplex: false, title: value, kind: null };
  }
  if (Array.isArray(value)) {
    return {
      text: `[${value.length}]`,
      isComplex: true,
      title: JSON.stringify(value, null, 2),
      kind: null,
    };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return {
      text: `{${keys.slice(0, 2).join(", ")}${keys.length > 2 ? "…" : ""}}`,
      isComplex: true,
      title: JSON.stringify(value, null, 2),
      kind: null,
    };
  }
  return { text: String(value), isComplex: false, kind: null };
}

export function CustomCell({
  row,
  path,
  ui,
  schema,
  onNavigateTicket,
}: {
  row: unknown;
  path: string;
  /** The column's `x-ui` annotation, already resolved. */
  ui?: CellUi | null;
  /** The column's schema node, for callers that hold the schema, not the annotation. */
  schema?: unknown;
  onNavigateTicket?: (ticketId: string) => void;
}) {
  const cleanPath = path.replace(/^custom:/, "");
  const value = extractRowValue(row, cleanPath);
  const { text, isComplex, title, kind } = formatCellValue(
    value,
    ui ?? readCellUi(schema),
  );

  const isMono =
    cleanPath.toLowerCase().includes("id") ||
    cleanPath.toLowerCase().includes("sha") ||
    cleanPath.toLowerCase().includes("hash") ||
    cleanPath.toLowerCase().includes("commit") ||
    cleanPath.toLowerCase().includes("branch") ||
    cleanPath.toLowerCase().includes("repo");

  return (
    <td
      className="max-w-44 truncate border-b border-(--border) px-3 py-1.5 whitespace-nowrap text-(--text-dim)"
      title={title}
    >
      {isComplex ? (
        <span className="mono rounded bg-(--surface-2) px-1 py-0.5 text-xs text-(--text-faint)">
          {text}
        </span>
      ) : typeof value === "boolean" ? (
        <span className="mono text-[11px] text-(--text-faint)">{text}</span>
      ) : typeof value === "number" ? (
        <span className="mono tabular-nums">{text}</span>
      ) : kind === "ticket" ? (
        <TicketHoverCard ticketId={text} onNavigateTicket={onNavigateTicket} />
      ) : typeof value === "string" ? (
        <span className={isMono ? "mono" : ""}>
          <TicketText text={text} onNavigateTicket={onNavigateTicket} />
        </span>
      ) : (
        <span className={isMono ? "mono" : ""}>{text}</span>
      )}
    </td>
  );
}
