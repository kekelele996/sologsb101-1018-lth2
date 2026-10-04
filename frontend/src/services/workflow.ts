/**
 * 两摊对账工作流（saga）
 * 质检室与工序台各自的台账在各自服务里独立事务提交；跨侧联动由本文件编排：
 *  - 分步提交，绝不使用跨表大事务伪装成原子操作；
 *  - 哪一步失败就只补偿/回退哪一侧，已提交的另一侧保留结果，随后可重试补齐。
 */
import {
  ACTOR_COAT,
  ACTOR_QC,
  ACTOR_SYSTEM,
  DomainRuleError,
  PermissionDeniedError,
  SideOperationError,
  type DomainActor,
} from './permission';
import {
  applyReworkKick,
  releaseAnchorFlags,
  removeCoat as coatRemove,
  reorderCoats as coatReorder,
  reconfirmCoat,
  createCoat as coatCreate,
  type CoatOrderChange,
} from './coatService';
import {
  markAnchorReconfirmed,
  reconcileHungAnchors,
  removeInspect as qcRemove,
  returnAnchorsToClaim,
  settleAnchorManually,
  submitInspect,
} from './inspectService';
import type { CoatDraft } from '@/types/coat';
import type { InspectDraft } from '@/types/inspect';

export interface WorkflowResult {
  ok: boolean;
  /** 失败时的界面文案 */
  message: string;
  /** 失败侧；两侧都没动时为 null */
  failedSide: DomainActor | null;
  /** 先成功、未被回退的一侧（供提示「另一侧已生效，可重试」） */
  committedSide: DomainActor | null;
}

function failure(message: string, failedSide: DomainActor | null, committedSide: DomainActor | null): WorkflowResult {
  return { ok: false, message, failedSide, committedSide };
}

/**
 * 质检室登记/编辑质检（先质检侧、后工序侧）
 * 1) 质检侧事务：写质检结论 + 返工定位（对不上道次先挂起，不触发打回）；
 * 2) 定位 active 时，工序侧事务：打回定位道及后序道次。
 *    工序侧失败 → 只回退质检侧（删除本次质检与定位），报「质检侧已退回，请重试」。
 */
export async function submitInspection(draft: InspectDraft, existingId?: string): Promise<WorkflowResult> {
  let submitted: { inspectId: string; anchorId: string | null; kicked: boolean } | null = null;
  try {
    const { inspect, anchor } = await submitInspect(ACTOR_QC, draft, existingId);
    submitted = { inspectId: inspect.id, anchorId: anchor?.id ?? null, kicked: false };
  } catch (error) {
    if (error instanceof PermissionDeniedError || error instanceof DomainRuleError) {
      return failure(error.message, ACTOR_QC, null);
    }
    return failure(`质检结论登记失败：${describe(error)}`, ACTOR_QC, null);
  }

  if (submitted.anchorId) {
    try {
      await applyReworkKick(ACTOR_SYSTEM, draft.bodyId, draft.defectCoatSeq as number, submitted.anchorId);
      submitted.kicked = true;
    } catch (error) {
      // 工序侧失败：只退回质检侧本次写入（删掉质检单与定位）
      await rollbackQcSubmit(submitted.inspectId, submitted.anchorId, existingId !== undefined);
      return failure(
        `工序台账打回道次失败，质检结论已一并退回：${describe(error)}。请重试登记。`,
        ACTOR_COAT,
        null,
      );
    }
  }
  return {
    ok: true,
    failedSide: null,
    committedSide: null,
    message:
      draft.verdict === 'rework'
        ? '质检已判返工：定位已登记，命中道次及后序道次已打回，等工序台按当前顺序逐道重确认'
        : '质检已判合格',
  };
}

/** 质检侧补偿：删除本次质检单；定位随级联作废 */
async function rollbackQcSubmit(inspectId: string, anchorId: string | null, isEdit: boolean): Promise<void> {
  try {
    if (isEdit) {
      // 编辑场景的补偿无法还原旧值，只能把新生成的定位作废并保留质检单，交人工处理
      if (anchorId) await settleAnchorManually(ACTOR_QC, anchorId);
    } else {
      await qcRemove(ACTOR_QC, inspectId);
      if (anchorId) await releaseAnchorFlags(ACTOR_SYSTEM, anchorId);
    }
  } catch {
    /* 补偿失败只记录，不再抛（调用方已在报错路径上） */
  }
}

/** 质检室删除质检记录（先质检侧、后工序侧解除挂账；工序侧失败不影响质检侧已删结果） */
export async function deleteInspection(inspectId: string): Promise<WorkflowResult> {
  let anchorIds: string[] = [];
  try {
    anchorIds = await qcRemove(ACTOR_QC, inspectId);
  } catch (error) {
    return failure(`质检记录删除失败：${describe(error)}`, ACTOR_QC, null);
  }
  let releaseFailed = false;
  for (const anchorId of anchorIds) {
    try {
      await releaseAnchorFlags(ACTOR_SYSTEM, anchorId);
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed) {
    return failure('质检记录已删除，但个别道次的重确认挂账解除失败，请在工序台重试对账。', null, ACTOR_QC);
  }
  return { ok: true, message: '质检记录已删除，相关道次挂账已解除', failedSide: null, committedSide: null };
}

/**
 * 工序台调序/撤道（先工序侧、后质检侧）
 * 1) 工序侧事务：调序重编号 / 撤道重编号；
 * 2) 质检侧事务：这件胎体未平账的旧定位一律退回待认领。
 *    质检侧失败 → 回退工序侧不可行（撤道的数据已删），按规则保留工序侧结果并挂失败标记，可重试退回。
 */
export async function changeCoatOrder(
  kind: 'reorder' | 'remove',
  payload: { bodyId: string; orderedIds?: string[]; coatId?: string },
): Promise<WorkflowResult> {
  let change: CoatOrderChange | null = null;
  try {
    change =
      kind === 'reorder'
        ? await coatReorder(ACTOR_COAT, payload.bodyId, payload.orderedIds ?? [])
        : await coatRemove(ACTOR_COAT, payload.coatId ?? '');
  } catch (error) {
    if (error instanceof PermissionDeniedError || error instanceof SideOperationError) {
      return failure(error.message, ACTOR_COAT, null);
    }
    return failure(`道次顺序调整失败：${describe(error)}`, ACTOR_COAT, null);
  }
  if (!change) {
    return { ok: true, message: '顺序未变化', failedSide: null, committedSide: null };
  }
  try {
    await returnAnchorsToClaim(ACTOR_SYSTEM, change.bodyId, change.reason);
  } catch (error) {
    return failure(
      `道次已调整，但质检侧旧定位退回待认领失败：${describe(error)}。工序结果保留，可点「重新对账」补齐。`,
      ACTOR_QC,
      ACTOR_COAT,
    );
  }
  return { ok: true, message: '道次顺序已更新，质检侧旧定位已退回待认领', failedSide: null, committedSide: null };
}

/**
 * 工序台逐道重确认（先工序侧、后质检侧）
 * 本道置完成并销挂账；若该定位涉及的道次已全部重确认，到质检侧标记「待复核平账」。
 * 质检侧失败 → 工序侧重确认结果保留，提示可重试对账（只补质检侧）。
 */
export async function confirmCoatRework(coatId: string, anchorId: string): Promise<WorkflowResult> {
  let allReconfirmed = false;
  try {
    const result = await reconfirmCoat(ACTOR_COAT, coatId, anchorId);
    if (!result) {
      return failure('该道次没有挂这条返工定位，无需重确认', null, null);
    }
    allReconfirmed = result.allReconfirmed;
  } catch (error) {
    if (error instanceof DomainRuleError || error instanceof PermissionDeniedError) {
      return failure(error.message, ACTOR_COAT, null);
    }
    return failure(`道次重确认失败：${describe(error)}`, ACTOR_COAT, null);
  }
  if (allReconfirmed) {
    try {
      await markAnchorReconfirmed(ACTOR_SYSTEM, anchorId);
    } catch (error) {
      return failure(
        `本道已重确认，但质检侧平账标记失败：${describe(error)}。工序结果保留，可重试对账。`,
        ACTOR_QC,
        ACTOR_COAT,
      );
    }
  }
  return {
    ok: true,
    message: allReconfirmed ? '该定位涉及道次已全部重确认，请质检室复核判合格平账' : '本道已按当前顺序重新确认',
    failedSide: null,
    committedSide: null,
  };
}

/**
 * 工序台新增道次（先工序侧、后质检侧自动对账）
 * 补登后按「胎体编号+道次序号」把挂起的定位对回 active；质检侧失败时工序侧保留。
 */
export async function addCoat(draft: CoatDraft): Promise<WorkflowResult> {
  try {
    await coatCreate(ACTOR_COAT, draft);
  } catch (error) {
    return failure(`新增道次失败：${describe(error)}`, ACTOR_COAT, null);
  }
  try {
    await reconcileHungAnchors(ACTOR_SYSTEM, draft.bodyId);
  } catch (error) {
    return failure(
      `道次已新增，但质检侧挂起定位对账失败：${describe(error)}。可稍后重试对账。`,
      ACTOR_QC,
      ACTOR_COAT,
    );
  }
  return { ok: true, message: '道次已新增，挂起定位已按胎体编号+道次序号重新对账', failedSide: null, committedSide: null };
}

/** 重试对账：只补质检侧（调序/撤道后退回待认领失败的补偿入口） */
export async function retryReturnAnchors(bodyId: string, reason: string): Promise<WorkflowResult> {
  try {
    await returnAnchorsToClaim(ACTOR_SYSTEM, bodyId, reason);
    return { ok: true, message: '对账补齐：旧定位已退回待认领', failedSide: null, committedSide: null };
  } catch (error) {
    return failure(`对账仍失败：${describe(error)}`, ACTOR_QC, null);
  }
}

/** 重试对账：只补工序侧挂起定位（补道次后激活） */
export async function retryReconcileHung(bodyId: string): Promise<WorkflowResult> {
  try {
    await reconcileHungAnchors(ACTOR_COAT, bodyId);
    return { ok: true, message: '对账完成：挂起定位已核对', failedSide: null, committedSide: null };
  } catch (error) {
    return failure(`对账仍失败：${describe(error)}`, ACTOR_QC, null);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
