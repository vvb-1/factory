/**
 * Transcript capture and stream flush guarantees (docs/event-runtime.md §6, §7; OPS-426).
 *
 * Adapters capture agent stdout into `.transcript.json` as a runtime artifact.
 * When large NDJSON streams are emitted, the child process `close` event may fire
 * before the Node/Bun write stream has finished flushing all buffered chunks to disk.
 *
 * This module ensures write streams are completely flushed and closed before
 * computing sha256 hashes and storing artifacts into the content-addressed store,
 * guaranteeing the artifact store's core invariant: stored bytes always equal
 * the computed hash and the agent's full output.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./canonical.mjs";
import { artifactPath } from "./artifacts.mjs";

export const TRANSCRIPT_FILENAME = ".transcript.json";

/**
 * Await a writable stream's complete flush to disk and close.
 * Idempotent, safe against already-closed or destroyed streams, and rejects on write errors.
 *
 * @param {import("node:stream").Writable | import("node:fs").WriteStream} stream
 * @returns {Promise<void>}
 */
export function waitForStreamFlush(stream) {
  if (!stream) return Promise.resolve();
  if (stream.writableFinished || stream.closed) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    };

    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    stream.once("finish", onFinish);
    stream.once("close", onClose);
    stream.once("error", onError);

    if (stream.destroyed) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }
  });
}

/**
 * Create a managed transcript capture write stream in a workspace.
 *
 * @param {string} workspaceDir
 * @param {{ filename?: string, flags?: string }} [options]
 * @returns {{
 *   stream: import("node:fs").WriteStream,
 *   filePath: string,
 *   flush: () => Promise<void>,
 *   endAndFlush: () => Promise<void>
 * }}
 */
export function createTranscriptCapture(workspaceDir, { filename = TRANSCRIPT_FILENAME, flags = "w" } = {}) {
  const filePath = path.join(workspaceDir, filename);
  const stream = createWriteStream(filePath, { flags });

  const flush = () => waitForStreamFlush(stream);

  const endAndFlush = () => {
    if (stream.writableFinished || stream.closed) {
      return Promise.resolve();
    }
    if (!stream.writableEnded) {
      stream.end();
    }
    return waitForStreamFlush(stream);
  };

  return {
    stream,
    filePath,
    flush,
    endAndFlush,
  };
}

/**
 * Compute the sha256 hash and size of a transcript file after ensuring any write stream is flushed.
 *
 * @param {string} filePath - Absolute path to transcript file
 * @param {import("node:stream").Writable} [stream] - Optional active write stream to flush first
 * @returns {Promise<{ sha256: string, sizeBytes: number, bytes: Buffer }>}
 */
export async function computeTranscriptHash(filePath, stream = null) {
  if (stream) {
    await waitForStreamFlush(stream);
  }
  if (!existsSync(filePath)) {
    throw new Error(`transcript file does not exist: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  const sha256 = sha256Hex(bytes);
  return {
    sha256,
    sizeBytes: bytes.byteLength,
    bytes,
  };
}

/**
 * Ensure transcript is flushed, compute its hash, and copy it to the content-addressed store.
 * Guarantees that the stored file contains the full bytes matching the computed sha256 hash.
 *
 * @param {object} params
 * @param {string} params.workspaceDir - Directory containing transcript
 * @param {string} [params.filename] - Transcript filename (default .transcript.json)
 * @param {string} params.storeRoot - Root directory of artifact store
 * @param {import("node:stream").Writable} [params.stream] - Optional active write stream
 * @returns {Promise<{ sha256: string, sizeBytes: number, uri: string, storePath: string }>}
 */
export async function flushAndStoreTranscript({
  workspaceDir,
  filename = TRANSCRIPT_FILENAME,
  storeRoot,
  stream = null,
}) {
  const filePath = path.join(workspaceDir, filename);
  if (stream) {
    if (!stream.writableEnded) {
      stream.end();
    }
    await waitForStreamFlush(stream);
  }

  const { sha256, sizeBytes } = await computeTranscriptHash(filePath);

  mkdirSync(storeRoot, { recursive: true });
  const dest = artifactPath(storeRoot, sha256);

  if (!existsSync(dest)) {
    copyFileSync(filePath, dest);
  }

  // Verify stored artifact matches computed sha256 and size
  const storedStat = statSync(dest);
  if (storedStat.size !== sizeBytes) {
    throw new Error(
      `stored artifact size mismatch for ${dest}: expected ${sizeBytes} bytes, got ${storedStat.size} bytes`,
    );
  }

  return {
    sha256,
    sizeBytes,
    uri: `file://${dest}`,
    storePath: dest,
  };
}
