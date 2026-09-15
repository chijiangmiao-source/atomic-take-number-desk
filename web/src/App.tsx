import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { createHttpApi } from './lib/api';
import { Issuer } from './lib/issuer';
import {
  draftsReducer,
  mergeOperationsByRevision,
  saveNoteDraft,
  type NoteDraft,
} from './lib/notes';
import type { IssuedOperation } from './lib/types';

const api = createHttpApi();
const SCENE_STORAGE_KEY = 'shot-number-issuer:scene';
const NOTES_MAX_LENGTH = 4000;

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

interface SceneOpRowProps {
  op: IssuedOperation;
  draft: NoteDraft | undefined;
  onBegin: () => void;
  onEdit: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** 看板行：静态展示，或行内编辑（编辑中 / 保存中 / 冲突）三种草稿状态。 */
function SceneOpRow({ op, draft, onBegin, onEdit, onSave, onCancel }: SceneOpRowProps) {
  if (!draft) {
    return (
      <tr data-testid="scene-op-row">
        <td className="num">#{op.shot_number}</td>
        <td>{op.notes || '—'}</td>
        <td className="mono" data-testid="note-revision">
          r{op.notes_revision}
        </td>
        <td className="mono">{shortId(op.client_op_id)}</td>
        <td className="mono">{op.created_at}</td>
        <td>
          <button
            type="button"
            className="ghost"
            data-testid="note-edit-button"
            onClick={onBegin}
          >
            编辑
          </button>
        </td>
      </tr>
    );
  }

  const saving = draft.status === 'saving';
  const tooLong = draft.text.length > NOTES_MAX_LENGTH;
  return (
    <tr data-testid="scene-op-row" className="editing">
      <td className="num">#{op.shot_number}</td>
      <td colSpan={5}>
        <div className="note-editor">
          <textarea
            data-testid="note-editor"
            rows={3}
            value={draft.text}
            disabled={saving}
            aria-invalid={tooLong}
            onChange={(e) => onEdit(e.target.value)}
          />
          {tooLong && (
            <span className="error-text">
              备注超过 {NOTES_MAX_LENGTH} 字上限，请精简后再保存
            </span>
          )}
          {saving && (
            <span className="hint" data-testid="note-saving">
              保存中…
            </span>
          )}
          {draft.status === 'editing' && draft.error && (
            <span className="error-text" data-testid="note-save-error">
              {draft.error}（输入已保留，可再次保存）
            </span>
          )}
          {draft.status === 'editing' && op.notes_revision > draft.baseRevision && (
            <span className="hint">
              提示：服务端已更新到 r{op.notes_revision}，保存时将按行自动合并。
            </span>
          )}
          {draft.status === 'conflict' && (
            <div className="conflict-panel" data-testid="note-conflict-panel">
              <strong>
                保存冲突：服务端已是 r{draft.conflict.current_revision}
                ，你的输入已保留在上方编辑框。
              </strong>
              <span className="hint">
                请对照三方文本与重叠片段，在编辑框里整理后再次保存。
              </span>
              <div className="conflict-columns">
                <div>
                  <span className="meta">基础文本（r{draft.conflict.base_revision}）</span>
                  <pre data-testid="conflict-base">{draft.conflict.base_notes || '（空）'}</pre>
                </div>
                <div>
                  <span className="meta">服务端当前（r{draft.conflict.current_revision}）</span>
                  <pre data-testid="conflict-server">
                    {draft.conflict.server_notes || '（空）'}
                  </pre>
                </div>
                <div>
                  <span className="meta">你的修改（未保存）</span>
                  <pre data-testid="conflict-local">{draft.conflict.local_notes || '（空）'}</pre>
                </div>
              </div>
              {draft.conflict.conflicts.map((fragment, index) => (
                <div className="conflict-fragment" key={index}>
                  <span className="meta">重叠片段 {index + 1}（基础 / 服务端 / 你的）</span>
                  <div className="conflict-columns">
                    <pre>{fragment.base.join('\n') || '（空）'}</pre>
                    <pre>{fragment.server.join('\n') || '（空）'}</pre>
                    <pre>{fragment.local.join('\n') || '（空）'}</pre>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="note-editor-actions">
            <button
              type="button"
              className="primary"
              data-testid="note-save-button"
              disabled={saving || tooLong}
              onClick={onSave}
            >
              {saving ? '保存中…' : draft.status === 'conflict' ? '再次保存' : '保存'}
            </button>
            <button
              type="button"
              className="ghost"
              data-testid="note-cancel-button"
              disabled={saving}
              onClick={onCancel}
            >
              取消
            </button>
            <span className="meta">基于 r{draft.baseRevision}</span>
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function App() {
  const [issuer] = useState(() => new Issuer(api, window.localStorage));
  const snapshot = useSyncExternalStore(issuer.subscribe, issuer.getSnapshot);

  const [sceneId, setSceneId] = useState(
    () => window.localStorage.getItem(SCENE_STORAGE_KEY) ?? '',
  );
  const [notes, setNotes] = useState('');
  const [opId, setOpId] = useState(() => issuer.newOperationId());
  const [injectFailure, setInjectFailure] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [sceneOps, setSceneOps] = useState<IssuedOperation[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [drafts, dispatchDrafts] = useReducer(draftsReducer, {});
  // 当前看板场次的最新值：用于丢弃场次切换前发出的过期轮询响应
  const boardSceneRef = useRef(sceneId);

  const refreshBoard = useCallback(async (scene: string) => {
    const trimmed = scene.trim();
    if (!trimmed) {
      setSceneOps([]);
      return;
    }
    try {
      const ops = await api.listSceneOperations(trimmed);
      if (boardSceneRef.current.trim() !== trimmed) return; // 场次已切换，丢弃过期响应
      // 按修订号合并：较旧的轮询响应不得覆盖已知的新修订
      setSceneOps((prev) => mergeOperationsByRevision(prev, ops));
      setBoardError(null);
    } catch {
      if (boardSceneRef.current.trim() !== trimmed) return;
      setBoardError('场次看板刷新失败：镜号服务不可达');
    }
  }, []);

  const issuedCount = snapshot.issued.length;
  useEffect(() => {
    boardSceneRef.current = sceneId;
    void refreshBoard(sceneId);
    const timer = window.setInterval(() => void refreshBoard(sceneId), 3000);
    return () => window.clearInterval(timer);
  }, [sceneId, issuedCount, refreshBoard]);

  const notesTooLong = notes.length > NOTES_MAX_LENGTH;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const scene = sceneId.trim();
    if (!scene || submitting || notesTooLong) return;
    setSubmitting(true);
    try {
      window.localStorage.setItem(SCENE_STORAGE_KEY, scene);
      const { opId: usedId, outcome } = await issuer.submit({
        scene_id: scene,
        notes,
        client_op_id: opId,
        injectFailureAfterCommit: injectFailure,
      });
      if (outcome.kind === 'success') {
        // 本次操作已完成：直接为下一条镜号备好新标识，
        // 现场改完备注即可再次领取，不必手动换标识。
        setOpId(issuer.newOperationId());
      } else if (usedId !== opId) {
        // 标识与某个待重试操作撞车，控制器已另发新标识：同步到表单。
        setOpId(usedId);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onRetry = async (clientOpId: string) => {
    const outcome = await issuer.retry(clientOpId);
    if (outcome.kind === 'success') {
      // 待重试操作已成功：若主表单还拿着它的标识，一并换新。
      setOpId((current) => (current === clientOpId ? issuer.newOperationId() : current));
    }
  };

  const onSaveNote = async (clientOpId: string) => {
    const draft = drafts[clientOpId];
    if (!draft || draft.status === 'saving') return;
    if (draft.text.length > NOTES_MAX_LENGTH) return;
    dispatchDrafts({ type: 'saving', clientOpId });
    const result = await saveNoteDraft(api, clientOpId, draft);
    if (result.kind === 'saved') {
      dispatchDrafts({ type: 'saved', clientOpId });
      // 保存响应即最新状态：直接合入看板，无需等待下一轮轮询
      setSceneOps((prev) => mergeOperationsByRevision(prev, [result.operation]));
    } else if (result.kind === 'conflict') {
      dispatchDrafts({ type: 'conflict', clientOpId, conflict: result.conflict });
      // 让看板行的静态文本跟上服务端当前修订
      setSceneOps((prev) =>
        prev.map((op) =>
          op.client_op_id === clientOpId &&
          result.conflict.current_revision > op.notes_revision
            ? {
                ...op,
                notes: result.conflict.server_notes,
                notes_revision: result.conflict.current_revision,
              }
            : op,
        ),
      );
    } else {
      // 网络失败或其它错误：草稿保留，输入不丢
      dispatchDrafts({ type: 'failed', clientOpId, error: result.error });
    }
  };

  const latest = snapshot.issued[0] ?? null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>镜号发放台</h1>
        <p className="subtitle">
          多台场记终端并发领取镜号：同一操作标识重试永远取回同一号码，号码严格连续、以提交顺序为准。发放后备注仍可在场次看板行内修订。
        </p>
      </header>

      <main className="layout">
        <section className="card">
          <h2>领取下一条镜号</h2>
          <form onSubmit={onSubmit}>
            <label className="field">
              <span>场次</span>
              <input
                data-testid="scene-input"
                value={sceneId}
                onChange={(e) => setSceneId(e.target.value)}
                placeholder="例如：A-12"
                required
              />
            </label>

            <label className="field">
              <span>
                备注
                <span className={notesTooLong ? 'error-text' : 'counter'}>
                  （{notes.length}/{NOTES_MAX_LENGTH}）
                </span>
              </span>
              <textarea
                data-testid="notes-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="镜头内容备注，可留空；发放后仍可在看板修订"
                rows={2}
                aria-invalid={notesTooLong}
              />
              {notesTooLong && (
                <span className="error-text" data-testid="notes-error">
                  备注超过 {NOTES_MAX_LENGTH} 字上限，请精简后再领取
                </span>
              )}
            </label>

            <label className="field">
              <span>操作标识（client_op_id；成功领取后自动更换，重试同一操作时保持不变）</span>
              <div className="op-id-row">
                <input
                  data-testid="op-id-input"
                  value={opId}
                  onChange={(e) => setOpId(e.target.value)}
                  spellCheck={false}
                  required
                />
                <button
                  type="button"
                  data-testid="regenerate-op-id"
                  onClick={() => setOpId(issuer.newOperationId())}
                  title="开始一次全新操作时生成新标识"
                >
                  新标识
                </button>
              </div>
            </label>

            <fieldset className="dev-options">
              <legend>开发选项</legend>
              <label className="checkbox">
                <input
                  type="checkbox"
                  data-testid="inject-toggle"
                  checked={injectFailure}
                  onChange={(e) => setInjectFailure(e.target.checked)}
                />
                模拟“落库后、回包前”故障（inject_failure_after_commit，仅开发模式生效）
              </label>
            </fieldset>

            <button
              type="submit"
              className="primary"
              data-testid="submit-button"
              disabled={submitting || !sceneId.trim() || !opId.trim() || notesTooLong}
            >
              {submitting ? '提交中…' : '领取下一条镜号'}
            </button>
          </form>

          {latest && (
            <div className="success-banner" data-testid="success-banner">
              <div className="shot-number">
                镜号 <span data-testid="shot-number-value">#{latest.shot_number}</span>
              </div>
              <div className="shot-meta">
                场次 {latest.scene_id} · 操作 {shortId(latest.client_op_id)}
                {latest.replayed && (
                  <span className="badge" data-testid="replayed-badge">
                    幂等重放：号码未变
                  </span>
                )}
              </div>
            </div>
          )}
        </section>

        {snapshot.pending.length > 0 && (
          <section className="card warning" data-testid="pending-list">
            <h2>待重试操作（{snapshot.pending.length}）</h2>
            <p className="hint">
              以下操作已安全保留（含页面刷新）。服务恢复后点击重试，将取回同一个镜号。
            </p>
            {snapshot.pending.map((op) => (
              <div className="op-card" data-testid="pending-card" key={op.client_op_id}>
                <div className="op-card-main">
                  <strong>{op.scene_id}</strong>
                  <span className="notes">{op.notes || '（无备注）'}</span>
                  <span className="meta">
                    操作 {shortId(op.client_op_id)} · 已尝试 {op.attempts} 次
                  </span>
                  {op.last_error && (
                    <span className="error-text" data-testid="pending-error">
                      {op.last_error}
                    </span>
                  )}
                </div>
                <div className="op-card-actions">
                  <button
                    type="button"
                    data-testid="retry-button"
                    onClick={() => void onRetry(op.client_op_id)}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    data-testid="discard-button"
                    onClick={() => issuer.discardPending(op.client_op_id)}
                  >
                    放弃
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {snapshot.failed.length > 0 && (
          <section className="card danger" data-testid="failed-list">
            <h2>失败操作（重试无效，{snapshot.failed.length}）</h2>
            {snapshot.failed.map((op) => (
              <div className="op-card" data-testid="failed-card" key={op.client_op_id}>
                <div className="op-card-main">
                  <strong>{op.scene_id}</strong>
                  <span className="notes">{op.notes || '（无备注）'}</span>
                  <span className="error-text">{op.reason}</span>
                  {op.existing_shot_number !== null && (
                    <span className="meta">
                      该标识已占用镜号 #{op.existing_shot_number}
                    </span>
                  )}
                </div>
                <div className="op-card-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => issuer.dismissFailed(op.client_op_id)}
                  >
                    知道了
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="card" data-testid="scene-board">
          <h2>
            场次看板{sceneId.trim() ? `：${sceneId.trim()}` : ''}（已发放 {sceneOps.length} 条）
          </h2>
          {boardError && <p className="error-text">{boardError}</p>}
          {!sceneId.trim() && (
            <p className="hint">
              填写场次后此处实时显示该场次已发放的镜号；点击行内“编辑”可修订备注，镜号不变。
            </p>
          )}
          {sceneOps.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>镜号</th>
                  <th>备注</th>
                  <th>修订</th>
                  <th>操作标识</th>
                  <th>发放时间 (UTC)</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sceneOps.map((op) => (
                  <SceneOpRow
                    key={op.client_op_id}
                    op={op}
                    draft={drafts[op.client_op_id]}
                    onBegin={() =>
                      dispatchDrafts({
                        type: 'begin',
                        clientOpId: op.client_op_id,
                        text: op.notes,
                        baseRevision: op.notes_revision,
                      })
                    }
                    onEdit={(text) =>
                      dispatchDrafts({ type: 'edit', clientOpId: op.client_op_id, text })
                    }
                    onSave={() => void onSaveNote(op.client_op_id)}
                    onCancel={() =>
                      dispatchDrafts({ type: 'cancel', clientOpId: op.client_op_id })
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
