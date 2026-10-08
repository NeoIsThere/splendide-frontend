import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { firstValueFrom, from } from 'rxjs';
import { syncBatches } from '../src/app/utils/sync-batches.ts';

// Exercise the actual service with HTTP/storage boundaries replaced. Transpile
// decorators because the Node test runner only strips TypeScript syntax.
const compiled = ts.transpileModule(readFileSync(new URL('../src/app/services/sync.service.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText;
type Item = {
  id: string; content: { id: string; text: string; done: boolean; subtasks: Array<{ id: string; text: string; done: boolean }> };
  serverRevision: number; dirty?: boolean; created?: boolean; deleted?: boolean; lastModifiedAt: string;
};
type Payload = { items: Item[]; order?: { baseOrderRevision: number; orderedIds: string[] } };
type Snapshot = { items: Item[]; itemsOrderRevision: number };
function items(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index), serverRevision: 1, dirty: true, lastModifiedAt: new Date().toISOString(),
    content: { id: String(index), text: '\u6f22'.repeat(120), done: false,
      subtasks: Array.from({ length: 10 }, (_, subtask) => ({ id: `${index}:${subtask}`, text: '\u6f22'.repeat(120), done: false })) },
  }));
}
function harness(localItems: Item[], respond: (payload: Payload, index: number) => Promise<Snapshot>, anonymous = false) {
  const sent: Array<{ url: string; payload: Payload }> = [];
  const merges: Array<{ snapshot: Snapshot; revision: number }> = [];
  const HttpClient = Symbol('HTTP');
  const StorageService = Symbol('storage');
  const storage = {
    getItemsRevision: () => 7, getLocalMutationRevision: () => 9, getSyncGeneration: () => 0,
    getItemsForList: () => localItems, getActiveUserId: () => anonymous ? null : 'user',
    getSection: () => ({ shareToken: 'shared-token' }), acceptServerSyncGeneration: () => undefined,
    getListOrderSync: () => ({ baseOrderRevision: 3, orderedIds: localItems.map(item => item.id) }),
    applySyncedItems: (_section: string, _list: string, snapshot: Snapshot, revision: number) => merges.push({ snapshot, revision }),
  };
  const http = { post: (url: string, payload: Payload) => {
    sent.push({ url, payload });
    return from(respond(payload, sent.length - 1).then(body => ({ body, headers: { get: () => null } })));
  } };
  const exports: { SyncService?: new () => {
    syncListItems(section: string, list: string): Promise<unknown>; reserveListItemsSync(section: string, list: string): void;
  } } = {};
  const modules: Record<string, unknown> = {
    '@angular/core': { Injectable: () => (target: unknown) => target, inject: (key: symbol) => key === HttpClient ? http : storage },
    '@angular/common/http': { HttpClient }, './storage.service': { StorageService },
    'rxjs': { firstValueFrom }, '../../environments/environment': { environment: { apiUrl: '/api' } },
    '../utils/sync-batches': { syncBatches },
  };
  runInNewContext(compiled, { exports, require: (id: string) => {
    assert.ok(id in modules, `Unexpected dependency: ${id}`);
    return modules[id];
  } });
  assert.ok(exports.SyncService);
  return { service: new exports.SyncService(), sent, merges };
}

for (const anonymous of [false, true]) {
  test(`${anonymous ? 'shared link' : 'account'} uploads all pending batches before applying a snapshot`, async () => {
    const localItems = items(200);
    const remote: Item[] = [];
    const context = harness(localItems, async payload => {
      assert.equal(context.merges.length, 0, 'intermediate responses must not replace pending local edits');
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024 * 1024);
      remote.push(...payload.items);
      return { items: [...remote], itemsOrderRevision: 3 };
    }, anonymous);
    await context.service.syncListItems('page', 'list');
    assert.ok(context.sent.length > 1);
    assert.deepEqual(remote.map(item => item.id), localItems.map(item => item.id));
    assert.equal(context.merges.length, 1);
    assert.equal(context.merges[0].snapshot.items.length, localItems.length);
    assert.equal(context.merges[0].revision, 7, 'storage must retain its in-flight local-edit guard');
    assert.ok(context.sent.slice(0, -1).every(request => !request.payload.order));
    assert.ok(context.sent.at(-1)!.payload.order);
    assert.equal(context.sent[0].url.includes('/share/shared-token/'), anonymous);
  });
}

test('an interrupted batch retains pending edits and a later attempt resends them', async () => {
  const localItems = items(200);
  let fail = true;
  const context = harness(localItems, async (payload, index) => {
    if (fail && index === 1) throw new Error('offline');
    return { items: payload.items, itemsOrderRevision: 3 };
  });
  await assert.rejects(context.service.syncListItems('page', 'list'), /offline/);
  assert.equal(context.merges.length, 0);
  assert.ok(localItems.every(item => item.dirty));
  fail = false;
  const retryStart = context.sent.length;
  await context.service.syncListItems('page', 'list');
  const retriedIds = context.sent.slice(retryStart).flatMap(request => Array.from(request.payload.items, item => item.id));
  assert.deepEqual(retriedIds, localItems.map(item => item.id));
});

test('a newer sync or task move cancels unsent batches and discards the old response', async () => {
  const context = harness(items(200), async payload => {
    context.service.reserveListItemsSync('page', 'list');
    return { items: payload.items, itemsOrderRevision: 3 };
  });
  await context.service.syncListItems('page', 'list');
  assert.equal(context.sent.length, 1);
  assert.equal(context.merges.length, 0);
});

test('clean tasks and acknowledged tombstones are omitted, while pending changes are uploaded', async () => {
  const localItems = items(6);
  localItems[0].dirty = false;
  localItems[1].deleted = true;
  localItems[1].dirty = false;
  localItems[2].deleted = true;
  localItems[3].created = true;
  localItems[3].deleted = true;
  localItems[4].serverRevision = 0;
  const context = harness(localItems, async payload => ({ items: payload.items, itemsOrderRevision: 3 }));
  await context.service.syncListItems('page', 'list');
  assert.deepEqual(Array.from(context.sent[0].payload.items, item => item.id), ['2', '4', '5']);
  assert.equal(context.sent[0].payload.items[1].created, true);
});
