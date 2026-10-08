import assert from 'node:assert/strict';
import test from 'node:test';
import { syncBatches } from '../src/app/utils/sync-batches.ts';

test('large Unicode task lists fit below the API limit without dropping or duplicating edits', () => {
  const items = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index), text: '漢'.repeat(120),
    subtasks: Array.from({ length: 10 }, (_, subtask) => ({ id: `${index}:${subtask}`, text: '漢'.repeat(120) })),
  }));
  const batches = syncBatches(items);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), items);
  for (const batch of batches) {
    const payload = { items: batch, order: { baseOrderRevision: 0, orderedIds: items.map(item => item.id) } };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024 * 1024);
  }
});

test('an unchanged list still sends one empty request to pull collaborators updates', () => {
  assert.deepEqual(syncBatches([]), [[]]);
});
