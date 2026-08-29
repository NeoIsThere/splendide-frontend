export const NATIVE_DEADLINE_NOTIFICATION_TYPE = 'splendide-task-deadline';

export interface NativeDeadlineSchedule {
  eventId: string;
  pageId: string;
  taskId: string;
  pageTitle: string;
  taskText: string;
  deadlineAt: string;
  shareToken?: string;
}

export interface PendingNativeNotification {
  id: number;
  title: string;
  body: string;
  extra?: unknown;
}

export interface PlannedNativeNotification extends NativeDeadlineSchedule {
  id: number;
}

export interface NativeDeadlineReconciliationPlan {
  cancelIds: number[];
  schedule: PlannedNativeNotification[];
}

const NATIVE_DEADLINE_ID_MIN = 1_000_000_000;
const NATIVE_DEADLINE_ID_RANGE = 1_000_000_000;

export function planNativeDeadlineNotifications(
  schedules: NativeDeadlineSchedule[],
  pending: PendingNativeNotification[],
  now = Date.now(),
): NativeDeadlineReconciliationPlan {
  const pendingDeadlines = pending.filter(notification =>
    notificationExtra(notification)['type'] === NATIVE_DEADLINE_NOTIFICATION_TYPE,
  );
  const pendingByEventId = new Map<string, PendingNativeNotification>();
  const duplicatePendingIds = new Set<number>();
  for (const notification of pendingDeadlines) {
    const eventId = String(notificationExtra(notification)['eventId'] ?? '').trim();
    if (!eventId) continue;
    if (pendingByEventId.has(eventId)) {
      duplicatePendingIds.add(notification.id);
      continue;
    }
    pendingByEventId.set(eventId, notification);
  }

  const desiredByEventId = new Map<string, NativeDeadlineSchedule>();
  for (const schedule of schedules) {
    if (schedule.eventId.trim() && Date.parse(schedule.deadlineAt) > now) {
      // A complete snapshot should contain one row per event. If an upstream
      // merge repeats one, the latest presentation wins without creating two
      // operating-system notifications.
      desiredByEventId.set(schedule.eventId, schedule);
    }
  }
  const desired = [...desiredByEventId.values()];
  const desiredEventIds = new Set(desired.map(schedule => schedule.eventId));
  const cancelIds = new Set(
    pendingDeadlines
      .filter(notification => {
        const eventId = String(notificationExtra(notification)['eventId'] ?? '').trim();
        return !eventId || !desiredEventIds.has(eventId);
      })
      .map(notification => notification.id),
  );
  for (const id of duplicatePendingIds) cancelIds.add(id);
  const occupiedIds = new Set(
    pending
      .filter(notification => !cancelIds.has(notification.id))
      .map(notification => notification.id),
  );
  const next: PlannedNativeNotification[] = [];

  for (const schedule of desired) {
    const existing = pendingByEventId.get(schedule.eventId);
    if (existing && nativeNotificationMatches(existing, schedule)) continue;
    if (existing) {
      cancelIds.add(existing.id);
      occupiedIds.delete(existing.id);
    }

    const id = availableNativeNotificationId(schedule.eventId, occupiedIds);
    occupiedIds.add(id);
    next.push({ ...schedule, id });
  }

  return {
    cancelIds: [...cancelIds].sort((left, right) => left - right),
    schedule: next,
  };
}

function nativeNotificationMatches(
  notification: PendingNativeNotification,
  schedule: NativeDeadlineSchedule,
): boolean {
  const extra = notificationExtra(notification);
  return notification.title === schedule.pageTitle &&
    notification.body === schedule.taskText &&
    String(extra['eventId'] ?? '') === schedule.eventId &&
    String(extra['deadlineAt'] ?? '') === schedule.deadlineAt &&
    String(extra['pageId'] ?? '') === schedule.pageId &&
    String(extra['taskId'] ?? '') === schedule.taskId &&
    String(extra['shareToken'] ?? '') === (schedule.shareToken ?? '');
}

function availableNativeNotificationId(eventId: string, occupiedIds: Set<number>): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < eventId.length; index += 1) {
    hash = Math.imul(hash ^ eventId.charCodeAt(index), 16_777_619) >>> 0;
  }
  let id = NATIVE_DEADLINE_ID_MIN + (hash % NATIVE_DEADLINE_ID_RANGE);
  while (occupiedIds.has(id)) {
    id = id === NATIVE_DEADLINE_ID_MIN + NATIVE_DEADLINE_ID_RANGE - 1
      ? NATIVE_DEADLINE_ID_MIN
      : id + 1;
  }
  return id;
}

function notificationExtra(notification: PendingNativeNotification): Record<string, unknown> {
  return typeof notification.extra === 'object' &&
    notification.extra !== null &&
    !Array.isArray(notification.extra)
    ? notification.extra as Record<string, unknown>
    : {};
}
