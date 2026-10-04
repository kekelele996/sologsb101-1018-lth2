/**
 * 工位角色与越权守卫
 * 两摊分记：成品质检室（qc）管质检结论与返工定位（inspects 表），
 * 髹涂工序台（bench）管髹涂道次与漆种（coats 表）。
 * 所有用户写入口统一经 assertTableWrite 校验当前工位，越权改对方那份会被挡下；
 * 系统内部联动（返工失效回写、对账挂起等）走系统通道，不经过本守卫。
 */

/** 工位：成品质检室 / 髹涂工序台 */
export type WorkRole = 'qc' | 'bench';

export const WORK_ROLE_LABEL: Record<WorkRole, string> = {
  qc: '成品质检室',
  bench: '髹涂工序台',
};

const LS_ROLE_KEY = 'gblacquer:work-role';

export function readWorkRole(): WorkRole {
  try {
    return localStorage.getItem(LS_ROLE_KEY) === 'qc' ? 'qc' : 'bench';
  } catch {
    return 'bench';
  }
}

export function writeWorkRole(role: WorkRole): void {
  try {
    localStorage.setItem(LS_ROLE_KEY, role);
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 表 → 归属工位；未登记的表不限制 */
export const TABLE_OWNER_ROLE: Record<string, WorkRole> = {
  coats: 'bench',
  inspects: 'qc',
};

const TABLE_LABEL: Record<string, string> = {
  coats: '髹涂道次与漆种',
  inspects: '质检结论与返工定位',
};

/** 越权写对方台账时抛出，页面捕获后提示「已被挡下」 */
export class RoleBlockedError extends Error {
  readonly tableName: string;

  constructor(tableName: string) {
    const owner = TABLE_OWNER_ROLE[tableName] ?? 'bench';
    super(
      `越权操作已被挡下：${TABLE_LABEL[tableName] ?? tableName}归${WORK_ROLE_LABEL[owner]}管理，` +
        `当前工位是${WORK_ROLE_LABEL[readWorkRole()]}，请切换工位后再操作`,
    );
    this.name = 'RoleBlockedError';
    this.tableName = tableName;
  }
}

/** 用户写入口统一守卫：当前工位与表归属不一致时抛 RoleBlockedError */
export function assertTableWrite(tableName: string): void {
  const owner = TABLE_OWNER_ROLE[tableName];
  if (!owner) return;
  if (readWorkRole() !== owner) throw new RoleBlockedError(tableName);
}

export function isRoleBlocked(error: unknown): error is RoleBlockedError {
  return error instanceof RoleBlockedError;
}
