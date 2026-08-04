/**
 * What today's runs have cost, in the notional units Claude reports.
 *
 * Lives here rather than in tick.mjs because the day budget has to bind every
 * stage that spawns an agent, not just dispatch. It used to gate dispatch
 * alone, which produced the exact inversion you do not want when over budget:
 * the stage that makes progress stopped, while triage and merge kept spawning
 * opus sessions every 5 and 10 minutes. On 2026-08-04 that ran to ~$335 of a
 * $200 budget, most of it re-reviewing two PRs that were already escalated and
 * waiting on a human.
 *
 * Subscription auth means these are not dollars — read it as a runaway guard.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(homedir(), ".factory/logs");

export function todaysSpendUSD(logDir = LOG_DIR) {
  const today = new Date().toISOString().slice(0, 10);
  let sum = 0;
  try {
    for (const f of new Bun.Glob("*.jsonl").scanSync(logDir)) {
      const full = path.join(logDir, f);
      if (new Date(Bun.file(full).lastModified).toISOString().slice(0, 10) !== today) continue;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        if (!line.includes('"total_cost_usd"')) continue;
        try { sum += JSON.parse(line).total_cost_usd ?? 0; } catch {}
      }
    }
  } catch { /* no log dir yet — nothing spent */ }
  return sum;
}

/** null when under budget; a human-readable reason when the day is spent. */
export function budgetExhausted(policy, logDir = LOG_DIR) {
  const perDay = policy?.budget?.per_day_usd;
  if (!perDay) return null;
  const spent = todaysSpendUSD(logDir);
  if (spent < perDay) return null;
  return `day budget spent (~$${spent.toFixed(2)} of $${perDay} notional)`;
}
