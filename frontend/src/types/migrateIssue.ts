/**
 * 旧数据升级异常（MigrateIssue）—— v2 → v3 迁移补不出固定标识的返工定位，单列留痕
 */
export type MigrateIssueKind = 'anchor-unmatched';

export interface MigrateIssue {
  id: string;
  /** 异常种类 */
  kind: MigrateIssueKind;
  /** 来源质检记录 id */
  inspectId: string;
  /** 胎体 id */
  bodyId: string;
  /** 胎体编号快照 */
  bodyCode: string;
  /** 当时质检记录上的定位道次序号（可能为空 / 越界） */
  coatSeq: number | null;
  /** 说明 */
  reason: string;
  createdAt: number;
  resolved: boolean;
}

export const MIGRATE_ISSUE_LABEL: Record<MigrateIssueKind, string> = {
  'anchor-unmatched': '返工定位无法补固定标识',
};
