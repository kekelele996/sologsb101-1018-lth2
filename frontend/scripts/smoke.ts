/**
 * 运行时冒烟测试（node + fake-indexeddb + tsx）：
 * 1. v2→v3 迁移：旧返工记录补固定标识；补不出的进 migrateIssues
 * 2. 两摊分账：越权写被挡
 * 3. 判返工 → 命中道及后序打回挂账，完成前判合格被挡
 * 4. 工序台逐道重确认 → 平账 → 可判合格
 * 5. 调序 → 旧定位退回待认领
 * 6. 挂起：对不上的定位 hung；补道次后自动对账
 * 运行：npx tsx scripts/smoke.ts
 */
import 'fake-indexeddb/auto';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log('✓ ' + msg);
}

async function main() {
  // ---------- 1) 构造 v2 旧库 ----------
  const { DB_NAME } = await import('@/utils/db');
  // 用独立 Dexie 实例以 v2 结构写入旧数据
  const { default: Dexie } = await import('dexie');
  if (await indexedDB.databases?.().then((dbs) => dbs.some((d) => d.name === DB_NAME))) {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  const old = new Dexie(DB_NAME);
  old.version(2).stores({
    bodies: 'id, code, material, shape, state, updatedAt',
    coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
    rooms: 'id, bodyId, date, verdict, updatedAt',
    polishes: 'id, bodyId, seq, method, updatedAt',
    inlays: 'id, bodyId, type, position, updatedAt',
    inspects: 'id, bodyId, verdict, date, updatedAt',
  });
  const now = Date.now();
  await old.table('bodies').bulkPut([
    { id: 'b1', code: 'OLD-1', material: 'wood', shape: 'bowl', sizeMm: 100, ownerName: 'x', state: 'done', createdAt: now, updatedAt: now },
    { id: 'b2', code: 'OLD-2', material: 'wood', shape: 'box', sizeMm: 80, ownerName: 'y', state: 'done', createdAt: now, updatedAt: now },
  ]);
  await old.table('coats').bulkPut([
    { id: 'c11', bodyId: 'b1', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-01-01', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now, updatedAt: now },
    { id: 'c12', bodyId: 'b1', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-01-02', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now, updatedAt: now },
    { id: 'c21', bodyId: 'b2', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-01-01', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now, updatedAt: now },
  ]);
  await old.table('inspects').bulkPut([
    { id: 'i1', bodyId: 'b1', verdict: 'rework', defectNote: '针孔', inspector: 'QC', date: '2026-01-03', defectCoatSeq: 2, defectRoomId: null, createdAt: now, updatedAt: now },
    { id: 'i2', bodyId: 'b2', verdict: 'rework', defectNote: '流挂', inspector: 'QC', date: '2026-01-03', defectCoatSeq: 3, defectRoomId: null, createdAt: now, updatedAt: now },
  ]);
  old.close();

  // ---------- 2) 打开 v3 触发迁移 ----------
  const { initDatabase, db } = await import('@/utils/db');
  await initDatabase();
  const anchors = await db.reworkAnchors.toArray();
  const issues = await db.migrateIssues.toArray();
  assert(anchors.length === 1, '迁移：能对上的旧返工补 1 条固定标识');
  assert(anchors[0].id === 'rwa_i1' && anchors[0].coatSeq === 2 && anchors[0].status === 'active', '迁移：固定标识 rwa_i1、定位第 2 道、active');
  assert(issues.length === 1 && issues[0].inspectId === 'i2', '迁移：补不出的（b2 只有 1 道却定位第 3 道）单列 migrateIssues');
  const c11 = await db.coats.get('c11');
  const c12 = await db.coats.get('c12');
  assert(c11.state === 'done' && c11.reconfirmBy.length === 0, '迁移：定位之前的道次保持完成');
  assert(c12.state === 'toPolish' && c12.reconfirmBy.includes('rwa_i1'), '迁移：命中道打回待打磨并挂重确认账');

  // ---------- 3) 越权写被挡 ----------
  const { submitInspect } = await import('@/services/inspectService');
  const { createCoat } = await import('@/services/coatService');
  const { ACTOR_COAT, ACTOR_QC } = await import('@/services/permission');
  let blocked = false;
  try {
    await submitInspect(ACTOR_COAT, {
      bodyId: 'b1', verdict: 'pass', defectNote: '', inspector: '', date: '2026-01-04', defectCoatSeq: null, defectRoomId: null,
    });
  } catch (e) {
    blocked = (e as Error).name === 'PermissionDeniedError';
  }
  assert(blocked, '越权：工序台身份写质检结论被挡下');
  blocked = false;
  try {
    await createCoat(ACTOR_QC, {
      bodyId: 'b1', seq: 9, paintType: 'raw', colorName: '漆黑', coatDate: '2026-01-04', thicknessUm: 40, state: 'todo', needRecheck: false,
    });
  } catch (e) {
    blocked = (e as Error).name === 'PermissionDeniedError';
  }
  assert(blocked, '越权：质检室身份写髹涂道次被挡下');

  // ---------- 4) 未重确认完判合格被挡 ----------
  const { submitInspection } = await import('@/services/workflow');
  let ruleBlocked = false;
  const blockedResult = await submitInspection({
    bodyId: 'b1', verdict: 'pass', defectNote: '', inspector: 'QC', date: '2026-01-04', defectCoatSeq: null, defectRoomId: null,
  });
  ruleBlocked = !blockedResult.ok;
  assert(ruleBlocked, '规则：有未平账返工时判合格被挡（' + blockedResult.message + '）');

  // ---------- 5) 工序台重确认 → 全部完成 → 质检复核平账 → 判合格 ----------
  const { confirmCoatRework } = await import('@/services/workflow');
  const r1 = await confirmCoatRework('c12', 'rwa_i1');
  assert(r1.ok && r1.message.includes('平账'), '工序台：第 2 道重确认后定位标记待复核平账（' + r1.message + '）');
  const afterAnchor = await db.reworkAnchors.get('rwa_i1');
  assert(afterAnchor.reconfirmed === true && afterAnchor.settled === false, '定位：reconfirmed=true 但未平账（等质检复核）');
  const { closeAnchor } = await import('@/services/inspectService');
  await closeAnchor(ACTOR_QC, 'rwa_i1');
  const settledAnchor = await db.reworkAnchors.get('rwa_i1');
  assert(settledAnchor.settled === true, '质检室：复核后平账');
  const passResult = await submitInspection({
    bodyId: 'b1', verdict: 'pass', defectNote: '', inspector: 'QC', date: '2026-01-05', defectCoatSeq: null, defectRoomId: null,
  });
  assert(passResult.ok, '平账后可以判合格');

  // ---------- 6) 新判返工（saga）：第 1 道起，后序都打回 ----------
  const kick = await submitInspection({
    bodyId: 'b1', verdict: 'rework', defectNote: '起皱', inspector: 'QC', date: '2026-01-06', defectCoatSeq: 1, defectRoomId: null,
  });
  assert(kick.ok, 'saga：判返工成功');
  const allAnchorsB1 = await db.reworkAnchors.where('bodyId').equals('b1').toArray();
  const newAnchor = allAnchorsB1
    .filter((a) => a.inspectId !== 'i1' && a.coatSeq === 1 && !a.settled)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  assert(!!newAnchor, 'saga：生成新返工定位');
  const coatsB1 = await db.coats.where('bodyId').equals('b1').toArray();
  assert(
    coatsB1.every((c) => c.state !== 'done' && c.reconfirmBy.includes(newAnchor!.id)),
    'saga：定位第 1 道后两道都不算完成且挂账',
  );
  // 直接推进到完成应被挡
  const { advanceCoatState } = await import('@/services/coatService');
  let kickBlocked = false;
  try {
    await advanceCoatState(ACTOR_COAT, 'c11', 'done');
  } catch (e) {
    kickBlocked = (e as Error).name === 'DomainRuleError';
  }
  assert(kickBlocked, '工序台：挂账道次不能直接推完成，必须走重确认');

  // ---------- 7) 调序 → 旧定位退回待认领 ----------
  const { changeCoatOrder } = await import('@/services/workflow');
  // 先重确认销账再调序，验证调序时未平账定位退回；改测：新建第 3 道后调序
  // 直接调序（当前 anchor active，道次挂账）
  const orderResult = await changeCoatOrder('reorder', { bodyId: 'b1', orderedIds: ['c12', 'c11'] });
  assert(orderResult.ok, 'saga：调序成功（' + orderResult.message + '）');
  const movedAnchor = await db.reworkAnchors.get(newAnchor!.id);
  assert(movedAnchor.status === 'pendingClaim', '调序后旧定位退回待认领');
  const reordered = (await db.coats.where('bodyId').equals('b1').toArray()).sort((a, b) => a.seq - b.seq);
  assert(reordered[0].id === 'c12' && reordered[0].seq === 1 && reordered[1].seq === 2, '调序后按新顺序重编号');

  // ---------- 8) 挂起与补登自动对账 ----------
  const hung = await submitInspection({
    bodyId: 'b1', verdict: 'rework', defectNote: '缺道', inspector: 'QC', date: '2026-01-07', defectCoatSeq: 5, defectRoomId: null,
  });
  assert(hung.ok, 'saga：定位到不存在的第 5 道也允许登记（先挂起）');
  const allAnchors = await db.reworkAnchors.where('bodyId').equals('b1').toArray();
  const hungAnchor = allAnchors.find((a) => a.coatSeq === 5 && !a.settled);
  assert(!!hungAnchor && hungAnchor.status === 'hung', '对账：对不上的定位先挂起');
  // 补登第 3 道（seq=3… 仍不到 5），再撤一道后重编号让 seq=5 出现 —— 更直接：新增到第 5 道
  const { addCoat } = await import('@/services/workflow');
  const draft = (seq: number) => ({
    bodyId: 'b1', seq, paintType: 'raw' as const, colorName: '漆黑', coatDate: '2026-01-08', thicknessUm: 40, state: 'todo' as const, needRecheck: false,
  });
  await addCoat(draft(3));
  let stillHung = (await db.reworkAnchors.get(hungAnchor.id)).status === 'hung';
  assert(stillHung, '补到第 3 道时第 5 道仍挂起');
  await addCoat(draft(4));
  await addCoat(draft(5));
  const reconciled = await db.reworkAnchors.get(hungAnchor.id);
  assert(reconciled.status === 'active', '补登到第 5 道后挂起定位自动对回 active');

  // ---------- 9) 单侧失败只退本侧：模拟质检侧失败（删除不存在的质检单后工序侧不应有联动影响） ----------
  // 用重确认的补偿路径不易模拟；这里验证 removeCoat 后质检侧退回：撤掉一道 → 全部未平账定位待认领
  const removeResult = await changeCoatOrder('remove', { bodyId: 'b1', coatId: 'c12' });
  assert(removeResult.ok, 'saga：撤道成功');
  const openAfterRemove = await db.reworkAnchors.where('bodyId').equals('b1').filter((a) => !a.settled).toArray();
  assert(openAfterRemove.every((a) => a.status === 'pendingClaim'), '撤道后未平账定位全部退回待认领');

  console.log('\n全部冒烟断言通过。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
