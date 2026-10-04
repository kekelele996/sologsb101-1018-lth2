/**
 * 当前工位状态管理（Zustand）
 * 工位决定可写范围：质检室写质检结论与返工定位，工序台写髹涂道次与漆种；
 * 跨页共享，初始值与持久化走 localStorage（见 utils/roleGuard.ts）。
 */
import { create } from 'zustand';
import { readWorkRole, writeWorkRole, type WorkRole } from '@/utils/roleGuard';

interface RoleStoreState {
  role: WorkRole;
  setRole: (role: WorkRole) => void;
}

export const useRoleStore = create<RoleStoreState>((set) => ({
  role: readWorkRole(),
  setRole(role) {
    writeWorkRole(role);
    set({ role });
  },
}));
