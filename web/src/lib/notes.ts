import {
  NotesConflictError,
  RequestError,
  RetryableError,
  type ShotNumberApi,
} from './api';
import type { IssuedOperation, NotesConflictInfo } from './types';

/**
 * 看板行内编辑的草稿状态机。
 *
 * editing  —— 场记正在修改文本；网络/服务失败也回到这里，输入不丢；
 * saving   —— 保存请求在途，文本冻结；
 * conflict —— 服务端返回 409 三方片段：本地输入保留，baseRevision 已推进到
 *             服务端当前修订号，场记对照整理后可再次保存。
 */
export type NoteDraft =
  | { status: 'editing'; text: string; baseRevision: number; error: string | null }
  | { status: 'saving'; text: string; baseRevision: number }
  | {
      status: 'conflict';
      text: string;
      baseRevision: number;
      conflict: NotesConflictInfo;
    };

export type DraftMap = Readonly<Record<string, NoteDraft>>;

export type DraftAction =
  | { type: 'begin'; clientOpId: string; text: string; baseRevision: number }
  | { type: 'edit'; clientOpId: string; text: string }
  | { type: 'saving'; clientOpId: string }
  | { type: 'saved'; clientOpId: string }
  | { type: 'failed'; clientOpId: string; error: string }
  | { type: 'conflict'; clientOpId: string; conflict: NotesConflictInfo }
  | { type: 'cancel'; clientOpId: string };

function without(state: DraftMap, clientOpId: string): DraftMap {
  if (!(clientOpId in state)) return state;
  const next = { ...state };
  delete next[clientOpId];
  return next;
}

export function draftsReducer(state: DraftMap, action: DraftAction): DraftMap {
  switch (action.type) {
    case 'begin': {
      const existing = state[action.clientOpId];
      if (existing?.status === 'saving') return state; // 保存途中不允许重开编辑
      return {
        ...state,
        [action.clientOpId]: {
          status: 'editing',
          text: action.text,
          baseRevision: action.baseRevision,
          error: null,
        },
      };
    }
    case 'edit': {
      const draft = state[action.clientOpId];
      if (!draft || draft.status === 'saving') return state;
      if (draft.status === 'conflict') {
        // 冲突面板保持可见，场记直接在其上整理文本
        return { ...state, [action.clientOpId]: { ...draft, text: action.text } };
      }
      return {
        ...state,
        [action.clientOpId]: { ...draft, text: action.text, error: null },
      };
    }
    case 'saving': {
      const draft = state[action.clientOpId];
      if (!draft || draft.status === 'saving') return state;
      return {
        ...state,
        [action.clientOpId]: {
          status: 'saving',
          text: draft.text,
          baseRevision: draft.baseRevision,
        },
      };
    }
    case 'saved':
      return without(state, action.clientOpId);
    case 'failed': {
      // 网络异常 / 5xx：回到编辑态，输入原样保留
      const draft = state[action.clientOpId];
      if (!draft || draft.status !== 'saving') return state;
      return {
        ...state,
        [action.clientOpId]: {
          status: 'editing',
          text: draft.text,
          baseRevision: draft.baseRevision,
          error: action.error,
        },
      };
    }
    case 'conflict': {
      // 409：输入保留，基础修订号推进到服务端当前值，便于整理后直接再存
      const draft = state[action.clientOpId];
      if (!draft || draft.status !== 'saving') return state;
      return {
        ...state,
        [action.clientOpId]: {
          status: 'conflict',
          text: draft.text,
          baseRevision: action.conflict.current_revision,
          conflict: action.conflict,
        },
      };
    }
    case 'cancel':
      return without(state, action.clientOpId);
  }
}

export type SaveNoteResult =
  | { kind: 'saved'; operation: IssuedOperation }
  | { kind: 'retryable'; error: string } // 网络 / 5xx：输入保留，可再次保存
  | { kind: 'conflict'; conflict: NotesConflictInfo }
  | { kind: 'rejected'; error: string }; // 其它 4xx：请求本身不合法

/** 执行一次备注保存。不抛异常，结果以判别联合返回。 */
export async function saveNoteDraft(
  api: ShotNumberApi,
  clientOpId: string,
  draft: { text: string; baseRevision: number },
): Promise<SaveNoteResult> {
  try {
    const operation = await api.updateNotes(clientOpId, {
      base_revision: draft.baseRevision,
      notes: draft.text,
    });
    return { kind: 'saved', operation };
  } catch (err) {
    if (err instanceof NotesConflictError) {
      return { kind: 'conflict', conflict: err.info };
    }
    if (err instanceof RetryableError) {
      return { kind: 'retryable', error: err.message };
    }
    if (err instanceof RequestError) {
      return { kind: 'rejected', error: err.message };
    }
    return { kind: 'retryable', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 合并看板数据：以最新一轮（轮询或保存）响应为准，但同一操作若本地已知
 * 更高的修订号（例如保存响应已先于轮询返回），较旧的数据不得覆盖新修订。
 */
export function mergeOperationsByRevision(
  prev: readonly IssuedOperation[],
  fresh: readonly IssuedOperation[],
): IssuedOperation[] {
  const prevById = new Map(prev.map((op) => [op.client_op_id, op]));
  return fresh.map((op) => {
    const known = prevById.get(op.client_op_id);
    return known && known.notes_revision > op.notes_revision ? known : op;
  });
}
