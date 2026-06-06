import { afterNextRender, ChangeDetectionStrategy, Component, computed, Injector, inject, signal, viewChild, ElementRef, OnDestroy, HostListener } from '@angular/core';
import { CdkDragDrop, CdkDrag, CdkDragMove, CdkDropList, CdkDragPlaceholder, CdkDragPreview, moveItemInArray } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { driver } from 'driver.js';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { StorageService, StoredSection, StoredList, StoredItem } from '../../services/storage.service';
import { SyncService } from '../../services/sync.service';
import { PublicSyncService } from '../../services/public-sync.service';
import { openExternalUrl } from '../../utils/external-link';

interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

interface Task {
  id: string;
  text: string;
  subtasks: Subtask[];
  done: boolean;
  doneAt?: string;
  lastModifiedAt?: string;
  serverRevision?: number;
}

interface DoneTask extends Task {
  sourceList: TaskListKind;
  doneAt: string;
}

interface TextSegment {
  text: string;
  href: string | null;
}

type TaskListKind = 'main' | 'secondary';
type KeyboardZone = 'tabs' | TaskListKind;
type SectionDeleteOption = 'delete' | 'cancel';
type InfoDialogKind = 'shared-page' | 'private-welcome';

const DEFAULT_BACKLOG_TITLE = 'later';
const DEFAULT_MAIN_TITLE = 'now';
const MAX_SECTIONS = 15;
const MAX_BACKLOG_TASKS = 200;
const MAX_MAIN_TASKS = MAX_BACKLOG_TASKS;
const MAX_DONE_TASKS = 10;
const PUBLIC_PERIODIC_SYNC_MS = 5_000; //5_000
const PRIVATE_PERIODIC_SYNC_MS = 15_000; //15_000
const PREMIUM_UPGRADE_PROMPT_DELAY_MS = 60_000; // 1 minute
const PREMIUM_UPGRADE_PROMPT_LAST_SHOWN_KEY = 'splendide_premium_upgrade_prompt_last_shown_day';
const PRIVATE_WELCOME_DIALOG_PENDING_KEY = 'splendide_private_welcome_dialog_pending';

let premiumUpgradePromptShownThisAppLoad = false;

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDrag, CdkDropList, CdkDragPlaceholder, CdkDragPreview, CdkScrollable, RouterLink],
})
export class HomeComponent implements OnDestroy {
  private readonly urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  private readonly injector = inject(Injector);
  protected readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly storage = inject(StorageService);
  private readonly sync = inject(SyncService);
  private readonly publicSync = inject(PublicSyncService);

  protected readonly dark = this.theme.dark;
  protected readonly publicPageId = signal<string | null>(null);
  protected readonly publicLoadFailed = signal(false);
  protected readonly shareMenuOpen = signal(false);
  protected readonly shareToastVisible = signal(false);
  protected readonly premiumUpgradePromptOpen = signal(false);
  protected readonly infoDialog = signal<InfoDialogKind | null>(null);
  protected readonly isPublicPage = computed(() => this.publicPageId() !== null);

  // ─── Sections ───────────────────────────────────────────
  protected readonly sections = signal<StoredSection[]>([]);
  protected readonly activeSectionId = signal<string | null>(null);
  protected readonly activeSection = computed(() => this.sections().find(s => s.id === this.activeSectionId()) ?? null);
  protected readonly canAddSection = computed(() => this.sections().length < MAX_SECTIONS);

  // ─── Section editing ────────────────────────────────────
  protected readonly editingSectionId = signal<string | null>(null);
  protected readonly addingSectionTitle = signal<string | null>(null);
  protected readonly confirmingDeleteSectionId = signal<string | null>(null);
  protected readonly sectionMenuOpen = signal(false);

  // ─── Active section lists ───────────────────────────────
  protected readonly mainList = computed(() => {
    const sec = this.activeSection();
    return sec?.lists.find(l => !l.isBacklog) ?? null;
  });
  protected readonly backlogList = computed(() => {
    const sec = this.activeSection();
    return sec?.lists.find(l => l.isBacklog) ?? null;
  });

  // ─── Tasks from active lists ────────────────────────────
  protected readonly tasks = computed<Task[]>(() => this.visibleTasks(this.mainList()));
  protected readonly secondaryTasks = computed<Task[]>(() => this.visibleTasks(this.backlogList()));
  protected readonly doneTasks = computed<DoneTask[]>(() => {
    const tasks = this.doneTasksForList('main', this.mainList());
    if (!this.isPublicPage()) {
      tasks.push(...this.doneTasksForList('secondary', this.backlogList()));
    }
    return tasks
      .sort((left, right) => this.compareDoneTasksNewestFirst(left, right))
      .slice(0, MAX_DONE_TASKS);
  });
  protected readonly doneTaskCount = computed(() => this.doneTasks().length);
  protected readonly mainTitle = computed(() => this.mainList()?.title || DEFAULT_MAIN_TITLE);
  protected readonly secondaryTitle = computed(() => this.backlogList()?.title || DEFAULT_BACKLOG_TITLE);

  // ─── Main tasks state ──────────────────────────────────
  protected readonly adding = signal(false);
  protected readonly newTaskText = signal('');
  protected readonly newSubtasks = signal<string[]>([]);
  protected readonly editingTaskId = signal<string | null>(null);
  protected readonly editingSubtask = signal<{ taskId: string; subtaskId: string } | null>(null);
  protected readonly addingSubtaskToId = signal<string | null>(null);
  protected readonly newInlineSubtaskText = signal('');
  protected readonly editingMainTitle = signal(false);

  protected readonly taskCount = computed(() => this.tasks().length);
  protected readonly completedCount = computed(() => this.tasks().filter(t => t.done).length);
  protected readonly canAdd = computed(() => this.taskCount() < MAX_MAIN_TASKS);
  protected readonly allDone = computed(() => {
    const t = this.tasks();
    return t.length > 0 && t.every(task => task.done && task.subtasks.every(s => s.done));
  });

  // ─── Secondary tasks state ─────────────────────────────
  protected readonly addingSecondary = signal(false);
  protected readonly newSecondaryText = signal('');
  protected readonly newSecondarySubtasks = signal<string[]>([]);
  protected readonly editingSecondaryId = signal<string | null>(null);
  protected readonly editingSecSubtask = signal<{ taskId: string; subtaskId: string } | null>(null);
  protected readonly addingSecSubtaskToId = signal<string | null>(null);
  protected readonly newInlineSecSubtaskText = signal('');
  protected readonly editingSecondaryTitle = signal(false);
  protected readonly secondaryVisible = signal(true);

  // ─── Task dot menus (mobile) ────────────────────────────
  protected readonly taskMenuOpenId = signal<string | null>(null);
  protected readonly secTaskMenuOpenId = signal<string | null>(null);

  // ─── User menu ──────────────────────────────────────────
  protected readonly menuOpen = signal(false);

  protected readonly keyboardZone = signal<KeyboardZone | null>(null);
  protected readonly currentList = signal<TaskListKind>('main');
  protected readonly activeKeyboardTask = signal<{ list: TaskListKind; id: string } | null>(null);
  protected readonly sectionDeleteConfirmFocus = signal<SectionDeleteOption>('delete');

  // ─── Global editing guard ──────────────────────────────
  protected readonly isEditing = computed(() =>
    this.adding() ||
    this.addingSecondary() ||
    this.editingTaskId() !== null ||
    this.editingSecondaryId() !== null ||
    this.editingSubtask() !== null ||
    this.editingSecSubtask() !== null ||
    this.addingSubtaskToId() !== null ||
    this.addingSecSubtaskToId() !== null ||
    this.editingMainTitle() ||
    this.editingSecondaryTitle() ||
    this.editingSectionId() !== null ||
    this.addingSectionTitle() !== null
  );

  protected readonly secondaryCount = computed(() => this.secondaryTasks().length);
  protected readonly secondaryCompletedCount = computed(() => this.secondaryTasks().filter(t => t.done).length);
  protected readonly canAddSecondary = computed(() => this.secondaryCount() < MAX_BACKLOG_TASKS);
  protected readonly mainDropListConnections = computed<string[]>(() => this.isPublicPage() ? [] : ['secondaryDropList']);
  protected readonly secondaryDropListConnections = computed<string[]>(() => ['mainDropList']);

  protected readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth <= 768);
  protected readonly dragging = signal(false);
  protected readonly dragDelay = computed(() => ({ touch: 0, mouse: 0 }));
  protected readonly dragAutoScrollDisabled = false;
  protected readonly dragAutoScrollStep = 24;
  protected readonly activeSectionIndex = computed(() => this.sections().findIndex(s => s.id === this.activeSectionId()));
  protected readonly showPrevArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() > 0);
  protected readonly showNextArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() < this.sections().length - 1);

  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private shareToastTimer: ReturnType<typeof setTimeout> | null = null;
  private premiumUpgradePromptTimer: ReturnType<typeof setTimeout> | null = null;
  private firstVisitCoachMarksPending = false;
  private coachMarksScheduled = false;
  private horizontalScrollGuardFrame: number | null = null;
  private horizontalScrollLocks: Array<{
    target: Window | HTMLElement;
    scrollBy: typeof window.scrollBy;
    scrollTo: typeof window.scrollTo;
    scroll: typeof window.scroll;
  }> = [];

  constructor() {
    void this.initFromStorage();
  }

  @HostListener('document:keydown', ['$event'])
  protected handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (this.infoDialog()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeInfoDialog();
        return;
      }
      if (event.key === 'Tab' || this.isInteractiveTarget(event.target)) return;
      event.preventDefault();
      return;
    }
    if (this.premiumUpgradePromptOpen()) {
      if (event.key === 'Tab' || this.isInteractiveTarget(event.target)) return;
      event.preventDefault();
      return;
    }
    if (this.isTextEntryTarget(event.target)) {
      if (event.key === 'Tab') {
        event.preventDefault();
        if (!event.shiftKey) this.startSubtaskFromActiveTaskEdit(event);
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (!event.shiftKey && !this.isEditing()) this.addSubtaskForActiveTask();
      return;
    }
    if (this.isInteractiveTarget(event.target)) {
      const arrowKey = event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      if (!arrowKey || !this.isKeyboardManagedTarget(event.target)) return;
      this.syncKeyboardFocusFromManagedTarget(event.target);
    }
    if (this.isEditing()) return;
    if (this.handleSectionDeleteConfirmationKeydown(event)) return;

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        this.moveKeyboardVertically(-1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.moveKeyboardVertically(1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.moveKeyboardHorizontally(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.moveKeyboardHorizontally(1);
        break;
      case 'Enter':
        event.preventDefault();
        this.openFocusedTaskOrCreate();
        break;
      case 'Delete':
        if (this.deleteActiveTabOrTask()) {
          event.preventDefault();
        }
        break;
    }
  }

  @HostListener('document:click', ['$event'])
  protected handleDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    if (this.confirmingClear() && !target.closest('[data-confirm-clear]')) {
      this.cancelClear();
    }
    if (this.confirmingSecondaryClear() && !target.closest('[data-confirm-secondary-clear]')) {
      this.cancelSecondaryClear();
    }
    if (this.confirmingDeleteSectionId() !== null && !target.closest('[data-confirm-delete-section]')) {
      this.cancelDeleteSection();
    }
    if (this.taskMenuOpenId() !== null && !target.closest('[data-task-menu]')) {
      this.taskMenuOpenId.set(null);
    }
    if (this.secTaskMenuOpenId() !== null && !target.closest('[data-sec-task-menu]')) {
      this.secTaskMenuOpenId.set(null);
    }
    if (this.shareMenuOpen() && !target.closest('[data-public-share]')) {
      this.shareMenuOpen.set(false);
    }
  }

  @HostListener('window:resize')
  protected handleWindowResize(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const mobile = width <= 768;
    if (mobile === this.isMobile()) return;
    this.isMobile.set(mobile);
    if (mobile) {
      this.stopHorizontalScrollGuard();
      this.unlockHorizontalDragScroll();
    }
  }

  ngOnDestroy(): void {
    this.stopPeriodicSync();
    if (this.shareToastTimer !== null) {
      clearTimeout(this.shareToastTimer);
      this.shareToastTimer = null;
    }
    if (this.premiumUpgradePromptTimer !== null) {
      clearTimeout(this.premiumUpgradePromptTimer);
      this.premiumUpgradePromptTimer = null;
    }
    this.stopHorizontalScrollGuard();
    this.unlockHorizontalDragScroll();
  }

  private async initFromStorage(): Promise<void> {
    const publicId = this.route.snapshot.paramMap.get('id');
    if (publicId) {
      await this.initPublicPage(publicId);
      return;
    }

    if (this.auth.isLoggedIn()) {
      await this.auth.fetchUser();
    }

    const userId = this.auth.user()?.id;
    let shouldShowCoachMarks = false;
    if (userId) {
      this.storage.setActivePartition(userId);
    } else {
      this.storage.setActivePartition();
      shouldShowCoachMarks = this.storage.isPartitionEmpty();
    }

    const loaded = this.storage.loadSections();
    this.sections.set(loaded);
    if (loaded.length > 0) {
      this.activeSectionId.set(loaded[0].id);
    }

    // Sync if premium
    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      await this.doFullSync();
    } else {
      this.ensureLocalDefaultListsForSections();
      this.startPeriodicSync();
    }

    this.schedulePremiumUpgradePrompt();
    this.firstVisitCoachMarksPending = shouldShowCoachMarks;
    this.showPendingPrivateWelcomeDialog();
    this.maybeScheduleFirstVisitCoachMarks();
  }

  private async initPublicPage(publicId: string): Promise<void> {
    this.publicPageId.set(publicId);
    this.publicLoadFailed.set(false);
    this.storage.setActivePublicPartition(publicId);

    try {
      const section = await this.publicSync.loadPublicPage(publicId);
      this.refreshSectionsFromStorage();
      this.activeSectionId.set(section.id);
      this.currentList.set('main');
      this.clearKeyboardFocus('main');
      this.startPeriodicSync();
    } catch {
      this.sections.set([]);
      this.activeSectionId.set(null);
      this.publicLoadFailed.set(true);
      this.clearKeyboardFocus('main');
    }
  }

  private async doFullSync(): Promise<void> {
    try {
      const synced = await this.sync.syncSections();
      this.sections.set(synced);
      await this.hydrateMissingSectionLists();
      const sections = this.sections();
      const first = sections[0];
      if (first) {
        this.activeSectionId.set(first.id);
      }
      for (const section of sections) {
        await this.doSyncSection(section.id);
      }
    } catch { /* silently fail */ }
    this.startPeriodicSync();
  }

  private startPeriodicSync(): void {
    this.stopPeriodicSync();
    const intervalMs = this.isPublicPage() ? PUBLIC_PERIODIC_SYNC_MS : PRIVATE_PERIODIC_SYNC_MS;
    this.syncIntervalId = setInterval(async () => {
      if (this.shouldSkipPeriodicSync()) return;
      if (this.isPublicPage()) {
        await this.doPublicPeriodicSync();
        return;
      }
      if (this.auth.isLoggedIn()) {
        await this.auth.fetchUser();
      }
      this.schedulePremiumUpgradePrompt();
      if (this.shouldSkipPeriodicSync()) return;
      if (this.auth.isLoggedIn() && this.auth.isPremium()) {
        await this.doPeriodicSync();
      }
    }, intervalMs);
  }

  private stopPeriodicSync(): void {
    if (this.syncIntervalId === null) return;
    clearInterval(this.syncIntervalId);
    this.syncIntervalId = null;
  }

  private async doPeriodicSync(): Promise<void> {
    if (this.shouldSkipPeriodicSync()) return;
    try {
      const synced = await this.sync.syncSections();
      if (this.shouldSkipPeriodicSync()) return;
      this.sections.set(synced);
      await this.hydrateMissingSectionLists();
      if (this.shouldSkipPeriodicSync()) return;
      const refreshed = this.sections();
      const activeId = this.activeSectionId();
      const syncedActiveId = activeId && refreshed.some(section => section.id === activeId)
        ? activeId
        : refreshed[0]?.id ?? null;
      if (syncedActiveId !== activeId) {
        this.activeSectionId.set(syncedActiveId);
      }
      if (syncedActiveId) {
        await this.doSyncSection(syncedActiveId);
      }
    } catch { /* silently fail */ }
  }

  private async doPublicPeriodicSync(): Promise<void> {
    const publicId = this.publicPageId();
    if (!publicId || this.publicLoadFailed() || this.shouldSkipPeriodicSync()) return;

    try {
      const lists = (await this.publicSync.syncPublicLists(publicId)).filter(list => !list.isBacklog);
      if (this.shouldSkipPeriodicSync()) return;
      for (const list of lists) {
        await this.publicSync.syncPublicListItems(publicId, list.id);
        if (this.shouldSkipPeriodicSync()) return;
      }
      const overflowListIds = this.enforceDoneTaskLimit(publicId);
      for (const listId of overflowListIds) {
        await this.publicSync.syncPublicListItems(publicId, listId);
      }
      this.refreshSectionsFromStorage();
    } catch { /* silently fail */ }
  }

  private shouldSkipPeriodicSync(): boolean {
    return this.isEditing() || this.dragging();
  }

  private schedulePremiumUpgradePrompt(): void {
    if (
      premiumUpgradePromptShownThisAppLoad ||
      this.wasPremiumUpgradePromptShownToday() ||
      !this.shouldOfferPremiumUpgrade()
    ) return;
    if (this.premiumUpgradePromptTimer !== null) return;

    this.premiumUpgradePromptTimer = setTimeout(() => {
      this.premiumUpgradePromptTimer = null;
      if (
        premiumUpgradePromptShownThisAppLoad ||
        this.wasPremiumUpgradePromptShownToday() ||
        !this.shouldOfferPremiumUpgrade()
      ) return;

      premiumUpgradePromptShownThisAppLoad = true;
      this.markPremiumUpgradePromptShownToday();
      this.premiumUpgradePromptOpen.set(true);
    }, PREMIUM_UPGRADE_PROMPT_DELAY_MS);
  }

  private shouldOfferPremiumUpgrade(): boolean {
    return this.isMainPage() && (!this.auth.isLoggedIn() || !this.auth.isPremium());
  }

  private isMainPage(): boolean {
    const path = this.router.url.split('?')[0]?.split('#')[0] ?? '/';
    return path === '/';
  }

  private wasPremiumUpgradePromptShownToday(): boolean {
    try {
      return localStorage.getItem(PREMIUM_UPGRADE_PROMPT_LAST_SHOWN_KEY) === this.localDayKey();
    } catch {
      return false;
    }
  }

  private markPremiumUpgradePromptShownToday(): void {
    try {
      localStorage.setItem(PREMIUM_UPGRADE_PROMPT_LAST_SHOWN_KEY, this.localDayKey());
    } catch {
      // Ignore storage errors; the in-memory guard still prevents repeats in this app load.
    }
  }

  private localDayKey(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  private markPrivateWelcomeDialogPending(): void {
    try {
      sessionStorage.setItem(PRIVATE_WELCOME_DIALOG_PENDING_KEY, '1');
    } catch {
      // Ignore storage errors; navigation should still work.
    }
    try {
      localStorage.setItem(PRIVATE_WELCOME_DIALOG_PENDING_KEY, '1');
    } catch {
      // Ignore storage errors; navigation should still work.
    }
  }

  private showPendingPrivateWelcomeDialog(): void {
    let hasPendingDialog = false;
    try {
      hasPendingDialog = sessionStorage.getItem(PRIVATE_WELCOME_DIALOG_PENDING_KEY) === '1';
      sessionStorage.removeItem(PRIVATE_WELCOME_DIALOG_PENDING_KEY);
    } catch {
      // If session storage is unavailable, fall back to local storage.
    }
    try {
      hasPendingDialog = localStorage.getItem(PRIVATE_WELCOME_DIALOG_PENDING_KEY) === '1' || hasPendingDialog;
      localStorage.removeItem(PRIVATE_WELCOME_DIALOG_PENDING_KEY);
    } catch {
      // If local storage is unavailable, rely on the session storage result.
    }
    if (hasPendingDialog) {
      this.infoDialog.set('private-welcome');
    }
  }

  private async doSyncSection(sectionId: string): Promise<void> {
    try {
      const lists = await this.sync.syncSectionLists(sectionId);
      for (const list of this.prioritizeMovedIntoLists(sectionId, lists)) {
        await this.sync.syncListItems(sectionId, list.id);
      }
      const overflowListIds = this.enforceDoneTaskLimit(sectionId);
      for (const listId of overflowListIds) {
        await this.sync.syncListItems(sectionId, listId);
      }
      this.refreshSectionsFromStorage();
    } catch { /* silently fail */ }
  }

  private async hydrateMissingSectionLists(sectionIds?: string[]): Promise<void> {
    if (this.isPublicPage() || !this.auth.isLoggedIn() || !this.auth.isPremium()) return;

    const ids = sectionIds ?? this.sections().map(section => section.id);
    for (const sectionId of ids) {
      const section = this.sections().find(existing => existing.id === sectionId);
      if (!section || this.sectionHasDefaultLists(section)) continue;

      try {
        await this.sync.syncSectionLists(sectionId);
        this.refreshSectionsFromStorage();
      } catch {
        // Keep the local section unchanged if we could not verify the backend state.
      }
    }
  }

  private sectionHasDefaultLists(section: StoredSection | null): boolean {
    return !!section &&
      section.lists.some(list => !list.isBacklog) &&
      section.lists.some(list => list.isBacklog);
  }

  private sectionHasList(section: StoredSection | null, list: TaskListKind): boolean {
    return !!section?.lists.some(existing => list === 'main' ? !existing.isBacklog : existing.isBacklog);
  }

  private ensureLocalDefaultLists(sectionId: string): void {
    if (this.storage.ensureSectionHasDefaultLists(sectionId)) {
      this.refreshSectionsFromStorage();
    }
  }

  private ensureLocalDefaultListsForSections(): void {
    let changed = false;
    for (const section of this.sections()) {
      if (!this.sectionHasDefaultLists(section)) {
        changed = this.storage.ensureSectionHasDefaultLists(section.id) || changed;
      }
    }
    if (changed) this.refreshSectionsFromStorage();
  }

  private prioritizeMovedIntoLists(sectionId: string, lists: StoredList[]): StoredList[] {
    return [...lists].sort((left, right) =>
      Number(this.hasMovedIntoItem(sectionId, right.id)) - Number(this.hasMovedIntoItem(sectionId, left.id)),
    );
  }

  private hasMovedIntoItem(sectionId: string, listId: string): boolean {
    return this.storage.getItemsForList(sectionId, listId).some(item =>
      item.created === true &&
      item.deleted !== true &&
      item.serverRevision > 0,
    );
  }

  private refreshSectionsFromStorage(): void {
    this.sections.set(this.storage.loadSections());
  }

  private maybeScheduleFirstVisitCoachMarks(): void {
    if (
      !this.firstVisitCoachMarksPending ||
      this.coachMarksScheduled ||
      this.infoDialog() !== null ||
      this.isPublicPage()
    ) return;

    this.firstVisitCoachMarksPending = false;
    this.scheduleCoachMarks();
  }

  private scheduleCoachMarks(): void {
    if (this.coachMarksScheduled) return;
    this.coachMarksScheduled = true;
    afterNextRender(() => {
      window.setTimeout(() => {
        this.coachMarksScheduled = false;
        if (this.infoDialog() !== null) {
          this.firstVisitCoachMarksPending = true;
          return;
        }
        this.startCoachMarks();
      }, 350);
    }, { injector: this.injector });
  }

  private startCoachMarks(): void {
    if (this.isPublicPage() || this.isEditing() || this.infoDialog() !== null || this.premiumUpgradePromptOpen()) return;

    const mainListTarget = document.querySelector<HTMLElement>('.my-primary-list-container');
    const secondaryListTarget = document.querySelector<HTMLElement>('.my-secondary-list-container');
    const createSectionTarget = Array.from(
      document.querySelectorAll<HTMLElement>('[data-coach-create-section]'),
    ).find(element => element.offsetParent !== null || element.getClientRects().length > 0);
    const moveTarget = document.querySelector<HTMLElement>('.main-drop-zone [data-keyboard-task]');
    if (!mainListTarget || !secondaryListTarget || !createSectionTarget || !moveTarget) return;

    driver({
      allowClose: false,
      animate: true,
      overlayOpacity: 0.28,
      stagePadding: 6,
      showButtons: ['next'],
      nextBtnText: 'next &rarr;',
      doneBtnText: 'done',
      steps: [
        {
          element: mainListTarget,
          popover: {
            title: 'Focus on what matters now',
            description: "Add tasks you're working on here",
            side: 'right',
            align: 'start',
          },
        },
        {
          element: secondaryListTarget,
          popover: {
            title: 'Keep the rest for later',
            description: "Store ideas here",
            side: 'right',
            align: 'start',
          },
        },
        {
          element: moveTarget,
          popover: {
            title: 'Drag tasks between lists',
            side: 'right',
            align: 'start',
          },
        },
        {
          element: createSectionTarget,
          popover: {
            title: 'Add a new page',
            description: "Use pages to organize work in different areas",
            side: 'bottom',
            align: 'start',
          },
        }
      ],
    }).drive();
  }

  protected setDragging(value: boolean): void {
    this.dragging.set(value);
    if (value) {
      if (!this.isMobile()) {
        this.resetHorizontalListScroll();
        this.lockHorizontalDragScroll();
        this.startHorizontalScrollGuard();
      }
    } else {
      this.stopHorizontalScrollGuard();
      this.unlockHorizontalDragScroll();
    }
  }

  protected isTabsFocused(): boolean {
    return this.keyboardZone() === 'tabs';
  }

  protected isSectionKeyboardFocused(sectionId: string): boolean {
    return this.isTabsFocused() && this.activeSectionId() === sectionId;
  }

  protected isTaskFocused(list: TaskListKind, id: string): boolean {
    const active = this.activeKeyboardTask();
    return active?.list === list && active.id === id;
  }

  protected isAddPlaceholderFocused(list: TaskListKind): boolean {
    return this.keyboardZone() === list && this.currentList() === list && this.activeKeyboardTask() === null;
  }

  protected clearTaskFocusOnMouseLeave(list: TaskListKind, id: string): void {
    const active = this.activeKeyboardTask();
    if (this.keyboardZone() === list && active?.list === list && active.id === id) {
      this.clearKeyboardFocus(list);
    }
  }

  protected isSectionDeleteOptionFocused(option: SectionDeleteOption): boolean {
    return this.keyboardZone() === 'tabs' &&
      this.confirmingDeleteSectionId() !== null &&
      this.sectionDeleteConfirmFocus() === option;
  }

  protected focusTabsForKeyboard(): void {
    this.keyboardZone.set('tabs');
    this.activeKeyboardTask.set(null);
    this.scrollActiveSectionIntoView();
  }

  private moveKeyboardVertically(direction: -1 | 1): void {
    if (this.keyboardZone() === null) {
      if (direction > 0) {
        this.focusListWithoutTask(this.currentList());
      } else {
        this.focusTabsForKeyboard();
      }
      return;
    }

    if (this.keyboardZone() === 'tabs') {
      if (direction > 0) {
        this.focusListWithoutTask(this.currentList());
      } else {
        this.scrollActiveSectionIntoView();
      }
      return;
    }

    const list = this.currentList();
    const items = this.tasksForList(list);
    const active = this.validActiveKeyboardTask();
    const activeIndex = active?.list === list
      ? items.findIndex(task => task.id === active.id)
      : -1;

    if (direction < 0) {
      if (!active || active.list !== list) {
        this.focusTabsForKeyboard();
        return;
      }
      if (activeIndex <= 0) {
        this.focusListWithoutTask(list);
        return;
      }
      this.setActiveKeyboardTask(list, items[activeIndex - 1].id);
      return;
    }

    if (!active || active.list !== list) {
      if (items.length > 0) {
        this.setActiveKeyboardTask(list, items[0].id);
      }
      return;
    }

    const nextIndex = Math.min(activeIndex + 1, items.length - 1);
    this.setActiveKeyboardTask(list, items[nextIndex].id);
  }

  private moveKeyboardHorizontally(direction: -1 | 1): void {
    if (this.keyboardZone() === 'tabs') {
      this.moveSectionKeyboardFocus(direction);
      return;
    }
    if (this.isPublicPage()) return;

    const sourceList = this.currentList();
    const targetList: TaskListKind = direction > 0 ? 'secondary' : 'main';
    if (sourceList === targetList) return;

    const sourceItems = this.tasksForList(sourceList);
    const targetItems = this.tasksForList(targetList);
    const active = this.validActiveKeyboardTask();
    if (!active || active.list !== sourceList) {
      this.focusListWithoutTask(targetList);
      return;
    }

    const activeIndex = active?.list === sourceList
      ? sourceItems.findIndex(task => task.id === active.id)
      : 0;
    const targetIndex = Math.min(Math.max(activeIndex, 0), targetItems.length - 1);

    if (targetItems.length === 0) {
      this.focusListWithoutTask(targetList);
      return;
    }

    this.setActiveKeyboardTask(targetList, targetItems[targetIndex].id);
  }

  private moveSectionKeyboardFocus(direction: -1 | 1): void {
    const sections = this.sections();
    if (sections.length === 0) return;

    const currentIndex = Math.max(this.activeSectionIndex(), 0);
    if (direction > 0 && currentIndex >= sections.length - 1) {
      if (this.canAddSection()) {
        this.focusTabsForKeyboard();
        this.startAddingSection();
      }
      return;
    }

    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), sections.length - 1);
    this.selectSection(sections[nextIndex].id);
    this.focusTabsForKeyboard();
  }

  private focusFirstTaskInCurrentList(): void {
    const list = this.currentList();
    const items = this.tasksForList(list);
    if (items.length === 0) {
      this.focusListWithoutTask(list);
      return;
    }

    this.setActiveKeyboardTask(list, items[0].id);
  }

  private setActiveKeyboardTask(list: TaskListKind, id: string): void {
    if (this.isPublicPage() && list === 'secondary') list = 'main';
    this.currentList.set(list);
    this.keyboardZone.set(list);
    this.activeKeyboardTask.set({ list, id });
    this.scrollKeyboardTaskIntoView(list, id);
  }

  private focusListWithoutTask(list: TaskListKind): void {
    if (this.isPublicPage() && list === 'secondary') list = 'main';
    this.currentList.set(list);
    this.keyboardZone.set(list);
    this.activeKeyboardTask.set(null);
  }

  private clearKeyboardFocus(list: TaskListKind = this.currentList()): void {
    this.currentList.set(list);
    this.keyboardZone.set(null);
    this.activeKeyboardTask.set(null);
  }

  private validActiveKeyboardTask(): { list: TaskListKind; id: string } | null {
    const active = this.activeKeyboardTask();
    if (!active) return null;
    if (this.tasksForList(active.list).some(task => task.id === active.id)) return active;

    this.activeKeyboardTask.set(null);
    return null;
  }

  private openFocusedTaskOrCreate(): void {
    const active = this.validActiveKeyboardTask();
    if (!active) {
      if (this.currentList() === 'secondary' && !this.isAddPlaceholderFocused('secondary')) return;
      this.startAddingInCurrentList();
      return;
    }

    if (active.list === 'main') {
      this.startEditingTask(active.id);
    } else {
      this.startEditingSecondary(active.id);
    }
  }

  private deleteActiveTabOrTask(): boolean {
    if (this.keyboardZone() === 'tabs') {
      const sectionId = this.activeSectionId();
      if (!sectionId || this.sections().length < 2) return false;
      this.startDeleteSection(sectionId);
      return true;
    }

    return this.deleteActiveKeyboardTask();
  }

  private handleSectionDeleteConfirmationKeydown(event: KeyboardEvent): boolean {
    const sectionId = this.confirmingDeleteSectionId();
    if (this.keyboardZone() !== 'tabs' || !sectionId) {
      return false;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.sectionDeleteConfirmFocus.set(event.key === 'ArrowLeft' ? 'delete' : 'cancel');
      return true;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.sectionDeleteConfirmFocus() === 'delete') {
        this.confirmDeleteSection();
      } else {
        this.cancelDeleteSection();
      }
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelDeleteSection();
      return true;
    }

    return false;
  }

  private startAddingInCurrentList(): void {
    if (this.currentList() === 'secondary') {
      void this.startAddingSecondary();
    } else {
      void this.startAdding();
    }
  }

  private addSubtaskForActiveTask(): boolean {
    const active = this.validActiveKeyboardTask();
    if (!active) return false;

    if (active.list === 'main') {
      this.startAddingSubtask(active.id);
    } else {
      this.startAddingSecSubtask(active.id);
    }
    return true;
  }

  private deleteActiveKeyboardTask(): boolean {
    const active = this.validActiveKeyboardTask();
    if (!active) return false;

    const items = this.tasksForList(active.list);
    const index = items.findIndex(task => task.id === active.id);
    const nextTask = items[index + 1] ?? items[index - 1] ?? null;

    if (active.list === 'main') {
      this.removeTask(active.id);
    } else {
      this.removeSecondaryTask(active.id);
    }

    if (nextTask) {
      this.setActiveKeyboardTask(active.list, nextTask.id);
    } else {
      this.focusListWithoutTask(active.list);
    }

    return true;
  }

  private tasksForList(list: TaskListKind): Task[] {
    return list === 'main' ? this.tasks() : this.secondaryTasks();
  }

  private scrollKeyboardTaskIntoView(list: TaskListKind, id: string): void {
    requestAnimationFrame(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-keyboard-task]')).filter(item =>
        item.dataset['keyboardList'] === list && item.dataset['keyboardTask'] === id
      );
      const el = items.find(item => item.offsetParent !== null) ?? items[0];
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  private scrollActiveSectionIntoView(): void {
    const sectionId = this.activeSectionId();
    if (!sectionId) return;

    requestAnimationFrame(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-keyboard-section]')).filter(item =>
        item.dataset['keyboardSection'] === sectionId
      );
      const el = items.find(item => item.offsetParent !== null) ?? items[0];
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  // ─── Section tab switching ─────────────────────────────

  protected selectSection(sectionId: string): void {
    if (this.isPublicPage()) return;
    if (this.activeSectionId() === sectionId) return;
    this.sectionMenuOpen.set(false);
    this.activeSectionId.set(sectionId);
    this.activeKeyboardTask.set(null);

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(async synced => {
        this.sections.set(synced);
        await this.hydrateMissingSectionLists([sectionId]);
        return this.doSyncSection(sectionId);
      }).catch(() => {});
    } else {
      this.ensureLocalDefaultLists(sectionId);
    }
  }

  protected goToPrevSection(): void {
    const idx = this.activeSectionIndex();
    if (idx > 0) this.selectSection(this.sections()[idx - 1].id);
  }

  protected goToNextSection(): void {
    const idx = this.activeSectionIndex();
    if (idx < this.sections().length - 1) this.selectSection(this.sections()[idx + 1].id);
  }

  protected dropSection(event: CdkDragDrop<StoredSection[]>): void {
    if (this.isPublicPage()) return;
    if (event.previousIndex === event.currentIndex) return;
    const items = [...this.sections()];
    moveItemInArray(items, event.previousIndex, event.currentIndex);
    items.forEach((s, i) => s.position = i);
    this.storage.saveSections(items, { markOrderDirty: true });
    this.sections.set(items);

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      const localOrderRevision = this.storage.getSectionOrderLocalRevision();
      this.sync.reorderSections(items.map(section => ({ id: section.id, position: section.position })))
        .then(result => {
          if (localOrderRevision !== this.storage.getSectionOrderLocalRevision()) return;
          this.storage.applySectionPositions(result.positions, result.orderRevision);
          this.refreshSectionsFromStorage();
        }).catch(() => {});
    }
  }

  protected dropSubtask(taskId: string, event: CdkDragDrop<Subtask[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.reorderSubtasksInList(this.mainList(), taskId, event.previousIndex, event.currentIndex);
  }

  protected dropSecSubtask(taskId: string, event: CdkDragDrop<Subtask[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.reorderSubtasksInList(this.backlogList(), taskId, event.previousIndex, event.currentIndex);
  }

  protected handleTaskDragMoved(_event: CdkDragMove<unknown>): void {
    if (this.isMobile() || typeof document === 'undefined') return;
    this.resetHorizontalListScroll();
  }

  private resetHorizontalListScroll(): void {
    if (this.isMobile()) return;
    if (typeof document === 'undefined') return;

    if (typeof window !== 'undefined' && window.scrollX !== 0) {
      window.scrollTo(0, window.scrollY);
    }

    if (document.documentElement.scrollLeft !== 0) document.documentElement.scrollLeft = 0;
    if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;

    for (const element of document.querySelectorAll<HTMLElement>(
      '.lists, .main-section, .secondary-section, .main-drop-zone, .sec-drop-zone, .task-list',
    )) {
      if (element.scrollLeft !== 0) element.scrollLeft = 0;
    }
  }

  private startHorizontalScrollGuard(): void {
    if (this.isMobile() || typeof window === 'undefined' || this.horizontalScrollGuardFrame !== null) return;

    const tick = () => {
      this.resetHorizontalListScroll();
      this.horizontalScrollGuardFrame = this.dragging()
        ? window.requestAnimationFrame(tick)
        : null;
    };
    this.horizontalScrollGuardFrame = window.requestAnimationFrame(tick);
  }

  private stopHorizontalScrollGuard(): void {
    if (typeof window === 'undefined') return;
    const hadGuard = this.horizontalScrollGuardFrame !== null;
    if (this.horizontalScrollGuardFrame !== null) {
      window.cancelAnimationFrame(this.horizontalScrollGuardFrame);
      this.horizontalScrollGuardFrame = null;
    }
    if (hadGuard || !this.isMobile()) this.resetHorizontalListScroll();
  }

  private lockHorizontalDragScroll(): void {
    if (
      this.isMobile() ||
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      this.horizontalScrollLocks.length > 0
    ) return;

    const targets: Array<Window | HTMLElement> = [
      window,
      ...document.querySelectorAll<HTMLElement>(
        '.lists, .main-section, .secondary-section, .main-drop-zone, .sec-drop-zone, .task-list',
      ),
    ];

    for (const target of targets) {
      const originalScrollBy = target.scrollBy.bind(target);
      const originalScrollTo = target.scrollTo.bind(target);
      const originalScroll = target.scroll.bind(target);
      const currentTop = () => target === window ? window.scrollY : (target as HTMLElement).scrollTop;
      const pinOptionsLeft = (options: ScrollToOptions): ScrollToOptions => ({ ...options, left: 0 });

      this.horizontalScrollLocks.push({
        target,
        scrollBy: originalScrollBy,
        scrollTo: originalScrollTo,
        scroll: originalScroll,
      });

      target.scrollBy = ((leftOrOptions?: number | ScrollToOptions, top?: number) => {
        if (typeof leftOrOptions === 'object') {
          originalScrollBy(pinOptionsLeft(leftOrOptions));
        } else {
          originalScrollBy(0, top ?? 0);
        }
      }) as typeof target.scrollBy;

      target.scrollTo = ((leftOrOptions?: number | ScrollToOptions, top?: number) => {
        if (typeof leftOrOptions === 'object') {
          originalScrollTo(pinOptionsLeft(leftOrOptions));
        } else {
          originalScrollTo(0, top ?? currentTop());
        }
      }) as typeof target.scrollTo;

      target.scroll = ((leftOrOptions?: number | ScrollToOptions, top?: number) => {
        if (typeof leftOrOptions === 'object') {
          originalScroll(pinOptionsLeft(leftOrOptions));
        } else {
          originalScroll(0, top ?? currentTop());
        }
      }) as typeof target.scroll;
    }
  }

  private unlockHorizontalDragScroll(): void {
    const hadLocks = this.horizontalScrollLocks.length > 0;
    for (const { target, scrollBy, scrollTo, scroll } of this.horizontalScrollLocks) {
      target.scrollBy = scrollBy as typeof target.scrollBy;
      target.scrollTo = scrollTo as typeof target.scrollTo;
      target.scroll = scroll as typeof target.scroll;
    }
    this.horizontalScrollLocks = [];
    if (hadLocks || !this.isMobile()) this.resetHorizontalListScroll();
  }

  // ─── Section creation ──────────────────────────────────

  protected startAddingSection(): void {
    if (this.isPublicPage()) return;
    if (!this.canAddSection() || this.isEditing()) return;
    this.sectionMenuOpen.set(false);
    this.addingSectionTitle.set('');
    this.focusVisibleInput('.section-add-input');
  }

  protected cancelAddingSection(): void {
    this.addingSectionTitle.set(null);
  }

  protected confirmAddSection(): void {
    const title = (this.addingSectionTitle() ?? '').trim();
    if (!title) { this.cancelAddingSection(); return; }

    if (!this.canAddSection()) { this.cancelAddingSection(); return; }

    const newSection = this.createSection(title);
    this.cancelAddingSection();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(synced => {
        this.sections.set(synced);
        return this.doSyncSection(newSection.id);
      }).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private createSection(title: string): StoredSection {
    const now = new Date().toISOString();
    const sectionId = crypto.randomUUID();
    const mainListId = crypto.randomUUID();
    const backlogListId = crypto.randomUUID();

    const newSection: StoredSection = {
      id: sectionId,
      title,
      position: this.sections().length,
      metadataLastModifiedAt: now,
      serverRevision: 0,
      created: true,
      dirty: true,
      lists: [
        { id: mainListId, title: DEFAULT_MAIN_TITLE, metadataLastModifiedAt: now, serverRevision: 0, itemsOrderRevision: 0, itemsBaseOrderRevision: 0, dirty: true, items: [], isBacklog: false },
        { id: backlogListId, title: DEFAULT_BACKLOG_TITLE, metadataLastModifiedAt: now, serverRevision: 0, itemsOrderRevision: 0, itemsBaseOrderRevision: 0, dirty: true, items: [], isBacklog: true },
      ],
    };

    this.storage.upsertSection(newSection);
    this.refreshSectionsFromStorage();
    this.activeSectionId.set(sectionId);

    return newSection;
  }

  private ensureDefaultSectionForItemCreation(list: TaskListKind): boolean {
    const active = this.activeSection();
    if (this.sectionHasList(active, list)) return true;

    if (active) {
      if (this.auth.isLoggedIn() && this.auth.isPremium() && !this.isPublicPage()) return false;
      this.ensureLocalDefaultLists(active.id);
      return this.sectionHasList(this.activeSection(), list);
    }

    if (this.sections().length === 0) {
      const created = this.createSection('my list');
      return this.sectionHasList(created, list);
    }

    const first = this.sections()[0];
    if (!first) return false;
    this.activeSectionId.set(first.id);
    if (this.auth.isLoggedIn() && this.auth.isPremium() && !this.isPublicPage()) return this.sectionHasList(first, list);
    this.ensureLocalDefaultLists(first.id);
    return this.sectionHasList(this.activeSection(), list);
  }

  private async ensureActiveListReadyForItemCreation(list: TaskListKind): Promise<boolean> {
    let active = this.activeSection();
    if (!active) {
      if (this.sections().length === 0 && !this.isPublicPage()) {
        active = this.createSection('my list');
      } else {
        active = this.sections()[0] ?? null;
        if (active) this.activeSectionId.set(active.id);
      }
    }
    if (!active) return false;
    if (this.sectionHasList(active, list)) return true;

    const sectionId = active.id;
    if (this.auth.isLoggedIn() && this.auth.isPremium() && !this.isPublicPage()) {
      try {
        await this.sync.syncSectionLists(sectionId);
        this.refreshSectionsFromStorage();
      } catch {
        return false;
      }

      active = this.activeSection();
      if (this.sectionHasList(active, list)) return true;
    }

    if (!this.isPublicPage() || list === 'main') {
      this.ensureLocalDefaultLists(sectionId);
    }
    return this.sectionHasList(this.activeSection(), list);
  }

  protected handleAddSectionKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmAddSection();
      this.focusTabsForKeyboard();
    } else if (event.key === 'ArrowLeft' && !(event.target as HTMLInputElement).value.trim()) {
      event.preventDefault();
      this.cancelAddingSection();
      this.focusTabsForKeyboard();
    } else if (event.key === 'Escape') {
      this.cancelAddingSection();
      this.focusTabsForKeyboard();
    }
  }

  protected onAddSectionInput(event: Event): void {
    this.addingSectionTitle.set((event.target as HTMLInputElement).value);
  }

  // ─── Section rename ────────────────────────────────────

  protected startEditingSection(sectionId: string): void {
    if (this.isPublicPage()) return;
    if (this.isEditing()) return;
    this.editingSectionId.set(sectionId);
    this.focusVisibleInput(`[data-edit-section="${sectionId}"]`, true);
  }

  protected saveSectionEdit(sectionId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      const p = this.storage.load();
      const sec = p.sections.find(s => s.id === sectionId);
      if (sec) {
        sec.title = value;
        sec.metadataLastModifiedAt = new Date().toISOString();
        sec.dirty = true;
        this.storage.save(p);
        this.refreshSectionsFromStorage();

        if (this.auth.isLoggedIn() && this.auth.isPremium()) {
          this.sync.syncSections().then(synced => this.sections.set(synced)).catch(() => {});
        }
      }
    }
    this.editingSectionId.set(null);
  }

  protected handleSectionEditKeydown(sectionId: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSectionEdit(sectionId, event);
    else if (event.key === 'Escape') this.editingSectionId.set(null);
  }

  // ─── Section deletion ──────────────────────────────────

  protected startDeleteSection(sectionId: string): void {
    this.sectionMenuOpen.set(false);
    this.confirmingDeleteSectionId.set(sectionId);
    this.sectionDeleteConfirmFocus.set('delete');
    this.keyboardZone.set('tabs');
    this.activeKeyboardTask.set(null);
  }

  protected cancelDeleteSection(): void {
    this.confirmingDeleteSectionId.set(null);
    this.sectionDeleteConfirmFocus.set('delete');
  }

  protected confirmDeleteSection(): void {
    const id = this.confirmingDeleteSectionId();
    if (!id) return;

    this.deleteSection(id);
    this.confirmingDeleteSectionId.set(null);
    this.sectionDeleteConfirmFocus.set('delete');
    this.focusTabsForKeyboard();
  }

  protected toggleSectionMenu(): void {
    if (this.isEditing()) return;
    this.sectionMenuOpen.update(open => !open);
  }

  protected closeSectionMenu(): void {
    this.sectionMenuOpen.set(false);
  }

  protected openSharedPageInfo(): void {
    this.shareMenuOpen.set(false);
    this.infoDialog.set('shared-page');
  }

  protected openPrivateWelcomeInfo(): void {
    this.menuOpen.set(false);
    this.infoDialog.set('private-welcome');
  }

  protected closeInfoDialog(): void {
    this.infoDialog.set(null);
    this.maybeScheduleFirstVisitCoachMarks();
  }

  protected openPrivateSplendide(): void {
    this.markPrivateWelcomeDialogPending();
  }

  protected startAddingSectionFromMenu(): void {
    this.startAddingSection();
  }

  protected async createPublicSection(): Promise<void> {
    if (this.isEditing()) return;
    this.sectionMenuOpen.set(false);
    const previousSectionId = this.activeSectionId();
    const publicWindow = window.open('', '_blank');
    try {
      const section = await this.publicSync.createPublicPage();
      this.restorePrivatePartition(previousSectionId);
      const publicUrl = `${window.location.origin}${this.router.serializeUrl(
        this.router.createUrlTree(['/public', section.id]),
      )}`;
      if (publicWindow) {
        publicWindow.opener = null;
        publicWindow.location.href = publicUrl;
      } else {
        window.open(publicUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      publicWindow?.close();
      this.restorePrivatePartition(previousSectionId);
      // The user can retry from the menu.
    }
  }

  private restorePrivatePartition(previousSectionId: string | null): void {
    this.storage.setActivePartition(this.auth.user()?.id);
    this.refreshSectionsFromStorage();
    const sections = this.sections();
    this.activeSectionId.set(
      previousSectionId && sections.some(section => section.id === previousSectionId)
        ? previousSectionId
        : sections[0]?.id ?? null,
    );
    this.clearKeyboardFocus('main');
  }

  protected startDeletingActiveSectionFromMenu(): void {
    const sectionId = this.activeSectionId();
    if (!sectionId || this.sections().length < 2) return;
    this.startDeleteSection(sectionId);
  }

  private deleteSection(sectionId: string): void {
    if (this.isPublicPage()) return;
    this.storage.removeSection(sectionId);
    this.refreshSectionsFromStorage();
    this.activeKeyboardTask.set(null);

    const remaining = this.sections();
    if (this.activeSectionId() === sectionId) {
      this.activeSectionId.set(remaining[0]?.id ?? null);
    }

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(synced => this.sections.set(synced)).catch(() => {});
    }
  }

  // ─── List mutation helper ──────────────────────────────

  private updateMainList(updater: (tasks: Task[]) => Task[], options?: { markOrderDirty?: boolean }): void {
    const sec = this.activeSection();
    const ml = this.mainList();
    if (!sec || !ml) return;

    const syncSectionsFirst = sec.created === true;
    this.storage.setItemsForList(
      sec.id,
      ml.id,
      this.buildItemsFromTasks(ml.items, updater(this.visibleTasks(ml))),
      options,
    );
    this.refreshSectionsFromStorage();
    this.syncItemsForList(sec.id, ml.id, syncSectionsFirst);
  }

  private updateBacklogList(updater: (tasks: Task[]) => Task[], options?: { markOrderDirty?: boolean }): void {
    const sec = this.activeSection();
    const bl = this.backlogList();
    if (!sec || !bl) return;

    const syncSectionsFirst = sec.created === true;
    this.storage.setItemsForList(
      sec.id,
      bl.id,
      this.buildItemsFromTasks(bl.items, updater(this.visibleTasks(bl))),
      options,
    );
    this.refreshSectionsFromStorage();
    this.syncItemsForList(sec.id, bl.id, syncSectionsFirst);
  }

  private updateBothLists(
    mainUpdater: (tasks: Task[]) => Task[],
    backlogUpdater: (tasks: Task[]) => Task[],
    syncOrder?: string[],
  ): void {
    const sec = this.activeSection();
    const ml = this.mainList();
    const bl = this.backlogList();
    if (!sec || !ml || !bl) return;

    const syncSectionsFirst = sec.created === true;
    this.storage.setItemsForList(sec.id, ml.id, this.buildItemsFromTasks(ml.items, mainUpdater(this.visibleTasks(ml))), { markOrderDirty: true });
    this.storage.setItemsForList(sec.id, bl.id, this.buildItemsFromTasks(bl.items, backlogUpdater(this.visibleTasks(bl))), { markOrderDirty: true });
    this.refreshSectionsFromStorage();
    this.syncItemsForLists(sec.id, syncOrder ?? [ml.id, bl.id], syncSectionsFirst);
  }

  private updateBacklogMeta(title?: string): void {
    const sec = this.activeSection();
    const bl = this.backlogList();
    if (!sec || !bl) return;

    this.updateListMeta(sec.id, bl, title);
  }

  private visibleTasks(list: StoredList | null): Task[] {
    return (list?.items ?? [])
      .filter(item => !item.deleted && !this.normalizeTask(item.content, item.id).done)
      .sort((a, b) => a.position - b.position)
      .map(item => ({
        ...this.normalizeTask(item.content, item.id),
        lastModifiedAt: item.lastModifiedAt,
        serverRevision: item.serverRevision,
      }));
  }

  private doneTasksForList(sourceList: TaskListKind, list: StoredList | null): DoneTask[] {
    const tasks: DoneTask[] = [];
    for (const item of list?.items ?? []) {
      if (item.deleted) continue;
      const task = this.normalizeTask(item.content, item.id);
      if (!task.done) continue;
      const doneAt = task.doneAt ?? item.lastModifiedAt;
      tasks.push({
        ...task,
        doneAt,
        lastModifiedAt: item.lastModifiedAt,
        serverRevision: item.serverRevision,
        sourceList,
      });
    }
    return tasks;
  }

  private compareDoneTasksNewestFirst(left: Pick<DoneTask, 'doneAt' | 'lastModifiedAt' | 'id'>, right: Pick<DoneTask, 'doneAt' | 'lastModifiedAt' | 'id'>): number {
    const timeDiff = this.doneTime(right.doneAt, right.lastModifiedAt) - this.doneTime(left.doneAt, left.lastModifiedAt);
    if (timeDiff !== 0) return timeDiff;
    const modifiedDiff = String(right.lastModifiedAt ?? '').localeCompare(String(left.lastModifiedAt ?? ''));
    if (modifiedDiff !== 0) return modifiedDiff;
    return right.id.localeCompare(left.id);
  }

  private doneTime(doneAt: string | undefined, fallback?: string): number {
    const doneTime = doneAt ? new Date(doneAt).getTime() : Number.NaN;
    if (!Number.isNaN(doneTime)) return doneTime;
    const fallbackTime = fallback ? new Date(fallback).getTime() : Number.NaN;
    return Number.isNaN(fallbackTime) ? 0 : fallbackTime;
  }

  private normalizeTask(value: unknown, fallbackId: string = crypto.randomUUID()): Task {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const id = String(record['id'] ?? fallbackId);
    const subtasks = Array.isArray(record['subtasks'])
      ? record['subtasks'].map(subtask => this.normalizeSubtask(subtask))
      : [];

    return {
      id,
      text: String(record['text'] ?? ''),
      subtasks,
      done: Boolean(record['done']),
      ...(typeof record['doneAt'] === 'string' && record['doneAt'] ? { doneAt: record['doneAt'] } : {}),
    };
  }

  private normalizeSubtask(value: unknown): Subtask {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};

    return {
      id: String(record['id'] ?? crypto.randomUUID()),
      text: String(record['text'] ?? ''),
      done: Boolean(record['done']),
    };
  }

  private taskContentEquals(left: unknown, right: Task): boolean {
    const normalizedLeft = this.normalizeTask(left, right.id);
    const leftSubtasks = new Map(normalizedLeft.subtasks.map(subtask => [subtask.id, subtask]));
    return normalizedLeft.id === right.id &&
      normalizedLeft.text === right.text &&
      normalizedLeft.done === right.done &&
      normalizedLeft.doneAt === right.doneAt &&
      normalizedLeft.subtasks.length === right.subtasks.length &&
      right.subtasks.every(subtask => {
        const other = leftSubtasks.get(subtask.id);
        if (!other) return false;
        return subtask.text === other.text &&
          subtask.done === other.done;
      });
  }

  private buildItemsFromTasks(existingItems: StoredItem[], tasks: Task[]): StoredItem[] {
    const now = new Date().toISOString();
    const existingById = new Map(existingItems.map(item => [item.id, item]));
    const nextIds = new Set(tasks.map(task => task.id));
    const nextItems = tasks.map((task, position) => {
      const normalizedTask = this.normalizeTask(task, task.id);
      const existing = existingById.get(normalizedTask.id);
      if (existing && !existing.deleted) {
        const contentChanged = !this.taskContentEquals(existing.content, normalizedTask);
        return {
          ...existing,
          content: normalizedTask,
          position,
          lastModifiedAt: contentChanged ? now : existing.lastModifiedAt,
          ...(contentChanged ? { dirty: true } : {}),
        };
      }

      return {
        id: normalizedTask.id,
        content: normalizedTask,
        position,
        lastModifiedAt: task.lastModifiedAt ?? now,
        serverRevision: task.serverRevision ?? 0,
        created: true,
        dirty: true,
      };
    });

    const preservedDoneItems = existingItems
      .filter(item => {
        if (item.deleted || nextIds.has(item.id)) return false;
        return this.normalizeTask(item.content, item.id).done;
      })
      .sort((a, b) => a.position - b.position)
      .map((item, index) => ({ ...item, position: nextItems.length + index }));

    const deletedItems = existingItems
      .filter(item => {
        if (item.deleted || nextIds.has(item.id)) return false;
        return !this.normalizeTask(item.content, item.id).done;
      })
      .map(item => ({ ...item, deleted: true, dirty: true, lastModifiedAt: now }));
    const alreadyDeleted = existingItems.filter(item => item.deleted && !nextIds.has(item.id));

    return [...nextItems, ...preservedDoneItems, ...deletedItems, ...alreadyDeleted];
  }

  private updateListMeta(sectionId: string, list: StoredList, title?: string): void {
    const updatedList: StoredList = {
      ...list,
      ...(title !== undefined ? { title } : {}),
      metadataLastModifiedAt: new Date().toISOString(),
      dirty: true,
    };
    this.storage.upsertList(sectionId, updatedList);
    this.refreshSectionsFromStorage();

    if (this.isPublicPage()) {
      this.publicSync.syncPublicLists(sectionId).then(() => this.refreshSectionsFromStorage()).catch(() => {});
      return;
    }

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSectionLists(sectionId).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private syncItemsForList(sectionId: string, listId: string, syncSectionsFirst = false): void {
    this.syncItemsForLists(sectionId, [listId], syncSectionsFirst);
  }

  private syncItemsForLists(sectionId: string, listIds: string[], syncSectionsFirst = false): void {
    if (this.isPublicPage()) {
      for (const listId of listIds) {
        this.publicSync.reserveListItemsSync(sectionId, listId);
      }

      this.publicSync.syncPublicLists(sectionId)
        .then(async () => {
          for (const listId of listIds) {
            await this.publicSync.syncPublicListItems(sectionId, listId);
          }
          const overflowListIds = this.enforceDoneTaskLimit(sectionId);
          for (const listId of overflowListIds) {
            await this.publicSync.syncPublicListItems(sectionId, listId);
          }
        })
        .then(() => this.refreshSectionsFromStorage())
        .catch(() => {});
      return;
    }

    if (!this.auth.isLoggedIn() || !this.auth.isPremium()) return;

    for (const listId of listIds) {
      this.sync.reserveListItemsSync(sectionId, listId);
    }

    const listSync = syncSectionsFirst
      ? this.sync.syncSections().then(synced => {
          this.sections.set(synced);
          return this.sync.syncSectionLists(sectionId);
        })
      : this.sync.syncSectionLists(sectionId);

    listSync
      .then(async () => {
        for (const listId of listIds) {
          await this.sync.syncListItems(sectionId, listId);
        }
        const overflowListIds = this.enforceDoneTaskLimit(sectionId);
        for (const listId of overflowListIds) {
          await this.sync.syncListItems(sectionId, listId);
        }
      })
      .then(() => this.refreshSectionsFromStorage())
      .catch(() => {});
  }

  private crossListSyncOrder(destination: 'main' | 'backlog'): string[] | undefined {
    const ml = this.mainList();
    const bl = this.backlogList();
    if (!ml || !bl) return undefined;
    return destination === 'main' ? [ml.id, bl.id] : [bl.id, ml.id];
  }

  private reorderTasksInList(sectionId: string, list: StoredList, tasks: Task[]): void {
    const order = new Map(tasks.map((task, position) => [task.id, position]));
    const items = list.items.map(item => ({
      ...item,
      position: order.get(item.id) ?? item.position,
    }));
    this.storage.setItemsForList(sectionId, list.id, items, { markOrderDirty: true });
    this.refreshSectionsFromStorage();

    if (this.isPublicPage()) {
      const payload = tasks.map((task, position) => ({ id: task.id, position }));
      const localItemsRevision = this.storage.getItemsRevision(sectionId, list.id);
      this.publicSync.reorderPublicItems(sectionId, list.id, payload)
        .then(result => {
          if (localItemsRevision !== this.storage.getItemsRevision(sectionId, list.id)) return;
          this.storage.applyItemPositions(sectionId, list.id, result.positions, result.orderRevision);
          this.refreshSectionsFromStorage();
        })
        .catch(() => {});
      return;
    }

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      const payload = tasks.map((task, position) => ({ id: task.id, position }));
      const localItemsRevision = this.storage.getItemsRevision(sectionId, list.id);
      this.sync.reorderItems(sectionId, list.id, payload)
        .then(result => {
          if (localItemsRevision !== this.storage.getItemsRevision(sectionId, list.id)) return;
          this.storage.applyItemPositions(sectionId, list.id, result.positions, result.orderRevision);
          this.refreshSectionsFromStorage();
        })
        .catch(() => {});
    }
  }

  // ─── Clear list ─────────────────────────────────────────
  private reorderSubtasksInList(list: StoredList | null, taskId: string, previousIndex: number, currentIndex: number): void {
    const sec = this.activeSection();
    if (!sec || !list) return;

    const now = new Date().toISOString();
    const items = list.items.map(item => {
      if (item.id !== taskId || item.deleted) return item;

      const task = this.normalizeTask(item.content, item.id);
      const subtasks = [...task.subtasks];
      moveItemInArray(subtasks, previousIndex, currentIndex);
      return {
        ...item,
        content: { ...task, subtasks },
        lastModifiedAt: now,
        dirty: true,
      };
    });

    this.storage.setItemsForList(sec.id, list.id, items);
    this.refreshSectionsFromStorage();
  }

  protected readonly confirmingClear = signal(false);
  protected readonly confirmingSecondaryClear = signal(false);

  protected startClear(): void { this.confirmingClear.set(true); }
  protected cancelClear(): void { this.confirmingClear.set(false); }
  protected confirmClear(): void {
    this.updateMainList(() => []);
    this.confirmingClear.set(false);
  }
  protected clearDoneTasks(): void {
    this.deleteDoneTasksFromList('main');
  }

  protected startSecondaryClear(): void { this.confirmingSecondaryClear.set(true); }
  protected cancelSecondaryClear(): void { this.confirmingSecondaryClear.set(false); }
  protected confirmSecondaryClear(): void {
    this.updateBacklogList(() => []);
    this.confirmingSecondaryClear.set(false);
  }
  protected clearDoneSecondary(): void {
    this.deleteDoneTasksFromList('secondary');
  }

  protected restoreDoneTask(task: DoneTask): void {
    this.restoreDoneTaskToSource(task, this.withoutDoneDate({ ...task, done: false }));
  }

  protected restoreDoneSubtask(task: DoneTask, subtaskId: string): void {
    const restoredTask = this.withoutDoneDate({
      ...task,
      done: false,
      subtasks: task.subtasks.map(subtask =>
        subtask.id === subtaskId ? { ...subtask, done: false } : subtask
      ),
    });
    this.restoreDoneTaskToSource(task, restoredTask);
  }

  private restoreDoneTaskToSource(task: DoneTask, restoredTask: Task): void {
    const sec = this.activeSection();
    const sourceList = this.listForKind(task.sourceList);
    if (!sec || !sourceList) return;

    const sourceItem = sourceList.items.find(item => item.id === task.id);
    if (!sourceItem) return;

    const now = new Date().toISOString();
    const restoredItem: StoredItem = {
      ...sourceItem,
      content: restoredTask,
      position: 0,
      lastModifiedAt: now,
      dirty: true,
    };
    delete restoredItem.deleted;

    this.storage.setItemsForList(
      sec.id,
      sourceList.id,
      this.prependVisibleItem(sourceList.items, restoredItem),
      { markOrderDirty: true },
    );
    this.refreshSectionsFromStorage();
    this.syncItemsForList(sec.id, sourceList.id, sec.created === true);
  }

  private completeTask(listKind: TaskListKind, id: string): void {
    const sec = this.activeSection();
    const list = this.listForKind(listKind);
    if (!sec || !list) return;

    const now = new Date().toISOString();
    let found = false;
    const items = this.normalizeStoredItemPositions(list.items.map(item => {
      const task = this.normalizeTask(item.content, item.id);
      if (!found && item.id === id && !item.deleted && !task.done) {
        found = true;
        return {
          ...item,
          content: {
            ...task,
            done: true,
            doneAt: now,
            subtasks: task.subtasks.map(subtask => ({ ...subtask, done: true })),
          },
          dirty: true,
          lastModifiedAt: now,
        };
      }

      return item;
    }));

    if (!found) return;

    this.storage.setItemsForList(sec.id, list.id, items);
    const overflowListIds = this.enforceDoneTaskLimit(sec.id, now);
    this.refreshSectionsFromStorage();
    this.syncItemsForLists(sec.id, [...new Set([list.id, ...overflowListIds])], sec.created === true);
  }

  private normalizeStoredItemPositions(items: StoredItem[]): StoredItem[] {
    let activePosition = 0;
    let donePosition = items.filter(item => !item.deleted && !this.normalizeTask(item.content, item.id).done).length;
    return items.map(item => {
      if (item.deleted) return item;
      const task = this.normalizeTask(item.content, item.id);
      return {
        ...item,
        position: task.done ? donePosition++ : activePosition++,
      };
    });
  }

  private deleteDoneTasksFromList(listKind: TaskListKind): void {
    const sec = this.activeSection();
    const list = this.listForKind(listKind);
    if (!sec || !list) return;

    const now = new Date().toISOString();
    let changed = false;
    const items = list.items.map(item => {
      if (item.deleted || !this.normalizeTask(item.content, item.id).done) return item;
      changed = true;
      return {
        ...item,
        deleted: true,
        dirty: true,
        lastModifiedAt: now,
      };
    });

    if (!changed) return;
    this.storage.setItemsForList(sec.id, list.id, items);
    this.refreshSectionsFromStorage();
    this.syncItemsForList(sec.id, list.id, sec.created === true);
  }

  private enforceDoneTaskLimit(sectionId: string, timestamp = new Date().toISOString()): string[] {
    const section = this.storage.getSection(sectionId);
    if (!section) return [];

    const lists = this.isPublicPage()
      ? section.lists.filter(list => !list.isBacklog)
      : section.lists;
    const doneItems: Array<{ list: StoredList; item: StoredItem; task: Task }> = [];
    for (const list of lists) {
      for (const item of list.items) {
        if (item.deleted) continue;
        const task = this.normalizeTask(item.content, item.id);
        if (!task.done) continue;
        doneItems.push({ list, item, task });
      }
    }

    if (doneItems.length <= MAX_DONE_TASKS) return [];

    const overflow = doneItems
      .sort((left, right) => this.compareDoneTasksNewestFirst(
        {
          id: left.item.id,
          doneAt: left.task.doneAt ?? left.item.lastModifiedAt,
          lastModifiedAt: left.item.lastModifiedAt,
        },
        {
          id: right.item.id,
          doneAt: right.task.doneAt ?? right.item.lastModifiedAt,
          lastModifiedAt: right.item.lastModifiedAt,
        },
      ))
      .slice(MAX_DONE_TASKS);

    const overflowByList = new Map<string, Set<string>>();
    for (const { list, item } of overflow) {
      const ids = overflowByList.get(list.id) ?? new Set<string>();
      ids.add(item.id);
      overflowByList.set(list.id, ids);
    }

    for (const list of section.lists) {
      const overflowIds = overflowByList.get(list.id);
      if (!overflowIds) continue;
      this.storage.setItemsForList(
        sectionId,
        list.id,
        list.items.map(item => overflowIds.has(item.id)
          ? {
              ...item,
              deleted: true,
              dirty: true,
              lastModifiedAt: timestamp,
            }
          : item),
      );
    }

    return [...overflowByList.keys()];
  }

  private prependVisibleItem(items: StoredItem[], restoredItem: StoredItem): StoredItem[] {
    let nextPosition = 1;
    return [
      restoredItem,
      ...items
        .filter(item => item.id !== restoredItem.id)
        .map(item => {
          const task = this.normalizeTask(item.content, item.id);
          if (!item.deleted && !task.done) {
            return { ...item, position: nextPosition++ };
          }
          return item;
        }),
    ];
  }

  private withoutDoneDate(task: Task): Task {
    const { doneAt: _doneAt, sourceList: _sourceList, ...rest } = task as Task & Partial<DoneTask>;
    return rest;
  }

  private listForKind(list: TaskListKind): StoredList | null {
    return list === 'main' ? this.mainList() : this.backlogList();
  }

  // ─── Scroll ─────────────────────────────────────────────
  protected readonly mainSection = viewChild<ElementRef<HTMLElement>>('mainSection');
  protected readonly secondarySection = viewChild<ElementRef<HTMLElement>>('secondarySection');

  // ─── User menu ──────────────────────────────────────────
  protected toggleMenu(): void {
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(['/sign-in']);
      return;
    }
    this.menuOpen.update(v => !v);
  }

  protected toggleDark(): void {
    this.theme.toggle();
  }

  protected toggleShareMenu(): void {
    this.shareMenuOpen.update(open => !open);
  }

  protected publicShareUrl(): string {
    const publicId = this.publicPageId();
    return publicId ? `${window.location.origin}/public/${publicId}` : window.location.origin;
  }

  protected async copyPublicLink(): Promise<void> {
    const publicId = this.publicPageId();
    if (!publicId) return;

    const url = this.publicShareUrl();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      this.copyTextFallback(url);
    }
    this.showShareToast();
  }

  private copyTextFallback(value: string): void {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  private showShareToast(): void {
    this.shareToastVisible.set(true);
    if (this.shareToastTimer !== null) clearTimeout(this.shareToastTimer);
    this.shareToastTimer = setTimeout(() => {
      this.shareToastVisible.set(false);
      this.shareToastTimer = null;
    }, 1800);
  }

  protected signOut(): void {
    this.menuOpen.set(false);
    this.storage.setActivePartition(); // switch to anonymous
    this.auth.logout();
    this.refreshSectionsFromStorage();
    const loaded = this.storage.loadSections();
    this.sections.set(loaded);
    this.activeSectionId.set(loaded[0]?.id ?? null);
    this.clearKeyboardFocus('main');
    this.schedulePremiumUpgradePrompt();
  }

  protected openSettings(): void {
    this.menuOpen.set(false);
    this.router.navigate(['/settings']);
  }

  protected async manageSubscription(): Promise<void> {
    this.menuOpen.set(false);
    try {
      const url = await this.auth.manageSubscription();
      await openExternalUrl(url);
    } catch {
      // silently fail — user can retry
    }
  }

  // ─── Main task: add ─────────────────────────────────────
  protected dismissPremiumUpgradePrompt(): void {
    premiumUpgradePromptShownThisAppLoad = true;
    this.markPremiumUpgradePromptShownToday();
    this.premiumUpgradePromptOpen.set(false);
    if (this.premiumUpgradePromptTimer !== null) {
      clearTimeout(this.premiumUpgradePromptTimer);
      this.premiumUpgradePromptTimer = null;
    }
  }

  protected goToPremiumUpgrade(): void {
    this.dismissPremiumUpgradePrompt();
    this.router.navigate(['/payment']);
  }

  protected async startAdding(): Promise<void> {
    this.focusListWithoutTask('main');
    if (!this.canAdd() || this.isEditing()) return;
    if (!(await this.ensureActiveListReadyForItemCreation('main'))) return;
    if (!this.canAdd() || this.isEditing()) return;
    this.adding.set(true);
    this.newTaskText.set('');
    this.newSubtasks.set([]);
    setTimeout(() => document.querySelector<HTMLInputElement>('.add-form:not(.add-form-sec) .input-minimal')?.focus());
  }

  protected cancelAdding(): void {
    this.adding.set(false);
    this.newTaskText.set('');
    this.newSubtasks.set([]);
  }

  protected confirmAdd(): void {
    const text = this.newTaskText().trim();
    if (!text) { this.cancelAdding(); return; }
    if (!this.ensureDefaultSectionForItemCreation('main')) return;
    const subtasks: Subtask[] = this.newSubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => ({ id: crypto.randomUUID(), text: s, done: false }));
    this.updateMainList(tasks => [
      { id: crypto.randomUUID(), text, subtasks, done: false },
      ...tasks,
    ], { markOrderDirty: true });
    this.cancelAdding();
  }

  protected onAddFormFocusOut(event: FocusEvent): void {
    const form = (event.currentTarget as HTMLElement);
    const next = event.relatedTarget as Node | null;
    if (!next || !form.contains(next)) {
      this.confirmAdd();
    }
  }

  protected addSubtaskField(focusNew = false): void {
    if (this.newSubtasks().length >= 10) return;
    this.newSubtasks.update(s => [...s, '']);
    if (focusNew) this.focusLastVisibleInput('.add-form:not(.add-form-sec) .input-sub');
  }

  private updateMainMeta(title?: string): void {
    const sec = this.activeSection();
    const ml = this.mainList();
    if (!sec || !ml) return;

    this.updateListMeta(sec.id, ml, title);
  }

  protected removeSubtaskField(index: number): void {
    this.newSubtasks.update(s => s.filter((_, i) => i !== index));
  }

  protected updateNewSubtask(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.newSubtasks.update(s => s.map((v, i) => (i === index ? value : v)));
  }

  protected onNewTaskInput(event: Event): void {
    this.newTaskText.set((event.target as HTMLInputElement).value);
  }

  protected handleAddKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.confirmAdd();
    else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.confirmAdd();
    }
    else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      this.addSubtaskField(true);
    }
    else if (event.key === 'Escape') this.cancelAdding();
  }

  // ─── Main title editing ─────────────────────────────────
  protected startEditingMainTitle(): void {
    if (this.isEditing()) return;
    this.editingMainTitle.set(true);
    this.focusVisibleInput('.main-title-input', true);
  }

  protected saveMainTitle(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateMainMeta(value);
    }
    this.editingMainTitle.set(false);
  }

  protected handleMainTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveMainTitle(event);
    else if (event.key === 'Escape') this.editingMainTitle.set(false);
  }

  // ─── Main task: toggle / remove ─────────────────────────
  protected toggleTask(id: string): void {
    this.completeTask('main', id);
  }

  protected removeTask(id: string): void {
    this.updateMainList(tasks => tasks.filter(t => t.id !== id));
  }

  // ─── Main task: inline edit ─────────────────────────────
  protected startEditingTask(id: string): void {
    if (this.isEditing()) return;
    this.setActiveKeyboardTask('main', id);
    this.editingTaskId.set(id);
    this.focusEditInput('task-' + id);
  }

  protected saveTaskEdit(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateMainList(tasks =>
        tasks.map(t => (t.id === id ? { ...t, text: value } : t))
      );
    }
    this.editingTaskId.set(null);
  }

  protected handleTaskEditKeydown(id: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.saveTaskEdit(id, event);
    } else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.saveTaskEdit(id, event);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.startSubtaskFromTaskEdit(id, event.target);
    }
    else if (event.key === 'Escape') {
      this.editingTaskId.set(null);
    }
  }

  // ─── Subtask: toggle / remove / edit ────────────────────
  protected toggleSubtask(taskId: string, subtaskId: string): void {
    this.updateMainList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSubtask(taskId: string, subtaskId: string): void {
    this.updateMainList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
          : t
      )
    );
  }

  protected startEditingSubtask(taskId: string, subtaskId: string): void {
    if (this.isEditing()) return;
    this.editingSubtask.set({ taskId, subtaskId });
    this.focusEditInput('sub-' + subtaskId);
  }

  protected saveSubtaskEdit(taskId: string, subtaskId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateMainList(tasks =>
        tasks.map(t =>
          t.id === taskId
            ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, text: value } : s)) }
            : t
        )
      );
    }
    this.editingSubtask.set(null);
  }

  protected handleSubtaskEditKeydown(taskId: string, subtaskId: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSubtaskEdit(taskId, subtaskId, event);
    else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.saveSubtaskEdit(taskId, subtaskId, event);
    }
    else if (event.key === 'Tab') {
      event.preventDefault();
      const value = (event.target as HTMLInputElement).value.trim();
      this.saveSubtaskEdit(taskId, subtaskId, event);
      if (value) queueMicrotask(() => this.startAddingSubtask(taskId, true));
    }
    else if (event.key === 'Escape') this.editingSubtask.set(null);
  }

  // ─── Subtask: add to existing task ─────────────────────
  protected startAddingSubtask(taskId: string, fromTaskEdit = false): void {
    if (!fromTaskEdit && this.isEditing()) return;
    const task = this.tasks().find(t => t.id === taskId);
    if (!task || task.subtasks.length >= 10) return;
    this.addingSubtaskToId.set(taskId);
    this.newInlineSubtaskText.set('');
    this.focusVisibleInput('[data-inline-subtask]');
  }

  protected cancelAddingSubtask(): void {
    this.addingSubtaskToId.set(null);
    this.newInlineSubtaskText.set('');
  }

  protected confirmAddSubtask(taskId: string): void {
    const text = this.newInlineSubtaskText().trim();
    if (!text) {
      this.cancelAddingSubtask();
      return;
    }
    this.updateMainList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: [...t.subtasks, { id: crypto.randomUUID(), text, done: false }] }
          : t
      )
    );
    this.cancelAddingSubtask();
  }

  protected handleInlineSubtaskKeydown(taskId: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmAddSubtask(taskId);
    } else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.confirmAddSubtask(taskId);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const value = this.newInlineSubtaskText().trim();
      if (!value) {
        this.cancelAddingSubtask();
        return;
      }
      this.confirmAddSubtask(taskId);
      queueMicrotask(() => this.startAddingSubtask(taskId, true));
    } else if (event.key === 'Escape') {
      this.cancelAddingSubtask();
    }
  }

  protected onInlineSubtaskInput(event: Event): void {
    this.newInlineSubtaskText.set((event.target as HTMLInputElement).value);
  }

  // ─── Secondary tasks ───────────────────────────────────
  protected async startAddingSecondary(): Promise<void> {
    this.focusListWithoutTask('secondary');
    if (!this.canAddSecondary() || this.isEditing()) return;
    if (!(await this.ensureActiveListReadyForItemCreation('secondary'))) return;
    if (!this.canAddSecondary() || this.isEditing()) return;
    this.addingSecondary.set(true);
    this.newSecondaryText.set('');
    this.newSecondarySubtasks.set([]);
    setTimeout(() => document.querySelector<HTMLInputElement>('.add-form-sec .input-minimal')?.focus());
  }

  protected cancelAddingSecondary(): void {
    this.addingSecondary.set(false);
    this.newSecondaryText.set('');
    this.newSecondarySubtasks.set([]);
  }

  protected confirmAddSecondary(): void {
    const text = this.newSecondaryText().trim();
    if (!text) { this.cancelAddingSecondary(); return; }
    if (!this.ensureDefaultSectionForItemCreation('secondary')) return;
    const subtasks: Subtask[] = this.newSecondarySubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => ({ id: crypto.randomUUID(), text: s, done: false }));
    this.updateBacklogList(tasks => [
      { id: crypto.randomUUID(), text, subtasks, done: false },
      ...tasks,
    ], { markOrderDirty: true });
    this.cancelAddingSecondary();
  }

  protected onSecAddFormFocusOut(event: FocusEvent): void {
    const form = (event.currentTarget as HTMLElement);
    const next = event.relatedTarget as Node | null;
    if (!next || !form.contains(next)) {
      this.confirmAddSecondary();
    }
  }

  protected onNewSecondaryInput(event: Event): void {
    this.newSecondaryText.set((event.target as HTMLInputElement).value);
  }

  protected handleSecondaryKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.confirmAddSecondary();
    else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.confirmAddSecondary();
    }
    else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      this.addSecSubtaskField(true);
    }
    else if (event.key === 'Escape') this.cancelAddingSecondary();
  }

  protected toggleSecondaryTask(id: string): void {
    this.completeTask('secondary', id);
  }

  protected removeSecondaryTask(id: string): void {
    this.updateBacklogList(tasks => tasks.filter(t => t.id !== id));
  }

  protected startEditingSecondary(id: string): void {
    if (this.isEditing()) return;
    this.setActiveKeyboardTask('secondary', id);
    this.editingSecondaryId.set(id);
    this.focusEditInput('sec-' + id);
  }

  protected saveSecondaryEdit(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateBacklogList(tasks =>
        tasks.map(t => (t.id === id ? { ...t, text: value } : t))
      );
    }
    this.editingSecondaryId.set(null);
  }

  protected handleSecondaryEditKeydown(id: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.saveSecondaryEdit(id, event);
    } else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.saveSecondaryEdit(id, event);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.startSubtaskFromSecondaryEdit(id, event.target);
    }
    else if (event.key === 'Escape') {
      this.editingSecondaryId.set(null);
    }
  }

  // ─── Secondary title editing ────────────────────────────
  protected startEditingSecondaryTitle(): void {
    if (this.isEditing()) return;
    this.editingSecondaryTitle.set(true);
    afterNextRender(() => {
      document.querySelector<HTMLInputElement>('.sec-title-input')?.focus();
    }, { injector: this.injector });
  }

  protected saveSecondaryTitle(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateBacklogMeta(value);
    }
    this.editingSecondaryTitle.set(false);
  }

  protected handleSecondaryTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecondaryTitle(event);
    else if (event.key === 'Escape') this.editingSecondaryTitle.set(false);
  }

  // ─── Secondary subtasks ─────────────────────────────────
  protected addSecSubtaskField(focusNew = false): void {
    if (this.newSecondarySubtasks().length >= 10) return;
    this.newSecondarySubtasks.update(s => [...s, '']);
    if (focusNew) this.focusLastVisibleInput('.add-form-sec .input-sub');
  }

  protected removeSecSubtaskField(index: number): void {
    this.newSecondarySubtasks.update(s => s.filter((_, i) => i !== index));
  }

  protected updateNewSecSubtask(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.newSecondarySubtasks.update(s => s.map((v, i) => (i === index ? value : v)));
  }

  protected toggleSecSubtask(taskId: string, subtaskId: string): void {
    this.updateBacklogList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSecSubtask(taskId: string, subtaskId: string): void {
    this.updateBacklogList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
          : t
      )
    );
  }

  protected startEditingSecSubtask(taskId: string, subtaskId: string): void {
    if (this.isEditing()) return;
    this.editingSecSubtask.set({ taskId, subtaskId });
    this.focusEditInput('secsub-' + subtaskId);
  }

  protected saveSecSubtaskEdit(taskId: string, subtaskId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateBacklogList(tasks =>
        tasks.map(t =>
          t.id === taskId
            ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, text: value } : s)) }
            : t
        )
      );
    }
    this.editingSecSubtask.set(null);
  }

  protected handleSecSubtaskEditKeydown(taskId: string, subtaskId: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecSubtaskEdit(taskId, subtaskId, event);
    else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.saveSecSubtaskEdit(taskId, subtaskId, event);
    }
    else if (event.key === 'Tab') {
      event.preventDefault();
      const value = (event.target as HTMLInputElement).value.trim();
      this.saveSecSubtaskEdit(taskId, subtaskId, event);
      if (value) queueMicrotask(() => this.startAddingSecSubtask(taskId, true));
    }
    else if (event.key === 'Escape') this.editingSecSubtask.set(null);
  }

  protected startAddingSecSubtask(taskId: string, fromTaskEdit = false): void {
    if (!fromTaskEdit && this.isEditing()) return;
    const task = this.secondaryTasks().find(t => t.id === taskId);
    if (!task || task.subtasks.length >= 10) return;
    this.addingSecSubtaskToId.set(taskId);
    this.newInlineSecSubtaskText.set('');
    this.focusVisibleInput('[data-inline-sec-subtask]');
  }

  protected cancelAddingSecSubtask(): void {
    this.addingSecSubtaskToId.set(null);
    this.newInlineSecSubtaskText.set('');
  }

  protected confirmAddSecSubtask(taskId: string): void {
    const text = this.newInlineSecSubtaskText().trim();
    if (!text) {
      this.cancelAddingSecSubtask();
      return;
    }
    this.updateBacklogList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: [...t.subtasks, { id: crypto.randomUUID(), text, done: false }] }
          : t
      )
    );
    this.cancelAddingSecSubtask();
  }

  protected handleInlineSecSubtaskKeydown(taskId: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmAddSecSubtask(taskId);
    } else if (this.isVerticalArrowKey(event)) {
      event.preventDefault();
      this.confirmAddSecSubtask(taskId);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const value = this.newInlineSecSubtaskText().trim();
      if (!value) {
        this.cancelAddingSecSubtask();
        return;
      }
      this.confirmAddSecSubtask(taskId);
      queueMicrotask(() => this.startAddingSecSubtask(taskId, true));
    } else if (event.key === 'Escape') {
      this.cancelAddingSecSubtask();
    }
  }

  protected onInlineSecSubtaskInput(event: Event): void {
    this.newInlineSecSubtaskText.set((event.target as HTMLInputElement).value);
  }

  // ─── Toggle secondary visibility ────────────────────────
  protected toggleSecondaryVisibility(): void {
    this.secondaryVisible.update(v => !v);
  }

  // ─── Task dot menu (mobile) ─────────────────────────────
  protected toggleTaskMenu(taskId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.taskMenuOpenId.update(id => id === taskId ? null : taskId);
    this.secTaskMenuOpenId.set(null);
  }

  protected toggleSecTaskMenu(taskId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.secTaskMenuOpenId.update(id => id === taskId ? null : taskId);
    this.taskMenuOpenId.set(null);
  }

  // ─── Move between lists (mobile buttons) ──────────────
  protected moveToBacklog(taskId: string): void {
    if (this.isEditing()) return;
    const mainItems = [...this.tasks()];
    const secItems = [...this.secondaryTasks()];
    const idx = mainItems.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const [task] = mainItems.splice(idx, 1);

    if (secItems.length >= MAX_BACKLOG_TASKS) {
      const displaced = secItems.shift()!;
      mainItems.push(displaced);
    }

    secItems.push(task);
    this.updateBothLists(() => mainItems, () => secItems, this.crossListSyncOrder('backlog'));
  }

  protected moveToMain(taskId: string): void {
    if (this.isEditing()) return;
    const secItems = [...this.secondaryTasks()];
    const mainItems = [...this.tasks()];
    const idx = secItems.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const [task] = secItems.splice(idx, 1);

    if (mainItems.length >= MAX_MAIN_TASKS) {
      const displaced = mainItems.pop()!;
      secItems.unshift(displaced);
    }

    mainItems.push(task);
    this.updateBothLists(() => mainItems, () => secItems, this.crossListSyncOrder('main'));
  }

  // ─── Drag & drop: main tasks ────────────────────────────
  protected dropMainTask(event: CdkDragDrop<unknown[]>): void {
    if (this.isEditing()) return;
    if (event.previousContainer === event.container) {
      const sec = this.activeSection();
      const ml = this.mainList();
      if (!sec || !ml) return;
      const items = [...this.tasks()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.reorderTasksInList(sec.id, ml, items);
    } else {
      const secItems = [...this.secondaryTasks()];
      const mainItems = [...this.tasks()];
      const secTask = secItems[event.previousIndex]!;
      secItems.splice(event.previousIndex, 1);

      if (mainItems.length >= MAX_MAIN_TASKS) {
        const displaced = mainItems.pop()!;
        secItems.unshift(displaced);
      }

      mainItems.splice(event.currentIndex, 0, secTask);
      this.updateBothLists(() => mainItems, () => secItems, this.crossListSyncOrder('main'));
    }
  }

  protected dropSecondaryTask(event: CdkDragDrop<unknown[]>): void {
    if (this.isEditing()) return;
    if (event.previousContainer === event.container) {
      const sec = this.activeSection();
      const bl = this.backlogList();
      if (!sec || !bl) return;
      const items = [...this.secondaryTasks()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.reorderTasksInList(sec.id, bl, items);
    } else {
      const mainItems = [...this.tasks()];
      const secItems = [...this.secondaryTasks()];
      const mainTask = mainItems[event.previousIndex]!;
      mainItems.splice(event.previousIndex, 1);

      if (secItems.length >= MAX_BACKLOG_TASKS) {
        const displaced = secItems.shift()!;
        mainItems.push(displaced);
      }

      secItems.splice(event.currentIndex, 0, mainTask);
      this.updateBothLists(() => mainItems, () => secItems, this.crossListSyncOrder('backlog'));
    }
  }

  // ─── Focus helper ───────────────────────────────────────
  private focusVisibleInput(selector: string, select = false): void {
    requestAnimationFrame(() => setTimeout(() => {
      const all = document.querySelectorAll<HTMLInputElement>(selector);
      const el = Array.from(all).find(i => i.offsetParent !== null) ?? all[0];
      el?.focus();
      if (select) el?.select();
    }));
  }

  private focusLastVisibleInput(selector: string): void {
    requestAnimationFrame(() => setTimeout(() => {
      const all = Array.from(document.querySelectorAll<HTMLInputElement>(selector));
      const visible = all.filter(i => i.offsetParent !== null);
      (visible.at(-1) ?? all.at(-1))?.focus();
    }));
  }

  private focusEditInput(editId: string): void {
    afterNextRender(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-edit-id="${editId}"]`);
      input?.focus();
    }, { injector: this.injector });
  }

  private startSubtaskFromActiveTaskEdit(event: KeyboardEvent): boolean {
    const mainTaskId = this.editingTaskId();
    if (mainTaskId !== null && this.startSubtaskFromTaskEdit(mainTaskId, event.target)) {
      event.preventDefault();
      return true;
    }

    const secondaryTaskId = this.editingSecondaryId();
    if (secondaryTaskId !== null && this.startSubtaskFromSecondaryEdit(secondaryTaskId, event.target)) {
      event.preventDefault();
      return true;
    }

    return false;
  }

  private startSubtaskFromTaskEdit(taskId: string, target: EventTarget | null): boolean {
    const input = this.getEditInput(target, `task-${taskId}`);
    if (!input || !input.value.trim()) return false;

    this.saveTaskEdit(taskId, { target: input } as unknown as Event);
    this.startAddingSubtask(taskId, true);
    return true;
  }

  private startSubtaskFromSecondaryEdit(taskId: string, target: EventTarget | null): boolean {
    const input = this.getEditInput(target, `sec-${taskId}`);
    if (!input || !input.value.trim()) return false;

    this.saveSecondaryEdit(taskId, { target: input } as unknown as Event);
    this.startAddingSecSubtask(taskId, true);
    return true;
  }

  private getEditInput(target: EventTarget | null, editId: string): HTMLInputElement | null {
    const targetInput = target instanceof HTMLInputElement ? target : null;
    if (targetInput?.dataset['editId'] === editId) return targetInput;

    const activeInput = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    if (activeInput?.dataset['editId'] === editId) return activeInput;

    return null;
  }

  protected linkSegments(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    this.urlPattern.lastIndex = 0;

    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = this.urlPattern.exec(text)) !== null) {
      const rawUrl = match[0];
      const index = match.index;
      if (index > cursor) {
        segments.push({ text: text.slice(cursor, index), href: null });
      }

      const { url, trailing } = this.splitTrailingLinkPunctuation(rawUrl);
      segments.push({
        text: url,
        href: url.startsWith('www.') ? `https://${url}` : url,
      });

      if (trailing) {
        segments.push({ text: trailing, href: null });
      }

      cursor = index + rawUrl.length;
    }

    if (cursor < text.length) {
      segments.push({ text: text.slice(cursor), href: null });
    }

    return segments.length > 0 ? segments : [{ text, href: null }];
  }

  protected openTaskLink(event: MouseEvent, href: string): void {
    event.stopPropagation();
    if (!window.splendideDesktop?.isDesktop) return;

    event.preventDefault();
    void openExternalUrl(href);
  }

  private splitTrailingLinkPunctuation(value: string): { url: string; trailing: string } {
    const match = value.match(/[.,!?;:]+$/);
    if (!match) return { url: value, trailing: '' };

    return {
      url: value.slice(0, -match[0].length),
      trailing: match[0],
    };
  }

  private isTextEntryTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(
      target.closest('input, textarea, select, [contenteditable="true"]')
    );
  }

  private isVerticalArrowKey(event: KeyboardEvent): boolean {
    return event.key === 'ArrowUp' || event.key === 'ArrowDown';
  }

  private isKeyboardManagedTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(
      target.closest('[data-keyboard-section], [data-keyboard-list]')
    );
  }

  private syncKeyboardFocusFromManagedTarget(target: EventTarget | null): void {
    if (!(target instanceof HTMLElement)) return;

    const listTarget = target.closest<HTMLElement>('[data-keyboard-list]');
    const list = listTarget?.dataset['keyboardList'];
    if (list === 'main' || list === 'secondary') {
      this.currentList.set(list);
      this.keyboardZone.set(list);
      const taskId = listTarget?.dataset['keyboardTask'];
      this.activeKeyboardTask.set(taskId ? { list, id: taskId } : null);
      return;
    }

    if (target.closest('[data-keyboard-section]')) {
      this.focusTabsForKeyboard();
    }
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(
      target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]')
    );
  }
}
