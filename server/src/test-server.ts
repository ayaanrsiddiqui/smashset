import { afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';

/**
 * One listening server for a whole test file, for every supertest call in it.
 *
 * supertest's own default is a fresh `app.listen(0)` and `close()` around
 * *each individual request* (lib/test.js, serverAddress). Across a full run
 * that is several hundred short-lived listeners churning the ephemeral port
 * range, and eventually a new one binds a port the kernel has not finished
 * with — the request then dies in the transport as `socket hang up` or
 * `Parse Error: Expected HTTP/`, surfacing as a failure in whichever test
 * happened to be running rather than anywhere near the cause. It hit the
 * 401-gate tests twice, which do no I/O at all.
 *
 * Measured once, on a minimal app with 8 concurrent workers: 5 failures in
 * 40,000 requests listening per-request, 0 in 40,000 listening once. That
 * number is evidence for the change, not a guarantee about it — what actually
 * has to stay true is that supertest keeps skipping its own listen/close when
 * handed something already listening, and test-server.test.ts asserts that.
 *
 * Loopback rather than the wildcard `app.listen(0)` binds: supertest dials
 * 127.0.0.1 regardless, and this listener now stays up for the whole file
 * instead of one request, so there is no reason to answer the network.
 */
export function testServer(app: Express): Server {
  const server = app.listen(0, '127.0.0.1');
  afterAll(() => closeTestServer(server));
  return server;
}

/**
 * Separate from testServer so the teardown half is reachable from a test —
 * an afterAll that only ever runs at the end of a real file is otherwise
 * impossible to assert on, and deleting it left the whole suite green.
 */
export function closeTestServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // close() alone waits out every open socket. One shared listener per file
    // means a test that leaves a response streaming — the SSE route in
    // routes/sets.ts never ends one — would hold teardown until vitest's hook
    // timeout, and blame this helper instead of the test holding the socket.
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
