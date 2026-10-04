/**
 * 两摊分账后的派生视图：有效完成判定、返工定位与道次对账
 * 纯函数，被工序台页、质检室页、useCoatProgress 与导出清单共用。
 */
import type { Coat } from '@/types/coat';
import type { ReworkAnchor } from '@/types/rework';
import { anchorReconcileKey } from '@/types/rework';

/** 挂了任一条返工重确认账的道次，即使 state==='done' 也「不算完成」 */
export function isCoatEffectivelyDone(coat: Coat): boolean {
  return coat.state === 'done' && coat.reconfirmBy.length === 0;
}

/** 该道是否被某条具体定位挂账 */
export function isCoatTaggedBy(coat: Coat, anchorId: string): boolean {
  return coat.reconfirmBy.includes(anchorId);
}

export interface BodyCoatView {
  bodyId: string;
  /** 按当前顺序排列的道次 */
  coats: Coat[];
  /** 有效完成道次数（挂重确认账的不算） */
  effectiveDone: number;
  /** 待重确认道次数 */
  reconfirmTotal: number;
  /** 定位道及后序是否都已重确认完成（供「可平账」判断） */
}

/** 胎体维度的道次视图 */
export function selectBodyCoatView(allCoats: Coat[], bodyId: string): BodyCoatView {
  const coats = allCoats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq);
  return {
    bodyId,
    coats,
    effectiveDone: coats.filter(isCoatEffectivelyDone).length,
    reconfirmTotal: coats.filter((coat) => coat.reconfirmBy.length > 0).length,
  };
}

/**
 * 定位对账状态：
 * - matched  工序台当前顺序里存在「胎体编号+道次序号」一致的道次
 * - missing  对不上，等工序台补
 */
export type AnchorMatch = 'matched' | 'missing';

export function matchAnchor(anchor: ReworkAnchor, coats: Coat[]): AnchorMatch {
  const key = anchorReconcileKey(anchor);
  return coats.some((coat) => anchorReconcileKey({ bodyId: coat.bodyId, coatSeq: coat.seq }) === key)
    ? 'matched'
    : 'missing';
}

/** 定位涉及的道次（按当前顺序：定位道及其后序），仅在 matched 时有意义 */
export function taggedCoatsForAnchor(allCoats: Coat[], anchor: ReworkAnchor): Coat[] {
  return allCoats
    .filter((coat) => coat.bodyId === anchor.bodyId && coat.seq >= anchor.coatSeq)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 这条定位是否已具备平账条件：
 * 定位有效 + 涉及道次当前都有效完成（没有挂账），且系统已打 reconfirmed 标记。
 */
export function anchorReadyToSettle(allCoats: Coat[], anchor: ReworkAnchor): boolean {
  if (anchor.settled) return false;
  if (anchor.status !== 'active') return false;
  if (!anchor.reconfirmed) return false;
  const involved = taggedCoatsForAnchor(allCoats, anchor);
  if (involved.length === 0) return false;
  return involved.every(isCoatEffectivelyDone);
}

/**
 * 该胎体是否允许质检室判合格：
 * 没有任何未平账定位才放行。
 * 注意：已重确认完但还没经质检室复核平账的定位仍然拦截（必须先在定位表「复核平账」）。
 */
export function passBlockReason(anchors: ReworkAnchor[], coats: Coat[], bodyId: string): string {
  void coats;
  const open = anchors.filter((anchor) => anchor.bodyId === bodyId && !anchor.settled);
  if (open.length === 0) return '';
  const ready = open.filter((anchor) => anchor.reconfirmed && anchor.status === 'active').length;
  const rest = open.length - ready;
  return ready > 0
    ? `${ready} 条返工已重确认完，待质检室复核平账；另有 ${rest} 条待处理。全部平账前不再判合格`
    : `还有 ${rest} 条返工定位待重确认/认领/补登，全部完成并平账前这件胎体不再判合格`;
}
