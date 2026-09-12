import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { closeTestServer, testServer } from './test-server.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

const probe = express();
probe.get('/probe', (_req, res) => {
  res.json({ ok: true });
});
const probeServer = testServer(probe);

// This file is the one place allowed to name the pattern it bans, in prose
// and in a regex — scanning itself just makes the guard fail on its own
// documentation.
const SELF = fileURLToPath(import.meta.url);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
    if (full === SELF) return [];
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function supertestFiles(): string[] {
  return testFiles(SRC).filter((file) => /from 'supertest'/.test(read(file)));
}

/**
 * Reverting testServer costs nothing visible — the suite still passes, it just
 * goes back to failing about one run in N with `socket hang up` in whichever
 * unrelated test was unlucky. So this guards the call shape rather than a
 * behaviour, because there is no behaviour to observe until it is too late.
 *
 * It keys on the testServer( call and not on the import, and not on the old
 * spelling of the banned call: the template a new file copies now reads
 * `const server = ...`, so the likeliest regression is dropping just the
 * wrapper while the import stays behind — which nothing else in the repo
 * catches, since tsconfig sets no noUnusedLocals and there is no linter.
 */
describe('supertest usage', () => {
  it('routes every supertest file through testServer', () => {
    const offenders = supertestFiles()
      .filter((file) => !/\btestServer\(/.test(read(file)))
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  it('never hands supertest the bare express app', () => {
    const offenders = testFiles(SRC)
      .filter((file) => /request\(\s*app\s*\)/.test(read(file)))
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  it('is actually reading the test files it claims to check', () => {
    // Without this, a broken directory walk makes both checks vacuously pass.
    // The floors sit below the current population (24 test files, 7 of them
    // using supertest) so that deleting a route's tests is not an unrelated
    // failure here — they only have to be high enough that a walk which lost
    // a directory, or all of routes/, cannot clear them.
    expect(testFiles(SRC).length).toBeGreaterThan(15);
    expect(supertestFiles().length).toBeGreaterThanOrEqual(5);
  });
});

describe('testServer', () => {
  it('serves every request from the one port, rather than a fresh listener each time', async () => {
    // The whole point of the helper: supertest only skips its own
    // listen(0)/close when what it is handed is already listening.
    const first = request(probeServer).get('/probe');
    const second = request(probeServer).get('/probe');

    const bound = (probeServer.address() as { port: number }).port;
    expect(Number(new URL(first.url).port)).toBe(bound);
    expect(Number(new URL(second.url).port)).toBe(bound);

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // Still listening afterwards — supertest did not close it out from under us.
    expect(probeServer.listening).toBe(true);
  });

  it('binds loopback only, since it now stays up for the whole file', () => {
    expect((probeServer.address() as { address: string }).address).toBe('127.0.0.1');
  });

  it('tears down while a response is still streaming, instead of waiting out the hook timeout', async () => {
    // Shaped like the SSE route in routes/sets.ts: headers flushed, a frame
    // written, the response never ended.
    const streaming = express();
    streaming.get('/stream', (_req, res) => {
      res.set('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write(': open\n\n');
    });
    const server = streaming.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };

    const open = http.get({ host: '127.0.0.1', port, path: '/stream' });
    await new Promise((resolve) => open.once('response', resolve));

    const started = Date.now();
    await closeTestServer(server);

    // Without closeAllConnections this sits on the open socket until vitest
    // kills the hook, so the margin here is the whole assertion.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(server.listening).toBe(false);
    open.destroy();
  });
});
