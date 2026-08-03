import { test, expect } from "bun:test";
import { matchEscalations } from "./escalate.mjs";

const globs = ["app/src/payment/**", "app/src/auth/**", "app/migrations/**"];

test("flags a file under an escalate glob", () => {
  const hits = matchEscalations(["app/src/payment/stripe.ts"], globs);
  expect(hits.length).toBe(1);
  expect(hits[0].globs).toEqual(["app/src/payment/**"]);
});

test("clean diff passes", () => {
  expect(matchEscalations(["app/src/pages/Home.tsx", "README.md"], globs)).toEqual([]);
});

test("a single protected file among many still escalates", () => {
  const hits = matchEscalations(
    ["docs/notes.md", "app/migrations/0042_add_index.sql", "app/src/ui/Button.tsx"],
    globs,
  );
  expect(hits.map((h) => h.file)).toEqual(["app/migrations/0042_add_index.sql"]);
});

test("settings glob with wildcard filename matches", () => {
  const hits = matchEscalations(
    ["legalease/legalease/settings_prod.py"],
    ["legalease/legalease/settings*.py"],
  );
  expect(hits.length).toBe(1);
});

test("empty glob list never escalates", () => {
  expect(matchEscalations(["anything.ts"], [])).toEqual([]);
});
