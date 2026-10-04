/**
 * 返工联动落库（系统通道，不经工位守卫）：
 * - 返工定位生效 / 变更 / 删除后，按现行生效定位重算道次失效范围；
 * - 工序台调序或撤道后，把该胎体旧定位退回待认领；
 * - 两侧按 胎体编号#道次序号 对账：对不上先挂起等对方补，哪侧失败只退哪侧。
 */
import { db } from './db';
import type { Coat } from '@/types/coat';
import type { Inspect } from '@/types/inspect';
import { buildReworkKey, isCoatInvalidated, minLocatedSeq, type ReconcileReport } from './rework';

/** 按该胎体现行生效定位重算失效范围；无生效定位则全部解除 */
export async function recomputeReworkInvalidation(bodyId: string): Promise<void> {
  const [inspects, coats] = await Promise.all([
    db.inspects.where('bodyId').equals(bodyId).toArray(),
    db.coats.where('bodyId').equals(bodyId).toArray(),
  ]);
  const minSeq = minLocatedSeq(inspects, bodyId);
  const now = Date.now();
  const changed = coats
    .filter((coat) => isCoatInvalidated(coat.seq, minSeq) !== coat.pendingReconfirm)
    .map((coat) => ({ ...coat, pendingReconfirm: isCoatInvalidated(coat.seq, minSeq), updatedAt: now }));
  if (changed.length > 0) await db.coats.bulkPut(changed);
}

/** 工序台调序或撤道后：该胎体已定位的返工定位退回待认领（旧标识保留备查），返回退回条数 */
export async function invalidateLocationsOfBody(bodyId: string): Promise<number> {
  const targets = await db.inspects
    .where('bodyId')
    .equals(bodyId)
    .filter((item) => item.verdict === 'rework' && item.locateState === 'located')
    .toArray();
  if (targets.length === 0) return 0;
  const now = Date.now();
  await db.inspects.bulkPut(targets.map((item) => ({ ...item, locateState: 'unclaimed' as const, updatedAt: now })));
  return targets.length;
}

/**
 * 两侧对账：按 胎体编号#道次序号 核对质检定位与工序道次。
 * 质检侧、工序侧各占一个独立事务：哪侧失败只回滚哪侧，另一侧已提交的保留。
 */
export async function reconcileBothSides(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    at: new Date().toISOString(),
    qcSuspended: [],
    qcRestored: [],
    benchSuspended: [],
    benchRestored: [],
    qcError: '',
    benchError: '',
  };
  const [bodies, coats, inspects] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.inspects.toArray(),
  ]);
  const codeOf = (bodyId: string): string => bodies.find((item) => item.id === bodyId)?.code ?? bodyId;
  const keyOfInspect = (inspect: Inspect): string =>
    inspect.reworkKey ??
    (typeof inspect.defectCoatSeq === 'number' ? buildReworkKey(codeOf(inspect.bodyId), inspect.defectCoatSeq) : '未定位');
  const keyOfCoat = (coat: Coat): string => buildReworkKey(codeOf(coat.bodyId), coat.seq);
  const now = Date.now();

  // 质检侧事务：定位的 胎体编号#道次序号 在工序侧是否还有对应道次
  const touchedBodies = new Set<string>();
  try {
    await db.transaction('rw', db.inspects, async () => {
      for (const inspect of inspects) {
        if (inspect.verdict !== 'rework' || typeof inspect.defectCoatSeq !== 'number') continue;
        if (inspect.locateState !== 'located' && inspect.locateState !== 'suspended') continue;
        const matched = coats.some((coat) => coat.bodyId === inspect.bodyId && coat.seq === inspect.defectCoatSeq);
        if (!matched && inspect.locateState === 'located') {
          await db.inspects.update(inspect.id, { locateState: 'suspended', updatedAt: now });
          report.qcSuspended.push({ inspectId: inspect.id, reworkKey: keyOfInspect(inspect) });
          touchedBodies.add(inspect.bodyId);
        } else if (matched && inspect.locateState === 'suspended') {
          await db.inspects.update(inspect.id, { locateState: 'located', updatedAt: now });
          report.qcRestored.push({ inspectId: inspect.id, reworkKey: keyOfInspect(inspect) });
          touchedBodies.add(inspect.bodyId);
        }
      }
    });
  } catch (error) {
    report.qcError = error instanceof Error ? error.message : '质检侧对账写入失败';
  }

  // 工序侧事务：先按对账后的定位重算失效，再核对失效道次是否都有生效定位覆盖
  try {
    const freshInspects = await db.inspects.toArray();
    await db.transaction('rw', db.coats, async () => {
      for (const bodyId of touchedBodies) {
        const minSeq = minLocatedSeq(freshInspects, bodyId);
        for (const coat of coats.filter((item) => item.bodyId === bodyId)) {
          const next = isCoatInvalidated(coat.seq, minSeq);
          if (next !== coat.pendingReconfirm) {
            await db.coats.update(coat.id, { pendingReconfirm: next, updatedAt: now });
            coat.pendingReconfirm = next;
          }
        }
      }
      for (const coat of coats) {
        if (!coat.pendingReconfirm) continue;
        const covered = freshInspects.some(
          (item) =>
            item.bodyId === coat.bodyId &&
            item.verdict === 'rework' &&
            item.locateState === 'located' &&
            typeof item.defectCoatSeq === 'number' &&
            (item.defectCoatSeq as number) <= coat.seq,
        );
        if (!covered && !coat.syncHold) {
          await db.coats.update(coat.id, { syncHold: true, updatedAt: now });
          coat.syncHold = true;
          report.benchSuspended.push({ coatId: coat.id, key: keyOfCoat(coat) });
        } else if (covered && coat.syncHold) {
          await db.coats.update(coat.id, { syncHold: false, updatedAt: now });
          coat.syncHold = false;
          report.benchRestored.push({ coatId: coat.id, key: keyOfCoat(coat) });
        }
      }
    });
  } catch (error) {
    report.benchError = error instanceof Error ? error.message : '工序侧对账写入失败';
  }
  return report;
}
