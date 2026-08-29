import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, Injector, inject, signal, viewChild, ElementRef, OnDestroy, HostListener } from '@angular/core';
import { CdkDragDrop, CdkDrag, CdkDropList, CdkDragPlaceholder, moveItemInArray } from '@angular/cdk/drag-drop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { driver, type DriveStep } from 'driver.js';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { StorageService, StoredSection, StoredList, StoredItem } from '../../services/storage.service';
import { SyncService } from '../../services/sync.service';
import { openExternalUrl } from '../../utils/external-link';
import { NativePlatformService } from '../../services/native-platform.service';
import { DeadlineNotificationsService } from '../../services/deadline-notifications.service';
import { environment } from '../../../environments/environment';
import {
  completedItemsBeyondRetention,
  SINGLE_LIST_COMPLETED_RETENTION,
} from '../../utils/completed-task-retention';

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
  deadlineAt?: string | null;
  deadlineTimeZone?: string | null;
  deadlineNotificationEnabled: boolean;
  deadlineScheduleId?: string;
  lastModifiedAt?: string;
  serverRevision?: number;
}

interface DoneTask extends Task {
  doneAt: string;
}

interface TextSegment {
  text: string;
  href: string | null;
}

interface TaskDropTarget {
  dropZone: HTMLElement;
  taskSelector: string;
}

interface PendingTaskDrag {
  inputType: 'pointer' | 'touch';
  sourceSectionId: string;
  sourceIndex: number;
  task: Task;
  pointerId: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  offsetX: number;
  offsetY: number;
  previewWidth: number;
  previewHeight: number;
  element: HTMLElement;
}

interface TaskDragState {
  sourceSectionId: string;
  sourceIndex: number;
  targetIndex: number;
  targetSectionId: string | null;
  task: Task;
  pointerId: number;
  lastClientX: number;
  lastClientY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  previewX: number;
  previewY: number;
  previewWidth: number;
  previewHeight: number;
}
type KeyboardZone = 'pages' | 'tasks';
type SectionDeleteOption = 'delete' | 'cancel';
type InfoDialogKind = 'shared-page' | 'private-welcome';
type ShareDialogMode = 'enabled' | 'disabled' | 'viewer';

const MAX_SECTIONS = 100;
const MAX_FREE_SECTIONS = 2;
const MAX_FREE_TASKS_PER_PAGE = 30;
const MAX_TASKS_PER_PAGE = 1000;
// The former two-list model retained ten completed tasks per list. Keeping
// twenty after the deterministic merge prevents an upgrade from deleting the
// completed half of a fully populated page.
const MAX_DONE_TASKS = SINGLE_LIST_COMPLETED_RETENTION;
const PUBLIC_PERIODIC_SYNC_MS = 10_000;
const PRIVATE_PERIODIC_SYNC_MS = 10_000;
const MOBILE_TOUCH_DRAG_START_DELAY_MS = 120;
const DESKTOP_TASK_AUTO_SCROLL_MAX_DELTA = 24;
const MOBILE_TASK_AUTO_SCROLL_MAX_DELTA = 1;
const PRIVATE_WELCOME_DIALOG_PENDING_KEY = 'splendide_private_welcome_dialog_pending';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDrag, CdkDropList, CdkDragPlaceholder, RouterLink],
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
  private readonly nativePlatform = inject(NativePlatformService);
  private readonly deadlineNotifications = inject(DeadlineNotificationsService);

  protected readonly dark = this.theme.dark;
  protected readonly publicLoadFailed = signal(false);
  protected readonly shareMenuOpen = signal(false);
  protected readonly shareDialogMode = signal<ShareDialogMode>('enabled');
  protected readonly shareToastVisible = signal(false);
  protected readonly premiumUpgradePromptOpen = signal(false);
  protected readonly premiumUpgradePromptDescription = signal('create more pages for larger work sessions');
  protected readonly infoDialog = signal<InfoDialogKind | null>(null);
  protected readonly isPublicPage = computed(() => false);

  // ─── Sections ───────────────────────────────────────────
  protected readonly sections = signal<StoredSection[]>([]);
  protected readonly activeSectionId = signal<string | null>(null);
  protected readonly activeSection = computed(() => this.sections().find(s => s.id === this.activeSectionId()) ?? null);
  protected readonly canAddSection = computed(() => {
    const maxSections = this.auth.isPremium() ? MAX_SECTIONS : MAX_FREE_SECTIONS;
    return this.sections().filter(section => this.isSectionOwner(section)).length < maxSections;
  });

  // ─── Section editing ────────────────────────────────────
  protected readonly editingSectionId = signal<string | null>(null);
  protected readonly addingSectionTitle = signal<string | null>(null);
  protected readonly confirmingDeleteSectionId = signal<string | null>(null);
  protected readonly sectionMenuOpen = signal(false);

  // ─── Active section lists ───────────────────────────────
  protected readonly taskList = computed(() => {
    const sec = this.activeSection();
    return sec?.lists[0] ?? null;
  });

  // ─── Tasks from active lists ────────────────────────────
  protected readonly tasks = computed<Task[]>(() => this.visibleTasks(this.taskList()));
  protected readonly doneTasks = computed<DoneTask[]>(() =>
    this.doneTasksForList(this.taskList())
      .sort((left, right) => this.compareDoneTasksNewestFirst(left, right))
      .slice(0, MAX_DONE_TASKS),
  );
  protected readonly doneTaskCount = computed(() => this.doneTasks().length);

  // ─── Task state ────────────────────────────────────────
  protected readonly adding = signal(false);
  protected readonly newTaskText = signal('');
  protected readonly newSubtasks = signal<string[]>([]);
  protected readonly editingTaskId = signal<string | null>(null);
  protected readonly editingSubtask = signal<{ taskId: string; subtaskId: string } | null>(null);
  protected readonly addingSubtaskToId = signal<string | null>(null);
  protected readonly newInlineSubtaskText = signal('');
  protected readonly deadlineEditorTaskId = signal<string | null>(null);
  protected readonly deadlineEditorTask = computed(() => {
    const id = this.deadlineEditorTaskId();
    return id ? this.tasks().find(task => task.id === id) ?? null : null;
  });
  protected readonly deadlineDraftLocal = signal('');
  protected readonly deadlineNotificationDraft = signal(false);
  protected readonly deadlinePermissionMessage = signal('');
  protected readonly deadlineDialog = viewChild<ElementRef<HTMLElement>>('deadlineDialog');
  protected readonly taskMoveDialog = viewChild<ElementRef<HTMLElement>>('taskMoveDialog');
  private readonly userMenuTrigger = viewChild<ElementRef<HTMLButtonElement>>('userMenuTrigger');

  protected readonly taskCount = computed(() => this.tasks().length);
  protected readonly completedCount = computed(() => this.tasks().filter(t => t.done).length);
  protected readonly canAdd = computed(() => this.canAddTask());
  protected readonly showAddPlaceholder = computed(() => this.canAdd() || this.freeOwnedTaskLimitApplies());
  protected readonly allDone = computed(() => {
    const t = this.tasks();
    return t.length > 0 && t.every(task => task.done && task.subtasks.every(s => s.done));
  });

  // ─── Task dot menus (mobile) ────────────────────────────
  protected readonly taskMenuOpenId = signal<string | null>(null);
  protected readonly taskMoveDialogTaskId = signal<string | null>(null);
  protected readonly taskMoveDialogTask = computed(() => {
    const id = this.taskMoveDialogTaskId();
    return id ? this.tasks().find(task => task.id === id) ?? null : null;
  });
  protected readonly taskMoveTargetSections = computed(() => {
    const activeId = this.activeSectionId();
    return this.sections().filter(section => section.id !== activeId && this.canAddTask(section));
  });

  // ─── User menu ──────────────────────────────────────────
  protected readonly menuOpen = signal(false);

  protected readonly keyboardZone = signal<KeyboardZone | null>(null);
  protected readonly activeKeyboardTaskId = signal<string | null>(null);
  protected readonly sectionDeleteConfirmFocus = signal<SectionDeleteOption>('delete');

  // ─── Global editing guard ──────────────────────────────
  protected readonly isEditing = computed(() =>
    this.adding() ||
    this.editingTaskId() !== null ||
    this.editingSubtask() !== null ||
    this.addingSubtaskToId() !== null ||
    this.deadlineEditorTaskId() !== null ||
    this.taskMoveDialogTaskId() !== null ||
    this.editingSectionId() !== null ||
    this.addingSectionTitle() !== null ||
    this.taskMoveInProgress()
  );

  protected readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth <= 768);
  protected readonly isElectronApp = environment.isElectron;
  protected readonly dragging = signal(false);
  protected readonly taskDragState = signal<TaskDragState | null>(null);
  protected readonly taskPageDropTargetId = signal<string | null>(null);
  protected readonly taskMoveAnnouncement = signal('');
  protected readonly taskMoveInProgress = signal(false);
  protected readonly dragDelay = computed(() => ({
    touch: MOBILE_TOUCH_DRAG_START_DELAY_MS,
    mouse: 0,
  }));
  protected readonly activeSectionIndex = computed(() => this.sections().findIndex(s => s.id === this.activeSectionId()));
  protected readonly showPrevArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() > 0);
  protected readonly showNextArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() < this.sections().length - 1);
  protected readonly activeSectionIsOwner = computed(() => {
    const section = this.activeSection();
    return section ? this.isSectionOwner(section) : false;
  });
  protected readonly activeSectionShareUrl = computed(() => {
    const token = this.activeSection()?.shareToken;
    return token ? `${environment.webUrl}/share/${token}` : '';
  });

  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private periodicSyncPromise: Promise<void> | null = null;
  private shareToastTimer: ReturnType<typeof setTimeout> | null = null;
  private firstVisitCoachMarksPending = false;
  private coachMarksScheduled = false;
  private coachDriver: ReturnType<typeof driver> | null = null;
  private horizontalScrollGuardFrame: number | null = null;
  private taskAutoScrollFrame: number | null = null;
  private taskLayoutAnimationFrame: number | null = null;
  private taskLayoutAnimationCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private taskTouchDragStartTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTaskDrag: PendingTaskDrag | null = null;
  private activeTaskDragElement: HTMLElement | null = null;
  private suppressNextTaskClick = false;
  private suppressTaskClickTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineDialogReturnFocus: HTMLElement | null = null;
  private taskMoveDialogReturnFocus: HTMLElement | null = null;
  private readonly handleDocumentTouchMove = (event: TouchEvent): void => this.handleTaskTouchMove(event);
  private readonly handleDocumentTouchEnd = (event: TouchEvent): void => this.finishTaskTouchDrag(event);
  private readonly handleDocumentTouchCancel = (event: TouchEvent): void => this.cancelTaskTouchDrag(event);
  private horizontalScrollLocks: Array<{
    target: Window | HTMLElement;
    scrollBy: typeof window.scrollBy;
    scrollTo: typeof window.scrollTo;
    scroll: typeof window.scroll;
  }> = [];

  constructor() {
    const finishInitialDeadlineReconciliation = this.deadlineNotifications.deferElectronReconciliation();
    this.addTaskTouchListeners();
    effect(() => {
      const target = this.deadlineNotifications.openedDeadline();
      if (!target) return;

      const section = this.sections().find(candidate => candidate.id === target.pageId);
      const taskExists = section?.lists.some(list => list.items.some(item =>
        item.id === target.taskId && !item.deleted,
      ));
      if (!section || !taskExists) return;

      this.setActiveSection(section.id, { persist: !this.isShareRouteUrl() });
      this.setActiveKeyboardTask(target.taskId);
      this.deadlineNotifications.clearOpenedDeadline();
    });
    if (!this.isShareRouteUrl()) {
      this.showPendingPrivateWelcomeDialog();
    }
    void this.initFromStorage().finally(() => finishInitialDeadlineReconciliation());
  }

  @HostListener('document:keydown', ['$event'])
  protected handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    if (this.menuOpen() && event.key === 'Escape') {
      event.preventDefault();
      this.menuOpen.set(false);
      queueMicrotask(() => this.userMenuTrigger()?.nativeElement.focus());
      return;
    }
    if (this.deadlineEditorTaskId() !== null) {
      this.handleModalKeydown(event, this.deadlineDialog()?.nativeElement, () => this.closeDeadlineEditor());
      return;
    }
    if (this.taskMoveDialogTaskId() !== null) {
      this.handleModalKeydown(event, this.taskMoveDialog()?.nativeElement, () => this.closeTaskMoveDialog());
      return;
    }
    if (event.repeat) return;
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
    if (this.taskDragState()) {
      if (event.key === 'Escape') this.cancelTaskPointerDrag();
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
    const interactiveTarget = this.isInteractiveTarget(event.target);
    if (interactiveTarget && event.key === 'Tab') return;
    if (event.key === 'Tab') {
      event.preventDefault();
      if (!event.shiftKey && !this.isEditing()) this.addSubtaskForActiveTask();
      return;
    }
    if (interactiveTarget) {
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
        if (this.deleteActivePageOrTask()) {
          event.preventDefault();
        }
        break;
    }
  }

  @HostListener('document:click', ['$event'])
  protected handleDocumentClick(event: MouseEvent): void {
    if (this.suppressNextTaskClick) {
      this.suppressNextTaskClick = false;
      if (this.suppressTaskClickTimer !== null) {
        clearTimeout(this.suppressTaskClickTimer);
        this.suppressTaskClickTimer = null;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    const target = event.target as HTMLElement;

    if (this.confirmingClear() && !target.closest('[data-confirm-clear]')) {
      this.cancelClear();
    }
    if (this.confirmingDeleteSectionId() !== null && !target.closest('[data-confirm-delete-section]')) {
      this.cancelDeleteSection();
    }
    if (this.taskMenuOpenId() !== null && !target.closest('[data-task-menu]')) {
      this.taskMenuOpenId.set(null);
    }
    if (this.shareMenuOpen() && !target.closest('[data-public-share]')) {
      this.shareMenuOpen.set(false);
    }
  }

  @HostListener('document:pointermove', ['$event'])
  protected handleDocumentPointerMove(event: PointerEvent): void {
    this.handleTaskPointerMove(event);
  }

  @HostListener('document:pointerup', ['$event'])
  protected handleDocumentPointerUp(event: PointerEvent): void {
    this.finishTaskPointerDrag(event);
  }

  @HostListener('document:pointercancel', ['$event'])
  protected handleDocumentPointerCancel(event: PointerEvent): void {
    this.cancelTaskPointerDrag(event);
  }

  @HostListener('window:resize')
  protected handleWindowResize(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const mobile = width <= 768;
    if (mobile === this.isMobile()) return;
    this.isMobile.set(mobile);
    this.taskMenuOpenId.set(null);
    if (mobile) {
      this.stopHorizontalScrollGuard();
      this.unlockHorizontalDragScroll();
    }
  }

  @HostListener('window:splendide-app-resume')
  protected async handleNativeAppResume(): Promise<void> {
    if (this.shouldSkipPeriodicSync()) return;
    if (this.auth.isLoggedIn()) {
      await this.auth.fetchUser();
      await this.doPeriodicSync();
    } else {
      await this.doAnonymousSharedPeriodicSync();
    }
  }

  ngOnDestroy(): void {
    this.stopPeriodicSync();
    this.coachDriver?.destroy();
    this.coachDriver = null;
    if (this.shareToastTimer !== null) {
      clearTimeout(this.shareToastTimer);
      this.shareToastTimer = null;
    }
    if (this.suppressTaskClickTimer !== null) {
      clearTimeout(this.suppressTaskClickTimer);
      this.suppressTaskClickTimer = null;
    }
    this.stopHorizontalScrollGuard();
    this.unlockHorizontalDragScroll();
    this.removeTaskTouchListeners();
    this.cancelTaskPointerDrag();
    document.body.classList.remove('native-dragging');
  }

  private async initFromStorage(): Promise<void> {
    await this.auth.waitForSessionReady();
    const shareToken = this.route.snapshot.paramMap.get('token');
    if (this.isShareRouteUrl() && shareToken) {
      await this.initSharedSection(shareToken);
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

    let loaded = this.storage.loadSections();
    this.setSections(loaded);
    this.restoreActiveSection(loaded, [this.storage.getActiveSectionPreference()]);

    if (this.auth.isLoggedIn()) {
      await this.doFullSync();
    } else {
      if (loaded.length === 0 && this.storage.ensureDefaultPartition()) {
        loaded = this.storage.loadSections();
        this.setSections(loaded);
        this.restoreActiveSection(loaded, [this.storage.getActiveSectionPreference()]);
      }
      this.ensureLocalTaskListsForSections();
      this.startPeriodicSync();
    }

    this.firstVisitCoachMarksPending = shouldShowCoachMarks;
    this.showPendingPrivateWelcomeDialog();
    this.maybeScheduleFirstVisitCoachMarks();
  }

  private async initSharedSection(shareToken: string): Promise<void> {
    this.publicLoadFailed.set(false);
    if (this.auth.isLoggedIn()) {
      await this.auth.fetchUser();
    }
    this.storage.setActivePartition(this.auth.user()?.id);

    try {
      const section = await this.sync.loadSharedSection(shareToken);
      this.refreshSectionsFromStorage();
      this.setActiveSection(section.id, { persist: false });
      this.clearKeyboardFocus();
      this.startPeriodicSync();
    } catch {
      this.publicLoadFailed.set(true);
      this.setSections([]);
      this.setActiveSection(null, { persist: false });
    }
  }

  private isShareRouteUrl(): boolean {
    const path = this.router.url.split('?')[0]?.split('#')[0] ?? '/';
    return path.startsWith('/share/');
  }

  private async doFullSync(): Promise<void> {
    try {
      const synced = await this.sync.syncSections();
      this.setSections(synced);
      await this.hydrateMissingSectionLists();
      const sections = this.sections();
      this.restoreActiveSection(sections);
      for (const section of sections) {
        await this.doSyncSection(section.id);
      }
    } catch { /* silently fail */ }
    this.startPeriodicSync();
  }

  private startPeriodicSync(): void {
    this.stopPeriodicSync();
    const intervalMs = this.auth.isLoggedIn() ? PRIVATE_PERIODIC_SYNC_MS : PUBLIC_PERIODIC_SYNC_MS;
    this.syncIntervalId = setInterval(async () => {
      if (this.shouldSkipPeriodicSync()) return;
      if (this.auth.isLoggedIn() && this.canUseElectronDeadlineOnlyPass()) {
        await this.deadlineNotifications.refreshElectronDeadlineSnapshot().catch(() => undefined);
        return;
      }
      if (this.auth.isLoggedIn()) {
        await this.auth.fetchUser();
      }
      if (this.shouldSkipPeriodicSync()) return;
      if (this.auth.isLoggedIn()) {
        await this.doPeriodicSync();
      } else {
        await this.doAnonymousSharedPeriodicSync();
      }
    }, intervalMs);
  }

  private stopPeriodicSync(): void {
    if (this.syncIntervalId === null) return;
    clearInterval(this.syncIntervalId);
    this.syncIntervalId = null;
  }

  private doPeriodicSync(): Promise<void> {
    if (this.periodicSyncPromise) return this.periodicSyncPromise;
    const run = this.performPeriodicSync();
    const tracked = run.finally(() => {
      if (this.periodicSyncPromise === tracked) this.periodicSyncPromise = null;
    });
    this.periodicSyncPromise = tracked;
    return tracked;
  }

  private async performPeriodicSync(): Promise<void> {
    if (this.shouldSkipPeriodicSync()) return;
    const finishDeadlineReconciliation = this.deadlineNotifications.deferElectronReconciliation();
    try {
      const synced = await this.sync.syncSections();
      if (this.shouldSkipPeriodicSync()) return;
      this.setSections(synced);
      await this.hydrateMissingSectionLists();
      const refreshed = this.sections();
      const activeId = this.activeSectionId();
      const syncedActiveId = this.resolveSectionId(refreshed, [
        activeId,
        this.storage.getActiveSectionPreference(),
      ]);
      if (syncedActiveId !== activeId) {
        this.setActiveSection(syncedActiveId);
      }

      const locallyChangedPageIds = refreshed
        .filter(section => section.lists.some(list =>
          list.dirty || list.itemsOrderDirty || list.items.some(item => item.dirty || item.created),
        ))
        .map(section => section.id);
      const sectionIdsToRefresh = [syncedActiveId, ...locallyChangedPageIds]
        .filter((sectionId): sectionId is string =>
          !!sectionId && refreshed.some(section => section.id === sectionId),
        )
        .filter((sectionId, index, sectionIds) => sectionIds.indexOf(sectionId) === index);
      let allRelevantPagesSynced = true;
      for (const sectionId of sectionIdsToRefresh) {
        allRelevantPagesSynced = await this.doSyncSection(sectionId) && allRelevantPagesSynced;
      }
      if (allRelevantPagesSynced && !this.shouldSkipPeriodicSync()) {
        await this.deadlineNotifications.refreshElectronDeadlineSnapshot();
      }
    } catch { /* silently fail */ }
    finally {
      await finishDeadlineReconciliation();
    }
  }

  private shouldSkipPeriodicSync(): boolean {
    return this.isEditing() || this.dragging();
  }

  private canUseElectronDeadlineOnlyPass(): boolean {
    if (!environment.isElectron || document.visibilityState !== 'hidden') return false;
    return !this.sections().some(section =>
      section.created || section.dirty || section.lists.some(list =>
        list.dirty || list.itemsOrderDirty || list.items.some(item => item.dirty || item.created),
      ),
    );
  }

  private async doAnonymousSharedPeriodicSync(): Promise<void> {
    const sharedSections = this.sections().filter(section => section.shareToken && !section.deleted);
    if (sharedSections.length === 0) return;
    const finishDeadlineReconciliation = this.deadlineNotifications.deferElectronReconciliation();
    try {
      for (const section of sharedSections) {
        await this.doSyncSection(section.id);
        if (this.shouldSkipPeriodicSync()) return;
      }
    } finally {
      await finishDeadlineReconciliation();
    }
  }

  private handleSharedSectionSyncFailure(sectionId: string, error: unknown): void {
    if (!(error instanceof HttpErrorResponse) || error.status !== 404) return;
    const section = this.storage.getSection(sectionId);
    if (!section?.shareToken && !section?.sharedAccess) return;

    this.storage.removeSection(sectionId);
    this.refreshSectionsFromStorage();
    if (this.activeSectionId() !== sectionId) return;

    const nextSection = this.sections()[0] ?? null;
    this.setActiveSection(nextSection?.id ?? null, { persist: !this.isShareRouteUrl() });
    if (!nextSection || this.isShareRouteUrl()) {
      this.publicLoadFailed.set(true);
    }
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

  private async doSyncSection(sectionId: string): Promise<boolean> {
    try {
      const lists = await this.sync.syncSectionLists(sectionId);
      for (const list of lists) {
        await this.sync.syncListItems(sectionId, list.id);
      }
      const overflowListIds = this.enforceDoneTaskLimit(sectionId);
      for (const listId of overflowListIds) {
        await this.sync.syncListItems(sectionId, listId);
      }
      this.refreshSectionsFromStorage();
      return true;
    } catch (error) {
      this.handleSharedSectionSyncFailure(sectionId, error);
      return false;
    }
  }

  private async hydrateMissingSectionLists(sectionIds?: string[]): Promise<void> {
    if (!this.auth.isLoggedIn()) return;

    const ids = sectionIds ?? this.sections().map(section => section.id);
    for (const sectionId of ids) {
      const section = this.sections().find(existing => existing.id === sectionId);
      if (!section || this.sectionHasTaskList(section)) continue;

      try {
        await this.sync.syncSectionLists(sectionId);
        this.refreshSectionsFromStorage();
      } catch {
        // Keep the local section unchanged if we could not verify the backend state.
      }
    }
  }

  private sectionHasTaskList(section: StoredSection | null): boolean {
    return section?.lists.length === 1;
  }

  private ensureLocalTaskList(sectionId: string): void {
    if (this.storage.ensureSectionHasTaskList(sectionId)) {
      this.refreshSectionsFromStorage();
    }
  }

  private ensureLocalTaskListsForSections(): void {
    let changed = false;
    for (const section of this.sections()) {
      if (!this.sectionHasTaskList(section)) {
        changed = this.storage.ensureSectionHasTaskList(section.id) || changed;
      }
    }
    if (changed) this.refreshSectionsFromStorage();
  }

  private refreshSectionsFromStorage(): void {
    const sections = this.storage.loadSections();
    this.setSections(sections);
  }

  private setSections(sections: StoredSection[]): void {
    this.sections.set(sections);
    void this.deadlineNotifications.reconcileDeadlines(sections);
  }

  private resolveSectionId(
    sections: StoredSection[],
    preferredIds: Array<string | null | undefined>,
  ): string | null {
    for (const id of preferredIds) {
      if (id && sections.some(section => section.id === id)) return id;
    }
    return sections[0]?.id ?? null;
  }

  private setActiveSection(sectionId: string | null, options?: { persist?: boolean }): void {
    this.activeSectionId.set(sectionId);
    if (options?.persist !== false && !this.isShareRouteUrl()) {
      this.storage.setActiveSectionPreference(sectionId);
    }
  }

  private restoreActiveSection(
    sections: StoredSection[] = this.sections(),
    preferredIds: Array<string | null | undefined> = [
      this.activeSectionId(),
      this.storage.getActiveSectionPreference(),
    ],
    options?: { persist?: boolean },
  ): string | null {
    const sectionId = this.resolveSectionId(sections, preferredIds);
    this.setActiveSection(sectionId, options);
    return sectionId;
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

    const taskListTarget = document.querySelector<HTMLElement>('.task-list-container');
    const createSectionTarget = Array.from(
      document.querySelectorAll<HTMLElement>('[data-coach-create-section]'),
    ).find(element => element.offsetParent !== null || element.getClientRects().length > 0);
    const shareTarget = document.querySelector<HTMLElement>('[data-coach-share]');
    if (!taskListTarget || !createSectionTarget) return;

    const coachSteps: DriveStep[] = [
      {
        element: taskListTarget,
        popover: {
          title: 'Keep every task in one calm list',
          side: 'right',
          align: 'start',
        },
      },
      {
        element: createSectionTarget,
        popover: {
          title: 'Add pages, then drag tasks onto their tabs',
          side: 'bottom',
          align: 'start',
        },
      },
    ];

    if (shareTarget) {
      coachSteps.push({
        element: shareTarget,
        popover: {
          title: 'Share a page',
          side: 'bottom',
          align: 'start',
        },
      });
    }

    this.coachDriver?.destroy();
    this.coachDriver = driver({
      allowClose: false,
      animate: true,
      overlayOpacity: 0.28,
      stagePadding: 6,
      showButtons: ['next'],
      nextBtnText: 'next &rarr;',
      doneBtnText: 'done',
      steps: coachSteps,
    });
    this.coachDriver.drive();
  }

  protected setDragging(value: boolean): void {
    const changed = this.dragging() !== value;
    this.dragging.set(value);
    document.body.classList.toggle('native-dragging', value);
    if (changed) {
      void (value ? this.nativePlatform.dragStarted() : this.nativePlatform.dropCompleted());
    }
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

  protected beginTaskPointerDrag(
    event: PointerEvent,
    task: Task,
    sourceIndex: number,
  ): void {
    if (this.isEditing() || this.coachDriver?.isActive()) return;
    if (event.pointerType === 'touch') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this.isTaskDragIgnoredTarget(event.target)) return;

    const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (!element) return;

    if (this.pendingTaskDrag || this.taskDragState()) this.clearTaskPointerDrag();
    event.preventDefault();
    event.stopPropagation();
    this.clearTextSelection();

    this.pendingTaskDrag = this.createPendingTaskDrag(
      sourceIndex,
      task,
      'pointer',
      event.pointerId,
      { x: event.clientX, y: event.clientY },
      element,
    );
    this.activeTaskDragElement = element;
    this.captureTaskPointer(element, event.pointerId);
    this.setActiveKeyboardTask(task.id);
    this.taskMenuOpenId.set(null);
  }

  protected beginTaskTouchDrag(
    event: TouchEvent,
    task: Task,
    sourceIndex: number,
  ): void {
    if (this.isEditing() || this.coachDriver?.isActive()) return;
    if (event.touches.length !== 1) return;
    if (this.isTaskDragIgnoredTarget(event.target)) return;

    const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const touch = event.touches.item(0);
    if (!element || !touch) return;

    if (this.pendingTaskDrag || this.taskDragState()) this.clearTaskPointerDrag();

    this.clearTextSelection();
    const pending = this.createPendingTaskDrag(
      sourceIndex,
      task,
      'touch',
      touch.identifier,
      { x: touch.clientX, y: touch.clientY },
      element,
    );
    this.pendingTaskDrag = pending;
    this.activeTaskDragElement = element;
    this.setActiveKeyboardTask(task.id);
    this.taskMenuOpenId.set(null);

    this.clearTaskTouchDragStartTimer();
    this.taskTouchDragStartTimer = setTimeout(() => {
      if (this.pendingTaskDrag !== pending || this.taskDragState()) return;
      this.startTaskPointerDrag(pending, { x: pending.latestX, y: pending.latestY });
    }, MOBILE_TOUCH_DRAG_START_DELAY_MS);
  }

  private createPendingTaskDrag(
    sourceIndex: number,
    task: Task,
    inputType: PendingTaskDrag['inputType'],
    pointerId: number,
    clientPoint: { x: number; y: number },
    element: HTMLElement,
  ): PendingTaskDrag {
    const sourceSectionId = this.activeSectionId();
    if (!sourceSectionId) throw new Error('Cannot drag a task without an active page');
    const rect = element.getBoundingClientRect();
    return {
      inputType,
      sourceSectionId,
      sourceIndex,
      task,
      pointerId,
      startX: clientPoint.x,
      startY: clientPoint.y,
      latestX: clientPoint.x,
      latestY: clientPoint.y,
      offsetX: clientPoint.x - rect.left,
      offsetY: clientPoint.y - rect.top,
      previewWidth: rect.width,
      previewHeight: rect.height,
      element,
    };
  }

  protected handleTaskDragScroll(): void {
    const drag = this.taskDragState();
    if (!drag) return;
    this.updateTaskDragForPoint(this.currentTaskDragPoint(drag), true, this.rawTaskDragPoint(drag));
  }

  protected showTaskDragPlaceholder(index: number): boolean {
    const drag = this.taskDragState();
    if (!drag || drag.targetSectionId !== null) return false;

    const renderedIndex =
      drag.targetIndex > drag.sourceIndex ? drag.targetIndex + 1 : drag.targetIndex;
    return renderedIndex === index;
  }

  protected isTaskDragSource(taskId: string): boolean {
    return this.taskDragState()?.task.id === taskId;
  }

  protected taskDragPlaceholderHeight(): number {
    return Math.max(36, this.taskDragState()?.previewHeight ?? 46);
  }

  protected taskDragPreviewTransform(): string {
    const drag = this.taskDragState();
    return drag ? `translate3d(${drag.previewX}px, ${drag.previewY}px, 0)` : '';
  }

  private handleTaskPointerMove(event: PointerEvent): void {
    const drag = this.taskDragState();
    const pending = this.pendingTaskDrag;
    if (pending?.inputType === 'touch') return;
    const pointerId = drag?.pointerId ?? pending?.pointerId;
    if (pointerId === undefined || event.pointerId !== pointerId) return;

    if (!drag) {
      if (!pending) return;
      pending.latestX = event.clientX;
      pending.latestY = event.clientY;
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      const threshold = event.pointerType === 'touch' ? 8 : 4;
      if (distance < threshold) return;
      this.startTaskPointerDrag(pending, { x: event.clientX, y: event.clientY });
    } else {
      this.updateTaskDragForPoint({ x: event.clientX, y: event.clientY });
    }

    event.preventDefault();
    event.stopPropagation();
  }

  private finishTaskPointerDrag(event: PointerEvent): void {
    const drag = this.taskDragState();
    const pending = this.pendingTaskDrag;
    if (pending?.inputType === 'touch') return;
    const pointerId = drag?.pointerId ?? pending?.pointerId;
    if (pointerId === undefined || event.pointerId !== pointerId) return;

    if (!drag) {
      this.clearTaskPointerDrag();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.updateTaskDragForPoint({ x: event.clientX, y: event.clientY }, false);
    const finalDrag = this.taskDragState();
    const previousRects = this.captureTaskLayoutRects();
    if (finalDrag) this.commitTaskDrag(finalDrag);
    this.clearTaskPointerDrag();
    this.animateTaskLayoutChange(previousRects);
    this.suppressTaskClickOnce();
  }

  private cancelTaskPointerDrag(event?: PointerEvent): void {
    const drag = this.taskDragState();
    const pending = this.pendingTaskDrag;
    if (event && pending?.inputType === 'touch') return;
    const pointerId = drag?.pointerId ?? pending?.pointerId;
    if (event && pointerId !== undefined && event.pointerId !== pointerId) return;
    if (event) event.preventDefault();
    this.clearTaskPointerDrag();
  }

  private startTaskPointerDrag(pending: PendingTaskDrag, clientPoint: { x: number; y: number }): void {
    this.clearTaskTouchDragStartTimer();
    this.suppressTaskClickOnce();
    this.taskDragState.set({
      sourceSectionId: pending.sourceSectionId,
      sourceIndex: pending.sourceIndex,
      targetIndex: pending.sourceIndex,
      targetSectionId: null,
      task: pending.task,
      pointerId: pending.pointerId,
      lastClientX: clientPoint.x,
      lastClientY: clientPoint.y,
      pointerOffsetX: pending.offsetX,
      pointerOffsetY: pending.offsetY,
      previewX: clientPoint.x - pending.offsetX,
      previewY: clientPoint.y - pending.offsetY,
      previewWidth: pending.previewWidth,
      previewHeight: pending.previewHeight,
    });
    this.setDragging(true);
    this.updateTaskDragForPoint(clientPoint);
    this.startTaskAutoScrollLoop();
  }

  private updateTaskDragForPoint(
    clientPoint: { x: number; y: number },
    allowAutoScroll = true,
    rawClientPoint = clientPoint,
  ): void {
    const drag = this.taskDragState();
    if (!drag) return;

    const pageTargetId = !this.isMobile()
      ? this.taskPageTargetFromClientPoint(rawClientPoint)
      : null;
    const targetSectionId = pageTargetId && pageTargetId !== drag.sourceSectionId
      ? pageTargetId
      : null;
    const target = this.taskDropTargetFromClientPoint(clientPoint);
    let targetIndex = drag.targetIndex;

    if (!targetSectionId && target) {
      if (allowAutoScroll) this.scrollTaskDropTargetNearEdge(target.dropZone, rawClientPoint);
      targetIndex = this.taskDropIndexFromClientPoint(
        target.dropZone,
        target.taskSelector,
        clientPoint,
        targetIndex,
        this.activeTaskDragElement,
      );
    }

    const previousRects =
      targetSectionId !== drag.targetSectionId || targetIndex !== drag.targetIndex
        ? this.captureTaskLayoutRects()
        : null;

    this.taskPageDropTargetId.set(targetSectionId);
    this.taskDragState.set({
      ...drag,
      targetIndex,
      targetSectionId,
      lastClientX: rawClientPoint.x,
      lastClientY: rawClientPoint.y,
      previewX: clientPoint.x - drag.pointerOffsetX,
      previewY: clientPoint.y - drag.pointerOffsetY,
    });
    if (previousRects) this.animateTaskLayoutChange(previousRects);
    this.clearTextSelection();

    if (!this.isMobile()) this.resetHorizontalListScroll();
  }

  private startTaskAutoScrollLoop(): void {
    if (typeof window === 'undefined' || this.taskAutoScrollFrame !== null) return;

    const tick = () => {
      const drag = this.taskDragState();
      if (!drag) {
        this.taskAutoScrollFrame = null;
        return;
      }

      const clientPoint = this.currentTaskDragPoint(drag);
      const rawClientPoint = this.rawTaskDragPoint(drag);
      const target =
        this.taskDropTargetFromClientPoint(clientPoint) ??
        this.taskDropTargetFromClientPoint(rawClientPoint);
      if (target && this.scrollTaskDropTargetNearEdge(target.dropZone, rawClientPoint)) {
        this.updateTaskDragForPoint(clientPoint, false, rawClientPoint);
      }
      this.taskAutoScrollFrame = window.requestAnimationFrame(tick);
    };

    this.taskAutoScrollFrame = window.requestAnimationFrame(tick);
  }

  private stopTaskAutoScrollLoop(): void {
    if (this.taskAutoScrollFrame === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(this.taskAutoScrollFrame);
    this.taskAutoScrollFrame = null;
  }

  private currentTaskDragPoint(drag: TaskDragState): { x: number; y: number } {
    return {
      x: drag.previewX + drag.pointerOffsetX,
      y: drag.previewY + drag.pointerOffsetY,
    };
  }

  private rawTaskDragPoint(drag: TaskDragState): { x: number; y: number } {
    return {
      x: drag.lastClientX,
      y: drag.lastClientY,
    };
  }

  private clearTaskPointerDrag(): void {
    this.releaseTaskPointerCapture();
    this.clearTaskTouchDragStartTimer();
    this.pendingTaskDrag = null;
    this.activeTaskDragElement = null;
    this.taskDragState.set(null);
    this.taskPageDropTargetId.set(null);
    this.stopTaskAutoScrollLoop();
    this.resetTaskLayoutAnimationStyles();
    if (this.dragging()) this.setDragging(false);
  }

  private addTaskTouchListeners(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('touchmove', this.handleDocumentTouchMove, { passive: false });
    document.addEventListener('touchend', this.handleDocumentTouchEnd);
    document.addEventListener('touchcancel', this.handleDocumentTouchCancel);
  }

  private removeTaskTouchListeners(): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('touchmove', this.handleDocumentTouchMove);
    document.removeEventListener('touchend', this.handleDocumentTouchEnd);
    document.removeEventListener('touchcancel', this.handleDocumentTouchCancel);
  }

  private handleTaskTouchMove(event: TouchEvent): void {
    const drag = this.taskDragState();
    const pending = this.pendingTaskDrag;
    const touch = this.changedTaskTouch(event);
    if (!touch) return;

    if (!drag) {
      if (!pending) return;
      pending.latestX = touch.clientX;
      pending.latestY = touch.clientY;
      const distance = Math.hypot(touch.clientX - pending.startX, touch.clientY - pending.startY);
      if (distance < 8) return;
      this.suppressTaskClickOnce();
      this.clearTaskPointerDrag();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rawClientPoint = { x: touch.clientX, y: touch.clientY };
    this.updateTaskDragForPoint(rawClientPoint, true, rawClientPoint);
  }

  private finishTaskTouchDrag(event: TouchEvent): void {
    const drag = this.taskDragState();
    const pending = this.pendingTaskDrag;
    const touch = this.changedTaskTouch(event);
    if (!touch) return;

    if (!drag) {
      if (pending) this.clearTaskPointerDrag();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rawClientPoint = { x: touch.clientX, y: touch.clientY };
    this.updateTaskDragForPoint(rawClientPoint, false, rawClientPoint);
    const finalDrag = this.taskDragState();
    if (finalDrag) this.commitTaskDrag(finalDrag);
    this.clearTaskPointerDrag();
    this.suppressTaskClickOnce();
  }

  private cancelTaskTouchDrag(event: TouchEvent): void {
    const drag = this.taskDragState();
    const touch = this.changedTaskTouch(event);
    if (!touch) return;
    if (drag) event.preventDefault();
    this.clearTaskPointerDrag();
  }

  private changedTaskTouch(event: TouchEvent): Touch | null {
    const drag = this.taskDragState();
    const pending = this.pendingTaskDrag;
    const pointerId = drag?.pointerId ?? pending?.pointerId;
    if (pointerId === undefined) return null;
    return Array.from(event.changedTouches).find(touch => touch.identifier === pointerId) ?? null;
  }

  private clearTaskTouchDragStartTimer(): void {
    if (this.taskTouchDragStartTimer === null) return;
    clearTimeout(this.taskTouchDragStartTimer);
    this.taskTouchDragStartTimer = null;
  }

  private captureTaskPointer(element: HTMLElement, pointerId: number): void {
    if (!element.setPointerCapture) return;
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // The browser can reject capture if the pointer ended during setup.
    }
  }

  private releaseTaskPointerCapture(): void {
    const element = this.activeTaskDragElement;
    const pointerId = this.taskDragState()?.pointerId ?? this.pendingTaskDrag?.pointerId;
    if (!element || pointerId === undefined || !element.releasePointerCapture) return;
    try {
      if (!element.hasPointerCapture || element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    } catch {
      // Capture may already be gone after pointercancel/pointerup.
    }
  }

  private clearTextSelection(): void {
    if (typeof document === 'undefined') return;
    document.getSelection()?.removeAllRanges();
  }

  private captureTaskLayoutRects(): Map<string, DOMRect> {
    const rects = new Map<string, DOMRect>();
    if (typeof document === 'undefined') return rects;

    for (const element of document.querySelectorAll<HTMLElement>('.task-item[data-keyboard-task]')) {
      if (element.offsetParent === null) continue;
      const taskId = element.dataset['keyboardTask'];
      if (!taskId) continue;
      rects.set(taskId, element.getBoundingClientRect());
    }

    return rects;
  }

  private animateTaskLayoutChange(previousRects: Map<string, DOMRect>): void {
    if (previousRects.size === 0 || typeof window === 'undefined' || typeof document === 'undefined') return;
    this.resetTaskLayoutAnimationStyles();

    this.taskLayoutAnimationFrame = window.requestAnimationFrame(() => {
      this.taskLayoutAnimationFrame = null;
      const animatedElements: HTMLElement[] = [];

      for (const element of document.querySelectorAll<HTMLElement>('.task-item[data-keyboard-task]')) {
        if (element.offsetParent === null) continue;
        const taskId = element.dataset['keyboardTask'];
        const previousRect = taskId ? previousRects.get(taskId) : undefined;
        if (!previousRect) continue;

        const nextRect = element.getBoundingClientRect();
        const deltaX = previousRect.left - nextRect.left;
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

        element.style.transition = 'none';
        element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
        element.style.willChange = 'transform';
        animatedElements.push(element);
      }

      if (animatedElements.length === 0) return;

      for (const element of animatedElements) element.getBoundingClientRect();

      for (const element of animatedElements) {
        element.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0.2, 1)';
        element.style.transform = '';
      }

      this.taskLayoutAnimationCleanupTimer = setTimeout(() => {
        this.resetTaskLayoutAnimationStyles();
      }, 220);
    });
  }

  private resetTaskLayoutAnimationStyles(): void {
    if (this.taskLayoutAnimationFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.taskLayoutAnimationFrame);
      this.taskLayoutAnimationFrame = null;
    }
    if (this.taskLayoutAnimationCleanupTimer !== null) {
      clearTimeout(this.taskLayoutAnimationCleanupTimer);
      this.taskLayoutAnimationCleanupTimer = null;
    }
    if (typeof document === 'undefined') return;

    for (const element of document.querySelectorAll<HTMLElement>('.task-item[data-keyboard-task]')) {
      element.style.transition = '';
      element.style.transform = '';
      element.style.willChange = '';
    }
  }

  private suppressTaskClickOnce(): void {
    this.suppressNextTaskClick = true;
    if (this.suppressTaskClickTimer !== null) {
      clearTimeout(this.suppressTaskClickTimer);
    }
    this.suppressTaskClickTimer = setTimeout(() => {
      this.suppressNextTaskClick = false;
      this.suppressTaskClickTimer = null;
    }, 350);
  }

  private scrollTaskDropTargetNearEdge(dropZone: HTMLElement, clientPoint: { x: number; y: number }): boolean {
    const scrollTarget = this.taskScrollTargetForDropZone(dropZone);
    if (!scrollTarget) return false;

    const rect = scrollTarget.getBoundingClientRect();
    const threshold = Math.min(90, Math.max(48, rect.height * 0.18));
    const maxDelta = this.isMobile() ? MOBILE_TASK_AUTO_SCROLL_MAX_DELTA : DESKTOP_TASK_AUTO_SCROLL_MAX_DELTA;
    let delta = 0;

    if (clientPoint.y < rect.top + threshold) {
      delta = -Math.ceil((1 - Math.max(0, clientPoint.y - rect.top) / threshold) * maxDelta);
    } else if (clientPoint.y > rect.bottom - threshold) {
      delta = Math.ceil((1 - Math.max(0, rect.bottom - clientPoint.y) / threshold) * maxDelta);
    }

    if (delta === 0) return false;
    const before = scrollTarget.scrollTop;
    scrollTarget.scrollTop += delta;
    return scrollTarget.scrollTop !== before;
  }

  private taskScrollTargetForDropZone(dropZone: HTMLElement): HTMLElement | null {
    const taskList = dropZone.querySelector<HTMLElement>(':scope > .task-list');
    if (taskList && taskList.scrollHeight > taskList.clientHeight + 1) return taskList;

    if (dropZone.scrollHeight > dropZone.clientHeight + 1) return dropZone;

    const lists = dropZone.closest<HTMLElement>('.lists');
    if (lists && lists.scrollHeight > lists.clientHeight + 1) return lists;

    return null;
  }

  private commitTaskDrag(drag: TaskDragState): void {
    if (this.isEditing()) return;
    if (drag.targetSectionId) {
      void this.commitTaskMoveToPage(drag);
      return;
    }
    this.commitTaskReorder(drag);
  }

  private commitTaskReorder(drag: TaskDragState): void {
    const section = this.activeSection();
    const list = this.taskList();
    if (!section || !list) return;

    const items = [...this.tasks()];
    const sourceIndex = items.findIndex(task => task.id === drag.task.id);
    if (!this.moveTaskInArray(items, sourceIndex, drag.targetIndex)) return;
    this.reorderTasksInList(section.id, list, items);
  }

  private async commitTaskMoveToPage(drag: TaskDragState): Promise<void> {
    const targetSectionId = drag.targetSectionId;
    if (!targetSectionId || targetSectionId === drag.sourceSectionId || this.taskMoveInProgress()) return;

    this.taskMoveInProgress.set(true);
    try {
      await this.performTaskMoveToPage(drag, targetSectionId);
    } finally {
      this.taskMoveInProgress.set(false);
    }
  }

  private async performTaskMoveToPage(drag: TaskDragState, targetSectionId: string): Promise<void> {

    let source = this.storage.getSection(drag.sourceSectionId);
    let target = this.storage.getSection(targetSectionId);
    if (!source || !target || !this.canAddTask(target)) {
      this.handleTaskLimitReached();
      return;
    }

    if (
      !this.auth.isLoggedIn() &&
      (Boolean(source.shareToken) || Boolean(target.shareToken) || source.sharedAccess || target.sharedAccess)
    ) {
      this.taskMoveAnnouncement.set('sign in before moving tasks between shared pages');
      return;
    }

    if (this.auth.isLoggedIn()) {
      try {
        await this.flushPagesBeforeCrossPageMove([drag.sourceSectionId, targetSectionId]);
      } catch {
        this.refreshSectionsFromStorage();
        this.taskMoveAnnouncement.set(`could not move ${drag.task.text}`);
        return;
      }
      source = this.storage.getSection(drag.sourceSectionId);
      target = this.storage.getSection(targetSectionId);
      const sourceHasTask = source?.lists[0]?.items.some(item => item.id === drag.task.id && !item.deleted);
      if (!source || !target || !sourceHasTask || !this.canAddTask(target)) {
        this.refreshSectionsFromStorage();
        this.taskMoveAnnouncement.set(`sync updated; move ${drag.task.text} again`);
        return;
      }
      if (!this.pagesAreCleanForCrossPageMove([drag.sourceSectionId, targetSectionId])) {
        this.refreshSectionsFromStorage();
        this.taskMoveAnnouncement.set(`page changed; move ${drag.task.text} again`);
        return;
      }
    }

    const targetPosition = 0;
    const rollback = this.storage.optimisticallyMoveItem(
      drag.sourceSectionId,
      drag.task.id,
      targetSectionId,
      targetPosition,
    );
    if (!rollback) return;

    this.refreshSectionsFromStorage();
    const targetTitle = target.title || 'page';
    this.taskMoveAnnouncement.set(`moved ${drag.task.text} to ${targetTitle}`);
    if (!this.auth.isLoggedIn()) return;

    try {
      const moved = await this.sync.moveTaskToSection(
        drag.sourceSectionId,
        drag.task.id,
        targetSectionId,
        targetPosition,
        rollback,
      );
      if (!moved) {
        await this.doSyncSection(drag.sourceSectionId);
        await this.doSyncSection(targetSectionId);
        this.taskMoveAnnouncement.set(`sync updated; move ${drag.task.text} again`);
      }
      this.refreshSectionsFromStorage();
    } catch {
      const rolledBack = this.storage.rollbackMovedItem(rollback);
      if (!rolledBack) {
        await this.doSyncSection(drag.sourceSectionId);
        await this.doSyncSection(targetSectionId);
      }
      this.refreshSectionsFromStorage();
      this.taskMoveAnnouncement.set(`could not move ${drag.task.text}`);
    }
  }

  private async flushPagesBeforeCrossPageMove(sectionIds: string[]): Promise<void> {
    const uniqueSectionIds = [...new Set(sectionIds)];
    if (uniqueSectionIds.some(sectionId => this.storage.getSection(sectionId)?.created)) {
      await this.sync.syncSections();
    }
    for (const sectionId of uniqueSectionIds) {
      let clean = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.sync.syncSectionLists(sectionId);
        const list = this.storage.getListsForSection(sectionId)[0];
        if (!list) break;
        await this.sync.syncListItems(sectionId, list.id);
        const synced = this.storage.getListsForSection(sectionId)[0];
        clean = Boolean(synced) && this.listIsCleanForCrossPageMove(synced!);
        if (clean) break;
      }
      if (!clean) throw new Error('Page changed while preparing the move.');
    }
  }

  private pagesAreCleanForCrossPageMove(sectionIds: string[]): boolean {
    return [...new Set(sectionIds)].every(sectionId => {
      const list = this.storage.getListsForSection(sectionId)[0];
      return Boolean(list) && this.listIsCleanForCrossPageMove(list!);
    });
  }

  private listIsCleanForCrossPageMove(list: StoredList): boolean {
    return !list.dirty &&
      !list.itemsOrderDirty &&
      list.items.every(item => !item.dirty && !item.created);
  }

  protected isPagesFocused(): boolean {
    return this.keyboardZone() === 'pages';
  }

  protected isSectionKeyboardFocused(sectionId: string): boolean {
    return this.isPagesFocused() && this.activeSectionId() === sectionId;
  }

  protected isTaskFocused(id: string): boolean {
    return this.keyboardZone() === 'tasks' && this.activeKeyboardTaskId() === id;
  }

  protected isAddPlaceholderFocused(): boolean {
    return this.keyboardZone() === 'tasks' && this.activeKeyboardTaskId() === null;
  }

  protected clearTaskFocusOnMouseLeave(id: string): void {
    if (this.isTaskFocused(id)) this.clearKeyboardFocus();
  }

  protected isSectionDeleteOptionFocused(option: SectionDeleteOption): boolean {
    return this.keyboardZone() === 'pages' &&
      this.confirmingDeleteSectionId() !== null &&
      this.sectionDeleteConfirmFocus() === option;
  }

  protected focusPagesForKeyboard(): void {
    this.keyboardZone.set('pages');
    this.activeKeyboardTaskId.set(null);
    this.scrollActiveSectionIntoView();
  }

  private moveKeyboardVertically(direction: -1 | 1): void {
    if (this.keyboardZone() === null) {
      direction > 0 ? this.focusTaskList() : this.focusPagesForKeyboard();
      return;
    }

    if (this.keyboardZone() === 'pages') {
      direction > 0 ? this.focusTaskList() : this.scrollActiveSectionIntoView();
      return;
    }

    const items = this.tasks();
    const activeId = this.validActiveKeyboardTaskId();
    const activeIndex = activeId ? items.findIndex(task => task.id === activeId) : -1;

    if (direction < 0) {
      if (!activeId) {
        this.focusPagesForKeyboard();
      } else if (activeIndex <= 0) {
        this.focusTaskList();
      } else {
        this.setActiveKeyboardTask(items[activeIndex - 1].id);
      }
      return;
    }

    if (!activeId) {
      if (items.length > 0) this.setActiveKeyboardTask(items[0].id);
      return;
    }

    const nextIndex = Math.min(activeIndex + 1, items.length - 1);
    this.setActiveKeyboardTask(items[nextIndex].id);
  }

  private moveKeyboardHorizontally(direction: -1 | 1): void {
    this.moveSectionKeyboardFocus(direction);
  }

  private moveSectionKeyboardFocus(direction: -1 | 1): void {
    const sections = this.sections();
    if (sections.length === 0) return;

    const currentIndex = Math.max(this.activeSectionIndex(), 0);
    if (direction > 0 && currentIndex >= sections.length - 1) {
      this.focusPagesForKeyboard();
      this.startAddingSection();
      return;
    }

    const nextIndex = Math.min(Math.max(currentIndex + direction, 0), sections.length - 1);
    this.selectSection(sections[nextIndex].id);
    this.focusPagesForKeyboard();
  }

  private focusFirstTask(): void {
    const first = this.tasks()[0];
    first ? this.setActiveKeyboardTask(first.id) : this.focusTaskList();
  }

  private setActiveKeyboardTask(id: string): void {
    this.keyboardZone.set('tasks');
    this.activeKeyboardTaskId.set(id);
    this.scrollKeyboardTaskIntoView(id);
  }

  private focusTaskList(): void {
    this.keyboardZone.set('tasks');
    this.activeKeyboardTaskId.set(null);
  }

  private clearKeyboardFocus(): void {
    this.keyboardZone.set(null);
    this.activeKeyboardTaskId.set(null);
  }

  private validActiveKeyboardTaskId(): string | null {
    const id = this.activeKeyboardTaskId();
    if (!id) return null;
    if (this.tasks().some(task => task.id === id)) return id;
    this.activeKeyboardTaskId.set(null);
    return null;
  }

  private openFocusedTaskOrCreate(): void {
    const id = this.validActiveKeyboardTaskId();
    id ? this.startEditingTask(id) : void this.startAdding();
  }

  private deleteActivePageOrTask(): boolean {
    if (this.keyboardZone() === 'pages') {
      const sectionId = this.activeSectionId();
      if (!sectionId || this.sections().length < 2) return false;
      this.startDeleteSection(sectionId);
      return true;
    }
    return this.deleteActiveKeyboardTask();
  }

  private handleSectionDeleteConfirmationKeydown(event: KeyboardEvent): boolean {
    const sectionId = this.confirmingDeleteSectionId();
    if (this.keyboardZone() !== 'pages' || !sectionId) return false;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.sectionDeleteConfirmFocus.set(event.key === 'ArrowLeft' ? 'delete' : 'cancel');
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.sectionDeleteConfirmFocus() === 'delete'
        ? this.confirmDeleteSection()
        : this.cancelDeleteSection();
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
    void this.startAdding();
  }

  private addSubtaskForActiveTask(): boolean {
    const id = this.validActiveKeyboardTaskId();
    if (!id) return false;
    this.startAddingSubtask(id);
    return true;
  }

  private deleteActiveKeyboardTask(): boolean {
    const id = this.validActiveKeyboardTaskId();
    if (!id) return false;

    const items = this.tasks();
    const index = items.findIndex(task => task.id === id);
    const nextTask = items[index + 1] ?? items[index - 1] ?? null;
    this.removeTask(id);
    nextTask ? this.setActiveKeyboardTask(nextTask.id) : this.focusTaskList();
    return true;
  }

  private scrollKeyboardTaskIntoView(id: string): void {
    requestAnimationFrame(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-keyboard-task]'));
      const element = items.find(item => item.dataset['keyboardTask'] === id && item.offsetParent !== null);
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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

  // ─── Section page switching ────────────────────────────

  protected isSectionOwner(section: StoredSection | null | undefined): boolean {
    if (!section || section.sharedAccess) return false;
    const userId = this.auth.user()?.id;
    return !section.ownerId || section.ownerId === userId;
  }

  protected canDeleteSection(section: StoredSection | null | undefined): boolean {
    return this.isSectionOwner(section) && this.sections().length > 1;
  }

  protected selectSection(sectionId: string): void {
    if (this.isPublicPage()) return;
    if (this.activeSectionId() === sectionId) return;
    this.sectionMenuOpen.set(false);
    this.setActiveSection(sectionId);
    this.activeKeyboardTaskId.set(null);

    if (this.auth.isLoggedIn()) {
      this.sync.syncSections().then(async synced => {
        this.setSections(synced);
        await this.hydrateMissingSectionLists([sectionId]);
        return this.doSyncSection(sectionId);
      }).catch(() => {});
    } else {
      this.ensureLocalTaskList(sectionId);
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
    this.setSections(items);

    if (this.auth.isLoggedIn()) {
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
    this.reorderSubtasksInList(this.taskList(), taskId, event.previousIndex, event.currentIndex);
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
      '.lists, .task-section, .task-drop-zone, .task-list',
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
        '.lists, .task-section, .task-drop-zone, .task-list',
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
    if (this.isEditing()) return;
    if (!this.canAddSection()) {
      this.handleSectionLimitReached();
      return;
    }
    this.sectionMenuOpen.set(false);
    this.addingSectionTitle.set('');
    this.focusVisibleInput('.section-add-input');
  }

  private handleSectionLimitReached(): void {
    this.sectionMenuOpen.set(false);
    if (!this.auth.isLoggedIn()) {
      void this.router.navigate(['/sign-in']);
      return;
    }
    if (!this.auth.isPremium()) {
      this.showPremiumUpgradePrompt('create more pages for larger work sessions');
    }
  }

  private handleTaskLimitReached(): void {
    if (!this.freeOwnedTaskLimitApplies()) return;
    this.showPremiumUpgradePrompt('create more tasks on each page');
  }

  private showPremiumUpgradePrompt(description: string): void {
    this.premiumUpgradePromptDescription.set(description);
    this.premiumUpgradePromptOpen.set(true);
  }

  protected cancelAddingSection(): void {
    this.addingSectionTitle.set(null);
  }

  protected confirmAddSection(): void {
    const title = (this.addingSectionTitle() ?? '').trim();
    if (!title) { this.cancelAddingSection(); return; }

    if (!this.canAddSection()) {
      this.cancelAddingSection();
      this.handleSectionLimitReached();
      return;
    }

    const newSection = this.createSection(title);
    this.cancelAddingSection();

    if (this.auth.isLoggedIn()) {
      this.sync.syncSections().then(synced => {
        this.setSections(synced);
        return this.doSyncSection(newSection.id);
      }).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private createSection(title: string): StoredSection {
    const now = new Date().toISOString();
    const sectionId = crypto.randomUUID();
    const listId = crypto.randomUUID();

    const newSection: StoredSection = {
      id: sectionId,
      title,
      position: this.sections().length,
      metadataLastModifiedAt: now,
      serverRevision: 0,
      created: true,
      dirty: true,
      lists: [
        { id: listId, title: '', metadataLastModifiedAt: now, serverRevision: 0, itemsOrderRevision: 0, itemsBaseOrderRevision: 0, dirty: true, items: [] },
      ],
    };

    this.storage.upsertSection(newSection);
    this.refreshSectionsFromStorage();
    this.setActiveSection(sectionId);

    return newSection;
  }

  private ensureSectionForTaskCreation(): boolean {
    const active = this.activeSection();
    if (this.sectionHasTaskList(active)) return true;

    if (active) {
      if (this.auth.isLoggedIn()) return false;
      this.ensureLocalTaskList(active.id);
      return this.sectionHasTaskList(this.activeSection());
    }

    if (this.sections().length === 0) {
      const created = this.createSection('my list');
      return this.sectionHasTaskList(created);
    }

    const first = this.sections()[0];
    if (!first) return false;
    this.setActiveSection(first.id);
    if (this.auth.isLoggedIn()) return this.sectionHasTaskList(first);
    this.ensureLocalTaskList(first.id);
    return this.sectionHasTaskList(this.activeSection());
  }

  private async ensureActiveTaskListReady(): Promise<boolean> {
    let active = this.activeSection();
    if (!active) {
      if (this.sections().length === 0 && !this.isPublicPage()) {
        active = this.createSection('my list');
      } else {
        active = this.sections()[0] ?? null;
        if (active) this.setActiveSection(active.id);
      }
    }
    if (!active) return false;
    if (this.sectionHasTaskList(active)) return true;

    const sectionId = active.id;
    if (this.auth.isLoggedIn()) {
      try {
        await this.sync.syncSectionLists(sectionId);
        this.refreshSectionsFromStorage();
      } catch {
        return false;
      }

      active = this.activeSection();
      if (this.sectionHasTaskList(active)) return true;
    }

    this.ensureLocalTaskList(sectionId);
    return this.sectionHasTaskList(this.activeSection());
  }

  protected handleAddSectionKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.confirmAddSection();
      this.focusPagesForKeyboard();
    } else if (event.key === 'ArrowLeft' && !(event.target as HTMLInputElement).value.trim()) {
      event.preventDefault();
      this.cancelAddingSection();
      this.focusPagesForKeyboard();
    } else if (event.key === 'Escape') {
      this.cancelAddingSection();
      this.focusPagesForKeyboard();
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

        if (this.auth.isLoggedIn() || sec.shareToken) {
          this.sync.syncSections().then(synced => this.setSections(synced)).catch(() => {});
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
    if (!this.canDeleteSection(this.sections().find(section => section.id === sectionId))) return;
    this.sectionMenuOpen.set(false);
    this.confirmingDeleteSectionId.set(sectionId);
    this.sectionDeleteConfirmFocus.set('delete');
    this.keyboardZone.set('pages');
    this.activeKeyboardTaskId.set(null);
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
    this.focusPagesForKeyboard();
  }

  protected toggleSectionMenu(): void {
    if (this.isEditing()) return;
    this.sectionMenuOpen.update(open => !open);
  }

  protected closeSectionMenu(): void {
    this.sectionMenuOpen.set(false);
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

  protected startDeletingActiveSectionFromMenu(): void {
    const sectionId = this.activeSectionId();
    if (!sectionId || !this.canDeleteSection(this.activeSection())) return;
    this.startDeleteSection(sectionId);
  }

  private deleteSection(sectionId: string): void {
    if (this.isPublicPage()) return;
    if (!this.canDeleteSection(this.sections().find(section => section.id === sectionId))) return;
    this.storage.removeSection(sectionId);
    this.refreshSectionsFromStorage();
    this.activeKeyboardTaskId.set(null);

    const remaining = this.sections();
    if (this.activeSectionId() === sectionId) {
      this.restoreActiveSection(remaining, [this.storage.getActiveSectionPreference()]);
    }

    if (this.auth.isLoggedIn()) {
      this.sync.syncSections().then(synced => this.setSections(synced)).catch(() => {});
    }
  }

  // ─── List mutation helper ──────────────────────────────

  private updateTaskList(updater: (tasks: Task[]) => Task[], options?: { markOrderDirty?: boolean }): void {
    if (this.taskMoveInProgress()) return;
    const sec = this.activeSection();
    const list = this.taskList();
    if (!sec || !list) return;

    const syncSectionsFirst = sec.created === true;
    this.storage.setItemsForList(
      sec.id,
      list.id,
      this.buildItemsFromTasks(list.items, updater(this.visibleTasks(list))),
      options,
    );
    this.refreshSectionsFromStorage();
    this.syncItemsForList(sec.id, list.id, syncSectionsFirst);
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

  private freeOwnedTaskLimitApplies(section = this.activeSection()): boolean {
    return this.isSectionOwner(section) && !this.auth.isPremium();
  }

  private canAddTask(section = this.activeSection()): boolean {
    const list = section?.lists[0];
    const taskCount = this.visibleTasks(list ?? null).length;
    const limit = this.freeOwnedTaskLimitApplies(section) ? MAX_FREE_TASKS_PER_PAGE : MAX_TASKS_PER_PAGE;
    return taskCount < limit;
  }

  private doneTasksForList(list: StoredList | null): DoneTask[] {
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
      ...(typeof record['deadlineAt'] === 'string' && record['deadlineAt']
        ? { deadlineAt: record['deadlineAt'] }
        : record['deadlineAt'] === null ? { deadlineAt: null } : {}),
      ...(typeof record['deadlineTimeZone'] === 'string' && record['deadlineTimeZone']
        ? { deadlineTimeZone: record['deadlineTimeZone'] }
        : record['deadlineTimeZone'] === null ? { deadlineTimeZone: null } : {}),
      deadlineNotificationEnabled: Boolean(record['deadlineAt'] && record['deadlineNotificationEnabled']),
      ...(typeof record['deadlineScheduleId'] === 'string' && record['deadlineScheduleId']
        ? { deadlineScheduleId: record['deadlineScheduleId'] }
        : {}),
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
      normalizedLeft.deadlineAt === right.deadlineAt &&
      normalizedLeft.deadlineTimeZone === right.deadlineTimeZone &&
      normalizedLeft.deadlineNotificationEnabled === right.deadlineNotificationEnabled &&
      normalizedLeft.deadlineScheduleId === right.deadlineScheduleId &&
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

  private syncItemsForList(sectionId: string, listId: string, syncSectionsFirst = false): void {
    this.syncItemsForLists(sectionId, [listId], syncSectionsFirst);
  }

  private syncItemsForLists(sectionId: string, listIds: string[], syncSectionsFirst = false): void {
    const canSyncSection = this.auth.isLoggedIn() || Boolean(this.storage.getSection(sectionId)?.shareToken);
    if (!canSyncSection) return;

    for (const listId of listIds) {
      this.sync.reserveListItemsSync(sectionId, listId);
    }

    const listSync = syncSectionsFirst && this.auth.isLoggedIn()
      ? this.sync.syncSections().then(synced => {
          this.setSections(synced);
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

  private reorderTasksInList(sectionId: string, list: StoredList, tasks: Task[]): void {
    const order = new Map(tasks.map((task, position) => [task.id, position]));
    const items = list.items.map(item => ({
      ...item,
      position: order.get(item.id) ?? item.position,
    }));
    this.storage.setItemsForList(sectionId, list.id, items, { markOrderDirty: true });
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() || this.storage.getSection(sectionId)?.shareToken) {
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

  private taskDropTargetFromClientPoint(clientPoint: { x: number; y: number }): TaskDropTarget | null {
    if (typeof document === 'undefined') return null;

    const elementAtPoint = document.elementFromPoint(clientPoint.x, clientPoint.y);
    const dropZone = elementAtPoint?.closest<HTMLElement>('.task-drop-zone');
    const target = dropZone ? this.taskDropTargetFromDropZone(dropZone) : null;
    if (target) return target;

    const fallbackZone = document.getElementById('taskDropList');
    if (!fallbackZone) return null;
    const rect = fallbackZone.getBoundingClientRect();
    if (
      clientPoint.x >= rect.left &&
      clientPoint.x <= rect.right &&
      clientPoint.y >= rect.top &&
      clientPoint.y <= rect.bottom
    ) {
      return this.taskDropTargetFromDropZone(fallbackZone);
    }

    return null;
  }

  private taskDropTargetFromDropZone(dropZone: HTMLElement): TaskDropTarget | null {
    return dropZone.classList.contains('task-drop-zone')
      ? { dropZone, taskSelector: '.task-list > .task-item' }
      : null;
  }

  private taskPageTargetFromClientPoint(clientPoint: { x: number; y: number }): string | null {
    if (typeof document === 'undefined') return null;
    const element = document.elementFromPoint(clientPoint.x, clientPoint.y);
    return element?.closest<HTMLElement>('[data-task-drop-section]')?.dataset['taskDropSection'] ?? null;
  }

  private taskDropIndexFromClientPoint(
    dropZone: HTMLElement,
    taskSelector: string,
    clientPoint: { x: number; y: number },
    fallbackIndex: number,
    draggedElement: HTMLElement | null,
  ): number {
    const dropZoneRect = dropZone.getBoundingClientRect();
    const isInsideDropZone =
      clientPoint.x >= dropZoneRect.left &&
      clientPoint.x <= dropZoneRect.right &&
      clientPoint.y >= dropZoneRect.top &&
      clientPoint.y <= dropZoneRect.bottom;
    if (!isInsideDropZone) return fallbackIndex;

    const taskList = dropZone.querySelector<HTMLElement>('.task-list');
    if (!taskList) return fallbackIndex;

    const pointerYInList =
      clientPoint.y - taskList.getBoundingClientRect().top + taskList.scrollTop;
    const taskItems = Array.from(dropZone.querySelectorAll<HTMLElement>(taskSelector))
      .filter(element =>
        element !== draggedElement &&
        element.offsetParent !== null &&
        !element.classList.contains('cdk-drag-placeholder') &&
        !element.classList.contains('cdk-drag-preview')
      );
    if (taskItems.length === 0) return 0;

    for (let index = 0; index < taskItems.length; index += 1) {
      const midpoint = this.layoutTopWithin(taskItems[index], taskList) + taskItems[index].offsetHeight / 2;
      if (pointerYInList < midpoint) {
        return index;
      }
    }

    return taskItems.length;
  }

  private layoutTopWithin(element: HTMLElement, ancestor: HTMLElement): number {
    let top = element.offsetTop;
    let parent = element.offsetParent as HTMLElement | null;

    while (parent && parent !== ancestor && ancestor.contains(parent)) {
      top += parent.offsetTop;
      parent = parent.offsetParent as HTMLElement | null;
    }

    return parent === ancestor ? top : element.offsetTop - ancestor.offsetTop;
  }

  private moveTaskInArray<T>(items: T[], previousIndex: number, targetIndex: number): boolean {
    if (previousIndex < 0 || previousIndex >= items.length) return false;
    if (previousIndex === targetIndex || (targetIndex >= items.length && previousIndex === items.length - 1)) {
      return false;
    }

    const [item] = items.splice(previousIndex, 1);
    items.splice(Math.max(0, Math.min(targetIndex, items.length)), 0, item);
    return true;
  }

  protected readonly confirmingClear = signal(false);

  protected startClear(): void { this.confirmingClear.set(true); }
  protected cancelClear(): void { this.confirmingClear.set(false); }
  protected confirmClear(): void {
    this.updateTaskList(() => []);
    this.confirmingClear.set(false);
  }
  protected clearDoneTasks(): void {
    this.deleteDoneTasks();
  }

  protected restoreDoneTask(task: DoneTask): void {
    if (!this.canAddTask()) {
      this.handleTaskLimitReached();
      return;
    }
    this.restoreDoneTaskToSource(task, this.withoutDoneDate({ ...task, done: false }));
  }

  protected restoreDoneSubtask(task: DoneTask, subtaskId: string): void {
    if (!this.canAddTask()) {
      this.handleTaskLimitReached();
      return;
    }
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
    const sourceList = this.taskList();
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

  private completeTask(id: string): void {
    const sec = this.activeSection();
    const list = this.taskList();
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

  private deleteDoneTasks(): void {
    const sec = this.activeSection();
    const list = this.taskList();
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

    const doneItems: Array<{ list: StoredList; item: StoredItem; task: Task }> = [];
    for (const list of section.lists) {
      for (const item of list.items) {
        if (item.deleted) continue;
        const task = this.normalizeTask(item.content, item.id);
        if (!task.done) continue;
        doneItems.push({ list, item, task });
      }
    }

    if (doneItems.length <= MAX_DONE_TASKS) return [];

    const overflow = completedItemsBeyondRetention(
      doneItems,
      (left, right) => this.compareDoneTasksNewestFirst(
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
      ),
    );

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
    const { doneAt: _doneAt, ...rest } = task;
    return rest;
  }

  // ─── Scroll ─────────────────────────────────────────────
  protected readonly taskSection = viewChild<ElementRef<HTMLElement>>('taskSection');

  // ─── User menu ──────────────────────────────────────────
  protected toggleMenu(): void {
    this.menuOpen.update(v => !v);
  }

  protected goToSignIn(): void {
    this.menuOpen.set(false);
    void this.router.navigate(['/sign-in']);
  }

  protected toggleDark(): void {
    this.theme.toggle();
  }

  protected toggleShareMenu(): void {
    this.showSharePanel();
  }

  protected showSharePanel(): void {
    this.shareDialogMode.set('viewer');
    this.shareMenuOpen.set(true);
  }

  protected showShareLinkPanel(): void {
    if (this.activeSection()?.isShared !== true || !this.shareSectionUrl()) return;
    this.showSharePanel();
  }

  protected shareSectionUrl(): string {
    return this.activeSectionShareUrl();
  }

  protected async setActiveSectionSharing(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const enabled = input.checked;
    if (enabled) {
      await this.enableActiveSectionSharing();
    } else {
      await this.disableActiveSectionSharing();
    }
    input.checked = this.activeSection()?.isShared === true;
  }

  protected async enableActiveSectionSharing(): Promise<void> {
    const section = this.activeSection();
    if (!section || !this.isSectionOwner(section)) return;
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(['/sign-in']);
      return;
    }
    try {
      const updated = await this.sync.enableSectionSharing(section.id);
      this.refreshSectionsFromStorage();
      this.setActiveSection(updated.id);
      this.shareDialogMode.set('enabled');
      this.shareMenuOpen.set(true);
    } catch {
      // The user can retry.
    }
  }

  protected async disableActiveSectionSharing(): Promise<void> {
    const section = this.activeSection();
    if (!section || !this.isSectionOwner(section)) return;
    try {
      const updated = await this.sync.disableSectionSharing(section.id);
      this.refreshSectionsFromStorage();
      this.setActiveSection(updated.id);
      this.shareDialogMode.set('disabled');
      this.shareMenuOpen.set(true);
    } catch {
      // The user can retry.
    }
  }

  protected async copySectionShareLink(): Promise<void> {
    const url = this.shareSectionUrl();
    if (!url) return;
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

  protected async signOut(): Promise<void> {
    this.menuOpen.set(false);
    await this.deadlineNotifications.detachCurrentAccountNotifications();
    this.storage.setActivePartition(); // switch to anonymous
    this.auth.logout();
    this.refreshSectionsFromStorage();
    const loaded = this.storage.loadSections();
    this.setSections(loaded);
    this.restoreActiveSection(loaded, [this.storage.getActiveSectionPreference()]);
    this.clearKeyboardFocus();
    await this.deadlineNotifications.reconcileDeadlines(loaded);
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

  // ─── Task: add ──────────────────────────────────────────
  protected dismissPremiumUpgradePrompt(): void {
    this.premiumUpgradePromptOpen.set(false);
  }

  protected goToPremiumUpgrade(): void {
    this.menuOpen.set(false);
    this.dismissPremiumUpgradePrompt();
    this.router.navigate(['/payment']);
  }

  protected async startAdding(): Promise<void> {
    this.focusTaskList();
    if (this.isEditing()) return;
    if (!this.canAdd()) {
      this.handleTaskLimitReached();
      return;
    }
    if (!(await this.ensureActiveTaskListReady())) return;
    if (this.isEditing()) return;
    if (!this.canAdd()) {
      this.handleTaskLimitReached();
      return;
    }
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
    if (!this.ensureSectionForTaskCreation()) return;
    if (!this.canAdd()) {
      this.cancelAdding();
      this.handleTaskLimitReached();
      return;
    }
    const subtasks: Subtask[] = this.newSubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => ({ id: crypto.randomUUID(), text: s, done: false }));
    this.updateTaskList(tasks => [
      { id: crypto.randomUUID(), text, subtasks, done: false, deadlineNotificationEnabled: false },
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

  protected addSubtaskField(focusNew = true): void {
    if (this.newSubtasks().length >= 10) return;
    this.newSubtasks.update(s => [...s, '']);
    if (focusNew) this.focusLastVisibleInput('.add-form:not(.add-form-sec) .input-sub');
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

  // ─── Task text editing ──────────────────────────────────
  protected toggleTask(id: string): void {
    this.completeTask(id);
  }

  protected removeTask(id: string): void {
    this.updateTaskList(tasks => tasks.filter(t => t.id !== id));
  }

  // ─── Task: inline edit ──────────────────────────────────
  protected startEditingTask(id: string): void {
    if (this.isEditing()) return;
    this.setActiveKeyboardTask(id);
    this.editingTaskId.set(id);
    this.focusEditInput('task-' + id);
  }

  protected handleTaskItemClick(event: MouseEvent, id: string): void {
    if (event.defaultPrevented || this.suppressNextTaskClick) return;
    if (this.isTaskEditIgnoredEvent(event)) return;
    this.startEditingTask(id);
  }

  protected saveTaskEdit(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.updateTaskList(tasks =>
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
    this.updateTaskList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSubtask(taskId: string, subtaskId: string): void {
    this.updateTaskList(tasks =>
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
      this.updateTaskList(tasks =>
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
    this.updateTaskList(tasks =>
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

  protected openDeadlineEditor(task: Task): void {
    if (this.isEditing()) return;
    this.deadlineDialogReturnFocus = this.activeHtmlElement();
    this.deadlineEditorTaskId.set(task.id);
    this.deadlineDraftLocal.set(this.deadlineLocalValue(task.deadlineAt));
    this.deadlineNotificationDraft.set(task.deadlineNotificationEnabled);
    this.deadlinePermissionMessage.set('');
    afterNextRender(() => {
      this.deadlineDialog()?.nativeElement
        .querySelector<HTMLInputElement>('[data-deadline-initial-focus]')
        ?.focus();
    }, { injector: this.injector });
  }

  protected closeDeadlineEditor(): void {
    const returnFocus = this.deadlineDialogReturnFocus;
    this.deadlineDialogReturnFocus = null;
    this.deadlineEditorTaskId.set(null);
    this.deadlineDraftLocal.set('');
    this.deadlineNotificationDraft.set(false);
    this.deadlinePermissionMessage.set('');
    this.restoreFocus(returnFocus);
  }

  protected updateDeadlineDraft(event: Event): void {
    this.deadlineDraftLocal.set((event.target as HTMLInputElement).value);
  }

  protected async updateDeadlineNotificationDraft(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    this.deadlineNotificationDraft.set(enabled);
    this.deadlinePermissionMessage.set('');
    if (!enabled) return;

    const granted = await this.deadlineNotifications.setDeviceNotificationsEnabled(true);
    if (granted) {
      if (this.deadlineNotifications.registrationState() === 'retrying') {
        this.deadlinePermissionMessage.set('notifications allowed; delivery will retry when online');
      }
      return;
    }

    const state = this.deadlineNotifications.permissionState();
    this.deadlinePermissionMessage.set(state === 'unsupported'
      ? 'notifications are unavailable on this device'
      : 'notifications are blocked on this device');
  }

  protected saveDeadline(event: Event): void {
    event.preventDefault();
    const taskId = this.deadlineEditorTaskId();
    const localValue = this.deadlineDraftLocal();
    const deadline = new Date(localValue);
    if (!taskId || !localValue || Number.isNaN(deadline.getTime())) {
      this.deadlinePermissionMessage.set('choose a valid date and time');
      return;
    }

    const deadlineAt = deadline.toISOString();
    const deadlineTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const deadlineNotificationEnabled = this.deadlineNotificationDraft();
    this.updateTaskList(tasks => tasks.map(task => {
      if (task.id !== taskId) return task;
      const scheduleChanged = task.deadlineAt !== deadlineAt ||
        task.deadlineNotificationEnabled !== deadlineNotificationEnabled;
      return {
        ...task,
        deadlineAt,
        deadlineTimeZone,
        deadlineNotificationEnabled,
        ...(deadlineNotificationEnabled
          ? {
              deadlineScheduleId: scheduleChanged || !task.deadlineScheduleId
                ? crypto.randomUUID()
                : task.deadlineScheduleId,
            }
          : { deadlineScheduleId: undefined }),
      };
    }));
    this.closeDeadlineEditor();
  }

  protected removeDeadline(): void {
    const taskId = this.deadlineEditorTaskId();
    if (!taskId) return;
    this.updateTaskList(tasks => tasks.map(task => task.id === taskId
      ? {
          ...task,
          deadlineAt: null,
          deadlineTimeZone: null,
          deadlineNotificationEnabled: false,
          deadlineScheduleId: undefined,
        }
      : task));
    this.closeDeadlineEditor();
  }

  protected deadlineLabel(deadlineAt: string): string {
    const deadline = new Date(deadlineAt);
    if (Number.isNaN(deadline.getTime())) return 'deadline';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(deadline);
  }

  private deadlineLocalValue(deadlineAt?: string | null): string {
    if (!deadlineAt) return '';
    const deadline = new Date(deadlineAt);
    if (Number.isNaN(deadline.getTime())) return '';
    const local = new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  protected toggleTaskMenu(taskId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.taskMenuOpenId.update(id => id === taskId ? null : taskId);
  }

  protected openTaskMoveDialog(task: Task): void {
    if (this.isEditing() || this.taskMoveTargetSections().length === 0) return;
    this.taskMoveDialogReturnFocus = this.activeHtmlElement();
    this.taskMenuOpenId.set(null);
    this.taskMoveDialogTaskId.set(task.id);
    afterNextRender(() => {
      this.taskMoveDialog()?.nativeElement
        .querySelector<HTMLButtonElement>('[data-task-move-initial-focus]')
        ?.focus();
    }, { injector: this.injector });
  }

  protected closeTaskMoveDialog(): void {
    const returnFocus = this.taskMoveDialogReturnFocus;
    this.taskMoveDialogReturnFocus = null;
    this.taskMoveDialogTaskId.set(null);
    this.restoreFocus(returnFocus);
  }

  protected async moveTaskToPage(task: Task, targetSectionId: string): Promise<void> {
    const sourceSectionId = this.activeSectionId();
    const sourceIndex = this.tasks().findIndex(candidate => candidate.id === task.id);
    if (!sourceSectionId || sourceIndex < 0 || this.taskMoveInProgress()) return;

    const drag: TaskDragState = {
      sourceSectionId,
      sourceIndex,
      targetIndex: 0,
      targetSectionId,
      task,
      pointerId: -1,
      lastClientX: 0,
      lastClientY: 0,
      pointerOffsetX: 0,
      pointerOffsetY: 0,
      previewX: 0,
      previewY: 0,
      previewWidth: 0,
      previewHeight: 0,
    };

    this.closeTaskMoveDialog();
    this.taskMoveInProgress.set(true);
    try {
      await this.performTaskMoveToPage(drag, targetSectionId);
    } finally {
      this.taskMoveInProgress.set(false);
    }
  }

  private handleModalKeydown(
    event: KeyboardEvent,
    dialog: HTMLElement | undefined,
    close: () => void,
  ): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = dialog ? this.dialogFocusableElements(dialog) : [];
    if (focusable.length === 0) {
      event.preventDefault();
      dialog?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.activeHtmlElement();
    if (!active || !dialog?.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
    return Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter(element => element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true');
  }

  private activeHtmlElement(): HTMLElement | null {
    return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }

  private restoreFocus(element: HTMLElement | null): void {
    if (!element) return;
    requestAnimationFrame(() => {
      if (element.isConnected) element.focus();
    });
  }

  private focusVisibleInput(selector: string, select = false): void {
    afterNextRender(() => {
      const all = document.querySelectorAll<HTMLInputElement>(selector);
      const el = Array.from(all).find(i => i.offsetParent !== null) ?? all[0];
      el?.focus();
      if (select) el?.select();
    }, { injector: this.injector });
  }

  private focusLastVisibleInput(selector: string): void {
    afterNextRender(() => {
      const all = Array.from(document.querySelectorAll<HTMLInputElement>(selector));
      const visible = all.filter(i => i.offsetParent !== null);
      (visible.at(-1) ?? all.at(-1))?.focus();
    }, { injector: this.injector });
  }

  private focusEditInput(editId: string): void {
    afterNextRender(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-edit-id="${editId}"]`);
      input?.focus();
    }, { injector: this.injector });
  }

  private startSubtaskFromActiveTaskEdit(event: KeyboardEvent): boolean {
    const taskId = this.editingTaskId();
    if (taskId !== null && this.startSubtaskFromTaskEdit(taskId, event.target)) {
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
    if (list === 'tasks') {
      this.keyboardZone.set('tasks');
      const taskId = listTarget?.dataset['keyboardTask'];
      this.activeKeyboardTaskId.set(taskId ?? null);
      return;
    }

    if (target.closest('[data-keyboard-section]')) {
      this.focusPagesForKeyboard();
    }
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(
      target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]')
    );
  }

  private isTaskDragIgnoredTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(
      target.closest(
        'input, textarea, select, button, a, [contenteditable="true"], .subtask-list, .subtask-row, .task-link',
      )
    );
  }

  private isTaskEditIgnoredEvent(event: Event): boolean {
    // A subtask delete removes the clicked button before the click bubbles to
    // the task row. composedPath() preserves the original event path, while
    // closest() on the now-detached target can no longer see the subtask row.
    return event.composedPath().some(target =>
      target instanceof HTMLElement && target.matches(
        'input, textarea, select, button, a, [contenteditable="true"], .subtask-list, .subtask-row, .task-link',
      )
    );
  }
}
