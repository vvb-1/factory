/** An asynchronous hook that denies: the waterfall must await it and stop. */
export const id = "factory/sample:async-deny";

export default async function asyncDeny() {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { decision: "deny", reason: "async_sample_deny" };
}
