export interface IssuedOperation {
  scene_id: string;
  client_op_id: string;
  /** 发放时的备注：不可变的请求指纹，幂等判定以它为准 */
  issue_notes: string;
  /** 当前备注：可修订内容 */
  notes: string;
  /** 当前备注的修订号（从 1 开始单调递增） */
  notes_revision: number;
  shot_number: number;
  created_at: string;
}

export interface IssueResponse extends IssuedOperation {
  /** true 表示这是一次幂等重放，号码是此前已提交的原始号码 */
  replayed: boolean;
}

export interface IssueRequestBody {
  scene_id: string;
  client_op_id: string;
  notes: string;
  inject_failure_after_commit?: boolean;
}

export interface UpdateNotesBody {
  /** 本次编辑所基于的修订号 */
  base_revision: number;
  /** 新的备注文本 */
  notes: string;
}

/** 操作流水中的一条事件：某次成功领取或某个真正生成的新备注修订。 */
export interface OperationEvent {
  /** 全局序号：严格等于事务提交先后 */
  seq: number;
  /** issued = 领取镜号；note_revised = 备注修订 */
  event_type: 'issued' | 'note_revised';
  scene_id: string;
  client_op_id: string;
  shot_number: number;
  /** 事件对应的备注修订号（领取恒为 1） */
  revision: number;
  /** 事件发生时的备注快照 */
  notes: string;
  created_at: string;
}

/** 流水的一页。next_cursor 为 null 表示当次浏览快照已翻完。 */
export interface EventsPage {
  events: OperationEvent[];
  next_cursor: string | null;
}

/** 三方合并冲突中一个重叠片段的按行内容。 */
export interface NotesConflictFragment {
  base: string[];
  server: string[];
  local: string[];
}

/** 409 notes_merge_conflict 的完整三方信息，供场记对照整理后再次保存。 */
export interface NotesConflictInfo {
  current_revision: number;
  base_revision: number;
  base_notes: string;
  server_notes: string;
  local_notes: string;
  conflicts: NotesConflictFragment[];
}
