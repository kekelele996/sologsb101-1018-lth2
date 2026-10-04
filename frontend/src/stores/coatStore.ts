/**
 * 髹涂道次状态管理（Zustand）—— 髹涂工序台那份台账
 * 维护道次顺序与状态推进；所有写入只走 coatService（ACTOR_COAT），
 * 涉及质检侧的调序/撤道/新增/重确认联动走 services/workflow（分步提交、单侧回滚）。
 */
import { create } from 'zustand';
import { db } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { ACTOR_COAT } from '@/services/permission';
import {
  advanceCoatState,
  batchUpdateCoats,
  markCoatsRecheck,
  updateCoat,
} from '@/services/coatService';
import { addCoat, changeCoatOrder, confirmCoatRework, retryReturnAnchors } from '@/services/workflow';
import { useBodyStore } from './bodyStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

/** 跨侧工作流执行结果提示（失败侧 + 文案），由页面弹 message */
export interface CoatActionNotice {
  ok: boolean;
  message: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<CoatActionNotice>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<CoatActionNotice>;
  removeCoat: (id: string) => Promise<CoatActionNotice>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<CoatActionNotice>;
  advanceState: (id: string) => Promise<CoatActionNotice>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<CoatActionNotice>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<CoatActionNotice>;
  /** 工序台对返工挂账道次按当前顺序逐道重确认（先工序侧、后质检侧平账标记） */
  reconfirmRework: (coatId: string, anchorId: string) => Promise<CoatActionNotice>;
  /** 单侧失败后的补偿：重试把该胎体旧定位退回待认领 */
  retryAnchorReturn: (bodyId: string) => Promise<CoatActionNotice>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    // 走 saga：先工序侧新增，再到质检侧按「胎体编号+道次序号」对账挂起定位
    const result = await addCoat(draft);
    await get().loadCoats();
    return { ok: result.ok, message: result.message };
  },

  async updateCoat(id, patch) {
    try {
      await updateCoat(ACTOR_COAT, id, patch);
      await get().loadCoats();
      return { ok: true, message: '已保存' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '道次保存失败' };
    }
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    if (!target) return { ok: false, message: '道次不存在' };
    // 走 saga：先工序侧撤道重编号，再把质检侧旧定位退回待认领（质检侧失败只报失败侧）
    const result = await changeCoatOrder('remove', { bodyId: target.bodyId, coatId: id });
    await get().loadCoats();
    return { ok: result.ok, message: result.message };
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return { ok: true, message: '' };
    try {
      await batchUpdateCoats(ACTOR_COAT, ids, patch);
      await get().loadCoats();
      return { ok: true, message: '批量更新完成' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '批量更新失败' };
    }
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return { ok: false, message: '道次不存在' };
    const next = nextCoatState(coat.state);
    if (next === coat.state) return { ok: true, message: '' };
    try {
      await advanceCoatState(ACTOR_COAT, id, next);
      await get().loadCoats();
      return { ok: true, message: `已推进为${next === 'done' ? '已完成' : '下一阶段'}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '状态推进失败' };
    }
  },

  async markRecheck(bodyId, recheck) {
    // 工序侧内部联动（荫房页），仍然是工序台身份
    try {
      await markCoatsRecheck(ACTOR_COAT, bodyId, recheck);
      await get().loadCoats();
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '待复检回写失败' };
    }
  },

  async reorderCoats(bodyId, orderedIds) {
    // 走 saga：调序重编号后质检侧旧定位退回待认领
    const result = await changeCoatOrder('reorder', { bodyId, orderedIds });
    await get().loadCoats();
    return { ok: result.ok, message: result.message };
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  async reconfirmRework(coatId, anchorId) {
    const result = await confirmCoatRework(coatId, anchorId);
    await get().loadCoats();
    return { ok: result.ok, message: result.message };
  },

  async retryAnchorReturn(bodyId) {
    const result = await retryReturnAnchors(bodyId, '工序台手动重新对账：旧定位退回待认领');
    return { ok: result.ok, message: result.message };
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
