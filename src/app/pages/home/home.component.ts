import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, Injector, inject, signal, viewChild, ElementRef } from '@angular/core';
import { CdkDragDrop, CdkDrag, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { RouterLink } from '@angular/router';
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
  protected readonly editingSecondaryId = signal<number | null>(null);
  protected readonly secondaryTitle = signal(this.load('splendide_sec_title', 'secondary'));
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
          this.secondaryTitle.set(data.secondaryTitle ?? 'secondary');
          this.secondaryVisible.set(data.secondaryVisible ?? true);
        }
      });
    }
  }

  protected readonly secondaryCount = computed(() => this.secondaryTasks().length);
  protected readonly secondaryCompletedCount = computed(() => this.secondaryTasks().filter(t => t.done).length);
  protected readonly canAddSecondary = computed(() => this.secondaryCount() < 15);

  // ─── Clear list ─────────────────────────────────────────
  protected readonly confirmingClear = signal(false);
  protected readonly confirmingSecondaryClear = signal(false);

  protected startClear(): void { this.confirmingClear.set(true); }
  protected cancelClear(): void { this.confirmingClear.set(false); }
  protected confirmClear(): void {
    this.tasks.set([]);
    this.confirmingClear.set(false);
  }

  protected startSecondaryClear(): void { this.confirmingSecondaryClear.set(true); }
  protected cancelSecondaryClear(): void { this.confirmingSecondaryClear.set(false); }
  protected confirmSecondaryClear(): void {
    this.secondaryTasks.set([]);
    this.confirmingSecondaryClear.set(false);
  }

  // ─── Scroll ─────────────────────────────────────────────
  protected readonly mainSection = viewChild<ElementRef<HTMLElement>>('mainSection');
  protected readonly secondarySection = viewChild<ElementRef<HTMLElement>>('secondarySection');
  protected readonly viewingSecondary = signal(false);

  // ─── User menu ──────────────────────────────────────────
  protected toggleMenu(): void {
    this.menuOpen.update(v => !v);
  }

  protected toggleDark(): void {
    this.theme.toggle();
  }

  protected signOut(): void {
    this.menuOpen.set(false);
    this.auth.logout();
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

  // ─── Main task: inline edit ─────────────────────────────
  protected startEditingTask(id: number): void {
    this.editingTaskId.set(id);
    this.focusEditInput('task-' + id);
  }

  protected saveTaskEdit(id: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.tasks.update(tasks =>
        tasks.map(t => (t.id === id ? { ...t, text: value } : t))
      );
    }
    this.editingTaskId.set(null);
  }

  protected handleTaskEditKeydown(id: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveTaskEdit(id, event);
    else if (event.key === 'Escape') this.editingTaskId.set(null);
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
    setTimeout(() => document.querySelector<HTMLInputElement>('.add-form-sec .input-minimal')?.focus());
  }

  protected cancelAddingSecondary(): void {
    this.addingSecondary.set(false);
    this.newSecondaryText.set('');
  }

  protected confirmAddSecondary(): void {
    const text = this.newSecondaryText().trim();
    if (!text) return;
    this.secondaryTasks.update(tasks => [
      ...tasks,
      { id: Date.now(), text, subtasks: [], done: false },
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
    this.editingSecondaryId.set(id);
    this.focusEditInput('sec-' + id);
  }

  protected saveSecondaryEdit(id: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (value) {
      this.secondaryTasks.update(tasks =>
        tasks.map(t => (t.id === id ? { ...t, text: value } : t))
      );
    }
    this.editingSecondaryId.set(null);
  }

  protected handleSecondaryEditKeydown(id: number, event: KeyboardEvent): void {
    if (event.key === 'Enter') this.saveSecondaryEdit(id, event);
    else if (event.key === 'Escape') this.editingSecondaryId.set(null);
  }

  // ─── Secondary title editing ────────────────────────────
  protected startEditingSecondaryTitle(): void {
    this.editingSecondaryTitle.set(true);
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

  // ─── Toggle secondary visibility ────────────────────────
  protected toggleSecondaryVisibility(): void {
    this.secondaryVisible.update(v => !v);
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
        // Main list full — swap: last main item goes to secondary
        const displaced = mainItems.pop()!;
        const newSec: SecondaryTask = { id: displaced.id, text: displaced.text, subtasks: displaced.subtasks, done: displaced.done };
        secItems.splice(event.previousIndex, 0, newSec);
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
      if (this.secondaryTasks().length >= 5) return;
      const mainItems = [...this.tasks()];
      const secItems = [...this.secondaryTasks()];
      const mainTask = mainItems[event.previousIndex]!;
      mainItems.splice(event.previousIndex, 1);
      const newSec: SecondaryTask = { id: mainTask.id, text: mainTask.text, subtasks: mainTask.subtasks, done: mainTask.done };
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

  protected scrollToSection(): void {
    if (this.viewingSecondary()) {
      this.mainSection()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      this.secondarySection()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    this.viewingSecondary.update(v => !v);
  }
}
