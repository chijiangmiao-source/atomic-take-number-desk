import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ShotNumberApi } from './lib/api';
import { EventFeed } from './lib/events';
import type { OperationEvent } from './lib/types';

const EVENT_TYPE_LABELS: Record<OperationEvent['event_type'], string> = {
  issued: '领取',
  note_revised: '备注修订',
};

function FeedRow({ event }: { event: OperationEvent }) {
  return (
    <tr data-testid="feed-row">
      <td className="mono" data-testid="feed-seq">
        {event.seq}
      </td>
      <td data-testid="feed-scene">{event.scene_id}</td>
      <td className="num" data-testid="feed-shot">
        #{event.shot_number}
      </td>
      <td>
        <span
          className={`feed-type feed-type-${event.event_type}`}
          data-testid="feed-event-type"
        >
          {EVENT_TYPE_LABELS[event.event_type]}
        </span>
      </td>
      <td className="mono" data-testid="feed-revision">
        r{event.revision}
      </td>
      <td className="feed-notes" data-testid="feed-notes">
        {event.notes || '—'}
      </td>
      <td className="mono" data-testid="feed-time">
        {event.created_at}
      </td>
    </tr>
  );
}

/**
 * 操作流水视图：全片场的领取与备注修订按提交先后排列（最新在前）。
 * 首屏固定当次浏览快照，滚动到底自动续页；浏览期间的新事件在
 * 点击“刷新流水”后才出现。加载失败保留已显示内容并就地重试。
 */
export function EventFeedView({ api }: { api: ShotNumberApi }) {
  const [feed] = useState(() => new EventFeed(api));
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasRows = snapshot.events.length > 0;

  // 打开视图即固定当次浏览快照并加载第一页
  useEffect(() => {
    void feed.refresh();
  }, [feed]);

  // 滚动到底自动续页；失败态下 loadMore 不动作，需就地重试。
  // 哨兵随首批事件一起挂载，因此依赖 hasRows 在其出现后重建观察器。
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void feed.loadMore();
        }
      },
      { root: scrollRef.current },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [feed, hasRows]);

  const { events, nextCursor, status, error, started } = snapshot;
  const loading = status === 'loading';

  return (
    <section className="card" data-testid="event-feed">
      <div className="feed-header">
        <h2>操作流水（全片场，最新在前）</h2>
        <div className="feed-header-actions">
          <span className="meta" data-testid="feed-count">
            已加载 {events.length} 条
          </span>
          <button
            type="button"
            className="ghost"
            data-testid="feed-refresh"
            disabled={loading}
            onClick={() => void feed.refresh()}
          >
            刷新流水
          </button>
        </div>
      </div>
      <p className="hint">
        首屏固定当次浏览的最高序号，续页只读该快照范围；浏览期间的新事件在刷新流水后出现。
      </p>

      {started && events.length === 0 && !loading && !error && (
        <p className="hint" data-testid="feed-empty">
          暂无流水事件：成功领取镜号或保存新备注修订后会在此出现。
        </p>
      )}

      {events.length > 0 && (
        <div className="feed-scroll" data-testid="feed-scroll" ref={scrollRef}>
          <table>
            <thead>
              <tr>
                <th>序号</th>
                <th>场次</th>
                <th>镜号</th>
                <th>事件类型</th>
                <th>修订</th>
                <th>当时备注</th>
                <th>发生时间 (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <FeedRow key={event.seq} event={event} />
              ))}
            </tbody>
          </table>
          <div ref={sentinelRef} className="feed-sentinel" />
        </div>
      )}

      {loading && (
        <p className="hint" data-testid="feed-loading">
          加载中…
        </p>
      )}
      {status === 'error' && (
        <div className="feed-error" data-testid="feed-error">
          <span className="error-text">{error}</span>
          <button
            type="button"
            data-testid="feed-retry"
            onClick={() => void feed.retry()}
          >
            就地重试
          </button>
        </div>
      )}
      {started && nextCursor === null && events.length > 0 && status !== 'error' && (
        <p className="hint feed-end" data-testid="feed-end">
          已显示当次快照的全部事件；之后的新事件请点击“刷新流水”查看。
        </p>
      )}
    </section>
  );
}
