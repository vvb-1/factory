// Allocate free TCP ports on 127.0.0.1 by binding `:0` on throwaway sockets.
// Works under both node and bun. All requested sockets are held open until
// every port is picked, so the same call never returns the same port twice.
//
//   import { freePorts } from "./free-port.mjs";      // async API
//   bun e2e/free-port.mjs 2                           // prints one port per line
import net from "node:net";

function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Throw if `port` cannot be bound right now (someone else is listening).
export async function assertPortFree(port, label = `port ${port}`) {
  let server;
  try {
    server = await listen(port);
  } catch (error) {
    throw new Error(
      `${label} (127.0.0.1:${port}) is already in use: ${error?.code ?? error}`,
      { cause: error },
    );
  }
  await close(server);
}

export async function freePorts(count = 1) {
  const servers = [];
  try {
    for (let i = 0; i < count; i += 1) servers.push(await listen());
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map(close));
  }
}

if (
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).pathname ===
    new URL(import.meta.url).pathname
) {
  const count = Number(process.argv[2] ?? 1);
  const ports = await freePorts(count);
  process.stdout.write(`${ports.join("\n")}\n`);
}
