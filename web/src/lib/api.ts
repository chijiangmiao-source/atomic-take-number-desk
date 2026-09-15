import type {
  IssueRequestBody,
  IssueResponse,
  IssuedOperation,
  NotesConflictInfo,
  UpdateNotesBody,
} from './types';

/** 409：同一 client_op_id 已被不同内容占用。此类错误重试无意义。 */
export class ConflictError extends Error {
  readonly existing: IssuedOperation | null;

  constructor(message: string, existing: IssuedOperation | null) {
    super(message);
    this.name = 'ConflictError';
    this.existing = existing;
  }
}

/** 409：备注与他人同期的修改重叠，三方自动合并失败。携带三方片段，整理后可再次保存。 */
export class NotesConflictError extends Error {
  readonly info: NotesConflictInfo;

  constructor(message: string, info: NotesConflictInfo) {
    super(message);
    this.name = 'NotesConflictError';
    this.info = info;
  }
}

/** 5xx 或网络异常：操作可能已落库也可能未落库，用相同 client_op_id 重试是安全的。 */
export class RetryableError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
  }
}

/** 其它 4xx：请求本身不合法，重试无意义。 */
export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

export interface ShotNumberApi {
  issue(body: IssueRequestBody): Promise<IssueResponse>;
  listSceneOperations(sceneId: string): Promise<IssuedOperation[]>;
  updateNotes(clientOpId: string, body: UpdateNotesBody): Promise<IssuedOperation>;
}

interface ErrorDetail {
  message?: string;
  existing?: IssuedOperation;
  notesConflict?: NotesConflictInfo;
}

function isNotesConflictInfo(value: unknown): value is NotesConflictInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Partial<NotesConflictInfo>;
  return (
    typeof info.current_revision === 'number' &&
    typeof info.base_revision === 'number' &&
    typeof info.base_notes === 'string' &&
    typeof info.server_notes === 'string' &&
    typeof info.local_notes === 'string' &&
    Array.isArray(info.conflicts)
  );
}

async function parseErrorBody(res: Response): Promise<ErrorDetail> {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return { message: detail };
    if (detail && typeof detail === 'object') {
      return {
        message: detail.message,
        existing: detail.existing ?? null,
        notesConflict:
          detail.error === 'notes_merge_conflict' && isNotesConflictInfo(detail)
            ? {
                current_revision: detail.current_revision,
                base_revision: detail.base_revision,
                base_notes: detail.base_notes,
                server_notes: detail.server_notes,
                local_notes: detail.local_notes,
                conflicts: detail.conflicts,
              }
            : undefined,
      };
    }
    if (Array.isArray(detail) && detail.length > 0) {
      return { message: detail.map((d: { msg?: string }) => d.msg ?? '').join('；') };
    }
    return {};
  } catch {
    return {};
  }
}

export function createHttpApi(baseUrl = ''): ShotNumberApi {
  return {
    async issue(body: IssueRequestBody): Promise<IssueResponse> {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/shot-numbers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new RetryableError('网络异常：无法连接镜号服务，操作已保留，可稍后重试');
      }

      if (res.ok) {
        return (await res.json()) as IssueResponse;
      }

      const detail = await parseErrorBody(res);
      if (res.status === 409) {
        throw new ConflictError(
          `操作标识冲突：${detail.message ?? '同一 client_op_id 不允许携带不同内容'}`,
          detail.existing ?? null,
        );
      }
      if (res.status >= 500) {
        const base = detail.message ?? '服务暂时不可用，操作已保留，可重试';
        throw new RetryableError(`${base}（HTTP ${res.status}）`, res.status);
      }
      throw new RequestError(
        detail.message
          ? `请求被拒绝：${detail.message}`
          : `请求被拒绝（HTTP ${res.status}）`,
        res.status,
      );
    },

    async listSceneOperations(sceneId: string): Promise<IssuedOperation[]> {
      const res = await fetch(
        `${baseUrl}/api/scenes/${encodeURIComponent(sceneId)}/operations`,
      );
      if (!res.ok) {
        throw new RetryableError(`场次看板加载失败（HTTP ${res.status}）`, res.status);
      }
      return (await res.json()) as IssuedOperation[];
    },

    async updateNotes(clientOpId: string, body: UpdateNotesBody): Promise<IssuedOperation> {
      let res: Response;
      try {
        res = await fetch(
          `${baseUrl}/api/operations/${encodeURIComponent(clientOpId)}/notes`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
      } catch {
        throw new RetryableError('网络异常：备注保存失败，输入已保留，可再次保存');
      }

      if (res.ok) {
        return (await res.json()) as IssuedOperation;
      }

      const detail = await parseErrorBody(res);
      if (res.status === 409 && detail.notesConflict) {
        throw new NotesConflictError(
          detail.message ?? '备注与他人同期的修改重叠',
          detail.notesConflict,
        );
      }
      if (res.status >= 500) {
        const base = detail.message ?? '服务暂时不可用，输入已保留，可再次保存';
        throw new RetryableError(`${base}（HTTP ${res.status}）`, res.status);
      }
      throw new RequestError(
        detail.message
          ? `备注保存被拒绝：${detail.message}`
          : `备注保存被拒绝（HTTP ${res.status}）`,
        res.status,
      );
    },
  };
}
