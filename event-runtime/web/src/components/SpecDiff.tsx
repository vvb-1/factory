// Line diff for two RunSpecs — the §12 replan path must show the operator
// exactly what changed before they approve the re-planned spec.

type DiffLine = { type: "same" | "del" | "add"; text: string };

/** Plain LCS line diff; specs are ~30 lines, so O(n·m) is nothing. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export function SpecDiff({ before, after }: { before: unknown; after: unknown }) {
  const lines = diffLines(
    JSON.stringify(before, null, 2).split("\n"),
    JSON.stringify(after, null, 2).split("\n"),
  );
  const changed = lines.filter((l) => l.type !== "same").length;
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-(--text-faint)">
        {changed === 0 ? "specs are identical" : `${changed} changed line${changed === 1 ? "" : "s"}`}
      </div>
      <pre className="mono max-h-80 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 leading-relaxed">
        {lines.map((l, idx) => (
          <div
            key={idx}
            style={
              l.type === "del"
                ? { color: "var(--hue-err)", background: "color-mix(in oklch, var(--hue-err) 8%, transparent)" }
                : l.type === "add"
                  ? { color: "var(--hue-ok)", background: "color-mix(in oklch, var(--hue-ok) 8%, transparent)" }
                  : undefined
            }
          >
            {l.type === "del" ? "- " : l.type === "add" ? "+ " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
