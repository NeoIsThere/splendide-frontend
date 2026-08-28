'use strict';

const DEADLINE_EVENT_CACHE = 'splendide-deadline-events-v1';
const DEADLINE_EVENT_TIMESTAMP_HEADER = 'X-Splendide-Delivered-At';
const DEADLINE_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEADLINE_EVENT_MAX_ENTRIES = 200;
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
  return new Request(new URL(`/__splendide_deadline_event__/${encodeURIComponent(eventId)}`, self.location.origin));
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
  const markers = await Promise.all((await cache.keys()).map(async request => {
    const response = await cache.match(request);
    return {
      request,
      deliveredAt: Number(response?.headers.get(DEADLINE_EVENT_TIMESTAMP_HEADER)),
    };
  }));
  const retained = markers
    .filter(marker => Number.isFinite(marker.deliveredAt) && now - marker.deliveredAt < DEADLINE_EVENT_MAX_AGE_MS)
    .sort((left, right) => right.deliveredAt - left.deliveredAt)
    .slice(0, DEADLINE_EVENT_MAX_ENTRIES);
  const retainedUrls = new Set(retained.map(marker => marker.request.url));
  await Promise.all(markers
    .filter(marker => !retainedUrls.has(marker.request.url))
    .map(marker => cache.delete(marker.request)));
}

async function markDeadlineDeliveredInCache(cache, eventId, deliveredAt = Date.now()) {
  if (!eventId) return;
  await cache.put(deadlineEventRequest(eventId), new Response('', {
    headers: { [DEADLINE_EVENT_TIMESTAMP_HEADER]: String(deliveredAt) },
  }));
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

function showDeadlineOnce({ eventId, title, body, tag, renotify, deadlineAt, data }) {
  return queueDeadlineEventOperation(async () => {
    const cache = await caches.open(DEADLINE_EVENT_CACHE);
    const now = Date.now();
    if (await deadlineWasDelivered(cache, eventId, now)) return false;
    await self.registration.showNotification(title, {
      body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
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
  });
}

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? asRecord(event.data.json()) : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const data = notificationData(payload);
  const presentation = asRecord(payload.notification);
  const eventId = String(data.eventId || `${data.taskId || 'task'}:${data.deadlineAt || 'deadline'}`);
  const title = String(presentation.title || payload.title || data.title || 'Task deadline');
  const body = String(presentation.body || payload.body || data.body || data.taskText || 'A task needs your attention');

  event.waitUntil(showDeadlineOnce({
    eventId,
    title,
    body,
    tag: presentation.tag,
    renotify: presentation.renotify,
    deadlineAt: data.deadlineAt,
    data,
  }));
});

self.addEventListener('message', event => {
  const data = asRecord(event.data);
  if (data.type === 'splendide-deadline-delivered') {
    event.waitUntil(markDeadlineDelivered(String(data.eventId || '')));
    return;
  }
  if (data.type !== 'splendide-show-offline-deadline') return;
  const schedule = asRecord(data.schedule);
  const responsePort = event.ports && event.ports[0];
  event.waitUntil(showDeadlineOnce({
    eventId: String(schedule.eventId || ''),
    title: String(schedule.pageTitle || 'Task deadline'),
    body: String(schedule.taskText || 'A task needs your attention'),
    tag: String(schedule.eventId || ''),
    renotify: false,
    deadlineAt: schedule.deadlineAt,
    data: schedule,
  }).then(shown => {
    if (responsePort) responsePort.postMessage({ ok: true, shown });
  }).catch(() => {
    if (responsePort) responsePort.postMessage({ ok: false, shown: false });
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = asRecord(event.notification.data);
  const url = notificationUrl(data);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(candidate => new URL(candidate.url).origin === self.location.origin);
    if (client) {
      client.postMessage({ type: 'splendide-notification-opened', data });
      if ('navigate' in client) await client.navigate(url);
      await client.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});
