import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { testServer } from '../test-server.js';
import { createApp } from '../app.js';
import { resetClientEventBudgets } from './clientEvents.js';

const server = testServer(createApp());

describe('POST /api/client-events', () => {
  /** Every `[client]` line the route wrote during the current test. */
  let lines: string[];

  beforeEach(() => {
    resetClientEventBudgets();
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = String(args[0]);
      if (line.startsWith('[client]')) lines.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a batch from a browser with no session at all', async () => {
    // The point of the endpoint. A TO whose session died is the case we most
    // need to hear about, and requireAuth would answer 401 and tell us nothing.
    const res = await request(server)
      .post('/api/client-events')
      .send({ sessionId: 'abc123', events: [{ kind: 'report-failed', setId: '99', attempt: 3 }] });

    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('abc123');
    expect(lines[0]).toContain('report-failed');
    expect(lines[0]).toContain('setId="99"');
    expect(lines[0]).toContain('attempt="3"');
  });

  it('logs one line per event in a batch', async () => {
    await request(server)
      .post('/api/client-events')
      .send({ sessionId: 's', events: [{ kind: 'crash' }, { kind: 'report-delivered' }, { kind: 'report-failed' }] });

    expect(lines).toHaveLength(3);
  });

  it('caps how many events one request can log', async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ kind: 'crash', n: i }));

    await request(server).post('/api/client-events').send({ sessionId: 's', events });

    expect(lines).toHaveLength(20);
  });

  it('cannot be made to forge a log line of its own', async () => {
    // A log reader splits on newlines, so an un-collapsed value would let a
    // client write something that reads as this server's own output.
    await request(server)
      .post('/api/client-events')
      .send({
        sessionId: 's',
        events: [{ kind: 'crash', message: 'boom\n[unhandled] totally real server error' }],
      });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('boom [unhandled] totally real server error');
  });

  it('drops a batch that blows the per-IP budget, but still answers 204', async () => {
    const full = Array.from({ length: 20 }, () => ({ kind: 'crash' }));
    // 6 x 20 exhausts the 120/minute budget exactly.
    for (let i = 0; i < 6; i++) {
      await request(server).post('/api/client-events').send({ sessionId: 's', events: full });
    }
    expect(lines).toHaveLength(120);

    const res = await request(server).post('/api/client-events').send({ sessionId: 's', events: full });

    // 204 rather than 429 on purpose: an error is something a client retries,
    // and a beacon that retries competes with reports for venue bandwidth.
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(120);
  });

  it('ignores an event with no kind rather than logging a blank line', async () => {
    await request(server)
      .post('/api/client-events')
      .send({ sessionId: 's', events: [{ setId: '1' }, 'not an object', null, { kind: 'crash' }] });

    expect(lines).toHaveLength(1);
  });

  it('survives a body that is not the shape it expects', async () => {
    const res = await request(server).post('/api/client-events').send({ events: 'nope' });

    expect(res.status).toBe(204);
    expect(lines).toHaveLength(0);
  });

  it('drops non-scalar fields instead of logging [object Object]', async () => {
    await request(server)
      .post('/api/client-events')
      .send({ sessionId: 's', events: [{ kind: 'crash', payload: { nested: true }, message: 'real' }] });

    expect(lines[0]).not.toContain('object Object');
    expect(lines[0]).toContain('message="real"');
  });
});
