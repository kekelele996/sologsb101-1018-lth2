/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 * 道次与漆种归髹涂工序台管理：用户写入口统一越权守卫；
 * 返工失效重确认、调序/撤道退回旧定位等联动走系统通道。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { assertTableWrite } from '@/utils/roleGuard';
import { isCoatInvalidated, minLocatedSeq } from '@/utils/rework';
import { invalidateLocationsOfBody } from '@/utils/reworkSync';
import { useBodyStore } from './bodyStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  /** 删除道次并重编号；返回被退回「待认领」的返工定位条数 */
  removeCoat: (id: string) => Promise<number>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  /** 工序台按现在的顺序逐道确认返工道次；返回错误文案由页面捕获 */
  confirmRework: (id: string) => Promise<void>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  /** 拖拽调序并重编号；返回被退回「待认领」的返工定位条数 */
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<number>;
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
    assertTableWrite('coats');
    const now = Date.now();
    // 新道次若落在生效返工定位的失效范围内（定位道次及其后），同样不算完成
    const inspects = await db.inspects.where('bodyId').equals(draft.bodyId).toArray();
    const minSeq = minLocatedSeq(inspects, draft.bodyId);
    const row: Coat = {
      ...draft,
      syncHold: false,
      pendingReconfirm: isCoatInvalidated(draft.seq, minSeq),
      id: createId('coat'),
      createdAt: now,
      updatedAt: now,
    };
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    assertTableWrite('coats');
    const before = get().coats.find((coat) => coat.id === id);
    await db.coats.update(id, { ...patch, updatedAt: Date.now() } as never);
    // 改道次序号等同调序：该胎体旧返工定位退回待认领
    if (before && typeof patch.seq === 'number' && patch.seq !== before.seq) {
      await invalidateLocationsOfBody(before.bodyId);
    }
    await get().loadCoats();
  },

  async removeCoat(id) {
    assertTableWrite('coats');
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    // 撤掉某一道：该胎体旧返工定位退回待认领
    const invalidated = target ? await invalidateLocationsOfBody(target.bodyId) : 0;
    await get().loadCoats();
    return invalidated;
  },

  async batchUpdate(ids, patch) {
    assertTableWrite('coats');
    if (ids.length === 0) return;
    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    assertTableWrite('coats');
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    await get().updateCoat(id, { state: next });
  },

  async confirmRework(id) {
    assertTableWrite('coats');
    const coat = get().coats.find((item) => item.id === id);
    if (!coat || !coat.pendingReconfirm) return;
    if (coat.syncHold) {
      throw new Error(`第 ${coat.seq} 道对账挂起中，待质检室补齐返工定位后再确认`);
    }
    // 必须按现在的顺序确认：只允许确认当前序号最小的待确认道次
    const first = get()
      .coats.filter((item) => item.bodyId === coat.bodyId && item.pendingReconfirm)
      .sort((a, b) => a.seq - b.seq)[0];
    if (first && first.id !== coat.id) {
      throw new Error(`请按现在的顺序重新确认：先确认第 ${first.seq} 道`);
    }
    await db.coats.update(coat.id, { pendingReconfirm: false, updatedAt: Date.now() } as never);
    await get().loadCoats();
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    await db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now })));
    await get().loadCoats();
  },

  async reorderCoats(bodyId, orderedIds) {
    assertTableWrite('coats');
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rows);
    // 调序后旧返工定位退回待认领
    const invalidated = await invalidateLocationsOfBody(bodyId);
    await get().loadCoats();
    return invalidated;
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
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
