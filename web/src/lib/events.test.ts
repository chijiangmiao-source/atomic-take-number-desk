import { describe, expect, it, vi } from 'vitest';
import { RetryableError, type ShotNumberApi } from './api';
import { EventFeed } from './events';
import type { EventsPage, OperationEvent } from './types';

function event(seq: number, overrides: Partial<OperationEvent> = {}): OperationEvent {
  return {
    seq,
    event_type: 'issued',
    scene_id: 'S-1',
    client_op_id: `op-${seq}`,
    shot_number: seq,
    revision: 1,
    notes: `备注${seq}`,
    created_at: `2026-09-15T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

function page(events: OperationEvent[], nextCursor: string | null): EventsPage {
  return { events, next_cursor: nextCursor };
}

/** 流水用例的 API 替身：只有 listEvents 会被调用。 */
function apiWith(listEvents: ShotNumberApi['listEvents']): ShotNumberApi {
  return {
    issue: async () => {
      throw new Error('not used');
    },
    listSceneOperations: async () => [],
    updateNotes: async () => {
      throw new Error('not used');
    },
    listEvents,
  };
}

describe('EventFeed', () => {
  it('refresh 加载首页并固定当次游标', async () => {
    const listEvents = vi.fn(async () => page([event(3), event(2)], '3:2'));
    const feed = new EventFeed(apiWith(listEvents), 2);

    await feed.refresh();

    const snap = feed.getSnapshot();
    expect(snap.events.map((e) => e.seq)).toEqual([3, 2]);
    expect(snap.nextCursor).toBe('3:2');
    expect(snap.status).toBe('idle');
    expect(snap.started).toBe(true);
    // 首页不带游标：由服务端固定当次浏览快照
    expect(listEvents).toHaveBeenCalledWith({ limit: 2 });
  });

  it('loadMore 逐页追加直到翻完，序号无重复', async () => {
    const pages: Record<string, EventsPage> = {
      first: page([event(5), event(4)], '5:4'),
      '5:4': page([event(3), event(2)], '5:2'),
      '5:2': page([event(1)], null),
    };
    const listEvents = vi.fn(
      async ({ cursor }: { cursor?: string | null }) => pages[cursor ?? 'first'],
    );
    const feed = new EventFeed(apiWith(listEvents), 2);

    await feed.refresh();
    await feed.loadMore();
    expect(feed.getSnapshot().events.map((e) => e.seq)).toEqual([5, 4, 3, 2]);
    expect(listEvents).toHaveBeenLastCalledWith({ cursor: '5:4', limit: 2 });

    await feed.loadMore();
    const snap = feed.getSnapshot();
    expect(snap.events.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(snap.nextCursor).toBeNull();

    // 已翻完：继续 loadMore 不再发请求
    const calls = listEvents.mock.calls.length;
    await feed.loadMore();
    expect(listEvents.mock.calls.length).toBe(calls);
  });

  it('加载失败保留已显示内容与原游标，就地重试后续页', async () => {
    let failNext = false;
    const listEvents = vi.fn(async ({ cursor }: { cursor?: string | null }) => {
      if (failNext) throw new RetryableError('网络异常：流水加载失败');
      return cursor === '3:2' ? page([event(1)], null) : page([event(3), event(2)], '3:2');
    });
    const feed = new EventFeed(apiWith(listEvents), 2);

    await feed.refresh();
    failNext = true;
    await feed.loadMore();

    // 失败：首页内容与原游标原样保留
    let snap = feed.getSnapshot();
    expect(snap.status).toBe('error');
    expect(snap.error).toContain('网络异常');
    expect(snap.events.map((e) => e.seq)).toEqual([3, 2]);
    expect(snap.nextCursor).toBe('3:2');

    // 失败态下 loadMore 不再发请求（避免滚动触发器反复轰炸）
    const calls = listEvents.mock.calls.length;
    await feed.loadMore();
    expect(listEvents.mock.calls.length).toBe(calls);

    // 就地重试：用原游标重发同一请求，成功后继续翻页
    failNext = false;
    await feed.retry();
    snap = feed.getSnapshot();
    expect(snap.status).toBe('idle');
    expect(snap.events.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(snap.nextCursor).toBeNull();
    expect(listEvents).toHaveBeenLastCalledWith({ cursor: '3:2', limit: 2 });
  });

  it('首页加载失败后可重试；浏览期间的新事件在刷新后出现', async () => {
    // 模拟服务端：快照语义由服务端保证，这里只验证控制器在刷新时整体替换内容
    let generation = 0;
    const listEvents = vi.fn(async () => {
      generation += 1;
      if (generation === 1) throw new RetryableError('服务暂时不可用');
      if (generation === 2) return page([event(2), event(1)], null);
      return page([event(4), event(3), event(2), event(1)], null);
    });
    const feed = new EventFeed(apiWith(listEvents), 4);

    await feed.refresh();
    expect(feed.getSnapshot().status).toBe('error');
    expect(feed.getSnapshot().events).toEqual([]);

    await feed.retry();
    expect(feed.getSnapshot().events.map((e) => e.seq)).toEqual([2, 1]);

    // 浏览期间服务端来了新事件（seq 3、4）：当前会话不变，刷新后整体替换
    await feed.refresh();
    expect(feed.getSnapshot().events.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
  });

  it('加载中的重复调用被忽略，不产生并发请求', async () => {
    let release!: (page: EventsPage) => void;
    const listEvents = vi.fn(
      () =>
        new Promise<EventsPage>((resolve) => {
          release = resolve;
        }),
    );
    const feed = new EventFeed(apiWith(listEvents), 2);

    const first = feed.refresh();
    const second = feed.refresh();
    const third = feed.loadMore();
    release(page([event(1)], null));
    await Promise.all([first, second, third]);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot().events.map((e) => e.seq)).toEqual([1]);
  });

  it('追加页与已有内容按序号去重（防御性）', async () => {
    const listEvents = vi.fn(async ({ cursor }: { cursor?: string | null }) =>
      cursor === '3:2'
        ? // 服务端异常地重复了 seq=2：控制器不得让界面出现重复行
          page([event(2), event(1)], null)
        : page([event(3), event(2)], '3:2'),
    );
    const feed = new EventFeed(apiWith(listEvents), 2);

    await feed.refresh();
    await feed.loadMore();

    expect(feed.getSnapshot().events.map((e) => e.seq)).toEqual([3, 2, 1]);
  });

  it('非失败态下 retry 不动作', async () => {
    const listEvents = vi.fn(async () => page([event(1)], null));
    const feed = new EventFeed(apiWith(listEvents), 2);

    await feed.retry();
    expect(listEvents).not.toHaveBeenCalled();

    await feed.refresh();
    const calls = listEvents.mock.calls.length;
    await feed.retry();
    expect(listEvents.mock.calls.length).toBe(calls);
  });
});
