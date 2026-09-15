import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  NotesConflictError,
  RequestError,
  RetryableError,
  createHttpApi,
} from './api';

const api = createHttpApi();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttpApi.issue', () => {
  it('201/200 返回已发放的镜号', async () => {
    const payload = {
      scene_id: 'A-1',
      client_op_id: 'op-1',
      issue_notes: '',
      notes: '',
      notes_revision: 1,
      shot_number: 3,
      created_at: '2026-09-15T00:00:00.000Z',
      replayed: false,
    };
    const fetchMock = vi.fn(async () => jsonResponse(201, payload));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '' });

    expect(res.shot_number).toBe(3);
    expect(res.replayed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shot-numbers',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('409 映射为 ConflictError 并携带已存在的操作', async () => {
    const existing = {
      scene_id: 'A-1',
      client_op_id: 'op-1',
      issue_notes: '原始内容',
      notes: '原始内容',
      notes_revision: 1,
      shot_number: 2,
      created_at: '2026-09-15T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, {
          detail: {
            error: 'client_op_id_conflict',
            message: 'client_op_id 已被占用',
            existing,
          },
        }),
      ),
    );

    const err = await api
      .issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '改动' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).existing?.shot_number).toBe(2);
  });

  it('503 映射为可重试错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(503, {
          detail: { error: 'injected_failure_after_commit', message: '注入故障' },
        }),
      ),
    );

    const err = await api
      .issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).status).toBe(503);
    expect((err as RetryableError).message).toContain('注入故障');
  });

  it('网络异常映射为可重试错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const err = await api
      .issue({ scene_id: 'A-1', client_op_id: 'op-1', notes: '' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
  });

  it('其它 4xx 映射为不可重试的请求错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(422, { detail: [{ msg: 'field required' }] }),
      ),
    );

    const err = await api
      .issue({ scene_id: '', client_op_id: 'op-1', notes: '' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(422);
  });
});

describe('createHttpApi.updateNotes', () => {
  it('200 返回更新后的操作（含新修订号）', async () => {
    const payload = {
      scene_id: 'A-1',
      client_op_id: 'op-1',
      issue_notes: '原始备注',
      notes: '修订后的备注',
      notes_revision: 2,
      shot_number: 1,
      created_at: '2026-09-15T00:00:00.000Z',
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, payload));
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.updateNotes('op-1', { base_revision: 1, notes: '修订后的备注' });

    expect(res.notes).toBe('修订后的备注');
    expect(res.notes_revision).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operations/op-1/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ base_revision: 1, notes: '修订后的备注' }),
      }),
    );
  });

  it('409 notes_merge_conflict 映射为 NotesConflictError 并携带三方片段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, {
          detail: {
            error: 'notes_merge_conflict',
            message: '备注与他人同期的修改重叠',
            current_revision: 2,
            base_revision: 1,
            base_notes: '第一行\n第二行\n第三行',
            server_notes: '第一行\n服务端改动\n第三行',
            local_notes: '第一行\n本地改动\n第三行',
            conflicts: [
              { base: ['第二行'], server: ['服务端改动'], local: ['本地改动'] },
            ],
          },
        }),
      ),
    );

    const err = await api
      .updateNotes('op-1', { base_revision: 1, notes: '第一行\n本地改动\n第三行' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotesConflictError);
    const info = (err as NotesConflictError).info;
    expect(info.current_revision).toBe(2);
    expect(info.server_notes).toContain('服务端改动');
    expect(info.local_notes).toContain('本地改动');
    expect(info.conflicts).toHaveLength(1);
    expect(info.conflicts[0].server).toEqual(['服务端改动']);
  });

  it('网络异常映射为可重试错误（输入应被保留）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const err = await api
      .updateNotes('op-1', { base_revision: 1, notes: 'x' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
  });

  it('5xx 映射为可重试错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(503, { detail: { message: '服务不可用' } })),
    );

    const err = await api
      .updateNotes('op-1', { base_revision: 1, notes: 'x' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).status).toBe(503);
  });

  it('404 映射为不可重试的请求错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, { detail: { error: 'not_found', message: '操作标识不存在' } }),
      ),
    );

    const err = await api
      .updateNotes('missing', { base_revision: 1, notes: 'x' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(404);
  });
});
