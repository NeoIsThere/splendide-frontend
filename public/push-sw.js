'use strict';

const DEADLINE_EVENT_CACHE = 'splendide-deadline-events-v1';
const DEADLINE_EVENT_TIMESTAMP_HEADER = 'X-Splendide-Delivered-At';
const DEADLINE_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEADLINE_EVENT_MAX_ENTRIES = 200;
const ANONYMOUS_INSTALLATION_CACHE = 'splendide-anonymous-installation-v1';
const ANONYMOUS_INSTALLATION_HEADER = 'X-Splendide-Anonymous-Installation-Id';
const ANONYMOUS_SNAPSHOT_REVISION_HEADER = 'X-Splendide-Anonymous-Snapshot-Revision';
const ACCOUNT_NOTIFICATION_USER_HEADER = 'X-Splendide-Account-Notification-User';
const ANONYMOUS_MAX_ACTIVE_EVENTS = 60;
let deadlineEventOperation = Promise.resolve();

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function notificationData(payload) {
  const presentation = asRecord(payload.notification);
  const nested = asRecord(payload.data);
  const presentationData = asRecord(presentation.data);
  return { ...payload, ...presentation, ...nested, ...presentationData };
}

function notificationUrl(data) {
  const pageId = String(data.pageId || data.sectionId || '');
  const taskId = String(data.taskId || data.itemId || '');
  const shareToken = String(data.shareToken || '');
  const path = shareToken ? `/share/${encodeURIComponent(shareToken)}` : '/';
  const url = new URL(path, self.location.origin);
  if (pageId) url.searchParams.set('pageId', pageId);
  if (taskId) url.searchParams.set('taskId', taskId);
  if (shareToken) url.searchParams.set('shareToken', shareToken);
  url.searchParams.set('notification', 'deadline');
  return url.href;
}

function deadlineEventRequest(eventId) {
  return new Request(
    new URL(`/__splendide_deadline_event__/${encodeURIComponent(eventId)}`, self.location.origin),
  );
}

function anonymousInstallationRequest() {
  return new Request(new URL('/__splendide_anonymous_installation__', self.location.origin));
}

function accountNotificationUserRequest() {
  return new Request(new URL('/__splendide_account_notification_user__', self.location.origin));
}

function normalizedAccountNotificationUserId(value) {
  const userId = String(value || '');
  return /^[A-Za-z0-9_-]{1,100}$/.test(userId) ? userId : '';
}

function normalizedAnonymousInstallationId(value) {
  const installationId = String(value || '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    installationId,
  )
    ? installationId
    : '';
}

function normalizedAnonymousSnapshotRevision(value) {
  const snapshotRevision = String(value || '');
  if (!/^[1-9][0-9]{0,15}$/.test(snapshotRevision)) return '';
  return Number.isSafeInteger(Number(snapshotRevision)) ? snapshotRevision : '';
}

function normalizedDeadlineEventId(value) {
  const eventId = String(value || '');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(eventId) ? eventId : '';
}

async function activeAnonymousInstallation() {
  const cache = await caches.open(ANONYMOUS_INSTALLATION_CACHE);
  const marker = await cache.match(anonymousInstallationRequest());
  if (!marker) return null;
  const installationId = normalizedAnonymousInstallationId(
    marker.headers.get(ANONYMOUS_INSTALLATION_HEADER),
  );
  const snapshotRevision = normalizedAnonymousSnapshotRevision(
    marker.headers.get(ANONYMOUS_SNAPSHOT_REVISION_HEADER),
  );
  const rawEventIds = await marker.clone().json().catch(() => []);
  if (!Array.isArray(rawEventIds) || rawEventIds.length > ANONYMOUS_MAX_ACTIVE_EVENTS) return null;
  const eventIds = rawEventIds.map(normalizedDeadlineEventId);
  if (eventIds.some(eventId => !eventId) || new Set(eventIds).size !== eventIds.length) return null;
  return installationId && snapshotRevision
    ? { installationId, snapshotRevision, eventIds: new Set(eventIds) }
    : null;
}

async function setActiveAnonymousInstallation(
  installationIdValue,
  snapshotRevisionValue,
  activeEventIdsValue,
) {
  const cache = await caches.open(ANONYMOUS_INSTALLATION_CACHE);
  const request = anonymousInstallationRequest();
  const suppliedInstallationId = String(installationIdValue || '');
  if (!suppliedInstallationId) {
    await cache.delete(request);
    return;
  }
  const installationId = normalizedAnonymousInstallationId(installationIdValue);
  if (!installationId) throw new Error('Invalid anonymous notification installation id.');
  const snapshotRevision = normalizedAnonymousSnapshotRevision(snapshotRevisionValue);
  if (!snapshotRevision) throw new Error('Invalid anonymous notification snapshot revision.');
  if (!Array.isArray(activeEventIdsValue) || activeEventIdsValue.length > ANONYMOUS_MAX_ACTIVE_EVENTS) {
    throw new Error('Invalid anonymous notification event snapshot.');
  }
  const activeEventIds = activeEventIdsValue.map(normalizedDeadlineEventId);
  if (
    activeEventIds.some(eventId => !eventId) ||
    new Set(activeEventIds).size !== activeEventIds.length
  ) {
    throw new Error('Invalid anonymous notification event snapshot.');
  }
  await cache.put(
    request,
    new Response(JSON.stringify(activeEventIds), {
      headers: {
        'Content-Type': 'application/json',
        [ANONYMOUS_INSTALLATION_HEADER]: installationId,
        [ANONYMOUS_SNAPSHOT_REVISION_HEADER]: snapshotRevision,
      },
    }),
  );
}

async function anonymousDeadlineIsActive(
  installationIdValue,
  snapshotRevisionValue,
  eventIdValue,
) {
  const installationId = normalizedAnonymousInstallationId(installationIdValue);
  const snapshotRevision = normalizedAnonymousSnapshotRevision(snapshotRevisionValue);
  const eventId = normalizedDeadlineEventId(eventIdValue);
  if (!installationId || !snapshotRevision || !eventId) return false;
  const active = await activeAnonymousInstallation();
  return active?.installationId === installationId &&
    Number(snapshotRevision) <= Number(active.snapshotRevision) &&
    active.eventIds.has(eventId);
}

async function activeAccountNotificationUserId() {
  const cache = await caches.open(ANONYMOUS_INSTALLATION_CACHE);
  const marker = await cache.match(accountNotificationUserRequest());
  return normalizedAccountNotificationUserId(
    marker?.headers.get(ACCOUNT_NOTIFICATION_USER_HEADER),
  );
}

async function setActiveAccountNotificationUser(userIdValue) {
  const cache = await caches.open(ANONYMOUS_INSTALLATION_CACHE);
  const request = accountNotificationUserRequest();
  const suppliedUserId = String(userIdValue || '');
  if (!suppliedUserId) {
    await cache.delete(request);
    return;
  }
  const userId = normalizedAccountNotificationUserId(userIdValue);
  if (!userId) throw new Error('Invalid account notification user id.');
  await cache.put(
    request,
    new Response('', { headers: { [ACCOUNT_NOTIFICATION_USER_HEADER]: userId } }),
  );
}

async function accountNotificationUserMatches(userIdValue) {
  const userId = normalizedAccountNotificationUserId(userIdValue);
  return Boolean(userId) && (await activeAccountNotificationUserId()) === userId;
}

async function deadlineWasDelivered(cache, eventId, now = Date.now()) {
  if (!eventId) return false;
  const request = deadlineEventRequest(eventId);
  const marker = await cache.match(request);
  if (!marker) return false;

  const deliveredAt = Number(marker.headers.get(DEADLINE_EVENT_TIMESTAMP_HEADER));
  if (!Number.isFinite(deliveredAt) || now - deliveredAt >= DEADLINE_EVENT_MAX_AGE_MS) {
    await cache.delete(request);
    return false;
  }
  return true;
}

async function pruneDeadlineEvents(cache, now) {
  const markers = await Promise.all(
    (await cache.keys()).map(async (request) => {
      const response = await cache.match(request);
      return {
        request,
        deliveredAt: Number(response?.headers.get(DEADLINE_EVENT_TIMESTAMP_HEADER)),
      };
    }),
  );
  const retained = markers
    .filter(
      (marker) =>
        Number.isFinite(marker.deliveredAt) && now - marker.deliveredAt < DEADLINE_EVENT_MAX_AGE_MS,
    )
    .sort((left, right) => right.deliveredAt - left.deliveredAt)
    .slice(0, DEADLINE_EVENT_MAX_ENTRIES);
  const retainedUrls = new Set(retained.map((marker) => marker.request.url));
  await Promise.all(
    markers
      .filter((marker) => !retainedUrls.has(marker.request.url))
      .map((marker) => cache.delete(marker.request)),
  );
}

async function markDeadlineDeliveredInCache(cache, eventId, deliveredAt = Date.now()) {
  if (!eventId) return;
  await cache.put(
    deadlineEventRequest(eventId),
    new Response('', {
      headers: { [DEADLINE_EVENT_TIMESTAMP_HEADER]: String(deliveredAt) },
    }),
  );
  await pruneDeadlineEvents(cache, deliveredAt);
}

function queueDeadlineEventOperation(operation) {
  const queued = deadlineEventOperation.catch(() => undefined).then(operation);
  deadlineEventOperation = queued.catch(() => undefined);
  return queued;
}

function markDeadlineDelivered(eventId) {
  if (!eventId) return Promise.resolve();
  return queueDeadlineEventOperation(async () => {
    const cache = await caches.open(DEADLINE_EVENT_CACHE);
    await markDeadlineDeliveredInCache(cache, eventId);
  });
}

async function showDeadlineOnceInCurrentOperation({
  eventId,
  title,
  body,
  tag,
  renotify,
  deadlineAt,
  data,
}) {
  const cache = await caches.open(DEADLINE_EVENT_CACHE);
  const now = Date.now();
  if (await deadlineWasDelivered(cache, eventId, now)) return false;
  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/notification-badge-96.png',
    tag: String(tag || eventId),
    renotify: renotify === true,
    silent: false,
    timestamp: Number.isFinite(Date.parse(String(deadlineAt || '')))
      ? Date.parse(String(deadlineAt))
      : now,
    data: {
      eventId,
      pageId: String(data.pageId || data.sectionId || ''),
      taskId: String(data.taskId || data.itemId || ''),
      shareToken: String(data.shareToken || ''),
    },
  });
  await markDeadlineDeliveredInCache(cache, eventId, now);
  return true;
}

function showDeadlineOnce(deadline) {
  return queueDeadlineEventOperation(() => showDeadlineOnceInCurrentOperation(deadline));
}

function showAnonymousDeadlineOnce(deadline, installationId, snapshotRevision) {
  return queueDeadlineEventOperation(async () => {
    if (!(await anonymousDeadlineIsActive(
      installationId,
      snapshotRevision,
      deadline.eventId,
    ))) return false;
    return showDeadlineOnceInCurrentOperation(deadline);
  });
}

function showAccountDeadlineOnce(deadline, userId) {
  return queueDeadlineEventOperation(async () => {
    if (!(await accountNotificationUserMatches(userId))) return false;
    return showDeadlineOnceInCurrentOperation(deadline);
  });
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? asRecord(event.data.json()) : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const data = notificationData(payload);
  const presentation = asRecord(payload.notification);
  const eventId = String(
    data.eventId || `${data.taskId || 'task'}:${data.deadlineAt || 'deadline'}`,
  );
  const title = String(presentation.title || payload.title || data.title || 'Task deadline');
  const body = String(
    presentation.body ||
      payload.body ||
      data.body ||
      data.taskText ||
      'A task needs your attention',
  );

  const deadline = {
    eventId,
    title,
    body,
    tag: presentation.tag,
    renotify: presentation.renotify,
    deadlineAt: data.deadlineAt,
    data,
  };
  const anonymousInstallationId = String(data.anonymousInstallationId || '');
  const anonymousSnapshotRevision = String(data.anonymousSnapshotRevision || '');
  const accountNotificationUserId = String(data.accountNotificationUserId || '');
  const anonymous =
    data.notificationScope === 'anonymous' ||
    Boolean(anonymousInstallationId) ||
    Boolean(anonymousSnapshotRevision);
  event.waitUntil(
    anonymous
      ? showAnonymousDeadlineOnce(deadline, anonymousInstallationId, anonymousSnapshotRevision)
      : showAccountDeadlineOnce(deadline, accountNotificationUserId),
  );
});

self.addEventListener('message', (event) => {
  const data = asRecord(event.data);
  if (data.type === 'splendide-set-anonymous-installation') {
    const responsePort = event.ports && event.ports[0];
    const installationId = String(data.installationId || '');
    const snapshotRevision = String(data.snapshotRevision || '');
    const activeEventIds = data.activeEventIds;
    event.waitUntil(
      queueDeadlineEventOperation(() =>
        setActiveAnonymousInstallation(installationId, snapshotRevision, activeEventIds),
      )
        .then(() => {
          if (responsePort) responsePort.postMessage({ ok: true });
        })
        .catch(() => {
          if (responsePort) responsePort.postMessage({ ok: false });
        }),
    );
    return;
  }
  if (data.type === 'splendide-set-account-notification-user') {
    const responsePort = event.ports && event.ports[0];
    const userId = String(data.userId || '');
    event.waitUntil(
      queueDeadlineEventOperation(() => setActiveAccountNotificationUser(userId))
        .then(() => {
          if (responsePort) responsePort.postMessage({ ok: true });
        })
        .catch(() => {
          if (responsePort) responsePort.postMessage({ ok: false });
        }),
    );
    return;
  }
  if (data.type === 'splendide-deadline-delivered') {
    event.waitUntil(markDeadlineDelivered(String(data.eventId || '')));
    return;
  }
  if (data.type !== 'splendide-show-offline-deadline') return;
  const schedule = asRecord(data.schedule);
  const responsePort = event.ports && event.ports[0];
  const deadline = {
    eventId: String(schedule.eventId || ''),
    title: String(schedule.pageTitle || 'Task deadline'),
    body: String(schedule.taskText || 'A task needs your attention'),
    tag: String(schedule.eventId || ''),
    renotify: false,
    deadlineAt: schedule.deadlineAt,
    data: schedule,
  };
  const scope = String(data.notificationScope || '');
  const display =
    scope === 'anonymous'
      ? showAnonymousDeadlineOnce(
          deadline,
          data.anonymousInstallationId,
          data.anonymousSnapshotRevision,
        )
      : scope === 'account'
        ? showAccountDeadlineOnce(deadline, data.accountNotificationUserId)
        : Promise.resolve(false);
  event.waitUntil(
    display
      .then((shown) => {
        if (responsePort) responsePort.postMessage({ ok: true, shown });
      })
      .catch(() => {
        if (responsePort) responsePort.postMessage({ ok: false, shown: false });
      }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = asRecord(event.notification.data);
  const url = notificationUrl(data);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find(
        (candidate) => new URL(candidate.url).origin === self.location.origin,
      );
      if (client) {
        client.postMessage({ type: 'splendide-notification-opened', data });
        if ('navigate' in client) await client.navigate(url);
        await client.focus();
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
