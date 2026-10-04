/**
 * 髹涂工序台领域服务（coat bench side）
 * 所有 coats 表写入的唯一入口：只在「工序侧」事务内操作 coats，
 * 绝不在这里写质检侧的 inspects / reworkAnchors（跨侧联动走 saga/workflow，分步提交、单侧回滚）。
 */
import { db } from '@/utils/db';
import type { Coat, CoatDraft, CoatState } from '@/types/coat';
import { ACTOR_SYSTEM, DomainRuleError, assertCoatActor, type DomainActor } from './permission';

/** 调序/撤道结果，供 saga 通知质检侧退回待认领 */
export interface CoatOrderChange {
  bodyId: string;
  removedCoatId?: string;
  reason: string;
}

function assertSystem(actor: DomainActor): void {
  if (actor !== ACTOR_SYSTEM) {
    throw new DomainRuleError('该联动动作只能由两摊对账编排触发');
  }
}

/** 道次被返工定位挂住时，不允许直接置完成；必须走逐道重确认 */
function assertNotBlockedToDone(coat: Coat, next: Partial<Coat>): void {
  if (next.state === 'done' && coat.state !== 'done' && coat.reconfirmBy.length > 0) {
    throw new DomainRuleError(
      `第 ${coat.seq} 道已被返工定位打回，须在工序台「返工重确认」里按当前顺序重新确认后才算完成`,
    );
  }
}

/** 工序台：新增道次（新建道次默认无重确认挂账） */
export async function createCoat(actor: DomainActor, draft: CoatDraft): Promise<Coat> {
  assertCoatActor(actor);
  const now = Date.now();
  const row: Coat = {
    ...draft,
    reconfirmBy: draft.reconfirmBy ?? [],
    id: createCoatId(),
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', db.coats, async () => {
    await db.coats.put(row);
  });
  return row;
}

export function createCoatId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `coat_${Date.now().toString(36)}${rand}`;
}

/** 工序台：改道次（漆种 / 色名 / 日期 / 厚度 / 状态 / 待复检）；返工挂账字段不由此入口改动 */
export async function updateCoat(actor: DomainActor, id: string, patch: Partial<Coat>): Promise<void> {
  assertCoatActor(actor);
  await db.transaction('rw', db.coats, async () => {
    const coat = await db.coats.get(id);
    if (!coat) return;
    assertNotBlockedToDone(coat, patch);
    const { reconfirmBy: _ignored, ...allowed } = patch;
    await db.coats.update(id, { ...allowed, updatedAt: Date.now() });
  });
}

/** 工序台：批量改漆种 / 状态；含返工挂账的道次不允许批量推完成 */
export async function batchUpdateCoats(
  actor: DomainActor,
  ids: string[],
  patch: Partial<Pick<Coat, 'paintType' | 'state' | 'needRecheck'>>,
): Promise<void> {
  assertCoatActor(actor);
  await db.transaction('rw', db.coats, async () => {
    const rows = await db.coats.where('id').anyOf(ids).toArray();
    const now = Date.now();
    for (const coat of rows) {
      assertNotBlockedToDone(coat, patch);
      await db.coats.put({ ...coat, ...patch, updatedAt: now });
    }
  });
}

/** 工序台：撤掉某一道，同胎体其余道次按当前顺序重编号（仅本侧事务） */
export async function removeCoat(actor: DomainActor, id: string): Promise<CoatOrderChange | null> {
  assertCoatActor(actor);
  const target = await db.coats.get(id);
  if (!target) return null;
  await db.transaction('rw', db.coats, async () => {
    await db.coats.delete(id);
    const rest = (await db.coats.where('bodyId').equals(target.bodyId).toArray())
      .sort((a, b) => a.seq - b.seq)
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rest);
  });
  return {
    bodyId: target.bodyId,
    removedCoatId: id,
    reason: `工序台撤掉第 ${target.seq} 道后重编号，旧定位退回待认领`,
  };
}

/** 工序台：拖拽调序并重编号（仅本侧事务），顺序确有变化时返回变更供 saga 通知质检侧 */
export async function reorderCoats(
  actor: DomainActor,
  bodyId: string,
  orderedIds: string[],
): Promise<CoatOrderChange | null> {
  assertCoatActor(actor);
  const changed = await db.transaction('rw', db.coats, async () => {
    const rows = (await db.coats.where('bodyId').equals(bodyId).toArray()).sort((a, b) => a.seq - b.seq);
    const before = rows.map((coat) => coat.id);
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const ordered = [...rows].sort((a, b) => {
      const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
      const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
    const after = ordered.map((coat) => coat.id);
    const sameOrder = before.length === after.length && before.every((id, index) => id === after[index]);
    if (sameOrder) return false;
    const now = Date.now();
    await db.coats.bulkPut(ordered.map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: now })));
    return true;
  });
  return changed
    ? { bodyId, reason: '工序台调整道次顺序并重编号，旧定位退回待认领' }
    : null;
}

/** 工序侧联动（打磨页）：道次状态推进；挂重确认账的道次最后一步必须走 reconfirmCoat */
export async function advanceCoatState(actor: DomainActor, id: string, next: CoatState): Promise<void> {
  assertCoatActor(actor);
  await db.transaction('rw', db.coats, async () => {
    const coat = await db.coats.get(id);
    if (!coat) return;
    assertNotBlockedToDone(coat, { state: next });
    await db.coats.update(id, { state: next, updatedAt: Date.now() });
  });
}

/** 工序侧联动（荫房页）：越界回写待复检 */
export async function markCoatsRecheck(actor: DomainActor, bodyId: string, recheck: boolean): Promise<void> {
  assertCoatActor(actor);
  await db.transaction('rw', db.coats, async () => {
    const now = Date.now();
    const rows = await db.coats.where('bodyId').equals(bodyId).toArray();
    await db.coats.bulkPut(
      rows
        .filter((coat) => coat.state !== 'done' || !recheck)
        .map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now })),
    );
  });
}

/* ------------------------ 仅供两摊对账编排调用的窄口 ------------------------ */

/**
 * 质检判返工后的工序侧联动：定位道及其后序道次不算完成 ——
 * 已完成的打回「待打磨」，并全部挂上该定位的重确认账。
 * 只允许 saga 编排身份调用；质检室本身无权直接改道次。
 */
export async function applyReworkKick(
  actor: DomainActor,
  bodyId: string,
  anchorSeq: number,
  anchorId: string,
): Promise<number> {
  assertSystem(actor);
  return db.transaction('rw', db.coats, async () => {
    const now = Date.now();
    const rows = (await db.coats.where('bodyId').equals(bodyId).toArray()).sort((a, b) => a.seq - b.seq);
    let touched = 0;
    await db.coats.bulkPut(
      rows.map((coat) => {
        if (coat.seq < anchorSeq) return coat;
        touched += 1;
        const reconfirmBy = coat.reconfirmBy.includes(anchorId)
          ? coat.reconfirmBy
          : [...coat.reconfirmBy, anchorId];
        return {
          ...coat,
          state: coat.state === 'done' ? ('toPolish' as CoatState) : coat.state,
          reconfirmBy,
          updatedAt: now,
        };
      }),
    );
    return touched;
  });
}

/**
 * 工序台按当前顺序逐道重确认：把挂账道次重新确认到「已完成」并销掉该定位的挂账标记。
 * 返回该定位是否已全部重确认完成（供 saga 到质检侧平账）。
 */
export async function reconfirmCoat(
  actor: DomainActor,
  coatId: string,
  anchorId: string,
): Promise<{ bodyId: string; anchorSeq: number; allReconfirmed: boolean } | null> {
  assertCoatActor(actor);
  return db.transaction('rw', db.coats, async () => {
    const coat = await db.coats.get(coatId);
    if (!coat || !coat.reconfirmBy.includes(anchorId)) return null;
    const reconfirmBy = coat.reconfirmBy.filter((id) => id !== anchorId);
    await db.coats.put({ ...coat, state: 'done', reconfirmBy, updatedAt: Date.now() });

    const rows = (await db.coats.where('bodyId').equals(coat.bodyId).toArray()).sort((a, b) => a.seq - b.seq);
    // 全部重确认 = 这件胎体上已没有任何道次还挂着该定位的账（每次重确认都会把本道置为完成）
    const allReconfirmed = rows.every((item) => !item.reconfirmBy.includes(anchorId));
    return { bodyId: coat.bodyId, anchorSeq: coat.seq, allReconfirmed };
  });
}

/** 质检侧删除/撤销返工时，由 saga 调用：解除某定位在道次上的全部挂账 */
export async function releaseAnchorFlags(actor: DomainActor, anchorId: string): Promise<void> {
  assertSystem(actor);
  await db.transaction('rw', db.coats, async () => {
    const now = Date.now();
    const rows = await db.coats.toCollection().filter((coat) => coat.reconfirmBy.includes(anchorId)).toArray();
    await db.coats.bulkPut(
      rows.map((coat) => ({
        ...coat,
        reconfirmBy: coat.reconfirmBy.filter((id) => id !== anchorId),
        updatedAt: now,
      })),
    );
  });
}
