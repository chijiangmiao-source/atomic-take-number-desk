import type { ShotNumberApi } from './api';
import type { OperationEvent } from './types';

/**
 * 操作流水的分页控制器。
 *
 * 浏览模型（与服务端游标协议对应）：
 * - refresh() 开启一次新的浏览会话：服务端固定当次最高序号为快照，
 *   返回第一页；浏览期间产生的新事件不会进入本次会话，下次刷新才出现；
 * - loadMore() 用上一页返回的 next_cursor 续页，只读快照范围内的数据；
 * - 加载失败时，已显示内容与游标原样保留，retry() 就地重发同一请求。
 */
export type FeedStatus = 'idle' | 'loading' | 'error';

export interface EventFeedSnapshot {
  /** 已累积展示的事件（新到旧） */
  events: OperationEvent[];
  /** 下一页游标；null 表示当次快照已翻完 */
  nextCursor: string | null;
  status: FeedStatus;
  error: string | null;
  /** 是否已完成过至少一次首页加载（区分“尚未加载”与“加载后为空”） */
  started: boolean;
}

/** 一次可能失败的加载请求：失败后被记住，供 retry() 原样重发。 */
type LoadRequest = { kind: 'refresh' } | { kind: 'page'; cursor: string };

export class EventFeed {
  private events: OperationEvent[] = [];
  private nextCursor: string | null = null;
  private status: FeedStatus = 'idle';
  private error: string | null = null;
  private started = false;
  private failedRequest: LoadRequest | null = null;
  private snapshot: EventFeedSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly api: ShotNumberApi,
    private readonly pageSize = 25,
  ) {
    this.snapshot = this.computeSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EventFeedSnapshot => this.snapshot;

  /** 开启新的浏览会话（固定新快照，回到第一页）。 */
  async refresh(): Promise<void> {
    if (this.status === 'loading') return;
    await this.perform({ kind: 'refresh' });
  }

  /** 滚动到底时续页。加载中、已出错或已翻完时不动作。 */
  async loadMore(): Promise<void> {
    if (this.status !== 'idle' || !this.started || this.nextCursor === null) return;
    await this.perform({ kind: 'page', cursor: this.nextCursor });
  }

  /** 失败后就地重试：重发完全相同的那次请求（游标未变）。 */
  async retry(): Promise<void> {
    if (this.status !== 'error' || this.failedRequest === null) return;
    await this.perform(this.failedRequest);
  }

  private async perform(request: LoadRequest): Promise<void> {
    this.status = 'loading';
    this.error = null;
    this.emit();
    try {
      const page =
        request.kind === 'refresh'
          ? await this.api.listEvents({ limit: this.pageSize })
          : await this.api.listEvents({ cursor: request.cursor, limit: this.pageSize });
      if (request.kind === 'refresh') {
        this.events = dedupBySeq(page.events);
      } else {
        // 服务端游标协议保证页间不重不漏；这里再按序号去重兜底
        const seen = new Set(this.events.map((event) => event.seq));
        this.events = [
          ...this.events,
          ...page.events.filter((event) => !seen.has(event.seq)),
        ];
      }
      this.nextCursor = page.next_cursor;
      this.status = 'idle';
      this.error = null;
      this.failedRequest = null;
      this.started = true;
    } catch (err) {
      // 已显示内容与游标原样保留，等待就地重试或刷新
      this.status = 'error';
      this.failedRequest = request;
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.emit();
  }

  private computeSnapshot(): EventFeedSnapshot {
    return {
      events: [...this.events],
      nextCursor: this.nextCursor,
      status: this.status,
      error: this.error,
      started: this.started,
    };
  }

  private emit(): void {
    this.snapshot = this.computeSnapshot();
    for (const listener of this.listeners) listener();
  }
}

function dedupBySeq(events: OperationEvent[]): OperationEvent[] {
  const seen = new Set<number>();
  return events.filter((event) => {
    if (seen.has(event.seq)) return false;
    seen.add(event.seq);
    return true;
  });
}
