import { ConflictError, RetryableError, type ShotNumberApi } from './api';
import type { IssueResponse } from './types';

/** 一次尚未确认成功的操作：网络异常 / 5xx 之后保留在此，等待重试。 */
export interface PendingOperation {
  scene_id: string;
  client_op_id: string;
  notes: string;
  attempts: number;
  last_error: string | null;
}

/** 被服务器拒绝（409 冲突）的操作：重试无意义，仅作反馈展示。 */
export interface FailedOperation {
  scene_id: string;
  client_op_id: string;
  notes: string;
  reason: string;
  existing_shot_number: number | null;
}

export interface IssuerSnapshot {
  pending: PendingOperation[];
  failed: FailedOperation[];
  issued: IssueResponse[];
}

/** localStorage 的最小抽象，便于测试注入。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'shot-number-issuer:pending:v1';

export type IdGenerator = () => string;

export function defaultIdGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 镜号领取控制器。
 *
 * 关键不变式：一个 client_op_id 对应且仅对应一次"领取下一条镜号"的意图。
 * - 提交前先把操作持久化到本地存储，随后无论页面刷新、断网还是服务崩溃，
 *   待重试操作都不会丢失；
 * - 重试永远使用最初保存的 (scene_id, client_op_id, notes)，因此幂等；
 * - 只有拿到成功响应才会把操作移出待重试列表。
 */
export class Issuer {
  private pendingOps = new Map<string, PendingOperation>();
  private failedOps: FailedOperation[] = [];
  private issuedOps: IssueResponse[] = [];
  private snapshot: IssuerSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly api: ShotNumberApi,
    private readonly storage: KeyValueStorage,
    private readonly generateId: IdGenerator = defaultIdGenerator,
  ) {
    for (const op of this.loadPersisted()) {
      this.pendingOps.set(op.client_op_id, op);
    }
    this.snapshot = this.computeSnapshot();
  }

  newOperationId(): string {
    return this.generateId();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): IssuerSnapshot => this.snapshot;

  /**
   * 提交一次新操作。injectFailureAfterCommit 只在首次尝试时透传（开发用），
   * 重试永远不会再携带它。
   */
  async submit(input: {
    scene_id: string;
    notes: string;
    client_op_id?: string;
    injectFailureAfterCommit?: boolean;
  }): Promise<string> {
    const op: PendingOperation = {
      scene_id: input.scene_id,
      notes: input.notes,
      client_op_id: input.client_op_id?.trim() || this.generateId(),
      attempts: 0,
      last_error: null,
    };
    this.pendingOps.set(op.client_op_id, op);
    this.persist();
    this.emit();
    await this.attempt(op.client_op_id, input.injectFailureAfterCommit === true);
    return op.client_op_id;
  }

  /** 用最初保存的原始载荷重试一次待重试操作。 */
  async retry(clientOpId: string): Promise<void> {
    await this.attempt(clientOpId, false);
  }

  /** 放弃一个待重试操作（不再重试，从本地存储移除）。 */
  discardPending(clientOpId: string): void {
    this.pendingOps.delete(clientOpId);
    this.persist();
    this.emit();
  }

  dismissFailed(clientOpId: string): void {
    this.failedOps = this.failedOps.filter((op) => op.client_op_id !== clientOpId);
    this.emit();
  }

  private async attempt(clientOpId: string, injectFailure: boolean): Promise<void> {
    const op = this.pendingOps.get(clientOpId);
    if (!op) return;
    op.attempts += 1;
    try {
      const res = await this.api.issue({
        scene_id: op.scene_id,
        client_op_id: op.client_op_id,
        notes: op.notes,
        ...(injectFailure ? { inject_failure_after_commit: true } : {}),
      });
      this.pendingOps.delete(op.client_op_id);
      this.failedOps = this.failedOps.filter((f) => f.client_op_id !== op.client_op_id);
      this.issuedOps = [
        res,
        ...this.issuedOps.filter((i) => i.client_op_id !== op.client_op_id),
      ];
    } catch (err) {
      if (err instanceof ConflictError) {
        // 409：标识已被不同内容占用，重试无意义，转入失败列表反馈给现场。
        this.pendingOps.delete(op.client_op_id);
        this.failedOps = [
          {
            scene_id: op.scene_id,
            client_op_id: op.client_op_id,
            notes: op.notes,
            reason: err.message,
            existing_shot_number: err.existing?.shot_number ?? null,
          },
          ...this.failedOps.filter((f) => f.client_op_id !== op.client_op_id),
        ];
      } else if (err instanceof RetryableError) {
        // 网络异常 / 5xx：操作保留在待重试列表，等待恢复。
        op.last_error = err.message;
      } else {
        op.last_error = err instanceof Error ? err.message : String(err);
      }
    }
    this.persist();
    this.emit();
  }

  private loadPersisted(): PendingOperation[] {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is PendingOperation =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as PendingOperation).client_op_id === 'string' &&
          typeof (item as PendingOperation).scene_id === 'string' &&
          typeof (item as PendingOperation).notes === 'string',
      );
    } catch {
      return [];
    }
  }

  private persist(): void {
    const ops = [...this.pendingOps.values()];
    if (ops.length === 0) {
      this.storage.removeItem(STORAGE_KEY);
    } else {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(ops));
    }
  }

  private computeSnapshot(): IssuerSnapshot {
    return {
      pending: [...this.pendingOps.values()],
      failed: [...this.failedOps],
      issued: [...this.issuedOps],
    };
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const listener of this.listeners) listener();
  }
}
