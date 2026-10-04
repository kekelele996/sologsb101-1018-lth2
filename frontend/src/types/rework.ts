/**
 * 返工定位（ReworkAnchor）数据模型 —— 质检室台账
 *
 * 质检判定「返工」后，质检室必须把缺陷定位到具体某一道髹涂工序，
 * 定位以固定标识（id）落库，不随工序台调序/撤道而漂移：
 * - active       定位有效：命中道次及其后序道次不算完成，等工序台按当前顺序逐道重确认
 * - pendingClaim 待认领：工序台调序或撤掉了被定位的道次，旧定位退回待认领，等质检室重新确认位置
 * - hung         挂起：按「胎体编号 + 道次序号」对账时工序台那边没有对应道次，等对方补登
 *
 * 权属约定：本台账只允许「质检室」（ACTOR_QC）写入；
 * 工序台只能经由授权的联动（重确认完成、调序撤道打回）改状态，且不得改定位内容。
 */

/** 返工定位状态 */
export type ReworkAnchorStatus = 'active' | 'pendingClaim' | 'hung';

export interface ReworkAnchor {
  /** 固定标识；旧数据升级时按「rwa_<inspectId>」补齐，重定位时沿用 */
  id: string;
  /** 所属胎体 id（对账维度一：胎体编号） */
  bodyId: string;
  /** 胎体编号冗余快照（code），便于升级后仍可人工辨认 */
  bodyCode: string;
  /** 定位道次序号（对账维度二：道次序号，按当时道次顺序） */
  coatSeq: number;
  /** 状态 */
  status: ReworkAnchorStatus;
  /** 关联质检记录 id */
  inspectId: string;
  /** 关联荫房记录 id（可空） */
  defectRoomId: string | null;
  /** 最近一次打回/认领原因说明 */
  note: string;
  /** 是否已由工序台把命中道次及后序全部重确认完成（派生快照，平账后由联动置 true） */
  reconfirmed: boolean;
  /** 已平账（重确认全部完成并经质检室复核），平账后记录保留留痕，不再拦截合格判定 */
  settled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ReworkAnchorDraft = Omit<ReworkAnchor, 'id' | 'createdAt' | 'updatedAt'>;

export const REWORK_STATUS_LABEL: Record<ReworkAnchorStatus, string> = {
  active: '返工待重确认',
  pendingClaim: '待认领（道次已变动）',
  hung: '挂起（待工序台补道次）',
};

export const REWORK_STATUS_COLOR: Record<ReworkAnchorStatus, string> = {
  active: '#b03a2e',
  pendingClaim: '#c9963c',
  hung: '#8c8c8c',
};

export const REWORK_STATUS_OPTIONS: ReadonlyArray<{ value: ReworkAnchorStatus; label: string }> = [
  { value: 'active', label: REWORK_STATUS_LABEL.active },
  { value: 'pendingClaim', label: REWORK_STATUS_LABEL.pendingClaim },
  { value: 'hung', label: REWORK_STATUS_LABEL.hung },
];

/** 对账键：胎体编号(id) + 道次序号 */
export function reconcileKey(bodyId: string, coatSeq: number): string {
  return `${bodyId}#${coatSeq}`;
}

export function anchorReconcileKey(anchor: Pick<ReworkAnchor, 'bodyId' | 'coatSeq'>): string {
  return reconcileKey(anchor.bodyId, anchor.coatSeq);
}
