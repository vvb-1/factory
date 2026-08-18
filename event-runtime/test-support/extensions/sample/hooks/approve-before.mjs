/**
 * The smallest hook that satisfies the contract (docs/extensions.md § Hooks):
 * a string `id` and a default `(ctx) => decision`. It allows everything
 * unless the extension's effective config says otherwise — proving that
 * `ctx.config` is the object `getExtensionConfig` hands out — and denies a
 * proposal whose ticket carries the `sample:deny` label, so extension tests
 * can watch a deny short-circuit the waterfall and land in `hook_decisions`.
 */
export const id = "factory/sample:approve-before";

export default function approveBefore(ctx) {
  if (ctx?.config?.greeting === "deny")
    return { decision: "deny", reason: "sample_greeting_deny" };
  const labels = ctx?.evidence?.ticket?.labels ?? [];
  if (labels.includes("sample:deny"))
    return { decision: "deny", reason: "sample_label_deny" };
  return { decision: "allow" };
}
