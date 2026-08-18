/** A hook that throws: fail closed, `hook_error:<id>`. */
export const id = "factory/sample:throws";

export default function throws() {
  throw new Error("fixture hook exploded");
}
