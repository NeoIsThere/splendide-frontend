import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../public/push-sw.js', import.meta.url), 'utf8');
const installationId = '11111111-1111-4111-8111-111111111111';
const otherInstallationId = '22222222-2222-4222-8222-222222222222';
const accountUserId = 'user_current_123';

interface NotificationDisplay {
  title: string;
  options: Record<string, unknown>;
}

interface StartedMessage {
  completion: Promise<Record<string, unknown>>;
}

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createWorkerHarness(
  onShowNotification: (display: NotificationDisplay) => Promise<void> = async () => undefined,
) {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const cacheByName = new Map<string, MemoryCache>();
  const displays: NotificationDisplay[] = [];
  const worker = {
    location: { origin: 'https://splendide.test' },
    registration: {
      async showNotification(title: string, options: Record<string, unknown>): Promise<void> {
        const display = { title, options };
        displays.push(display);
        await onShowNotification(display);
      },
    },
    clients: {
      async matchAll(): Promise<unknown[]> {
        return [];
      },
      async openWindow(): Promise<void> {
        return undefined;
      },
    },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
  };
  const cacheStorage = {
    async open(name: string): Promise<MemoryCache> {
      let cache = cacheByName.get(name);
      if (!cache) {
        cache = new MemoryCache();
        cacheByName.set(name, cache);
      }
      return cache;
    },
  };

  vm.runInNewContext(
    workerSource,
    {
      self: worker,
      caches: cacheStorage,
      Request,
      Response,
      URL,
      Date,
      Promise,
      setTimeout,
      clearTimeout,
      encodeURIComponent,
    },
    { filename: 'push-sw.js' },
  );

  function listener(type: string): (event: Record<string, unknown>) => void {
    const registered = listeners.get(type) ?? [];
    assert.equal(registered.length, 1, `expected one ${type} listener`);
    return registered[0];
  }

  function dispatchPush(payload: Record<string, unknown>): Promise<void> {
    const pending: Promise<unknown>[] = [];
    listener('push')({
      data: { json: () => payload },
      waitUntil: (operation: Promise<unknown>) => pending.push(Promise.resolve(operation)),
    });
    assert.equal(pending.length, 1);
    return Promise.all(pending).then(() => undefined);
  }

  function startMessage(data: Record<string, unknown>): StartedMessage {
    const pending: Promise<unknown>[] = [];
    let response: Record<string, unknown> | undefined;
    listener('message')({
      data,
      ports: [
        {
          postMessage(value: Record<string, unknown>): void {
            response = value;
          },
        },
      ],
      waitUntil: (operation: Promise<unknown>) => pending.push(Promise.resolve(operation)),
    });
    assert.equal(pending.length, 1);
    return {
      completion: Promise.all(pending).then(() => {
        assert.ok(response, 'expected the worker to acknowledge the message');
        return response;
      }),
    };
  }

  return { dispatchPush, startMessage, displays };
}

function markerMessage(
  id: string | null,
  revision: string | null = null,
  activeEventIds: string[] = [],
): Record<string, unknown> {
  return {
    type: 'splendide-set-anonymous-installation',
    installationId: id,
    snapshotRevision: revision,
    activeEventIds,
  };
}

function accountMarkerMessage(userId: string | null): Record<string, unknown> {
  return {
    type: 'splendide-set-account-notification-user',
    userId,
  };
}

function anonymousPush(eventId: string, id: string, revision: string): Record<string, unknown> {
  return {
    notificationScope: 'anonymous',
    anonymousInstallationId: id,
    anonymousSnapshotRevision: revision,
    eventId,
    taskId: 'task-1',
    pageId: 'page-1',
    deadlineAt: '2030-08-29T10:00:00.000Z',
    notification: {
      title: 'Inbox',
      body: 'Finish the task',
    },
  };
}

function accountPush(eventId: string, userId: string): Record<string, unknown> {
  return {
    notificationScope: 'account',
    accountNotificationUserId: userId,
    eventId,
    taskId: 'task-1',
    pageId: 'page-1',
    deadlineAt: '2030-08-29T10:00:00.000Z',
    notification: {
      title: 'Inbox',
      body: 'Finish the task',
    },
  };
}

function fallbackMessage(
  eventId: string,
  scope?: 'anonymous' | 'account',
  id = installationId,
  revision = '42',
): Record<string, unknown> {
  return {
    type: 'splendide-show-offline-deadline',
    ...(scope ? { notificationScope: scope } : {}),
    anonymousInstallationId: id,
    anonymousSnapshotRevision: revision,
    accountNotificationUserId: accountUserId,
    schedule: {
      eventId,
      taskId: 'task-1',
      pageId: 'page-1',
      pageTitle: 'Inbox',
      taskText: 'Finish the task',
      deadlineAt: '2030-08-29T10:00:00.000Z',
    },
  };
}

test('a clear acknowledgement is a hard cutoff for concurrently queued anonymous pushes', async () => {
  const showStarted = deferred();
  const allowShowToFinish = deferred();
  const harness = createWorkerHarness(async () => {
    showStarted.resolve();
    await allowShowToFinish.promise;
  });
  assert.equal(
    (await harness.startMessage(markerMessage(
      installationId,
      '42',
      ['event-before-clear', 'event-after-clear'],
    )).completion).ok,
    true,
  );

  const alreadyQueuedPush = harness.dispatchPush(
    anonymousPush('event-before-clear', installationId, '42'),
  );
  await showStarted.promise;
  const clear = harness.startMessage(markerMessage(null));
  const stalePushQueuedAfterClear = harness.dispatchPush(
    anonymousPush('event-after-clear', installationId, '42'),
  );
  let clearAcknowledged = false;
  void clear.completion.then(() => {
    clearAcknowledged = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    clearAcknowledged,
    false,
    'clear must not acknowledge while an earlier display is pending',
  );

  allowShowToFinish.resolve();
  await alreadyQueuedPush;
  assert.equal((await clear.completion).ok, true);
  await stalePushQueuedAfterClear;
  assert.equal(harness.displays.length, 1, 'a push ordered after the clear must remain suppressed');

  await harness.dispatchPush(anonymousPush('event-after-ack', installationId, '42'));
  assert.equal(
    harness.displays.length,
    1,
    'a push delivered after the clear acknowledgement must remain suppressed',
  );
});

test('anonymous pushes require the active installation and event snapshot', async () => {
  const harness = createWorkerHarness();
  assert.equal(
    (await harness.startMessage(markerMessage(
      installationId,
      '42',
      ['exact-snapshot', 'delayed-unchanged'],
    )).completion).ok,
    true,
  );

  await harness.dispatchPush(anonymousPush('wrong-id', otherInstallationId, '42'));
  await harness.dispatchPush(anonymousPush('exact-snapshot', installationId, '43'));
  await harness.dispatchPush(anonymousPush('cancelled-event', installationId, '41'));
  assert.equal(harness.displays.length, 0);

  await harness.dispatchPush(anonymousPush('exact-snapshot', installationId, '42'));
  await harness.dispatchPush(anonymousPush('delayed-unchanged', installationId, '41'));
  assert.equal(harness.displays.length, 2);
});

test('anonymous foreground fallback is active-event gated and rejects legacy unscoped messages', async () => {
  const harness = createWorkerHarness();
  assert.equal(
    (await harness.startMessage(markerMessage(installationId, '42', ['fallback-exact'])).completion).ok,
    true,
  );

  const wrongRevision = await harness.startMessage(
    fallbackMessage('fallback-exact', 'anonymous', installationId, '43'),
  ).completion;
  const unscoped = await harness.startMessage(fallbackMessage('fallback-unscoped')).completion;
  const exact = await harness.startMessage(
    fallbackMessage('fallback-exact', 'anonymous', installationId, '42'),
  ).completion;

  assert.equal(wrongRevision.ok, true);
  assert.equal(wrongRevision.shown, false);
  assert.equal(unscoped.ok, true);
  assert.equal(unscoped.shown, false);
  assert.equal(exact.ok, true);
  assert.equal(exact.shown, true);
  assert.equal(harness.displays.length, 1);
});

test('invalid marker updates are rejected without clearing the active anonymous snapshot', async () => {
  const harness = createWorkerHarness();
  assert.equal(
    (await harness.startMessage(markerMessage(installationId, '42', ['still-active'])).completion).ok,
    true,
  );
  assert.equal(
    (await harness.startMessage(markerMessage(
      'not-an-installation-id',
      '43',
      ['still-active'],
    )).completion).ok,
    false,
  );
  assert.equal(
    (await harness.startMessage(markerMessage(
      installationId,
      'not-a-revision',
      ['still-active'],
    )).completion).ok,
    false,
  );

  await harness.dispatchPush(anonymousPush('still-active', installationId, '42'));
  assert.equal(harness.displays.length, 1);
});

test('account pushes and foreground fallback require the current signed-in account marker', async () => {
  const harness = createWorkerHarness();
  await harness.dispatchPush(accountPush('missing-marker', accountUserId));
  assert.equal(harness.displays.length, 0);

  assert.equal(
    (await harness.startMessage(accountMarkerMessage(accountUserId)).completion).ok,
    true,
  );
  await harness.dispatchPush(accountPush('wrong-user', 'user_previous_456'));
  await harness.dispatchPush(accountPush('current-user', accountUserId));
  const fallback = await harness.startMessage(
    fallbackMessage('account-fallback', 'account'),
  ).completion;

  assert.equal(fallback.ok, true);
  assert.equal(fallback.shown, true);
  assert.equal(harness.displays.length, 2);
});

test('clearing the account marker is a hard cutoff for queued account pushes', async () => {
  const showStarted = deferred();
  const allowShowToFinish = deferred();
  const harness = createWorkerHarness(async () => {
    showStarted.resolve();
    await allowShowToFinish.promise;
  });
  assert.equal(
    (await harness.startMessage(accountMarkerMessage(accountUserId)).completion).ok,
    true,
  );

  const alreadyQueuedPush = harness.dispatchPush(accountPush('account-before-clear', accountUserId));
  await showStarted.promise;
  const clear = harness.startMessage(accountMarkerMessage(null));
  const stalePush = harness.dispatchPush(accountPush('account-after-clear', accountUserId));
  allowShowToFinish.resolve();
  await alreadyQueuedPush;
  assert.equal((await clear.completion).ok, true);
  await stalePush;
  assert.equal(harness.displays.length, 1);

  await harness.dispatchPush(accountPush('account-after-ack', accountUserId));
  assert.equal(harness.displays.length, 1);
});
