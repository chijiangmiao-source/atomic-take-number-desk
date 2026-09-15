import { describe, expect, it, vi } from 'vitest';
import {
  NotesConflictError,
  RequestError,
  RetryableError,
  type ShotNumberApi,
} from './api';
import {
  draftsReducer,
  mergeOperationsByRevision,
  saveNoteDraft,
  type DraftMap,
  type NoteDraft,
} from './notes';
import type { IssuedOperation, NotesConflictInfo } from './types';

function op(overrides: Partial<IssuedOperation> = {}): IssuedOperation {
  return {
    scene_id: 'A-1',
    client_op_id: 'op-1',
    issue_notes: '发放备注',
    notes: '发放备注',
    notes_revision: 1,
    shot_number: 1,
    created_at: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

function conflictInfo(overrides: Partial<NotesConflictInfo> = {}): NotesConflictInfo {
  return {
    current_revision: 2,
    base_revision: 1,
    base_notes: '一\n二\n三',
    server_notes: '一\n服务端\n三',
    local_notes: '一\n本地\n三',
    conflicts: [{ base: ['二'], server: ['服务端'], local: ['本地'] }],
    ...overrides,
  };
}

function editing(text = '草稿', baseRevision = 1): NoteDraft {
  return { status: 'editing', text, baseRevision, error: null };
}

describe('draftsReducer 草稿状态机', () => {
  it('begin 进入编辑态，edit 更新文本', () => {
    let state: DraftMap = {};
    state = draftsReducer(state, {
      type: 'begin',
      clientOpId: 'op-1',
      text: '原始',
      baseRevision: 1,
    });
    expect(state['op-1']).toEqual(editing('原始'));

    state = draftsReducer(state, { type: 'edit', clientOpId: 'op-1', text: '改过' });
    expect(state['op-1']).toEqual(editing('改过'));
  });

  it('editing → saving → saved：草稿被清除', () => {
    let state: DraftMap = { 'op-1': editing('新文本', 2) };
    state = draftsReducer(state, { type: 'saving', clientOpId: 'op-1' });
    expect(state['op-1']).toEqual({ status: 'saving', text: '新文本', baseRevision: 2 });

    state = draftsReducer(state, { type: 'saved', clientOpId: 'op-1' });
    expect(state['op-1']).toBeUndefined();
  });

  it('网络失败：saving → editing，输入与基础修订号原样保留', () => {
    let state: DraftMap = { 'op-1': { status: 'saving', text: '未发出去的文本', baseRevision: 3 } };
    state = draftsReducer(state, {
      type: 'failed',
      clientOpId: 'op-1',
      error: '网络异常：备注保存失败',
    });
    const draft = state['op-1'];
    expect(draft?.status).toBe('editing');
    expect(draft?.text).toBe('未发出去的文本');
    expect(draft?.baseRevision).toBe(3);
    expect(draft?.status === 'editing' && draft.error).toContain('网络异常');
  });

  it('冲突：saving → conflict，输入保留且基础修订号推进到服务端当前值', () => {
    let state: DraftMap = { 'op-1': { status: 'saving', text: '一\n本地\n三', baseRevision: 1 } };
    state = draftsReducer(state, {
      type: 'conflict',
      clientOpId: 'op-1',
      conflict: conflictInfo(),
    });
    const draft = state['op-1'];
    expect(draft?.status).toBe('conflict');
    expect(draft?.text).toBe('一\n本地\n三'); // 本地输入不丢
    expect(draft?.baseRevision).toBe(2); // 已推进到 current_revision
    if (draft?.status === 'conflict') {
      expect(draft.conflict.server_notes).toContain('服务端');
      expect(draft.conflict.conflicts[0].local).toEqual(['本地']);
    }
  });

  it('冲突状态下继续编辑：文本更新但冲突面板信息保留', () => {
    let state: DraftMap = {
      'op-1': {
        status: 'conflict',
        text: '一\n本地\n三',
        baseRevision: 2,
        conflict: conflictInfo(),
      },
    };
    state = draftsReducer(state, {
      type: 'edit',
      clientOpId: 'op-1',
      text: '一\n整理后的文本\n三',
    });
    const draft = state['op-1'];
    expect(draft?.status).toBe('conflict');
    expect(draft?.text).toBe('一\n整理后的文本\n三');
  });

  it('保存中不允许重开编辑或重复保存', () => {
    const saving: NoteDraft = { status: 'saving', text: '冻结', baseRevision: 1 };
    let state: DraftMap = { 'op-1': saving };
    state = draftsReducer(state, {
      type: 'begin',
      clientOpId: 'op-1',
      text: '别的',
      baseRevision: 1,
    });
    expect(state['op-1']).toEqual(saving);
    state = draftsReducer(state, { type: 'edit', clientOpId: 'op-1', text: '改动' });
    expect(state['op-1']).toEqual(saving);
  });

  it('cancel 清除草稿', () => {
    const state: DraftMap = { 'op-1': editing() };
    expect(draftsReducer(state, { type: 'cancel', clientOpId: 'op-1' })['op-1']).toBeUndefined();
  });
});

describe('saveNoteDraft', () => {
  function apiWith(updateNotes: ShotNumberApi['updateNotes']): ShotNumberApi {
    return {
      issue: async () => {
        throw new Error('not used');
      },
      listSceneOperations: async () => [],
      updateNotes,
      listEvents: async () => {
        throw new Error('not used');
      },
    };
  }

  it('成功：返回更新后的操作', async () => {
    const updated = op({ notes: '新文本', notes_revision: 2 });
    const api = apiWith(vi.fn(async () => updated));
    const result = await saveNoteDraft(api, 'op-1', { text: '新文本', baseRevision: 1 });
    expect(result).toEqual({ kind: 'saved', operation: updated });
    expect(api.updateNotes).toHaveBeenCalledWith('op-1', {
      base_revision: 1,
      notes: '新文本',
    });
  });

  it('网络失败：返回 retryable，调用方据此保留输入', async () => {
    const api = apiWith(
      vi.fn(async () => {
        throw new RetryableError('网络异常：备注保存失败，输入已保留，可再次保存');
      }),
    );
    const result = await saveNoteDraft(api, 'op-1', { text: '保留我', baseRevision: 1 });
    expect(result.kind).toBe('retryable');
    if (result.kind === 'retryable') expect(result.error).toContain('网络异常');
  });

  it('409 重叠：返回 conflict 与三方片段', async () => {
    const info = conflictInfo();
    const api = apiWith(
      vi.fn(async () => {
        throw new NotesConflictError('备注与他人同期的修改重叠', info);
      }),
    );
    const result = await saveNoteDraft(api, 'op-1', { text: '一\n本地\n三', baseRevision: 1 });
    expect(result).toEqual({ kind: 'conflict', conflict: info });
  });

  it('其它 4xx：返回 rejected', async () => {
    const api = apiWith(
      vi.fn(async () => {
        throw new RequestError('备注保存被拒绝：操作标识不存在', 404);
      }),
    );
    const result = await saveNoteDraft(api, 'op-1', { text: 'x', baseRevision: 1 });
    expect(result.kind).toBe('rejected');
  });
});

describe('mergeOperationsByRevision（较旧的轮询响应不得覆盖新修订）', () => {
  it('同一操作保留修订号更高的版本', () => {
    const known = op({ notes: '已保存的新文本', notes_revision: 5 });
    const stalePoll = op({ notes: '旧文本', notes_revision: 4 });

    const merged = mergeOperationsByRevision([known], [stalePoll]);
    expect(merged[0].notes_revision).toBe(5);
    expect(merged[0].notes).toBe('已保存的新文本');
  });

  it('轮询带来更高修订时采用轮询数据', () => {
    const known = op({ notes: '旧文本', notes_revision: 4 });
    const fresh = op({ notes: '别人刚保存的文本', notes_revision: 5 });

    const merged = mergeOperationsByRevision([known], [fresh]);
    expect(merged[0].notes_revision).toBe(5);
    expect(merged[0].notes).toBe('别人刚保存的文本');
  });

  it('保存响应合入看板：替换同标识的旧行', () => {
    const listed = op({ notes: '旧文本', notes_revision: 1 });
    const saved = op({ notes: '刚保存', notes_revision: 2 });

    const merged = mergeOperationsByRevision([listed], [saved]);
    expect(merged).toHaveLength(1);
    expect(merged[0].notes).toBe('刚保存');
  });

  it('新出现的操作追加进看板，顺序以来源列表为准', () => {
    const first = op({ client_op_id: 'op-1', shot_number: 1 });
    const second = op({ client_op_id: 'op-2', shot_number: 2 });

    const merged = mergeOperationsByRevision([first], [first, second]);
    expect(merged.map((o) => o.client_op_id)).toEqual(['op-1', 'op-2']);
  });
});
