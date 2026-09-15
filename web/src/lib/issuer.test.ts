import { describe, expect, it, vi } from 'vitest';
import { ConflictError, RetryableError, type ShotNumberApi } from './api';
import { Issuer, type KeyValueStorage, type PendingOperation } from './issuer';
import type { IssueRequestBody, IssueResponse, IssuedOperation } from './types';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function issuedResponse(body: IssueRequestBody, shotNumber: number): IssueResponse {
  return {
    scene_id: body.scene_id,
    client_op_id: body.client_op_id,
    notes: body.notes,
    shot_number: shotNumber,
    created_at: '2026-09-15T00:00:00.000Z',
    replayed: false,
  };
}

function existingOperation(body: IssueRequestBody, shotNumber: number): IssuedOperation {
  return {
    scene_id: body.scene_id,
    client_op_id: body.client_op_id,
    notes: body.notes,
    shot_number: shotNumber,
    created_at: '2026-09-15T00:00:00.000Z',
  };
}

function idSequence(): () => string {
  let seq = 0;
  return () => `op-${(seq += 1)}`;
}

describe('Issuer', () => {
  it('提交成功后记录镜号并清空待重试', async () => {
    const api: ShotNumberApi = {
      issue: vi.fn(async (body) => issuedResponse(body, 7)),
      listSceneOperations: async () => [],
    };
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    const opId = await issuer.submit({ scene_id: 'A-1', notes: '开场' });

    expect(opId).toBe('op-1');
    expect(api.issue).toHaveBeenCalledTimes(1);
    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.issued).toHaveLength(1);
    expect(snapshot.issued[0].shot_number).toBe(7);
  });

  it('可重试失败（503/网络）后保留待重试操作，且持久化到本地存储', async () => {
    const api: ShotNumberApi = {
      issue: vi.fn(async () => {
        throw new RetryableError('服务暂时不可用（HTTP 503）', 503);
      }),
      listSceneOperations: async () => [],
    };
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'A-1', notes: '雨夜', injectFailureAfterCommit: true });

    const snapshot = issuer.getSnapshot();
    expect(snapshot.issued).toHaveLength(0);
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0].last_error).toContain('503');
    // 已持久化：刷新页面（新 Issuer 实例）后待重试操作仍在
    const persisted = JSON.parse(
      storage.data.get('shot-number-issuer:pending:v1')!,
    ) as PendingOperation[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].client_op_id).toBe('op-1');

    const restored = new Issuer(api, storage, idSequence());
    expect(restored.getSnapshot().pending).toHaveLength(1);
    expect(restored.getSnapshot().pending[0].client_op_id).toBe('op-1');
  });

  it('恢复后重试使用完全相同的 client_op_id 与内容，成功后显示唯一镜号', async () => {
    const calls: IssueRequestBody[] = [];
    let down = true;
    const api: ShotNumberApi = {
      issue: vi.fn(async (body: IssueRequestBody) => {
        calls.push(body);
        if (down) throw new RetryableError('网络异常');
        return { ...issuedResponse(body, 3), replayed: true };
      }),
      listSceneOperations: async () => [],
    };
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'B-2', notes: '追车' });
    expect(issuer.getSnapshot().pending).toHaveLength(1);

    // 模拟服务恢复后重试
    down = false;
    await issuer.retry('op-1');

    expect(calls).toHaveLength(2);
    // 两次调用的幂等键与内容完全一致 —— 服务器据此返回同一个号码
    expect(calls[1].client_op_id).toBe(calls[0].client_op_id);
    expect(calls[1].scene_id).toBe(calls[0].scene_id);
    expect(calls[1].notes).toBe(calls[0].notes);
    // 重试不得再次携带故障注入标记
    expect(calls[0].inject_failure_after_commit).toBeUndefined();
    expect(calls[1].inject_failure_after_commit).toBeUndefined();

    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.issued[0].shot_number).toBe(3);
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
  });

  it('故障注入标记只在首次尝试时透传', async () => {
    const calls: IssueRequestBody[] = [];
    const api: ShotNumberApi = {
      issue: vi.fn(async (body: IssueRequestBody) => {
        calls.push(body);
        if (calls.length === 1) throw new RetryableError('注入故障', 503);
        return issuedResponse(body, 1);
      }),
      listSceneOperations: async () => [],
    };
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    await issuer.submit({ scene_id: 'C-3', notes: '', injectFailureAfterCommit: true });
    expect(calls[0].inject_failure_after_commit).toBe(true);

    await issuer.retry('op-1');
    expect(calls[1].inject_failure_after_commit).toBeUndefined();
    expect(issuer.getSnapshot().issued[0].shot_number).toBe(1);
  });

  it('409 冲突转入失败列表并给出反馈，不再重试', async () => {
    const api: ShotNumberApi = {
      issue: vi.fn(async (body: IssueRequestBody) => {
        throw new ConflictError('client_op_id 已被占用', existingOperation(body, 5));
      }),
      listSceneOperations: async () => [],
    };
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'D-4', notes: '改动后的内容' });

    const snapshot = issuer.getSnapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.issued).toHaveLength(0);
    expect(snapshot.failed).toHaveLength(1);
    expect(snapshot.failed[0].existing_shot_number).toBe(5);
    expect(snapshot.failed[0].reason).toContain('占用');
    // 冲突操作不应留在本地待重试存储里
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
  });

  it('放弃待重试操作后从存储中移除', async () => {
    const api: ShotNumberApi = {
      issue: vi.fn(async () => {
        throw new RetryableError('网络异常');
      }),
      listSceneOperations: async () => [],
    };
    const storage = memoryStorage();
    const issuer = new Issuer(api, storage, idSequence());

    await issuer.submit({ scene_id: 'E-5', notes: '' });
    expect(issuer.getSnapshot().pending).toHaveLength(1);

    issuer.discardPending('op-1');
    expect(issuer.getSnapshot().pending).toHaveLength(0);
    expect(storage.data.has('shot-number-issuer:pending:v1')).toBe(false);
  });

  it('同一操作标识重复提交由服务器幂等处理：客户端只发相同载荷', async () => {
    const calls: IssueRequestBody[] = [];
    const api: ShotNumberApi = {
      issue: vi.fn(async (body: IssueRequestBody) => {
        calls.push(body);
        return { ...issuedResponse(body, 9), replayed: calls.length > 1 };
      }),
      listSceneOperations: async () => [],
    };
    const issuer = new Issuer(api, memoryStorage(), idSequence());

    // 用户拿着同一个 op id 连续提交两次（例如双击）
    await issuer.submit({ scene_id: 'F-6', notes: '同一镜头', client_op_id: 'fixed-op' });
    await issuer.submit({ scene_id: 'F-6', notes: '同一镜头', client_op_id: 'fixed-op' });

    expect(calls).toHaveLength(2);
    expect(calls[0].client_op_id).toBe('fixed-op');
    expect(calls[1].client_op_id).toBe('fixed-op');
    const snapshot = issuer.getSnapshot();
    expect(snapshot.issued).toHaveLength(1);
    expect(snapshot.issued[0].shot_number).toBe(9);
    expect(snapshot.issued[0].replayed).toBe(true);
  });
});
