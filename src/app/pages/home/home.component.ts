import { afterNextRender, ChangeDetectionStrategy, Component, computed, Injector, inject, signal, viewChild, ElementRef, OnDestroy, HostListener } from '@angular/core';
import { CdkDragDrop, CdkDrag, CdkDropList, CdkDragPlaceholder, moveItemInArray } from '@angular/cdk/drag-drop';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { StorageService, StoredSection, StoredList, StoredItem } from '../../services/storage.service';
import { SyncService } from '../../services/sync.service';

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
  lastModifiedAt?: string;
}

const DEFAULT_BACKLOG_TITLE = 'Later';
const DEFAULT_MAIN_TITLE = 'Now';
const MAX_SECTIONS = 10;
const MAX_MAIN_TASKS = 7;
const MAX_BACKLOG_TASKS = 200;

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDrag, CdkDropList, CdkDragPlaceholder, RouterLink],
})
export class HomeComponent implements OnDestroy {
  private readonly injector = inject(Injector);
  protected readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly storage = inject(StorageService);
  private readonly sync = inject(SyncService);

  protected readonly dark = this.theme.dark;

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

  protected readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth <= 768);
  protected readonly dragging = signal(false);
  protected readonly dragDelay = computed(() => this.isMobile() ? { touch: 200, mouse: 0 } : { touch: 0, mouse: 0 });
  protected readonly activeSectionIndex = computed(() => this.sections().findIndex(s => s.id === this.activeSectionId()));
  protected readonly showPrevArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() > 0);
  protected readonly showNextArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() < this.sections().length - 1);

  private syncIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.initFromStorage();
  }

  @HostListener('document:keydown', ['$event'])
  protected handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (event.key === 'Tab' && !event.shiftKey && this.startSubtaskFromActiveTaskEdit(event)) return;
    if (event.key !== 'Enter' || this.isEditing() || this.isInteractiveTarget(event.target)) return;

    event.preventDefault();
    this.startAdding();
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
  }

  ngOnDestroy(): void {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  private async initFromStorage(): Promise<void> {
    if (this.auth.isLoggedIn()) {
      await this.auth.fetchUser();
    }

    const userId = this.auth.user()?.id;
    if (userId) {
      this.storage.setActivePartition(userId);
    } else {
      this.storage.setActivePartition();
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
      this.startPeriodicSync();
    }
  }

  private async doFullSync(): Promise<void> {
    try {
      const synced = await this.sync.syncSections();
      this.sections.set(synced);
      const first = synced[0];
      if (first) {
        this.activeSectionId.set(first.id);
        await this.doSyncSection(first.id);
      }
    } catch { /* silently fail */ }
    this.startPeriodicSync();
  }

  private startPeriodicSync(): void {
    if (this.syncIntervalId !== null) return;
    this.syncIntervalId = setInterval(async () => {
      if (this.shouldSkipPeriodicSync()) return;
      if (this.auth.isLoggedIn()) {
        await this.auth.fetchUser();
      }
      if (this.shouldSkipPeriodicSync()) return;
      if (this.auth.isLoggedIn() && this.auth.isPremium()) {
        await this.doPeriodicSync();
      }
    }, 30_000);
  }

  private async doPeriodicSync(): Promise<void> {
    if (this.shouldSkipPeriodicSync()) return;
    try {
      const synced = await this.sync.syncSections();
      if (this.shouldSkipPeriodicSync()) return;
      this.sections.set(synced);
      const activeId = this.activeSectionId();
      if (activeId) {
        await this.doSyncSection(activeId);
      }
    } catch { /* silently fail */ }
  }

  private shouldSkipPeriodicSync(): boolean {
    return this.isEditing() || this.dragging();
  }

  private async doSyncSection(sectionId: string): Promise<void> {
    try {
      const lists = await this.sync.syncSectionLists(sectionId);
      for (const list of lists) {
        await this.sync.syncListItems(sectionId, list.id);
      }
      this.refreshSectionsFromStorage();
    } catch { /* silently fail */ }
  }

  private refreshSectionsFromStorage(): void {
    this.sections.set(this.storage.loadSections());
  }

  protected setDragging(value: boolean): void {
    this.dragging.set(value);
  }

  // ─── Section tab switching ─────────────────────────────

  protected selectSection(sectionId: string): void {
    if (this.activeSectionId() === sectionId) return;
    this.sectionMenuOpen.set(false);
    this.activeSectionId.set(sectionId);

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(synced => {
        this.sections.set(synced);
        return this.doSyncSection(sectionId);
      }).catch(() => {});
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
    if (event.previousIndex === event.currentIndex) return;
    const items = [...this.sections()];
    moveItemInArray(items, event.previousIndex, event.currentIndex);
    items.forEach((s, i) => s.position = i);
    this.storage.saveSections(items);
    this.sections.set(items);

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.reorderSections(items.map(section => ({ id: section.id, position: section.position })))
        .then(positions => {
          const current = [...this.sections()];
          for (const p of positions) {
            const sec = current.find(s => s.id === p.id);
            if (sec) sec.position = p.position;
          }
          current.sort((a, b) => a.position - b.position);
          this.storage.saveSections(current);
          this.sections.set(current);
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

  // ─── Section creation ──────────────────────────────────

  protected startAddingSection(): void {
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
      created: true,
      lists: [
        { id: mainListId, title: DEFAULT_MAIN_TITLE, metadataLastModifiedAt: now, items: [], isBacklog: false },
        { id: backlogListId, title: DEFAULT_BACKLOG_TITLE, metadataLastModifiedAt: now, items: [], isBacklog: true },
      ],
    };

    this.storage.upsertSection(newSection);
    this.refreshSectionsFromStorage();
    this.activeSectionId.set(sectionId);

    return newSection;
  }

  private ensureDefaultSectionForItemCreation(): void {
    if (this.activeSection() && this.mainList() && this.backlogList()) return;

    const existingSection = this.sections().find(section =>
      section.lists.some(list => !list.isBacklog) &&
      section.lists.some(list => list.isBacklog),
    );
    if (existingSection) {
      this.activeSectionId.set(existingSection.id);
      return;
    }

    if (this.sections().length === 0) {
      this.createSection('My Tasks');
    }
  }

  protected handleAddSectionKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.confirmAddSection();
    else if (event.key === 'Escape') this.cancelAddingSection();
  }

  protected onAddSectionInput(event: Event): void {
    this.addingSectionTitle.set((event.target as HTMLInputElement).value);
  }

  // ─── Section rename ────────────────────────────────────

  protected startEditingSection(sectionId: string): void {
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
  }

  protected cancelDeleteSection(): void {
    this.confirmingDeleteSectionId.set(null);
  }

  protected confirmDeleteSection(): void {
    const id = this.confirmingDeleteSectionId();
    if (!id) return;

    this.deleteSection(id);
    this.confirmingDeleteSectionId.set(null);
  }

  protected toggleSectionMenu(): void {
    if (this.isEditing()) return;
    this.sectionMenuOpen.update(open => !open);
  }

  protected closeSectionMenu(): void {
    this.sectionMenuOpen.set(false);
  }

  protected startAddingSectionFromMenu(): void {
    this.startAddingSection();
  }

  protected startDeletingActiveSectionFromMenu(): void {
    const sectionId = this.activeSectionId();
    if (!sectionId || this.sections().length < 2) return;
    this.sectionMenuOpen.set(false);
    this.deleteSection(sectionId);
  }

  private deleteSection(sectionId: string): void {
    this.storage.removeSection(sectionId);
    this.refreshSectionsFromStorage();

    const remaining = this.sections();
    if (this.activeSectionId() === sectionId) {
      this.activeSectionId.set(remaining[0]?.id ?? null);
    }

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(synced => this.sections.set(synced)).catch(() => {});
    }
  }

  // ─── List mutation helper ──────────────────────────────

  private updateMainList(updater: (tasks: Task[]) => Task[]): void {
    const sec = this.activeSection();
    const ml = this.mainList();
    if (!sec || !ml) return;

    const syncSectionsFirst = sec.created === true;
    this.storage.setItemsForList(sec.id, ml.id, this.buildItemsFromTasks(ml.items, updater(this.visibleTasks(ml))));
    this.refreshSectionsFromStorage();
    this.syncItemsForList(sec.id, ml.id, syncSectionsFirst);
  }

  private updateBacklogList(updater: (tasks: Task[]) => Task[]): void {
    const sec = this.activeSection();
    const bl = this.backlogList();
    if (!sec || !bl) return;

    const syncSectionsFirst = sec.created === true;
    this.storage.setItemsForList(sec.id, bl.id, this.buildItemsFromTasks(bl.items, updater(this.visibleTasks(bl))));
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
    this.storage.setItemsForList(sec.id, ml.id, this.buildItemsFromTasks(ml.items, mainUpdater(this.visibleTasks(ml))));
    this.storage.setItemsForList(sec.id, bl.id, this.buildItemsFromTasks(bl.items, backlogUpdater(this.visibleTasks(bl))));
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
      .filter(item => !item.deleted)
      .sort((a, b) => a.position - b.position)
      .map(item => ({ ...this.normalizeTask(item.content, item.id), lastModifiedAt: item.lastModifiedAt }));
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
        };
      }

      return {
        id: normalizedTask.id,
        content: normalizedTask,
        position,
        lastModifiedAt: task.lastModifiedAt ?? now,
        created: true,
      };
    });

    const deletedItems = existingItems
      .filter(item => !item.deleted && !nextIds.has(item.id))
      .map(item => ({ ...item, deleted: true, lastModifiedAt: now }));
    const alreadyDeleted = existingItems.filter(item => item.deleted && !nextIds.has(item.id));

    return [...nextItems, ...deletedItems, ...alreadyDeleted];
  }

  private updateListMeta(sectionId: string, list: StoredList, title?: string): void {
    const updatedList: StoredList = {
      ...list,
      ...(title !== undefined ? { title } : {}),
      metadataLastModifiedAt: new Date().toISOString(),
    };
    this.storage.upsertList(sectionId, updatedList);
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSectionLists(sectionId).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private syncItemsForList(sectionId: string, listId: string, syncSectionsFirst = false): void {
    this.syncItemsForLists(sectionId, [listId], syncSectionsFirst);
  }

  private syncItemsForLists(sectionId: string, listIds: string[], syncSectionsFirst = false): void {
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
      .then(async lists => {
        const ids = [...listIds, ...lists.map(list => list.id)];
        for (const listId of [...new Set(ids)]) {
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
    this.storage.setItemsForList(sectionId, list.id, items);
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      const payload = tasks.map((task, position) => ({ id: task.id, position }));
      this.sync.reorderItems(sectionId, list.id, payload)
        .then(positions => {
          this.storage.applyItemPositions(sectionId, list.id, positions);
          this.refreshSectionsFromStorage();
        })
        .catch(() => {});
    }
  }

  // ─── Clear list ─────────────────────────────────────────
  private reorderSubtasksInList(list: StoredList | null, taskId: string, previousIndex: number, currentIndex: number): void {
    const sec = this.activeSection();
    if (!sec || !list) return;

    const items = list.items.map(item => {
      if (item.id !== taskId || item.deleted) return item;

      const task = this.normalizeTask(item.content, item.id);
      const subtasks = [...task.subtasks];
      moveItemInArray(subtasks, previousIndex, currentIndex);
      return {
        ...item,
        content: { ...task, subtasks },
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
    this.updateMainList(tasks => tasks.filter(t => !t.done));
  }

  protected startSecondaryClear(): void { this.confirmingSecondaryClear.set(true); }
  protected cancelSecondaryClear(): void { this.confirmingSecondaryClear.set(false); }
  protected confirmSecondaryClear(): void {
    this.updateBacklogList(() => []);
    this.confirmingSecondaryClear.set(false);
  }
  protected clearDoneSecondary(): void {
    this.updateBacklogList(tasks => tasks.filter(t => !t.done));
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

  protected signOut(): void {
    this.menuOpen.set(false);
    this.storage.setActivePartition(); // switch to anonymous
    this.auth.logout();
    this.refreshSectionsFromStorage();
    const loaded = this.storage.loadSections();
    this.sections.set(loaded);
    this.activeSectionId.set(loaded[0]?.id ?? null);
  }

  protected openSettings(): void {
    this.menuOpen.set(false);
    this.router.navigate(['/settings']);
  }

  protected async manageSubscription(): Promise<void> {
    this.menuOpen.set(false);
    try {
      const url = await this.auth.manageSubscription();
      window.location.href = url;
    } catch {
      // silently fail — user can retry
    }
  }

  // ─── Main task: add ─────────────────────────────────────
  protected startAdding(): void {
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
    this.ensureDefaultSectionForItemCreation();
    const subtasks: Subtask[] = this.newSubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => ({ id: crypto.randomUUID(), text: s, done: false }));
    this.updateMainList(tasks => [
      ...tasks,
      { id: crypto.randomUUID(), text, subtasks, done: false },
    ]);
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
    this.updateMainList(tasks =>
      tasks.map(t => {
        if (t.id !== id) return t;
        const done = !t.done;
        return {
          ...t,
          done,
          subtasks: done ? t.subtasks.map(s => ({ ...s, done: true })) : t.subtasks,
        };
      })
    );
  }

  protected removeTask(id: string): void {
    this.updateMainList(tasks => tasks.filter(t => t.id !== id));
  }

  // ─── Main task: inline edit ─────────────────────────────
  protected startEditingTask(id: string): void {
    if (this.isEditing()) return;
    this.editingTaskId.set(id);
    this.focusEditInput('task-' + id);
  }

  protected saveTaskEdit(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!value) return;
    this.updateMainList(tasks =>
      tasks.map(t => (t.id === id ? { ...t, text: value } : t))
    );
    this.editingTaskId.set(null);
  }

  protected handleTaskEditKeydown(id: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
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
    } else if (event.key === 'Escape') {
      this.cancelAddingSubtask();
    }
  }

  protected onInlineSubtaskInput(event: Event): void {
    this.newInlineSubtaskText.set((event.target as HTMLInputElement).value);
  }

  // ─── Secondary tasks ───────────────────────────────────
  protected startAddingSecondary(): void {
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
    this.ensureDefaultSectionForItemCreation();
    const subtasks: Subtask[] = this.newSecondarySubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => ({ id: crypto.randomUUID(), text: s, done: false }));
    this.updateBacklogList(tasks => [
      ...tasks,
      { id: crypto.randomUUID(), text, subtasks, done: false },
    ]);
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
    else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      this.addSecSubtaskField(true);
    }
    else if (event.key === 'Escape') this.cancelAddingSecondary();
  }

  protected toggleSecondaryTask(id: string): void {
    this.updateBacklogList(tasks =>
      tasks.map(t => {
        if (t.id !== id) return t;
        const done = !t.done;
        return {
          ...t,
          done,
          subtasks: done ? t.subtasks.map(s => ({ ...s, done: true })) : t.subtasks,
        };
      })
    );
  }

  protected removeSecondaryTask(id: string): void {
    this.updateBacklogList(tasks => tasks.filter(t => t.id !== id));
  }

  protected startEditingSecondary(id: string): void {
    if (this.isEditing()) return;
    this.editingSecondaryId.set(id);
    this.focusEditInput('sec-' + id);
  }

  protected saveSecondaryEdit(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!value) return;
    this.updateBacklogList(tasks =>
      tasks.map(t => (t.id === id ? { ...t, text: value } : t))
    );
    this.editingSecondaryId.set(null);
  }

  protected handleSecondaryEditKeydown(id: string, event: KeyboardEvent): void {
    if (event.key === 'Enter') {
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

  private isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(
      target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]')
    );
  }
}
