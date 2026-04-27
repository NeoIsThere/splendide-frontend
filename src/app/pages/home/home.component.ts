import { afterNextRender, ChangeDetectionStrategy, Component, computed, Injector, inject, signal, viewChild, ElementRef, OnDestroy } from '@angular/core';
import { CdkDragDrop, CdkDrag, CdkDropList, CdkDragPlaceholder, moveItemInArray } from '@angular/cdk/drag-drop';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { StorageService, StoredSection, StoredList } from '../../services/storage.service';
import { SyncService } from '../../services/sync.service';

interface Subtask {
  id: number;
  text: string;
  done: boolean;
}

interface Task {
  id: number;
  text: string;
  subtasks: Subtask[];
  done: boolean;
}

const DEFAULT_BACKLOG_TITLE = 'Later';
const MAX_SECTIONS = 5;
const MAX_MAIN_TASKS = 5;
const MAX_BACKLOG_TASKS = 1000;

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
  protected readonly tasks = computed<Task[]>(() => (this.mainList()?.content as Task[]) ?? []);
  protected readonly secondaryTasks = computed<Task[]>(() => (this.backlogList()?.content as Task[]) ?? []);
  protected readonly secondaryTitle = computed(() => this.backlogList()?.title || DEFAULT_BACKLOG_TITLE);

  // ─── Main tasks state ──────────────────────────────────
  protected readonly adding = signal(false);
  protected readonly newTaskText = signal('');
  protected readonly newSubtasks = signal<string[]>([]);
  protected readonly editingTaskId = signal<number | null>(null);
  protected readonly editingSubtask = signal<{ taskId: number; subtaskId: number } | null>(null);
  protected readonly addingSubtaskToId = signal<number | null>(null);
  protected readonly newInlineSubtaskText = signal('');

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
  protected readonly editingSecondaryId = signal<number | null>(null);
  protected readonly editingSecSubtask = signal<{ taskId: number; subtaskId: number } | null>(null);
  protected readonly addingSecSubtaskToId = signal<number | null>(null);
  protected readonly newInlineSecSubtaskText = signal('');
  protected readonly editingSecondaryTitle = signal(false);
  protected readonly secondaryVisible = signal(true);

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
    this.editingSecondaryTitle() ||
    this.editingSectionId() !== null ||
    this.addingSectionTitle() !== null
  );

  protected readonly secondaryCount = computed(() => this.secondaryTasks().length);
  protected readonly secondaryCompletedCount = computed(() => this.secondaryTasks().filter(t => t.done).length);
  protected readonly canAddSecondary = computed(() => this.secondaryCount() < MAX_BACKLOG_TASKS);

  protected readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth <= 768);
  protected readonly dragDelay = computed(() => this.isMobile() ? { touch: 200, mouse: 0 } : { touch: 0, mouse: 0 });
  protected readonly activeSectionIndex = computed(() => this.sections().findIndex(s => s.id === this.activeSectionId()));
  protected readonly showPrevArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() > 0);
  protected readonly showNextArrow = computed(() => this.sections().length > 1 && this.activeSectionIndex() < this.sections().length - 1);

  private syncIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.initFromStorage();
  }

  ngOnDestroy(): void {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  private initFromStorage(): void {
    // Set active partition
    const userId = this.auth.user()?.id;
    if (userId) {
      this.storage.setActivePartition(userId);
      if (!this.auth.isPremium() && this.storage.isPartitionEmpty(userId)) {
        this.storage.copyAnonymousToUser(userId);
      }
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
      this.doFullSync();
    }
  }

  private async doFullSync(): Promise<void> {
    try {
      const synced = await this.sync.syncSections();
      this.sections.set(synced);
      const first = synced[0];
      if (first) {
        this.activeSectionId.set(first.id);
        await this.doSyncSectionLists(first.id);
      }
    } catch { /* silently fail */ }
    this.startPeriodicSync();
  }

  private startPeriodicSync(): void {
    if (this.syncIntervalId !== null) return;
    this.syncIntervalId = setInterval(() => {
      if (this.auth.isLoggedIn() && this.auth.isPremium()) {
        this.doPeriodicSync();
      }
    }, 30_000);
  }

  private async doPeriodicSync(): Promise<void> {
    try {
      const synced = await this.sync.syncSections();
      this.sections.set(synced);
      const activeId = this.activeSectionId();
      if (activeId) {
        await this.doSyncSectionLists(activeId);
      }
    } catch { /* silently fail */ }
  }

  private async doSyncSectionLists(sectionId: string): Promise<void> {
    try {
      const lists = await this.sync.syncSectionLists(sectionId);
      this.refreshSectionsFromStorage();
    } catch { /* silently fail */ }
  }

  private refreshSectionsFromStorage(): void {
    this.sections.set(this.storage.loadSections());
  }

  // ─── Section tab switching ─────────────────────────────

  protected selectSection(sectionId: string): void {
    if (this.activeSectionId() === sectionId) return;
    this.sectionMenuOpen.set(false);
    this.activeSectionId.set(sectionId);

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(synced => {
        this.sections.set(synced);
        return this.doSyncSectionLists(sectionId);
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
    const movedSection = items[event.previousIndex];
    moveItemInArray(items, event.previousIndex, event.currentIndex);
    items.forEach((s, i) => s.position = i);
    this.storage.saveSections(items);
    this.sections.set(items);

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.reorderSections(movedSection.id, event.previousIndex, event.currentIndex)
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

  protected dropSubtask(taskId: number, event: CdkDragDrop<Subtask[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.updateMainList(tasks =>
      tasks.map(t => {
        if (t.id !== taskId) return t;
        const subs = [...t.subtasks];
        moveItemInArray(subs, event.previousIndex, event.currentIndex);
        return { ...t, subtasks: subs };
      })
    );
  }

  protected dropSecSubtask(taskId: number, event: CdkDragDrop<Subtask[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.updateBacklogList(tasks =>
      tasks.map(t => {
        if (t.id !== taskId) return t;
        const subs = [...t.subtasks];
        moveItemInArray(subs, event.previousIndex, event.currentIndex);
        return { ...t, subtasks: subs };
      })
    );
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

    const now = new Date().toISOString();
    const sectionId = crypto.randomUUID();
    const mainListId = crypto.randomUUID();
    const backlogListId = crypto.randomUUID();

    const newSection: StoredSection = {
      id: sectionId,
      title,
      position: this.sections().length,
      metadataLastModifiedAt: now,
      isNew: true,
      lists: [
        { id: mainListId, title: '', lastModifiedAt: now, content: [], isBacklog: false },
        { id: backlogListId, title: DEFAULT_BACKLOG_TITLE, lastModifiedAt: now, content: [], isBacklog: true },
      ],
    };

    this.storage.upsertSection(newSection);
    this.refreshSectionsFromStorage();
    this.activeSectionId.set(sectionId);
    this.cancelAddingSection();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSections().then(synced => {
        this.sections.set(synced);
        return this.sync.syncSectionLists(sectionId);
      }).then(() => this.refreshSectionsFromStorage()).catch(() => {});
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

    const newContent = updater(ml.content as Task[]);
    const now = new Date().toISOString();
    const updatedList: StoredList = { ...ml, content: newContent, lastModifiedAt: now };
    this.storage.upsertList(sec.id, updatedList);
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSectionLists(sec.id).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private updateBacklogList(updater: (tasks: Task[]) => Task[]): void {
    const sec = this.activeSection();
    const bl = this.backlogList();
    if (!sec || !bl) return;

    const newContent = updater(bl.content as Task[]);
    const now = new Date().toISOString();
    const updatedList: StoredList = { ...bl, content: newContent, lastModifiedAt: now };
    this.storage.upsertList(sec.id, updatedList);
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSectionLists(sec.id).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private updateBothLists(mainUpdater: (tasks: Task[]) => Task[], backlogUpdater: (tasks: Task[]) => Task[]): void {
    const sec = this.activeSection();
    const ml = this.mainList();
    const bl = this.backlogList();
    if (!sec || !ml || !bl) return;

    const now = new Date().toISOString();
    const updatedMain: StoredList = { ...ml, content: mainUpdater(ml.content as Task[]), lastModifiedAt: now };
    const updatedBacklog: StoredList = { ...bl, content: backlogUpdater(bl.content as Task[]), lastModifiedAt: now };
    this.storage.upsertList(sec.id, updatedMain);
    this.storage.upsertList(sec.id, updatedBacklog);
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSectionLists(sec.id).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  private updateBacklogMeta(title?: string): void {
    const sec = this.activeSection();
    const bl = this.backlogList();
    if (!sec || !bl) return;

    const now = new Date().toISOString();
    const updatedList: StoredList = { ...bl, lastModifiedAt: now };
    if (title !== undefined) updatedList.title = title;
    this.storage.upsertList(sec.id, updatedList);
    this.refreshSectionsFromStorage();

    if (this.auth.isLoggedIn() && this.auth.isPremium()) {
      this.sync.syncSectionLists(sec.id).then(() => this.refreshSectionsFromStorage()).catch(() => {});
    }
  }

  // ─── Clear list ─────────────────────────────────────────
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
    const subtasks: Subtask[] = this.newSubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map((s, i) => ({ id: Date.now() + i + 1, text: s, done: false }));
    this.updateMainList(tasks => [
      ...tasks,
      { id: Date.now(), text, subtasks, done: false },
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

  protected addSubtaskField(): void {
    if (this.newSubtasks().length >= 10) return;
    this.newSubtasks.update(s => [...s, '']);
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
    else if (event.key === 'Escape') this.cancelAdding();
  }

  // ─── Main task: toggle / remove ─────────────────────────
  protected toggleTask(id: number): void {
    this.updateMainList(tasks =>
      tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }

  protected removeTask(id: number): void {
    this.updateMainList(tasks => tasks.filter(t => t.id !== id));
  }

  // ─── Main task: inline edit ─────────────────────────────
  protected startEditingTask(id: number): void {
    if (this.isEditing()) return;
    this.editingTaskId.set(id);
    this.focusEditInput('task-' + id);
  }

  protected saveTaskEdit(id: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!value) return;
    this.updateMainList(tasks =>
      tasks.map(t => (t.id === id ? { ...t, text: value } : t))
    );
    this.editingTaskId.set(null);
  }

  protected handleTaskEditKeydown(id: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveTaskEdit(id, event);
    else if (event.key === 'Escape') {
      this.editingTaskId.set(null);
    }
  }

  // ─── Subtask: toggle / remove / edit ────────────────────
  protected toggleSubtask(taskId: number, subtaskId: number): void {
    this.updateMainList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSubtask(taskId: number, subtaskId: number): void {
    this.updateMainList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
          : t
      )
    );
  }

  protected startEditingSubtask(taskId: number, subtaskId: number): void {
    if (this.isEditing()) return;
    this.editingSubtask.set({ taskId, subtaskId });
    this.focusEditInput('sub-' + subtaskId);
  }

  protected saveSubtaskEdit(taskId: number, subtaskId: number, event: Event): void {
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

  protected handleSubtaskEditKeydown(taskId: number, subtaskId: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSubtaskEdit(taskId, subtaskId, event);
    else if (event.key === 'Escape') this.editingSubtask.set(null);
  }

  // ─── Subtask: add to existing task ─────────────────────
  protected startAddingSubtask(taskId: number): void {
    if (this.isEditing()) return;
    const task = this.tasks().find(t => t.id === taskId);
    if (!task || task.subtasks.length >= 10) return;
    this.addingSubtaskToId.set(taskId);
    this.newInlineSubtaskText.set('');
    afterNextRender(() => {
      document.querySelector<HTMLInputElement>('[data-inline-subtask]')?.focus();
    }, { injector: this.injector });
  }

  protected cancelAddingSubtask(): void {
    this.addingSubtaskToId.set(null);
    this.newInlineSubtaskText.set('');
  }

  protected confirmAddSubtask(taskId: number): void {
    const text = this.newInlineSubtaskText().trim();
    if (!text) {
      this.cancelAddingSubtask();
      return;
    }
    this.updateMainList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: [...t.subtasks, { id: Date.now(), text, done: false }] }
          : t
      )
    );
    this.cancelAddingSubtask();
  }

  protected handleInlineSubtaskKeydown(taskId: number, event: KeyboardEvent): void {
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
    const subtasks: Subtask[] = this.newSecondarySubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map((s, i) => ({ id: Date.now() + i + 1, text: s, done: false }));
    this.updateBacklogList(tasks => [
      ...tasks,
      { id: Date.now(), text, subtasks, done: false },
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
    else if (event.key === 'Escape') this.cancelAddingSecondary();
  }

  protected toggleSecondaryTask(id: number): void {
    this.updateBacklogList(tasks =>
      tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }

  protected removeSecondaryTask(id: number): void {
    this.updateBacklogList(tasks => tasks.filter(t => t.id !== id));
  }

  protected startEditingSecondary(id: number): void {
    if (this.isEditing()) return;
    this.editingSecondaryId.set(id);
    this.focusEditInput('sec-' + id);
  }

  protected saveSecondaryEdit(id: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!value) return;
    this.updateBacklogList(tasks =>
      tasks.map(t => (t.id === id ? { ...t, text: value } : t))
    );
    this.editingSecondaryId.set(null);
  }

  protected handleSecondaryEditKeydown(id: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecondaryEdit(id, event);
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
  protected addSecSubtaskField(): void {
    if (this.newSecondarySubtasks().length >= 10) return;
    this.newSecondarySubtasks.update(s => [...s, '']);
  }

  protected removeSecSubtaskField(index: number): void {
    this.newSecondarySubtasks.update(s => s.filter((_, i) => i !== index));
  }

  protected updateNewSecSubtask(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.newSecondarySubtasks.update(s => s.map((v, i) => (i === index ? value : v)));
  }

  protected toggleSecSubtask(taskId: number, subtaskId: number): void {
    this.updateBacklogList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSecSubtask(taskId: number, subtaskId: number): void {
    this.updateBacklogList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
          : t
      )
    );
  }

  protected startEditingSecSubtask(taskId: number, subtaskId: number): void {
    if (this.isEditing()) return;
    this.editingSecSubtask.set({ taskId, subtaskId });
    this.focusEditInput('secsub-' + subtaskId);
  }

  protected saveSecSubtaskEdit(taskId: number, subtaskId: number, event: Event): void {
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

  protected handleSecSubtaskEditKeydown(taskId: number, subtaskId: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecSubtaskEdit(taskId, subtaskId, event);
    else if (event.key === 'Escape') this.editingSecSubtask.set(null);
  }

  protected startAddingSecSubtask(taskId: number): void {
    if (this.isEditing()) return;
    const task = this.secondaryTasks().find(t => t.id === taskId);
    if (!task || task.subtasks.length >= 10) return;
    this.addingSecSubtaskToId.set(taskId);
    this.newInlineSecSubtaskText.set('');
    afterNextRender(() => {
      document.querySelector<HTMLInputElement>('[data-inline-sec-subtask]')?.focus();
    }, { injector: this.injector });
  }

  protected cancelAddingSecSubtask(): void {
    this.addingSecSubtaskToId.set(null);
    this.newInlineSecSubtaskText.set('');
  }

  protected confirmAddSecSubtask(taskId: number): void {
    const text = this.newInlineSecSubtaskText().trim();
    if (!text) {
      this.cancelAddingSecSubtask();
      return;
    }
    this.updateBacklogList(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: [...t.subtasks, { id: Date.now(), text, done: false }] }
          : t
      )
    );
    this.cancelAddingSecSubtask();
  }

  protected handleInlineSecSubtaskKeydown(taskId: number, event: KeyboardEvent): void {
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

  // ─── Move between lists (mobile buttons) ──────────────
  protected moveToBacklog(taskId: number): void {
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
    this.updateBothLists(() => mainItems, () => secItems);
  }

  protected moveToMain(taskId: number): void {
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
    this.updateBothLists(() => mainItems, () => secItems);
  }

  // ─── Drag & drop: main tasks ────────────────────────────
  protected dropMainTask(event: CdkDragDrop<unknown[]>): void {
    if (this.isEditing()) return;
    if (event.previousContainer === event.container) {
      const items = [...this.tasks()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.updateMainList(() => items);
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
      this.updateBothLists(() => mainItems, () => secItems);
    }
  }

  protected dropSecondaryTask(event: CdkDragDrop<unknown[]>): void {
    if (this.isEditing()) return;
    if (event.previousContainer === event.container) {
      const items = [...this.secondaryTasks()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.updateBacklogList(() => items);
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
      this.updateBothLists(() => mainItems, () => secItems);
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

  private focusEditInput(editId: string): void {
    afterNextRender(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-edit-id="${editId}"]`);
      input?.focus();
    }, { injector: this.injector });
  }
}
