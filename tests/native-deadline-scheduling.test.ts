import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_DEADLINE_NOTIFICATION_TYPE,
  planNativeDeadlineNotifications,
  type NativeDeadlineSchedule,
} from '../src/app/utils/native-deadline-scheduling.ts';

const now = Date.parse('2026-08-29T10:00:00.000Z');
const first: NativeDeadlineSchedule = {
  eventId: 'task-1:schedule-1',
  pageId: 'page-1',
  taskId: 'task-1',
  pageTitle: 'release',
  taskText: 'publish build',
  deadlineAt: '2026-08-29T11:00:00.000Z',
};

test('keeps an identical pending anonymous deadline without rescheduling it', () => {
  const plan = planNativeDeadlineNotifications([first], [{
    id: 1_234_567_890,
    title: first.pageTitle,
    body: first.taskText,
    extra: {
      type: NATIVE_DEADLINE_NOTIFICATION_TYPE,
      eventId: first.eventId,
      deadlineAt: first.deadlineAt,
      pageId: first.pageId,
      taskId: first.taskId,
      shareToken: '',
    },
  }], now);

  assert.deepEqual(plan, { cancelIds: [], schedule: [] });
});

test('cancels removed schedules and replaces changed presentation data', () => {
  const plan = planNativeDeadlineNotifications([{ ...first, taskText: 'publish final build' }], [{
    id: 1_234_567_890,
    title: first.pageTitle,
    body: first.taskText,
    extra: {
      type: NATIVE_DEADLINE_NOTIFICATION_TYPE,
      eventId: first.eventId,
      deadlineAt: first.deadlineAt,
      pageId: first.pageId,
      taskId: first.taskId,
      shareToken: '',
    },
  }, {
    id: 1_234_567_891,
    title: 'old',
    body: 'old',
    extra: {
      type: NATIVE_DEADLINE_NOTIFICATION_TYPE,
      eventId: 'removed-event',
    },
  }], now);

  assert.deepEqual(plan.cancelIds, [1_234_567_890, 1_234_567_891]);
  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].eventId, first.eventId);
  assert.equal(plan.schedule[0].taskText, 'publish final build');
});

test('does not schedule an already elapsed deadline', () => {
  const plan = planNativeDeadlineNotifications([{
    ...first,
    deadlineAt: '2026-08-29T09:59:59.999Z',
  }], [], now);

  assert.deepEqual(plan, { cancelIds: [], schedule: [] });
});

test('allocates stable distinct 32-bit ids without taking ids owned by another feature', () => {
  const second = {
    ...first,
    eventId: 'task-2:schedule-1',
    taskId: 'task-2',
  };
  const plan = planNativeDeadlineNotifications([first, second], [{
    id: 42,
    title: 'another feature',
    body: 'leave me alone',
  }], now);

  assert.equal(plan.schedule.length, 2);
  assert.equal(new Set(plan.schedule.map(notification => notification.id)).size, 2);
  assert.ok(plan.schedule.every(notification =>
    notification.id >= 1_000_000_000 && notification.id < 2_000_000_000,
  ));
  assert.ok(plan.schedule.every(notification => notification.id !== 42));
});

test('deduplicates repeated desired event ids using the latest presentation', () => {
  const plan = planNativeDeadlineNotifications([
    first,
    { ...first, taskText: 'latest task text' },
  ], [], now);

  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].eventId, first.eventId);
  assert.equal(plan.schedule[0].taskText, 'latest task text');
});

test('cancels duplicate pending rows for one event without replacing the retained match', () => {
  const extra = {
    type: NATIVE_DEADLINE_NOTIFICATION_TYPE,
    eventId: first.eventId,
    deadlineAt: first.deadlineAt,
    pageId: first.pageId,
    taskId: first.taskId,
    shareToken: '',
  };
  const plan = planNativeDeadlineNotifications([first], [{
    id: 1_234_567_890,
    title: first.pageTitle,
    body: first.taskText,
    extra,
  }, {
    id: 1_234_567_891,
    title: first.pageTitle,
    body: first.taskText,
    extra,
  }], now);

  assert.deepEqual(plan.cancelIds, [1_234_567_891]);
  assert.deepEqual(plan.schedule, []);
});
