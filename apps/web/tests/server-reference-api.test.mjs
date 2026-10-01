import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceApi } from '../features/stage-two/server-reference/api.ts';

const token = owner => `header.${btoa(JSON.stringify({ sub: owner }))}.fixture`;
test('reference requests authenticate and reject account switches before network', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(init.headers.Authorization, `Bearer ${token('alice')}`); return Response.json({ available: false }); };
  try {
    const api = createReferenceApi('alice', async () => token('alice'));
    assert.equal((await api.capability('content', 'segment', new AbortController().signal)).available, false);
    await assert.rejects(createReferenceApi('alice', async () => token('bob')).prepare('content', 'segment', new AbortController().signal), /Account changed/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('authenticated SSE handles split events and heartbeat without inventing results', async () => {
  const original = globalThis.fetch; const updates = [];
  const chunks = [': heartbeat\n\nevent: ref', 'erence\ndata: {"id":"one","state":"processing"}\n', '\nevent: reference\ndata: {"id":"one","state":"completed"}\n\n'];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await createReferenceApi('alice', async () => token('alice')).watch('one', new AbortController().signal, row => updates.push(row.state));
    assert.deepEqual(updates, ['processing', 'completed']);
  } finally { globalThis.fetch = original; }
});

test('stream failure is explicit so the caller can reconcile durable status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('event: unavailable\ndata: {"message":"unavailable"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(createReferenceApi('alice', async () => token('alice')).watch('one', new AbortController().signal, () => assert.fail('unexpected update')), /interrupted/);
  } finally { globalThis.fetch = original; }
});
