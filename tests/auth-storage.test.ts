import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { signal, computed } from '@angular/core';
import { firstValueFrom, of, throwError } from 'rxjs';
import { planSingleListMigration } from '../src/app/utils/single-list-migration.ts';
import type { StorageService, Partition } from '../src/app/services/storage.service.ts';
import type { AuthService } from '../src/app/services/auth.service.ts';

const anonymousKey = 'splendide_v3_anonymous';
const accountKey = 'splendide_v3_nominal_account';
const timestamp = '2026-10-11T10:00:00.000Z';
function fixture(text = 'Laptop task'): Partition {
  return { syncGeneration: 0, sectionOrderRevision: 0, sectionBaseOrderRevision: 0, sections: [{
    id: 'page', title: 'my page', position: 0, metadataLastModifiedAt: timestamp, serverRevision: 0,
    lists: [{ id: 'list', title: 'tasks', metadataLastModifiedAt: timestamp, serverRevision: 0,
      itemsOrderRevision: 0, itemsBaseOrderRevision: 0, items: [{
        id: 'task', content: { id: 'task', text, done: true, doneAt: timestamp,
          subtasks: [{ id: 'child', text: 'Keep this child', done: false }] },
        deadlineAt: '2026-12-01T10:00:00.000Z', deadlineTimeZone: 'Europe/Paris', deadlineNotificationEnabled: false,
        position: 0, lastModifiedAt: timestamp, serverRevision: 0,
      }] }],
  }] };
}
const user = { id: 'account', email: 'account@example.invalid', name: null, isPremium: false,
  accountType: 'user', premiumOverride: null, hasPassword: true, syncGeneration: 0,
  darkMode: false, backgroundTheme: 'neutral', sharedNotificationsEnabled: false,
  hasStripeSubscription: false, hasMobileSubscription: false };

function harness(platform = 'web') {
  const values = new Map<string, string>([[anonymousKey, JSON.stringify(fixture())]]);
  const localStorage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const dependencies = new Map<unknown, unknown>();
  const core = { Injectable: () => (target: unknown) => target, signal, computed,
    inject: (key: unknown) => { assert.ok(dependencies.has(key)); return dependencies.get(key); } };
  const modules: Record<string, unknown> = {
    '@angular/core': core, '../utils/single-list-migration': { planSingleListMigration },
  };
  const secure = new Map<string, string>();
  function load<T>(name: string): T {
    const exports = {};
    const compiled = ts.transpileModule(readFileSync(new URL(`../src/app/services/${name}.service.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText;
    runInNewContext(compiled, { exports, localStorage, crypto: { randomUUID },
      window: { addEventListener: () => undefined, splendideDesktop: {
        isDesktop: platform === 'electron', startGoogleOAuth: async () => ({ code: 'code' }),
      } },
      require: (id: string) => { assert.ok(id in modules, `Unexpected dependency: ${id}`); return modules[id]; },
    });
    return exports as T;
  }
  const storageType = load<{ StorageService: new () => StorageService }>('storage').StorageService;
  const storage = new storageType();
  const HttpClient = Symbol('http');
  const Router = Symbol('router');
  const ThemeService = Symbol('theme');
  const PosthogService = Symbol('analytics');
  const calls: { url: string; body: unknown }[] = [];
  let response: unknown = { accessToken: 'token', refreshToken: 'native-refresh', user, isFirstSignIn: true };
  let failure = false;
  dependencies.set(storageType, storage);
  dependencies.set(HttpClient, {
    post: (url: string, body: unknown) => { calls.push({ url, body }); return failure ? throwError(() => new Error('offline')) : of(response); },
    get: () => of(user), delete: () => of({}),
  });
  dependencies.set(Router, { navigate: () => undefined });
  dependencies.set(ThemeService, { pendingPreferenceForUser: () => null, setDark: () => undefined, setBackgroundTheme: () => undefined });
  dependencies.set(PosthogService, { identifyUser: () => undefined, reset: () => undefined });
  Object.assign(modules, {
    '@angular/common/http': { HttpClient, HttpErrorResponse: Error }, '@angular/router': { Router },
    './storage.service': { StorageService: storageType }, './theme.service': { ThemeService, isBackgroundThemeId: () => true },
    './posthog.service': { PosthogService }, 'rxjs': { firstValueFrom },
    '../../environments/environment': { environment: { apiUrl: '/api', isMobile: ['android', 'ios'].includes(platform) } },
    '@capacitor/core': { Capacitor: { getPlatform: () => platform } },
    '@aparajita/capacitor-secure-storage': { SecureStorage: {
      get: async (key: string) => secure.get(key), set: async (key: string, value: string) => secure.set(key, value),
      remove: async (key: string) => secure.delete(key),
    } },
    '@capgo/capacitor-social-login': { SocialLogin: { initialize: async () => undefined,
      login: async () => ({ result: { idToken: 'identity', responseType: 'online', profile: {} } }),
    } },
  });
  const Auth = load<{ AuthService: new () => AuthService }>('auth').AuthService;
  return { auth: new Auth(), storage, values, calls, secure,
    respond: (next: unknown) => { response = next; }, fail: (next: boolean) => { failure = next; } };
}

for (const platform of ['web', 'electron', 'android', 'ios']) {
  test(`${platform}: verification leaves the browser anonymous; first login copies and later login never imports`, async () => {
    const ctx = harness(platform);
    await ctx.auth.waitForSessionReady();
    const original = ctx.values.get(anonymousKey);
    ctx.respond({ message: 'EMAIL_VERIFIED' });
    await ctx.auth.verifyEmail('phone-verification');
    assert.equal(ctx.auth.isLoggedIn(), false);
    assert.equal(ctx.values.has(accountKey), false);
    assert.equal(ctx.values.get(anonymousKey), original);

    ctx.fail(true);
    await assert.rejects(ctx.auth.login(user.email, 'password'), /offline/);
    assert.equal(ctx.values.has(accountKey), false);
    ctx.fail(false);
    ctx.respond({ accessToken: 'token', user, isFirstSignIn: true, isNewUser: false });
    await ctx.auth.login(user.email, 'password');
    assert.equal(ctx.storage.getActiveUserId(), user.id);
    const imported = ctx.storage.loadSections()[0];
    const importedTask = imported.lists[0].items[0];
    assert.notEqual(imported.id, 'page');
    assert.notEqual(importedTask.id, 'task');
    assert.equal(importedTask.created, true);
    assert.equal(importedTask.dirty, true);
    assert.equal(importedTask.lastModifiedAt, timestamp);
    assert.equal(importedTask.deadlineAt, '2026-12-01T10:00:00.000Z');
    const content = importedTask.content as { text: string; done: boolean; doneAt: string; subtasks: unknown[] };
    assert.equal(content.text, 'Laptop task');
    assert.equal(content.done, true);
    assert.equal(content.doneAt, timestamp);
    assert.equal(content.subtasks.length, 1);
    assert.equal(ctx.values.get(anonymousKey), original, 'copy must not consume or modify anonymous storage');
    const nominal = ctx.values.get(accountKey);
    ctx.auth.logout();
    assert.equal(ctx.storage.getActiveUserId(), undefined);
    assert.equal((ctx.storage.loadSections()[0].lists[0].items[0].content as { text: string }).text, 'Laptop task');

    ctx.values.set(anonymousKey, JSON.stringify(fixture('New anonymous task')));
    const changedAnonymous = ctx.values.get(anonymousKey);
    ctx.respond({ accessToken: 'later-token', user, isFirstSignIn: false, isNewUser: true });
    await ctx.auth.login(user.email, 'password');
    assert.equal(ctx.values.get(accountKey), nominal, 'the first-sign-in flag takes precedence over account creation');
    assert.equal(ctx.values.get(anonymousKey), changedAnonymous);
    ctx.auth.logout();
    assert.equal((ctx.storage.loadSections()[0].lists[0].items[0].content as { text: string }).text, 'New anonymous task');
  });
}

test('only the device performing the first sign-in contributes its anonymous tasks', async () => {
  const laptop = harness();
  const phone = harness('android');
  await phone.auth.waitForSessionReady();
  phone.values.set(anonymousKey, JSON.stringify(fixture('Phone task')));
  phone.respond({ message: 'EMAIL_VERIFIED' });
  await phone.auth.verifyEmail('token');
  await laptop.auth.login(user.email, 'password');
  phone.respond({ accessToken: 'token', user, isFirstSignIn: false });
  await phone.auth.login(user.email, 'password');
  assert.equal(phone.values.has(accountKey), false, 'ordinary login waits for cloud data instead of copying phone tasks');
  assert.match(laptop.values.get(accountKey)!, /Laptop task/);
  assert.doesNotMatch(laptop.values.get(accountKey)!, /Phone task/);
  assert.match(phone.values.get(anonymousKey)!, /Phone task/);
});

test('a first sign-in on an empty phone does not import laptop tasks during a later sign-in', async () => {
  const laptop = harness();
  const phone = harness('ios');
  await phone.auth.waitForSessionReady();
  phone.values.delete(anonymousKey);
  await phone.auth.login(user.email, 'password');
  assert.equal(phone.storage.loadSections().length, 0);
  laptop.respond({ accessToken: 'token', user, isFirstSignIn: false });
  await laptop.auth.login(user.email, 'password');
  assert.equal(laptop.storage.loadSections().length, 0);
  laptop.auth.logout();
  assert.equal((laptop.storage.loadSections()[0].lists[0].items[0].content as { text: string }).text, 'Laptop task');
});

test('first sign-in preserves shared-page identity and omits deleted pages and tasks', async () => {
  const ctx = harness();
  const source = fixture();
  const privatePage = source.sections[0];
  privatePage.lists[0].items.push({ ...privatePage.lists[0].items[0], id: 'deleted-task', deleted: true });
  source.sections.push({ ...privatePage, id: 'shared-page', position: 1, ownerId: 'another-user', sharedAccess: true,
    isShared: true, shareToken: 'shared-link', lists: [] });
  source.sections.push({ ...privatePage, id: 'deleted-page', position: 2, deleted: true });
  ctx.values.set(anonymousKey, JSON.stringify(source));
  const original = ctx.values.get(anonymousKey);
  await ctx.auth.login(user.email, 'password');
  const pages = ctx.storage.loadSections();
  assert.equal(pages.length, 2);
  assert.equal(pages[0].lists[0].items.length, 1);
  assert.equal(pages[1].id, 'shared-page');
  assert.equal(pages[1].ownerId, 'another-user');
  assert.equal(pages[1].shareToken, 'shared-link');
  assert.equal(ctx.values.get(anonymousKey), original);
  ctx.auth.expireSession();
  assert.equal(ctx.storage.getActiveUserId(), undefined);
  assert.equal(ctx.values.get(anonymousKey), original);
});

for (const provider of ['google', 'electron', 'android', 'ios']) {
  test(`${provider}: social first sign-in uses the same import rule`, async () => {
    const ctx = harness(provider === 'google' ? 'web' : provider);
    await ctx.auth.waitForSessionReady();
    if (provider === 'google') await ctx.auth.googleAuth('identity');
    else if (provider === 'ios') await ctx.auth.appleMobileAuth();
    else await ctx.auth.googleDesktopAuth();
    assert.ok(ctx.values.has(accountKey));
    assert.equal(ctx.storage.getActiveUserId(), user.id);
  });
}
