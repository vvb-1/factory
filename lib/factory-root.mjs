/**
 * Resolve the factory checkout from env, default path, or this file's location.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "tools/linear.mjs";

/** @returns {string} absolute path to factory checkout */
export function factoryRoot() {
  const env = process.env.FACTORY_ROOT;
  if (env && existsSync(path.join(env, MARKER))) return path.resolve(env);

  const defaultPath = path.join(homedir(), "Develop/factory");
  if (existsSync(path.join(defaultPath, MARKER))) return defaultPath;

  const fromLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(path.join(fromLib, MARKER))) return fromLib;

  return env ? path.resolve(env) : defaultPath;
}
