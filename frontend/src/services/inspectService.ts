/**
 * 质检室领域服务（QC room side）
 * 只写质检侧台账 inspects / reworkAnchors / migrateIssues；
 * 不在这里改 coats（打回道次走 workflow 里的工序侧服务，分步提交、单侧回滚）。
 */
import { db } from '@/utils/db';
import type { Inspect, InspectDraft } from '@/types/inspect';
import type { ReworkAnchor, ReworkAnchorStatus } from '@/types/rework';
import {
  ACTOR_COAT,
  ACTOR_SYSTEM,
  DomainRuleError,
  assertQcActor,
  type DomainActor,
} from './permission';
import type { MigrateIssue } from '@/types/migrateIssue';

export function createInspectId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `inspect_${Date.now().toString(36)}${rand}`;
}

export function createAnchorId(inspectId: string): string {
  return `rwa_${inspectId}`;
}

function assertSystem(actor: DomainActor): void {
  if (actor !== ACTOR_SYSTEM) {
    throw new DomainRuleError('该联动动作只能由两摊对账编排触发');
  }
}

/** 这件胎体是否存在尚未平账的返工定位（active / pendingClaim / hung 均算） */
export async function findOpenAnchors(bodyId: string): Promise<ReworkAnchor[]> {
  return db.reworkAnchors.where('bodyId').equals(bodyId).filter((anchor) => !anchor.settled).toArray();
}

/** 判合格的硬条件：不存在未平账的返工定位（重确认完仍须质检室复核平账后才算数） */
async function assertPassAllowed(bodyId: string): Promise<void> {
  const open = await findOpenAnchors(bodyId);
  if (open.length > 0) {
    const ready = open.filter((anchor) => anchor.reconfirmed && anchor.status === 'active').length;
    const rest = open.length - ready;
    const readyHint = ready > 0 ? `${ready} 条已重确认完、待质检室复核平账；` : '';
    throw new DomainRuleError(
      `该胎体还有 ${open.length} 条返工定位未平账（${readyHint}其余 ${rest} 条待重确认/认领/补登），全部平账前不再判合格`,
    );
  }
}

async function countCoat(bodyId: string, seq: number): Promise<number> {
  return db.coats.where({ bodyId, seq }).count();
}

async function upsertAnchor(
  inspect: Inspect,
  coatSeq: number,
  opts: {
    id?: string;
    status: ReworkAnchorStatus;
    note: string;
    reconfirmed?: boolean;
    settled?: boolean;
  },
): Promise<ReworkAnchor> {
  const body = await db.bodies.get(inspect.bodyId);
  const now = Date.now();
  const existing = opts.id ? await db.reworkAnchors.get(opts.id) : undefined;
  const row: ReworkAnchor = {
    id: opts.id ?? createAnchorId(inspect.id),
    bodyId: inspect.bodyId,
    bodyCode: body?.code ?? '',
    coatSeq,
    status: opts.status,
    inspectId: inspect.id,
    defectRoomId: inspect.defectRoomId,
    note: opts.note,
    reconfirmed: opts.reconfirmed ?? existing?.reconfirmed ?? false,
    settled: opts.settled ?? existing?.settled ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.reworkAnchors.put(row);
  return row;
}

/** 质检室：登记质检结论。返工时必须定位道次，并按对账结果落 active / hung 定位（仅本侧事务） */
export async function submitInspect(
  actor: DomainActor,
  draft: InspectDraft,
  existingId?: string,
): Promise<{ inspect: Inspect; anchor: ReworkAnchor | null }> {
  assertQcActor(actor);
  return db.transaction('rw', db.inspects, db.reworkAnchors, db.coats, db.bodies, async () => {
    if (draft.verdict === 'rework' && draft.defectCoatSeq === null) {
      throw new DomainRuleError('判定返工必须定位到具体道次，便于工序台按当前顺序重确认');
    }
    if (draft.verdict === 'pass') {
      await assertPassAllowed(draft.bodyId);
    }

    const now = Date.now();
    let inspect: Inspect;
    let anchor: ReworkAnchor | null = null;
    if (existingId) {
      const old = await db.inspects.get(existingId);
      inspect = { ...(old as Inspect), ...draft, updatedAt: now };
      await db.inspects.put(inspect);
      // 编辑会作废旧定位（同一质检单重判后按新位置重挂）
      await db.reworkAnchors.where('inspectId').equals(existingId).modify({ settled: true, updatedAt: now });
    } else {
      inspect = { ...draft, id: createInspectId(), createdAt: now, updatedAt: now };
      await db.inspects.put(inspect);
    }

    if (inspect.verdict === 'rework' && inspect.defectCoatSeq !== null) {
      const seq = inspect.defectCoatSeq;
      const matched = (await countCoat(inspect.bodyId, seq)) > 0;
      anchor = await upsertAnchor(inspect, seq, {
        status: matched ? 'active' : 'hung',
        note: matched
          ? '质检判返工，定位道及后序道次打回，待工序台按当前顺序逐道重确认'
          : '按胎体编号+道次序号对账时工序台无此道次，先挂起等对方补登',
      });
    }
    return { inspect, anchor };
  });
}

/** 质检室：删除质检记录（其定位同时作废留痕；道次挂账由 saga 解除） */
export async function removeInspect(actor: DomainActor, inspectId: string): Promise<string[]> {
  assertQcActor(actor);
  return db.transaction('rw', db.inspects, db.reworkAnchors, async () => {
    const anchors = await db.reworkAnchors.where('inspectId').equals(inspectId).toArray();
    const now = Date.now();
    await db.reworkAnchors.bulkPut(anchors.map((anchor) => ({ ...anchor, settled: true, updatedAt: now })));
    await db.inspects.delete(inspectId);
    return anchors.filter((anchor) => !anchor.settled).map((anchor) => anchor.id);
  });
}

/** 质检室：把待认领的旧定位重新指到当前顺序的某一道 */
export async function claimAnchor(
  actor: DomainActor,
  anchorId: string,
  coatSeq: number,
): Promise<ReworkAnchor> {
  assertQcActor(actor);
  return db.transaction('rw', db.reworkAnchors, db.coats, async () => {
    const anchor = await db.reworkAnchors.get(anchorId);
    if (!anchor) throw new DomainRuleError('返工定位不存在或已被删除');
    const matched = (await countCoat(anchor.bodyId, coatSeq)) > 0;
    const now = Date.now();
    const next: ReworkAnchor = {
      ...anchor,
      coatSeq,
      status: matched ? 'active' : 'hung',
      reconfirmed: false,
      settled: false,
      note: matched
        ? '质检室已把旧定位重新认领到当前顺序的道次，待工序台重确认'
        : '重新认领时该道次仍不存在，继续挂起等工序台补登',
      updatedAt: now,
    };
    await db.reworkAnchors.put(next);
    return next;
  });
}

/** 质检室：手工解除/作废一条定位（其道次挂账由 saga 解除） */
export async function settleAnchorManually(actor: DomainActor, anchorId: string): Promise<ReworkAnchor | null> {
  assertQcActor(actor);
  return db.transaction('rw', db.reworkAnchors, async () => {
    const anchor = await db.reworkAnchors.get(anchorId);
    if (!anchor) return null;
    const next: ReworkAnchor = { ...anchor, settled: true, updatedAt: Date.now() };
    await db.reworkAnchors.put(next);
    return next;
  });
}

/* ------------------------ 仅供两摊对账编排调用的窄口 ------------------------ */

/** 工序台调序/撤道后：这件胎体上所有未平账的定位一律退回待认领（只改质检侧） */
export async function returnAnchorsToClaim(
  actor: DomainActor,
  bodyId: string,
  reason: string,
): Promise<ReworkAnchor[]> {
  assertSystem(actor);
  return db.transaction('rw', db.reworkAnchors, async () => {
    const anchors = await db.reworkAnchors
      .where('bodyId')
      .equals(bodyId)
      .filter((anchor) => !anchor.settled)
      .toArray();
    const now = Date.now();
    const next = anchors.map((anchor) => ({
      ...anchor,
      status: 'pendingClaim' as ReworkAnchorStatus,
      reconfirmed: false,
      note: reason,
      updatedAt: now,
    }));
    await db.reworkAnchors.bulkPut(next);
    return next;
  });
}

/**
 * 工序台补登道次后自动对账：按 胎体编号+道次序号 匹配的 hung 定位转 active。
 * 返回新激活的定位（供 saga 决定是否需要再次打回道次；当前实现：打回在质检室认领时统一做）。
 */
export async function reconcileHungAnchors(
  actor: DomainActor,
  bodyId: string,
): Promise<ReworkAnchor[]> {
  if (actor !== ACTOR_SYSTEM && actor !== ACTOR_COAT) {
    throw new DomainRuleError('对账只能由工序台补登或系统编排触发');
  }
  return db.transaction('rw', db.reworkAnchors, db.coats, async () => {
    const hung = await db.reworkAnchors
      .where('bodyId')
      .equals(bodyId)
      .filter((anchor) => !anchor.settled && anchor.status === 'hung')
      .toArray();
    const now = Date.now();
    const activated: ReworkAnchor[] = [];
    for (const anchor of hung) {
      const matched = (await countCoat(bodyId, anchor.coatSeq)) > 0;
      if (matched) {
        const next: ReworkAnchor = {
          ...anchor,
          status: 'active',
          note: '工序台已补登对应道次，对账通过，待逐道重确认',
          updatedAt: now,
        };
        await db.reworkAnchors.put(next);
        activated.push(next);
      }
    }
    return activated;
  });
}

/** 工序台逐道重确认完成后：标记定位已全部重确认（状态保持 active，等质检室复核判合格时平账） */
export async function markAnchorReconfirmed(
  actor: DomainActor,
  anchorId: string,
): Promise<ReworkAnchor | null> {
  assertSystem(actor);
  return db.transaction('rw', db.reworkAnchors, async () => {
    const anchor = await db.reworkAnchors.get(anchorId);
    if (!anchor || anchor.settled) return null;
    const next: ReworkAnchor = {
      ...anchor,
      reconfirmed: true,
      note: '工序台已按当前顺序重确认完毕，等质检室复核判合格后平账',
      updatedAt: Date.now(),
    };
    await db.reworkAnchors.put(next);
    return next;
  });
}

/** 质检室在定位全部重确认后复核通过：平账（settled） */
export async function closeAnchor(actor: DomainActor, anchorId: string): Promise<ReworkAnchor | null> {
  assertQcActor(actor);
  return db.transaction('rw', db.reworkAnchors, async () => {
    const anchor = await db.reworkAnchors.get(anchorId);
    if (!anchor) return null;
    if (!anchor.reconfirmed) {
      throw new DomainRuleError('工序台尚未重确认完该定位涉及的道次，不能平账');
    }
    const next: ReworkAnchor = { ...anchor, settled: true, updatedAt: Date.now() };
    await db.reworkAnchors.put(next);
    return next;
  });
}

/** 升级异常台账：列出 / 标记已处理 */
export async function listMigrateIssues(): Promise<MigrateIssue[]> {
  return db.migrateIssues.orderBy('createdAt').toArray();
}

export async function resolveMigrateIssue(actor: DomainActor, issueId: string): Promise<void> {
  assertQcActor(actor);
  await db.migrateIssues.update(issueId, { resolved: true });
}
