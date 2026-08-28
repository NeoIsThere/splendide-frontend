import assert from 'node:assert/strict';
import test from 'node:test';
import { planSingleListMigration } from '../src/app/utils/single-list-migration.ts';

const idFor = (seed: string) => `generated:${seed}`;

test('merges main, backlog, and extra lists deterministically without losing items', () => {
  const plan = planSingleListMigration([
    { id: 'backlog-b', isBacklog: true, sourceIndex: 0, items: [{ id: 'later-b' }] },
    { id: 'main', isBacklog: false, sourceIndex: 1, items: [{ id: 'now-a' }, { id: 'now-b' }] },
    { id: 'extra', sourceIndex: 2, items: [{ id: 'extra-a' }] },
    { id: 'backlog-a', isBacklog: true, sourceIndex: 3, items: [{ id: 'later-a' }] },
  ], 'page-1', idFor);

  assert.ok(plan);
  assert.equal(plan.canonicalListId, 'main');
  assert.deepEqual(plan.items.map(entry => entry.id), [
    'now-a',
    'now-b',
    'later-a',
    'later-b',
    'extra-a',
  ]);
  assert.deepEqual(plan.items.map(entry => entry.position), [0, 1, 2, 3, 4]);
});

test('re-keys duplicate item ids and preserves both rows', () => {
  const plan = planSingleListMigration([
    { id: 'main', isBacklog: false, sourceIndex: 0, items: [{ id: 'same', text: 'first' }] },
    { id: 'backlog', isBacklog: true, sourceIndex: 1, items: [{ id: 'same', text: 'second' }] },
  ], 'page-2', idFor);

  assert.ok(plan);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].id, 'same');
  assert.equal(plan.items[0].duplicated, false);
  assert.equal(plan.items[1].id, 'generated:page-2:backlog:same:1');
  assert.equal(plan.items[1].duplicated, true);
  assert.deepEqual(plan.items.map(entry => entry.item.text), ['first', 'second']);
});
