import type { ProjectDocument } from '../domain/project';

export type ProjectCommand = Readonly<{
  label: string;
  coalesceKey?: string;
  apply: (document: ProjectDocument) => ProjectDocument;
}>;

type HistoryEntry = {
  label: string;
  coalesceKey?: string;
  before: ProjectDocument;
  after: ProjectDocument;
};

export type HistorySnapshot = Readonly<{ label: string; coalesceKey?: string }>;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  }
  return value;
}

function immutableDocument(document: ProjectDocument): ProjectDocument {
  return deepFreeze(structuredClone(document));
}

export class CommandBus {
  private document: ProjectDocument;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private transaction?: { label: string; before: ProjectDocument; changed: boolean };
  private openCoalesceKey?: string;

  constructor(
    initialDocument: ProjectDocument,
    readonly maxHistory = 100,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    if (!Number.isSafeInteger(maxHistory) || maxHistory < 0) throw new TypeError('maxHistory must be a non-negative integer');
    this.document = immutableDocument(initialDocument);
  }

  get current(): ProjectDocument { return this.document; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoDepth(): number { return this.undoStack.length; }
  get undoHistory(): readonly HistorySnapshot[] {
    return Object.freeze(this.undoStack.map(({ label, coalesceKey }) => Object.freeze({ label, ...(coalesceKey ? { coalesceKey } : {}) })));
  }

  execute(command: ProjectCommand): ProjectDocument {
    const before = this.document;
    const applied = command.apply(before);
    if (applied === before) return before;
    const after = immutableDocument({ ...applied, updatedAt: this.clock() });
    this.document = after;
    this.redoStack.length = 0;

    if (this.transaction) {
      this.transaction.changed = true;
      return after;
    }

    const previous = this.undoStack.at(-1);
    if (command.coalesceKey && this.openCoalesceKey === command.coalesceKey && previous?.coalesceKey === command.coalesceKey) {
      previous.after = after;
      previous.label = command.label;
    } else {
      this.pushUndo({ label: command.label, coalesceKey: command.coalesceKey, before, after });
    }
    this.openCoalesceKey = command.coalesceKey;
    return after;
  }

  runTransaction(label: string, operation: () => void): ProjectDocument {
    if (this.transaction) {
      operation();
      return this.document;
    }
    const transaction = { label, before: this.document, changed: false };
    const redoBefore = [...this.redoStack];
    this.transaction = transaction;
    try {
      operation();
    } catch (error) {
      this.document = transaction.before;
      this.redoStack.splice(0, this.redoStack.length, ...redoBefore);
      throw error;
    } finally {
      this.transaction = undefined;
      this.openCoalesceKey = undefined;
    }
    if (transaction.changed && this.document !== transaction.before) {
      this.pushUndo({ label, before: transaction.before, after: this.document });
    }
    return this.document;
  }

  undo(): ProjectDocument {
    if (this.transaction) throw new Error('Cannot undo inside a transaction');
    const entry = this.undoStack.pop();
    if (!entry) return this.document;
    this.document = entry.before;
    this.redoStack.push(entry);
    this.openCoalesceKey = undefined;
    return this.document;
  }

  redo(): ProjectDocument {
    if (this.transaction) throw new Error('Cannot redo inside a transaction');
    const entry = this.redoStack.pop();
    if (!entry) return this.document;
    this.document = entry.after;
    this.undoStack.push(entry);
    this.openCoalesceKey = undefined;
    return this.document;
  }

  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.openCoalesceKey = undefined;
  }

  /** Call on pointer-up / input blur so a later gesture creates a new undo step. */
  endCoalescing(): void { this.openCoalesceKey = undefined; }

  private pushUndo(entry: HistoryEntry): void {
    if (this.maxHistory === 0) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.splice(0, this.undoStack.length - this.maxHistory);
  }
}
