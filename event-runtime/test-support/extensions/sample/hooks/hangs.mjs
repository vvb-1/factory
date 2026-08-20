/** A hook that never answers: the registry's timeout must deny it. */
export const id = "factory/sample:hangs";

export default function hangs() {
  return new Promise(() => {});
}
