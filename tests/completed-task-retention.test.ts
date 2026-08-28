import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedItemsBeyondRetention,
  SINGLE_LIST_COMPLETED_RETENTION,
} from '../src/app/utils/completed-task-retention.ts';

interface CompletedItem {
  id: string;
  completedAt: number;
}

const newestFirst = (left: CompletedItem, right: CompletedItem) =>
  right.completedAt - left.completedAt;

test('retains all twenty completed tasks merged from two legacy lists', () => {
  const merged = Array.from({ length: 20 }, (_, index) => ({
    id: `task-${index}`,
    completedAt: index,
  }));

  assert.equal(SINGLE_LIST_COMPLETED_RETENTION, 20);
  assert.deepEqual(completedItemsBeyondRetention(merged, newestFirst), []);
});

test('only the oldest task over the single-list retention is removed', () => {
  const merged = Array.from({ length: 21 }, (_, index) => ({
    id: `task-${index}`,
    completedAt: index,
  }));

  assert.deepEqual(
    completedItemsBeyondRetention(merged, newestFirst).map(item => item.id),
    ['task-0'],
  );
});
