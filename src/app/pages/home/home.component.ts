import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, Injector, inject, signal, viewChild, ElementRef } from '@angular/core';
import { CdkDragDrop, CdkDrag, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ListSyncService } from '../../services/list-sync.service';
import { ThemeService } from '../../services/theme.service';

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

interface SecondaryTask {
  id: number;
  text: string;
  subtasks: Subtask[];
  done: boolean;
}

const DEFAULT_SECONDARY_TITLE = 'Backlog';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDrag, CdkDropList, RouterLink],
})
export class HomeComponent {
  private readonly injector = inject(Injector);
  protected readonly auth = inject(AuthService);
  private readonly listSync = inject(ListSyncService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  protected readonly dark = this.theme.dark;

  // ─── Main tasks ─────────────────────────────────────────
  protected readonly tasks = signal<Task[]>(this.load('splendide_tasks', []));
  protected readonly adding = signal(false);
  protected readonly newTaskText = signal('');
  protected readonly newSubtasks = signal<string[]>([]);
  protected readonly editingTaskId = signal<number | null>(null);
  protected readonly editingSubtask = signal<{ taskId: number; subtaskId: number } | null>(null);
  protected readonly addingSubtaskToId = signal<number | null>(null);
  protected readonly newInlineSubtaskText = signal('');

  protected readonly taskCount = computed(() => this.tasks().length);
  protected readonly completedCount = computed(() => this.tasks().filter(t => t.done).length);
  protected readonly canAdd = computed(() => this.taskCount() < 5);
  protected readonly allDone = computed(() => {
    const t = this.tasks();
    return t.length > 0 && t.every(task => task.done && task.subtasks.every(s => s.done));
  });

  // ─── Secondary tasks ───────────────────────────────────
  protected readonly secondaryTasks = signal<SecondaryTask[]>(this.load('splendide_secondary', []));
  protected readonly addingSecondary = signal(false);
  protected readonly newSecondaryText = signal('');
  protected readonly newSecondarySubtasks = signal<string[]>([]);
  protected readonly editingSecondaryId = signal<number | null>(null);
  protected readonly editingSecSubtask = signal<{ taskId: number; subtaskId: number } | null>(null);
  protected readonly addingSecSubtaskToId = signal<number | null>(null);
  protected readonly newInlineSecSubtaskText = signal('');
  protected readonly secondaryTitle = signal(this.load('splendide_sec_title', DEFAULT_SECONDARY_TITLE));
  protected readonly editingSecondaryTitle = signal(false);
  protected readonly secondaryVisible = signal(this.load('splendide_sec_visible', true));

  // ─── User menu ──────────────────────────────────────────
  protected readonly menuOpen = signal(false);

  constructor() {
    effect(() => this.save('splendide_tasks', this.tasks()));
    effect(() => this.save('splendide_secondary', this.secondaryTasks()));
    effect(() => this.save('splendide_sec_title', this.secondaryTitle()));
    effect(() => this.save('splendide_sec_visible', this.secondaryVisible()));

    // Auto-sync for premium users
    effect(() => {
      // Read all reactive state to track
      const data = {
        tasks: this.tasks(),
        secondaryTasks: this.secondaryTasks(),
        secondaryTitle: this.secondaryTitle(),
        secondaryVisible: this.secondaryVisible(),
      };
      if (this.auth.isPremium()) {
        this.listSync.debouncedSave(data);
      }
    });

    // Load from server for premium users
    if (this.auth.isPremium()) {
      this.listSync.load().then(data => {
        if (data) {
          this.tasks.set(data.tasks ?? []);
          this.secondaryTasks.set(data.secondaryTasks ?? []);
          this.secondaryTitle.set(data.secondaryTitle ?? DEFAULT_SECONDARY_TITLE);
          this.secondaryVisible.set(data.secondaryVisible ?? true);
        }
      });
    }
  }

  protected readonly secondaryCount = computed(() => this.secondaryTasks().length);
  protected readonly secondaryCompletedCount = computed(() => this.secondaryTasks().filter(t => t.done).length);
  protected readonly canAddSecondary = computed(() => this.secondaryCount() < 1000);

  protected readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth <= 768);
  protected readonly dragDelay = computed(() => this.isMobile() ? { touch: 200, mouse: 0 } : { touch: 0, mouse: 0 });

  // ─── Clear list ─────────────────────────────────────────
  protected readonly confirmingClear = signal(false);
  protected readonly confirmingSecondaryClear = signal(false);

  protected startClear(): void { this.confirmingClear.set(true); }
  protected cancelClear(): void { this.confirmingClear.set(false); }
  protected confirmClear(): void {
    this.tasks.set([]);
    this.confirmingClear.set(false);
  }
  protected clearDoneTasks(): void {
    this.tasks.update(tasks => tasks.filter(t => !t.done));
  }

  protected startSecondaryClear(): void { this.confirmingSecondaryClear.set(true); }
  protected cancelSecondaryClear(): void { this.confirmingSecondaryClear.set(false); }
  protected confirmSecondaryClear(): void {
    this.secondaryTasks.set([]);
    this.confirmingSecondaryClear.set(false);
  }
  protected clearDoneSecondary(): void {
    this.secondaryTasks.update(tasks => tasks.filter(t => !t.done));
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
    this.auth.logout();
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

  // ─── Persistence ────────────────────────────────────────
  private load<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) as T : fallback;
    } catch {
      return fallback;
    }
  }

  private save(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* quota exceeded — ignore */ }
  }

  // ─── Main task: add ─────────────────────────────────────
  protected startAdding(): void {
    if (!this.canAdd()) return;
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
    if (!text) return;
    const subtasks: Subtask[] = this.newSubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map((s, i) => ({ id: Date.now() + i + 1, text: s, done: false }));
    this.tasks.update(tasks => [
      ...tasks,
      { id: Date.now(), text, subtasks, done: false },
    ]);
    this.cancelAdding();
  }

  protected addSubtaskField(): void {
    if (this.newSubtasks().length >= 5) return;
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
    this.tasks.update(tasks =>
      tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }

  protected removeTask(id: number): void {
    this.tasks.update(tasks => tasks.filter(t => t.id !== id));
  }

  // ─── Guard: block edits while any task name input is empty ─
  private hasEmptyTaskEdit(): boolean {
    if (this.editingTaskId() !== null) {
      const el = document.querySelector<HTMLInputElement>(`[data-edit-id="task-${this.editingTaskId()}"]`);
      if (el && !el.value.trim()) return true;
    }
    if (this.editingSecondaryId() !== null) {
      const el = document.querySelector<HTMLInputElement>(`[data-edit-id="sec-${this.editingSecondaryId()}"]`);
      if (el && !el.value.trim()) return true;
    }
    const sub = this.editingSubtask();
    if (sub) {
      const el = document.querySelector<HTMLInputElement>(`[data-edit-id="sub-${sub.subtaskId}"]`);
      if (el && !el.value.trim()) return true;
    }
    const secSub = this.editingSecSubtask();
    if (secSub) {
      const el = document.querySelector<HTMLInputElement>(`[data-edit-id="secsub-${secSub.subtaskId}"]`);
      if (el && !el.value.trim()) return true;
    }
    return false;
  }

  // ─── Main task: inline edit ─────────────────────────────
  protected startEditingTask(id: number): void {
    if (this.hasEmptyTaskEdit()) return;
    this.editingTaskId.set(id);
    this.focusEditInput('task-' + id);
  }

  protected saveTaskEdit(id: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!value) return;
    this.tasks.update(tasks =>
      tasks.map(t => (t.id === id ? { ...t, text: value } : t))
    );
    this.editingTaskId.set(null);
  }

  protected handleTaskEditKeydown(id: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveTaskEdit(id, event);
    else if (event.key === 'Escape') {
      const task = this.tasks().find(t => t.id === id);
      if (task) (event.target as HTMLInputElement).value = task.text;
      this.editingTaskId.set(null);
    }
  }

  // ─── Subtask: toggle / remove / edit ────────────────────
  protected toggleSubtask(taskId: number, subtaskId: number): void {
    this.tasks.update(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSubtask(taskId: number, subtaskId: number): void {
    this.tasks.update(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
          : t
      )
    );
  }

  protected startEditingSubtask(taskId: number, subtaskId: number): void {
    if (this.hasEmptyTaskEdit()) return;
    this.editingSubtask.set({ taskId, subtaskId });
    this.focusEditInput('sub-' + subtaskId);
  }

  protected saveSubtaskEdit(taskId: number, subtaskId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.tasks.update(tasks =>
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
    if (this.hasEmptyTaskEdit()) return;
    const task = this.tasks().find(t => t.id === taskId);
    if (!task || task.subtasks.length >= 5) return;
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
    this.tasks.update(tasks =>
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
    if (!this.canAddSecondary()) return;
    this.addingSecondary.set(true);
    this.newSecondaryText.set('');
    this.newSecondarySubtasks.set([]);
    setTimeout(() => document.querySelector<HTMLInputElement>('.add-form-sec .input-minimal')?.focus());
  }

  protected cancelAddingSecondary(): void {
    this.addingSecondary.set(false);
    this.newSecondaryText.set('');
    this.newSecondarySubtasks.set([]);
    this.newSecondaryText.set('');
  }

  protected confirmAddSecondary(): void {
    const text = this.newSecondaryText().trim();
    if (!text) return;
    const subtasks: Subtask[] = this.newSecondarySubtasks()
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map((s, i) => ({ id: Date.now() + i + 1, text: s, done: false }));
    this.secondaryTasks.update(tasks => [
      ...tasks,
      { id: Date.now(), text, subtasks, done: false },
    ]);
    this.cancelAddingSecondary();
  }

  protected onNewSecondaryInput(event: Event): void {
    this.newSecondaryText.set((event.target as HTMLInputElement).value);
  }

  protected handleSecondaryKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.confirmAddSecondary();
    else if (event.key === 'Escape') this.cancelAddingSecondary();
  }

  protected toggleSecondaryTask(id: number): void {
    this.secondaryTasks.update(tasks =>
      tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }

  protected removeSecondaryTask(id: number): void {
    this.secondaryTasks.update(tasks => tasks.filter(t => t.id !== id));
  }

  protected startEditingSecondary(id: number): void {
    if (this.hasEmptyTaskEdit()) return;
    this.editingSecondaryId.set(id);
    this.focusEditInput('sec-' + id);
  }

  protected saveSecondaryEdit(id: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!value) return;
    this.secondaryTasks.update(tasks =>
      tasks.map(t => (t.id === id ? { ...t, text: value } : t))
    );
    this.editingSecondaryId.set(null);
  }

  protected handleSecondaryEditKeydown(id: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecondaryEdit(id, event);
    else if (event.key === 'Escape') {
      const task = this.secondaryTasks().find(t => t.id === id);
      if (task) (event.target as HTMLInputElement).value = task.text;
      this.editingSecondaryId.set(null);
    }
  }

  // ─── Secondary title editing ────────────────────────────
  protected startEditingSecondaryTitle(): void {
    this.editingSecondaryTitle.set(true);
    afterNextRender(() => {
      document.querySelector<HTMLInputElement>('.sec-title-input')?.focus();
    }, { injector: this.injector });
  }

  protected saveSecondaryTitle(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.secondaryTitle.set(value);
    }
    this.editingSecondaryTitle.set(false);
  }

  protected handleSecondaryTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecondaryTitle(event);
    else if (event.key === 'Escape') this.editingSecondaryTitle.set(false);
  }

  // ─── Secondary subtasks ─────────────────────────────────
  protected addSecSubtaskField(): void {
    if (this.newSecondarySubtasks().length >= 5) return;
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
    this.secondaryTasks.update(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.id === subtaskId ? { ...s, done: !s.done } : s)) }
          : t
      )
    );
  }

  protected removeSecSubtask(taskId: number, subtaskId: number): void {
    this.secondaryTasks.update(tasks =>
      tasks.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== subtaskId) }
          : t
      )
    );
  }

  protected startEditingSecSubtask(taskId: number, subtaskId: number): void {
    if (this.hasEmptyTaskEdit()) return;
    this.editingSecSubtask.set({ taskId, subtaskId });
    this.focusEditInput('secsub-' + subtaskId);
  }

  protected saveSecSubtaskEdit(taskId: number, subtaskId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.secondaryTasks.update(tasks =>
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
    if (this.hasEmptyTaskEdit()) return;
    const task = this.secondaryTasks().find(t => t.id === taskId);
    if (!task || task.subtasks.length >= 5) return;
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
    this.secondaryTasks.update(tasks =>
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
    const mainItems = [...this.tasks()];
    const idx = mainItems.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const [task] = mainItems.splice(idx, 1);
    const secItems = [...this.secondaryTasks()];
    const newSec: SecondaryTask = { id: task.id, text: task.text, subtasks: task.subtasks, done: task.done };

    if (secItems.length >= 1000) {
      const displaced = secItems.shift()!;
      const newMain: Task = { id: displaced.id, text: displaced.text, subtasks: displaced.subtasks, done: displaced.done };
      mainItems.push(newMain);
    }

    secItems.push(newSec);
    this.tasks.set(mainItems);
    this.secondaryTasks.set(secItems);
  }

  protected moveToMain(taskId: number): void {
    const secItems = [...this.secondaryTasks()];
    const idx = secItems.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const [task] = secItems.splice(idx, 1);
    const mainItems = [...this.tasks()];
    const newMain: Task = { id: task.id, text: task.text, subtasks: task.subtasks, done: task.done };

    if (mainItems.length >= 5) {
      const displaced = mainItems.pop()!;
      const newSec: SecondaryTask = { id: displaced.id, text: displaced.text, subtasks: displaced.subtasks, done: displaced.done };
      secItems.unshift(newSec);
    }

    mainItems.push(newMain);
    this.tasks.set(mainItems);
    this.secondaryTasks.set(secItems);
  }

  // ─── Drag & drop: main tasks ────────────────────────────
  protected dropMainTask(event: CdkDragDrop<unknown[]>): void {
    if (event.previousContainer === event.container) {
      const items = [...this.tasks()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.tasks.set(items);
    } else {
      const secItems = [...this.secondaryTasks()];
      const mainItems = [...this.tasks()];
      const secTask = secItems[event.previousIndex]!;
      secItems.splice(event.previousIndex, 1);
      const newTask: Task = { id: secTask.id, text: secTask.text, subtasks: secTask.subtasks, done: secTask.done };

      if (mainItems.length >= 5) {
        // Main list full — last main item goes to first position of backlog
        const displaced = mainItems.pop()!;
        const newSec: SecondaryTask = { id: displaced.id, text: displaced.text, subtasks: displaced.subtasks, done: displaced.done };
        secItems.unshift(newSec);
      }

      mainItems.splice(event.currentIndex, 0, newTask);
      this.secondaryTasks.set(secItems);
      this.tasks.set(mainItems);
    }
  }

  protected dropSecondaryTask(event: CdkDragDrop<unknown[]>): void {
    if (event.previousContainer === event.container) {
      const items = [...this.secondaryTasks()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.secondaryTasks.set(items);
    } else {
      const mainItems = [...this.tasks()];
      const secItems = [...this.secondaryTasks()];
      const mainTask = mainItems[event.previousIndex]!;
      mainItems.splice(event.previousIndex, 1);
      const newSec: SecondaryTask = { id: mainTask.id, text: mainTask.text, subtasks: mainTask.subtasks, done: mainTask.done };

      if (secItems.length >= 1000) {
        // Backlog full — first backlog item goes to last position of main list
        const displaced = secItems.shift()!;
        const newMain: Task = { id: displaced.id, text: displaced.text, subtasks: displaced.subtasks, done: displaced.done };
        mainItems.push(newMain);
      }

      secItems.splice(event.currentIndex, 0, newSec);
      this.tasks.set(mainItems);
      this.secondaryTasks.set(secItems);
    }
  }

  // ─── Scroll between sections ────────────────────────────
  private focusEditInput(editId: string): void {
    afterNextRender(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-edit-id="${editId}"]`);
      input?.focus();
    }, { injector: this.injector });
  }

}
