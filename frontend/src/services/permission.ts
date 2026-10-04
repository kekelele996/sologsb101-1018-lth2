/**
 * 权属与越权防护：质检室与髹涂工序台两摊分开记账，越权改对方那份一律挡下。
 *
 * - ACTOR_QC   质检室：只写质检结论（inspects）、返工定位（reworkAnchors）
 * - ACTOR_COAT 髹涂工序台：只写髹涂道次与漆种（coats）
 * - 打磨页 / 荫房页属于工序侧联动入口，以 ACTOR_COAT 身份经白名单方法回写 coats
 *
 * 服务层在落库前调用对应 guard，越权写抛 PermissionDeniedError，
 * 由调用方（store / saga）转成界面提示，绝不静默放行。
 */

export const ACTOR_QC = 'qc-room' as const;
export const ACTOR_COAT = 'coat-bench' as const;
/**
 * 系统编排身份：只用于「两摊对账」工作流内部的窄口联动
 * （如判返工后自动打回道次、道次全确认后自动平账、撤定位时解除挂账）。
 * 人工界面拿不到这个身份。
 */
export const ACTOR_SYSTEM = 'system-reconcile' as const;

/** 允许写 coats 的角色（工序台本体 + 工序侧打磨/荫房联动） */
export type CoatActor = typeof ACTOR_COAT;
/** 允许写 inspects / reworkAnchors 的角色 */
export type QcActor = typeof ACTOR_QC;

export type DomainActor = typeof ACTOR_QC | typeof ACTOR_COAT | typeof ACTOR_SYSTEM;

/** 越权修改对方台账 */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/** 业务规则不满足（如仍有未重确认的返工定位却判合格） */
export class DomainRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainRuleError';
  }
}

/** 一侧操作失败时携带归属侧，saga 据此只回退失败侧 */
export class SideOperationError extends Error {
  readonly side: DomainActor;
  constructor(side: DomainActor, message: string) {
    super(message);
    this.name = 'SideOperationError';
    this.side = side;
  }
}

export function assertQcActor(actor: string): asserts actor is QcActor {
  if (actor !== ACTOR_QC) {
    throw new PermissionDeniedError('质检台账归质检室管，工序台无权改质检结论或返工定位');
  }
}

export function assertCoatActor(actor: string): asserts actor is CoatActor {
  if (actor !== ACTOR_COAT) {
    throw new PermissionDeniedError('髹涂道次归工序台管，质检室无权改道次与漆种');
  }
}
