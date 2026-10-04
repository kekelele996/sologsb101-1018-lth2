/**
 * 质检室状态管理（Zustand）—— 质检室那份台账
 * 只缓存质检结论、返工定位固定标识与升级异常；
 * 所有写入都走 inspectService（ACTOR_QC），跨侧联动走 services/workflow。
 */
import { create } from 'zustand';
import { db } from '@/utils/db';
import type { Inspect } from '@/types/inspect';
import type { ReworkAnchor } from '@/types/rework';
import type { MigrateIssue } from '@/types/migrateIssue';

interface QcStoreState {
  inspects: Inspect[];
  anchors: ReworkAnchor[];
  migrateIssues: MigrateIssue[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadQc: () => Promise<void>;
  inspectsOfBody: (bodyId: string) => Inspect[];
  anchorsOfBody: (bodyId: string) => ReworkAnchor[];
  /** 该胎体是否存在未平账返工定位（未重确认完前不再判合格） */
  openAnchorsOfBody: (bodyId: string) => ReworkAnchor[];
  anchorById: (id: string) => ReworkAnchor | undefined;
}

export const useQcStore = create<QcStoreState>((set, get) => ({
  inspects: [],
  anchors: [],
  migrateIssues: [],
  loading: false,
  ready: false,
  error: '',

  async loadQc() {
    set({ loading: true });
    try {
      const [inspects, anchors, migrateIssues] = await Promise.all([
        db.inspects.toArray(),
        db.reworkAnchors.toArray(),
        db.migrateIssues.toArray(),
      ]);
      inspects.sort((a, b) => b.date.localeCompare(a.date));
      anchors.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ inspects, anchors, migrateIssues, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '质检台账读取失败' });
    }
  },

  inspectsOfBody(bodyId) {
    return get()
      .inspects.filter((inspect) => inspect.bodyId === bodyId)
      .sort((a, b) => b.date.localeCompare(a.date));
  },

  anchorsOfBody(bodyId) {
    return get()
      .anchors.filter((anchor) => anchor.bodyId === bodyId)
      .sort((a, b) => a.coatSeq - b.coatSeq);
  },

  openAnchorsOfBody(bodyId) {
    return get().anchors.filter((anchor) => anchor.bodyId === bodyId && !anchor.settled);
  },

  anchorById(id) {
    return get().anchors.find((anchor) => anchor.id === id);
  },
}));

/** 选择器：未平账定位 */
export function selectOpenAnchors(anchors: ReworkAnchor[]): ReworkAnchor[] {
  return anchors.filter((anchor) => !anchor.settled);
}
