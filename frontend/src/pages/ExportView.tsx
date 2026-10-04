/**
 * /export 成品质检与 JSON 结构版本导入导出（成品质检室）
 * 质检室管质检结论与返工定位：判定返工时定位到具体道次并生成固定标识（胎体编号#道次序号），
 * 定位生效后该道及其后道次不算完成，未确认完前该胎体不能再判合格；
 * 两侧按固定标识对账，对不上先挂起等对方补，哪侧失败只退哪侧。
 * 消费 Inspect 及全部模型；复用 <StatBadge>、<EmptyPanel>。
 */
import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoleStore } from '@/stores/roleStore';
import { useRoomStore } from '@/stores/roomStore';
import { COAT_STATE_LABEL, PAINT_TYPE_LABEL } from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { ROOM_VERDICT_LABEL } from '@/types/room';
import {
  INSPECT_VERDICT_COLOR,
  INSPECT_VERDICT_LABEL,
  INSPECT_VERDICT_OPTIONS,
  LOCATE_STATE_COLOR,
  LOCATE_STATE_LABEL,
  createEmptyInspectDraft,
  type Inspect,
  type InspectDraft,
  type InspectVerdict,
} from '@/types/inspect';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  readLastMigration,
  resetDatabase,
  validateSnapshot,
  writeLastBackupAt,
  type LacquerSnapshot,
  type MigrationReport,
} from '@/utils/db';
import { isRoleBlocked } from '@/utils/roleGuard';
import { buildReworkKey, passBlockReason, type ReconcileReport } from '@/utils/rework';
import { reconcileBothSides, recomputeReworkInvalidation } from '@/utils/reworkSync';
import { buildReworkList, copyText, exportLedgerCsv, exportReworkList, exportSnapshotJson } from '@/utils/export';

export default function ExportView() {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<InspectDraft>();
  const inspectTable = useIdbTable<Inspect>((database) => database.inspects, { sortByUpdatedAt: false });
  const fileRef = useRef<HTMLInputElement>(null);

  const bodies = useBodyStore((state) => state.bodies);
  const loadBodies = useBodyStore((state) => state.loadBodies);
  const coats = useCoatStore((state) => state.coats);
  const loadCoats = useCoatStore((state) => state.loadCoats);
  const rooms = useRoomStore((state) => state.rooms);
  const loadRooms = useRoomStore((state) => state.loadRooms);
  const role = useRoleStore((state) => state.role);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Inspect | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(readLastBackupAt());
  const [migration, setMigration] = useState<MigrationReport | null>(() => readLastMigration());
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const watchedBodyId = Form.useWatch('bodyId', form) as string | undefined;
  const watchedVerdict = Form.useWatch('verdict', form) as InspectVerdict | undefined;

  /** 当前工位是否可写质检：质检结论与返工定位归质检室管理 */
  const canQc = role === 'qc';

  /** 统一执行写入：越权被挡下时提示，其余异常报错 */
  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        if (isRoleBlocked(error)) message.warning(error.message);
        else message.error(error instanceof Error ? error.message : '操作失败');
      }
    },
    [message],
  );

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const stat = useMemo(() => {
    const total = inspectTable.rows.length;
    const pass = inspectTable.rows.filter((row) => row.verdict === 'pass').length;
    const rework = total - pass;
    const unclaimed = inspectTable.rows.filter((row) => row.locateState === 'unclaimed').length;
    const suspended =
      inspectTable.rows.filter((row) => row.locateState === 'suspended').length +
      coats.filter((coat) => coat.syncHold).length;
    return { total, pass, rework, unclaimed, suspended, passPercent: total === 0 ? 0 : Math.round((pass / total) * 100) };
  }, [inspectTable.rows, coats]);

  const draftBodyId = watchedBodyId ?? bodies[0]?.id ?? '';
  const draftCoats = coats.filter((coat) => coat.bodyId === draftBodyId).sort((a, b) => a.seq - b.seq);
  const draftRooms = rooms.filter((room) => room.bodyId === draftBodyId);

  const reworkText = useMemo(
    () => buildReworkList(bodies, coats, rooms, inspectTable.rows),
    [bodies, coats, rooms, inspectTable.rows],
  );

  const openCreate = (): void => {
    if (!canQc) {
      message.warning('越权操作已被挡下：质检结论与返工定位归成品质检室管理，请切换工位后再操作');
      return;
    }
    const bodyId = bodies[0]?.id ?? '';
    if (!bodyId) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditing(null);
    form.setFieldsValue(createEmptyInspectDraft(bodyId));
    setOpen(true);
  };

  const openEdit = (row: Inspect): void => {
    setEditing(row);
    form.setFieldsValue({
      bodyId: row.bodyId,
      verdict: row.verdict,
      defectNote: row.defectNote,
      inspector: row.inspector,
      date: row.date,
      // 待认领的旧定位不再信任原道次序号，需质检室按现行道次重新认领
      defectCoatSeq: row.locateState === 'unclaimed' ? null : row.defectCoatSeq,
      defectRoomId: row.defectRoomId,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const bodyId = values.bodyId;
    // 没确认完前这件胎体不再判合格
    if (values.verdict === 'pass') {
      const reason = passBlockReason(coats, inspectTable.rows, bodyId);
      if (reason) {
        message.error(`不能判合格：${reason}`);
        return;
      }
    }
    const body = bodies.find((item) => item.id === bodyId);
    const locatedSeq = values.verdict === 'rework' && typeof values.defectCoatSeq === 'number' ? values.defectCoatSeq : null;
    const payload: InspectDraft = {
      ...values,
      defectCoatSeq: values.verdict === 'rework' ? locatedSeq : null,
      defectRoomId: values.verdict === 'rework' ? (values.defectRoomId ?? null) : null,
      // 定位生效即生成固定标识（胎体编号#道次序号），两侧按此对账
      reworkKey: locatedSeq !== null && body ? buildReworkKey(body.code, locatedSeq) : null,
      locateState: locatedSeq !== null ? 'located' : null,
    };
    await run(async () => {
      if (editing) {
        await inspectTable.update(editing.id, payload);
        message.success('已更新质检记录');
      } else {
        await inspectTable.create(payload, 'inspect');
        message.success(
          payload.verdict === 'rework' ? '已登记返工，定位道次及其后道次已转为待重确认' : '已登记质检合格',
        );
      }
      // 系统通道联动：按现行生效定位重算该胎体道次失效范围
      const affected = new Set<string>([bodyId]);
      if (editing && editing.bodyId !== bodyId) affected.add(editing.bodyId);
      for (const id of affected) {
        await recomputeReworkInvalidation(id);
      }
      await loadCoats();
      setOpen(false);
    });
  };

  const handleRemove = async (row: Inspect): Promise<void> => {
    await run(async () => {
      await inspectTable.remove(row.id);
      if (row.verdict === 'rework') {
        await recomputeReworkInvalidation(row.bodyId);
        await loadCoats();
      }
      message.success('已删除');
    });
  };

  /** 两侧对账：按 胎体编号#道次序号 核对，哪侧失败只退哪侧 */
  const handleReconcile = async (): Promise<void> => {
    setReconciling(true);
    try {
      const result = await reconcileBothSides();
      setReport(result);
      await loadCoats();
      if (result.qcError) message.error(`质检侧对账失败，已只退质检侧：${result.qcError}`);
      if (result.benchError) message.error(`工序侧对账失败，已只退工序侧：${result.benchError}`);
      if (!result.qcError && !result.benchError) message.success('两侧对账完成');
    } finally {
      setReconciling(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    const snapshot = await exportSnapshot();
    const filename = exportSnapshotJson(snapshot);
    const stamp = new Date().toISOString();
    writeLastBackupAt(stamp);
    setLastBackupAt(stamp);
    message.success(`已导出 ${filename}（结构版本 v${snapshot.schemaVersion}）`);
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      message.error('JSON 解析失败，请确认文件格式');
      return;
    }
    const invalid = validateSnapshot(parsed);
    if (invalid) {
      message.error(invalid);
      return;
    }
    modal.confirm({
      title: '覆盖导入本地数据',
      content: '导入会清空当前浏览器中的全部档案，再写入备份内容，操作不可撤销。',
      okText: '确认导入',
      cancelText: '取消',
      onOk: async () => {
        await importSnapshot(parsed as LacquerSnapshot);
        await Promise.all([loadBodies(), loadCoats(), loadRooms()]);
        setMigration(readLastMigration());
        message.success('导入完成，数据已覆盖');
      },
    });
  };

  const handleReset = async (): Promise<void> => {
    await resetDatabase();
    await Promise.all([loadBodies(), loadCoats(), loadRooms()]);
    message.success('已清空并重新载入演示数据');
  };

  const columns: ColumnsType<Inspect> = [
    { title: '质检日期', dataIndex: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 120,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 100,
      filters: INSPECT_VERDICT_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, record) => record.verdict === value,
      render: (value: InspectVerdict) => <Tag color={INSPECT_VERDICT_COLOR[value]}>{INSPECT_VERDICT_LABEL[value]}</Tag>,
    },
    {
      title: '缺陷说明',
      dataIndex: 'defectNote',
      render: (value: string, record) =>
        record.verdict === 'rework' ? (
          <Space direction="vertical" size={2}>
            <Space size={4} wrap>
              <Typography.Text>{value || '未填写'}</Typography.Text>
              {record.locateState ? (
                <Tag color={LOCATE_STATE_COLOR[record.locateState]}>{LOCATE_STATE_LABEL[record.locateState]}</Tag>
              ) : null}
              {record.reworkKey ? <Typography.Text code>{record.reworkKey}</Typography.Text> : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.locateState === 'unclaimed'
                ? `旧定位 ${record.reworkKey ?? '未生成标识'} 已退回待认领：工序台调序或撤道后，需重新定位；`
                : record.locateState === 'suspended'
                  ? '对账不符已挂起，等工序台补齐道次；'
                  : ''}
              定位道次：
              {record.defectCoatSeq === null
                ? '未指定'
                : (() => {
                    const coat = coats.find(
                      (item) => item.bodyId === record.bodyId && item.seq === record.defectCoatSeq,
                    );
                    return coat
                      ? `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName}（${COAT_STATE_LABEL[coat.state]}）`
                      : `第 ${record.defectCoatSeq} 道（工序侧暂无此道）`;
                  })()}
              ；荫房：
              {record.defectRoomId === null
                ? '未指定'
                : (() => {
                    const room = rooms.find((item) => item.id === record.defectRoomId);
                    return room
                      ? `${room.date} ${room.tempC}℃ / ${room.humidityPct}%（${ROOM_VERDICT_LABEL[room.verdict]}）`
                      : '记录已删除';
                  })()}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    { title: '质检人', dataIndex: 'inspector', width: 110, render: (value: string) => value || '未填写' },
    {
      title: '操作',
      key: 'action',
      width: 170,
      render: (_value, record) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            disabled={!canQc}
            onClick={() => openEdit(record)}
          >
            {record.locateState === 'unclaimed' ? '重新认领' : '编辑'}
          </Button>
          <Popconfirm
            title="删除该质检记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void handleRemove(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} disabled={!canQc}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>成品质检与数据导出</h2>
          <p>
            本地库 {DB_NAME} · 结构版本 v{DB_SCHEMA_VERSION}
            {lastBackupAt ? ` · 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : ' · 尚未导出过备份'}
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudDownloadOutlined />} onClick={() => void handleExport()}>
            导出 JSON
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>
            导入 JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => void handleImportFile(event)}
          />
          <Popconfirm
            title="清空并重播种"
            description="会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。"
            okText="确认重置"
            cancelText="取消"
            onConfirm={() => void handleReset()}
          >
            <Button danger icon={<ReloadOutlined />}>
              清空重播种
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="质检记录" value={stat.total} suffix="条" tone="primary" />
        <StatBadge label="合格率" value={`${stat.passPercent}%`} percent={stat.passPercent} tone="success" />
        <StatBadge label="合格" value={stat.pass} suffix="条" tone="info" />
        <StatBadge label="返工" value={stat.rework} suffix="条" tone="danger" />
        <StatBadge label="定位待认领" value={stat.unclaimed} suffix="条" tone="warning" />
        <StatBadge label="对账挂起" value={stat.suspended} suffix="项" tone="danger" />
      </div>

      {!canQc ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="当前工位：髹涂工序台。质检结论与返工定位归成品质检室管理，登记与编辑只读；两侧对账与数据导出不受工位限制。"
        />
      ) : null}

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card
            className="gb-table-card"
            title="质检登记"
            extra={
              <Button type="primary" size="small" icon={<PlusOutlined />} disabled={!canQc} onClick={openCreate}>
                新增质检
              </Button>
            }
            styles={{ body: { padding: 0 } }}
          >
            {inspectTable.rows.length === 0 ? (
              <EmptyPanel
                title="还没有质检记录"
                description="登记成品质检结论；判定返工时需定位到具体道次与荫房记录。"
                actionText="新增质检"
                onAction={openCreate}
                size="small"
              />
            ) : (
              <Table<Inspect>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 6 }}
                columns={columns}
                dataSource={[...inspectTable.rows].sort((a, b) => b.date.localeCompare(a.date))}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card
            title="返工清单"
            extra={
              <Space size={4}>
                <Button size="small" icon={<FileTextOutlined />} onClick={() => {
                  const filename = exportReworkList(bodies, coats, rooms, inspectTable.rows);
                  message.success(`已导出 ${filename}`);
                }}>
                  导出清单
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    void copyText(reworkText).then((ok) =>
                      ok ? message.success('返工清单已复制到剪贴板') : message.warning('浏览器未授权剪贴板'),
                    )
                  }
                >
                  复制
                </Button>
              </Space>
            }
          >
            <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>
              {reworkText}
            </pre>
          </Card>

          <Card
            title="两侧对账"
            style={{ marginTop: 16 }}
            extra={
              <Button size="small" icon={<SwapOutlined />} loading={reconciling} onClick={() => void handleReconcile()}>
                开始对账
              </Button>
            }
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按 胎体编号#道次序号 核对质检定位与工序道次：对不上的先挂起等对方补，哪侧失败只退哪侧。
              </Typography.Text>
              {report ? (
                <Alert
                  type={report.qcError || report.benchError ? 'error' : 'success'}
                  showIcon
                  message={
                    report.qcError || report.benchError
                      ? `${report.qcError ? `质检侧失败（只退质检侧）：${report.qcError}` : ''}${
                          report.qcError && report.benchError ? '；' : ''
                        }${report.benchError ? `工序侧失败（只退工序侧）：${report.benchError}` : ''}`
                      : `质检侧挂起 ${report.qcSuspended.length} 条 / 恢复 ${report.qcRestored.length} 条；工序侧挂起 ${report.benchSuspended.length} 道 / 恢复 ${report.benchRestored.length} 道`
                  }
                  description={
                    [
                      ...report.qcSuspended.map((item) => `质检挂起：${item.reworkKey}`),
                      ...report.qcRestored.map((item) => `质检恢复：${item.reworkKey}`),
                      ...report.benchSuspended.map((item) => `工序挂起：${item.key}`),
                      ...report.benchRestored.map((item) => `工序恢复：${item.key}`),
                    ].join('；') || undefined
                  }
                />
              ) : null}
              {stat.unclaimed > 0 || stat.suspended > 0 ? (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  当前未了结：待认领 {stat.unclaimed} 条（需质检室重新定位）· 对账挂起 {stat.suspended} 项（等对方补）
                </Typography.Text>
              ) : (
                <Typography.Text type="success" style={{ fontSize: 12 }}>
                  两侧账目当前全部对上，无待认领或挂起项。
                </Typography.Text>
              )}
            </Space>
          </Card>

          <Card title="整库导出" style={{ marginTop: 16 }}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                导出文件包含 6 张业务表全量数据与结构版本号，可在其他设备通过「导入 JSON」还原。
              </Typography.Text>
              <Space wrap>
                <Button icon={<CloudDownloadOutlined />} onClick={() => void handleExport()}>
                  JSON 备份
                </Button>
                <Button
                  onClick={() => {
                    const filename = exportLedgerCsv(bodies, coats, rooms);
                    message.success(`已导出 ${filename}`);
                  }}
                >
                  工序台账 CSV
                </Button>
              </Space>
              <Alert
                type="info"
                showIcon
                message="无状态容器"
                description="服务端不保存任何数据；清理浏览器站点数据会丢失档案，请定期导出备份。"
              />
            </Space>
          </Card>

          {migration ? (
            <Card title="结构升级报告" style={{ marginTop: 16 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  v{migration.from} → v{migration.to} · {migration.source === 'upgrade' ? '本地库升级' : '旧备份导入'} ·{' '}
                  {new Date(migration.at).toLocaleString('zh-CN')}；已按当时的道次顺序为返工定位补固定标识{' '}
                  {migration.backfilled} 条。
                </Typography.Text>
                {migration.failed.length === 0 ? (
                  <Typography.Text type="success" style={{ fontSize: 12 }}>
                    全部返工定位均已补上固定标识。
                  </Typography.Text>
                ) : (
                  <>
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      以下 {migration.failed.length} 条补不出固定标识，已退回待认领，请质检室重新定位：
                    </Typography.Text>
                    <Table
                      rowKey="inspectId"
                      size="small"
                      pagination={false}
                      columns={[
                        { title: '质检记录', dataIndex: 'inspectId', width: 150 },
                        { title: '胎体', dataIndex: 'bodyCode', width: 100 },
                        {
                          title: '定位道次',
                          dataIndex: 'defectCoatSeq',
                          width: 90,
                          render: (value: number | null) => (value === null ? '—' : `第 ${value} 道`),
                        },
                        { title: '补不出原因', dataIndex: 'reason' },
                      ]}
                      dataSource={migration.failed}
                    />
                  </>
                )}
              </Space>
            </Card>
          ) : null}
        </Col>
      </Row>

      <Modal
        open={open}
        title={editing ? '编辑质检记录' : '新增质检记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="bodyId" label="质检胎体" rules={[{ required: true }]}>
            <Select
              options={bodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
              }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="verdict" label="质检结论" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...INSPECT_VERDICT_OPTIONS]} />
            </Form.Item>
            <Form.Item name="date" label="质检日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="inspector" label="质检人" style={{ flex: 1 }}>
              <Input placeholder="如：周衡" />
            </Form.Item>
          </Space>
          <Form.Item name="defectNote" label="缺陷说明" rules={watchedVerdict === 'rework' ? [{ required: true, message: '返工必须填写缺陷说明' }] : []}>
            <Select
              allowClear
              showSearch
              placeholder="如：起皱（荫干过快）"
              options={[
                '漆面流挂',
                '起皱（荫干过快）',
                '针孔气泡',
                '边缘露底',
                '推光不匀',
                '镶嵌脱落',
              ].map((item) => ({ value: item, label: item }))}
            />
          </Form.Item>
          {watchedVerdict === 'rework' ? (
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item name="defectCoatSeq" label="定位道次" style={{ flex: 1 }}>
                <Select
                  allowClear
                  placeholder="选择道次"
                  options={draftCoats.map((coat) => ({
                    value: coat.seq,
                    label: `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName}`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="defectRoomId" label="关联荫房记录" style={{ flex: 1 }}>
                <Select
                  allowClear
                  placeholder="选择荫房记录"
                  options={draftRooms.map((room) => ({
                    value: room.id,
                    label: `${room.date} ${room.tempC}℃/${room.humidityPct}% · ${ROOM_VERDICT_LABEL[room.verdict]}`,
                  }))}
                />
              </Form.Item>
            </Space>
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
