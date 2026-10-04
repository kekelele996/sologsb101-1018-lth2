/**
 * 返工联动纯函数：固定标识、失效范围、判合格拦截、旧数据补标识与对账报告类型。
 * 不触碰 IndexedDB；落库联动（重算失效、退回待认领、两侧对账）见 utils/reworkSync.ts。
 */
import type { Body } from '@/types/body';
import type { Coat } from '@/types/coat';
import type { Inspect, LocateState } from '@/types/inspect';

/** 返工定位固定标识：胎体编号#道次序号，两侧对账即按此键 */
export function buildReworkKey(bodyCode: string, seq: number): string {
  return `${bodyCode}#${seq}`;
}

/** 该胎体当前生效（已定位）的返工定位道次序号列表 */
export function locatedReworkSeqs(inspects: Inspect[], bodyId: string): number[] {
  return inspects
    .filter(
      (item) =>
        item.bodyId === bodyId &&
        item.verdict === 'rework' &&
        item.locateState === 'located' &&
        typeof item.defectCoatSeq === 'number',
    )
    .map((item) => item.defectCoatSeq as number);
}

/** 生效定位的最小道次序号；无生效定位返回 null */
export function minLocatedSeq(inspects: Inspect[], bodyId: string): number | null {
  const seqs = locatedReworkSeqs(inspects, bodyId);
  return seqs.length === 0 ? null : Math.min(...seqs);
}

/** 道次是否处于返工失效范围：生效定位道次及其后道次都不算完成 */
export function isCoatInvalidated(coatSeq: number, minSeq: number | null): boolean {
  return minSeq !== null && coatSeq >= minSeq;
}

/**
 * 判合格拦截：存在未确认完的返工道次、对账挂起道次或未了结的返工定位时返回原因，
 * 否则返回空串（「没确认完前这件胎体也不再判合格」）。
 */
export function passBlockReason(coats: Coat[], inspects: Inspect[], bodyId: string): string {
  const pending = coats
    .filter((coat) => coat.bodyId === bodyId && coat.pendingReconfirm)
    .sort((a, b) => a.seq - b.seq);
  if (pending.length > 0) {
    return `第 ${pending.map((coat) => coat.seq).join('、')} 道返工后尚未经工序台按现在的顺序重新确认`;
  }
  const held = coats
    .filter((coat) => coat.bodyId === bodyId && coat.syncHold)
    .sort((a, b) => a.seq - b.seq);
  if (held.length > 0) {
    return `第 ${held.map((coat) => coat.seq).join('、')} 道对账挂起中，待两侧补齐`;
  }
  const open = inspects.filter(
    (item) =>
      item.bodyId === bodyId &&
      item.verdict === 'rework' &&
      (item.locateState === 'unclaimed' || item.locateState === 'suspended'),
  );
  if (open.length > 0) {
    const keys = open.map((item) => item.reworkKey ?? '未生成标识').join('、');
    return `返工定位未了结（${keys}）：待认领的需重新定位，已挂起的等工序台补道次`;
  }
  return '';
}

/* ------------------------------ 旧数据升级：补固定标识 ------------------------------ */

/** 补不出固定标识的返工定位，升级报告里单列 */
export interface ReworkBackfillFailure {
  inspectId: string;
  bodyCode: string;
  defectCoatSeq: number | null;
  reason: string;
}

export interface ReworkBackfillResult {
  backfilled: number;
  failed: ReworkBackfillFailure[];
}

export interface NormalizeRowsInput {
  bodies: Body[];
  coats: Coat[];
  inspects: Inspect[];
}

export interface NormalizeRowsOutput {
  coats: Coat[];
  inspects: Inspect[];
  backfill: ReworkBackfillResult;
}

const LOCATE_STATES: readonly LocateState[] = ['located', 'unclaimed', 'suspended'];

/**
 * 旧数据升级规范化（v2→v3 本地升级与旧备份导入共用）：
 * 1. 道次补 pendingReconfirm / syncHold 默认标记；
 * 2. 按当时的道次顺序为返工定位补固定标识（胎体编号#道次序号），补不出的单列进 failed；
 * 3. 按生效定位重算各胎体返工失效范围。
 */
export function normalizeRows(input: NormalizeRowsInput): NormalizeRowsOutput {
  const coats = input.coats.map((coat) => ({
    ...coat,
    pendingReconfirm: coat.pendingReconfirm === true,
    syncHold: coat.syncHold === true,
  }));
  const backfill: ReworkBackfillResult = { backfilled: 0, failed: [] };
  const inspects = input.inspects.map((inspect) => {
    if (inspect.verdict !== 'rework' || typeof inspect.defectCoatSeq !== 'number') {
      return { ...inspect, reworkKey: null, locateState: null };
    }
    const hasKey = typeof inspect.reworkKey === 'string' && inspect.reworkKey.length > 0;
    const hasState = inspect.locateState !== null && LOCATE_STATES.includes(inspect.locateState as LocateState);
    if (hasKey && hasState) return inspect;
    const body = input.bodies.find((item) => item.id === inspect.bodyId);
    const coat = coats.find((item) => item.bodyId === inspect.bodyId && item.seq === inspect.defectCoatSeq);
    if (body && coat) {
      backfill.backfilled += 1;
      return {
        ...inspect,
        reworkKey: buildReworkKey(body.code, inspect.defectCoatSeq),
        locateState: 'located' as const,
      };
    }
    backfill.failed.push({
      inspectId: inspect.id,
      bodyCode: body?.code ?? inspect.bodyId,
      defectCoatSeq: inspect.defectCoatSeq,
      reason: body ? `第 ${inspect.defectCoatSeq} 道不在当时的道次顺序中` : '胎体档案不存在',
    });
    return { ...inspect, reworkKey: null, locateState: 'unclaimed' as const };
  });
  // 按生效定位重算失效范围（以当时的道次顺序为准）
  const minSeqByBody = new Map<string, number | null>();
  const minSeqOf = (bodyId: string): number | null => {
    if (!minSeqByBody.has(bodyId)) minSeqByBody.set(bodyId, minLocatedSeq(inspects, bodyId));
    return minSeqByBody.get(bodyId) ?? null;
  };
  const recomputed = coats.map((coat) => ({
    ...coat,
    pendingReconfirm: isCoatInvalidated(coat.seq, minSeqOf(coat.bodyId)),
  }));
  return { coats: recomputed, inspects, backfill };
}

/* ------------------------------ 两侧对账 ------------------------------ */

export interface ReconcileReport {
  at: string;
  /** 质检侧本次挂起的返工定位 */
  qcSuspended: Array<{ inspectId: string; reworkKey: string }>;
  /** 质检侧本次恢复的定位（工序台已补道次） */
  qcRestored: Array<{ inspectId: string; reworkKey: string }>;
  /** 工序侧本次挂起的道次 */
  benchSuspended: Array<{ coatId: string; key: string }>;
  /** 工序侧本次解除挂起的道次 */
  benchRestored: Array<{ coatId: string; key: string }>;
  /** 质检侧失败原因（只退质检侧）；空串表示成功 */
  qcError: string;
  /** 工序侧失败原因（只退工序侧）；空串表示成功 */
  benchError: string;
}
