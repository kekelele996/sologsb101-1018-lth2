/**
 * /qc 质检室
 * 质检室这份台账：只管质检结论（合格/返工）与返工定位（固定标识、状态、平账）。
 * - 判返工必须定位到道次；按「胎体编号+道次序号」对不上工序台账时先挂起；
 * - 命中道及后序道次自动打回，工序台重确认完前不再判合格；
 * - 工序台调序/撤道后退回待认领的旧定位，在这里重新认领；
 * - 旧数据升级补不出固定标识的记录在「升级异常」里单列。
 * 本页任何道次写入都被服务层挡下（越权防护）。
 */
import { useMemo, useState } from 'react';
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
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useQcStore } from '@/stores/qcStore';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL, PAINT_TYPE_LABEL } from '@/types/coat';
import { ROOM_VERDICT_LABEL } from '@/types/room';
import {
  INSPECT_VERDICT_COLOR,
  INSPECT_VERDICT_LABEL,
  INSPECT_VERDICT_OPTIONS,
  createEmptyInspectDraft,
  type Inspect,
  type InspectDraft,
  type InspectVerdict,
} from '@/types/inspect';
import {
  REWORK_STATUS_COLOR,
  REWORK_STATUS_LABEL,
  type ReworkAnchor,
} from '@/types/rework';
import { MIGRATE_ISSUE_LABEL } from '@/types/migrateIssue';
import { ACTOR_QC } from '@/services/permission';
import { claimAnchor, closeAnchor } from '@/services/inspectService';
import { deleteInspection, submitInspection } from '@/services/workflow';
import {
  anchorReadyToSettle,
  isCoatEffectivelyDone,
  passBlockReason,
  taggedCoatsForAnchor,
} from '@/utils/reworkView';
import { exportReworkList, buildReworkList } from '@/utils/export';
import { useRoomStore } from '@/stores/roomStore';

export default function QualityRoom() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<InspectDraft>();
  const [claimForm] = Form.useForm<{ coatSeq: number }>();

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const loadCoats = useCoatStore((state) => state.loadCoats);
  const rooms = useRoomStore((state) => state.rooms);
  const inspects = useQcStore((state) => state.inspects);
  const anchors = useQcStore((state) => state.anchors);
  const migrateIssues = useQcStore((state) => state.migrateIssues);
  const loadQc = useQcStore((state) => state.loadQc);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Inspect | null>(null);
  const [claiming, setClaiming] = useState<ReworkAnchor | null>(null);

  const watchedBodyId = Form.useWatch('bodyId', form) as string | undefined;
  const watchedVerdict = Form.useWatch('verdict', form) as InspectVerdict | undefined;
  const watchedSeq = Form.useWatch('defectCoatSeq', form) as number | undefined;

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const stat = useMemo(() => {
    const total = inspects.length;
    const pass = inspects.filter((row) => row.verdict === 'pass').length;
    const openAnchors = anchors.filter((anchor) => !anchor.settled);
    return {
      total,
      pass,
      rework: total - pass,
      passPercent: total === 0 ? 0 : Math.round((pass / total) * 100),
      active: openAnchors.filter((anchor) => anchor.status === 'active').length,
      waiting: openAnchors.filter((anchor) => anchor.status !== 'active').length,
    };
  }, [inspects, anchors]);

  const draftBodyId = watchedBodyId ?? bodies[0]?.id ?? '';
  const draftCoats = coats.filter((coat) => coat.bodyId === draftBodyId).sort((a, b) => a.seq - b.seq);
  const draftRooms = rooms.filter((room) => room.bodyId === draftBodyId);
  const draftBlockReason = draftBodyId ? passBlockReason(anchors, coats, draftBodyId) : '';

  const refreshBoth = async (): Promise<void> => {
    await Promise.all([loadQc(), loadCoats()]);
  };

  const openCreate = (): void => {
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
      defectCoatSeq: row.defectCoatSeq,
      defectRoomId: row.defectRoomId,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (values.verdict === 'rework' && values.defectCoatSeq === undefined) {
      message.warning('判定返工必须定位到具体道次');
      return;
    }
    const payload: InspectDraft = {
      ...values,
      defectCoatSeq: values.verdict === 'rework' ? (values.defectCoatSeq ?? null) : null,
      defectRoomId: values.verdict === 'rework' ? (values.defectRoomId ?? null) : null,
    };
    const result = await submitInspection(payload, editing?.id);
    if (result.ok) {
      message.success(result.message);
      setOpen(false);
      await refreshBoth();
    } else {
      message.error(result.message);
    }
  };

  const handleDelete = async (row: Inspect): Promise<void> => {
    const result = await deleteInspection(row.id);
    await refreshBoth();
    if (result.ok) message.success(result.message);
    else message.warning(result.message);
  };

  const openClaim = (anchor: ReworkAnchor): void => {
    setClaiming(anchor);
    claimForm.setFieldsValue({ coatSeq: anchor.coatSeq });
  };

  const submitClaim = async (): Promise<void> => {
    if (!claiming) return;
    const values = await claimForm.validateFields();
    try {
      await claimAnchor(ACTOR_QC, claiming.id, values.coatSeq);
      message.success('旧定位已重新认领到当前顺序的道次');
      setClaiming(null);
      await refreshBoth();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '认领失败');
    }
  };

  const handleSettle = async (anchor: ReworkAnchor): Promise<void> => {
    try {
      await closeAnchor(ACTOR_QC, anchor.id);
      message.success('已复核平账，该胎体可重新判合格');
      await loadQc();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '平账失败');
    }
  };

  const reworkText = useMemo(
    () => buildReworkList(bodies, coats, rooms, inspects, anchors),
    [bodies, coats, rooms, inspects, anchors],
  );

  const inspectColumns: ColumnsType<Inspect> = [
    { title: '质检日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体编号',
      dataIndex: 'bodyId',
      width: 110,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 90,
      render: (value: InspectVerdict) => <Tag color={INSPECT_VERDICT_COLOR[value]}>{INSPECT_VERDICT_LABEL[value]}</Tag>,
    },
    {
      title: '缺陷 / 定位',
      dataIndex: 'defectNote',
      render: (value: string, record) => {
        if (record.verdict !== 'rework') return <Typography.Text type="secondary">—</Typography.Text>;
        const anchor = anchors.find((item) => item.inspectId === record.id);
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text>{value || '未填写'}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              定位第 {record.defectCoatSeq ?? '?'} 道
              {anchor ? ` · 标识 ${anchor.id} · ${REWORK_STATUS_LABEL[anchor.status]}${anchor.settled ? '（已平账）' : ''}` : ''}
            </Typography.Text>
          </Space>
        );
      },
    },
    { title: '质检人', dataIndex: 'inspector', width: 90, render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该质检记录"
            description="关联返工定位一并作废，道次挂账解除。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const anchorColumns: ColumnsType<ReworkAnchor> = [
    { title: '固定标识', dataIndex: 'id', width: 190, render: (value: string) => <Typography.Text code style={{ fontSize: 12 }}>{value}</Typography.Text> },
    {
      title: '胎体',
      dataIndex: 'bodyCode',
      width: 100,
      render: (value: string, record) => <Tag color="#8c2f1f">{value || bodyCode(record.bodyId)}</Tag>,
    },
    {
      title: '定位道次',
      dataIndex: 'coatSeq',
      width: 90,
      render: (seq: number) => `第 ${seq} 道`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (status: ReworkAnchor['status'], record) => (
        <Tooltip title={record.note}>
          <Tag color={REWORK_STATUS_COLOR[status]}>{REWORK_STATUS_LABEL[status]}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '待重确认道次',
      key: 'tagged',
      render: (_v, record) => {
        if (record.status === 'hung') return <Typography.Text type="secondary">对账挂起，等工序台补道次</Typography.Text>;
        if (record.status === 'pendingClaim') return <Typography.Text type="warning">顺序已变，待质检室重新认领</Typography.Text>;
        const tagged = taggedCoatsForAnchor(coats, record);
        const pending = tagged.filter((coat) => !isCoatEffectivelyDone(coat)).map((coat) => coat.seq);
        return pending.length > 0 ? (
          <Space size={4} wrap>
            {pending.map((seq) => (
              <Tag key={seq} color="volcano">第 {seq} 道</Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="success">已全部重确认</Typography.Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_v, record) => {
        if (record.settled) return <Tag color="green">已平账</Tag>;
        return (
          <Space size={4}>
            {record.status === 'pendingClaim' || record.status === 'hung' ? (
              <Button size="small" type="link" onClick={() => openClaim(record)}>
                重新认领
              </Button>
            ) : null}
            <Tooltip title="工序台全部重确认后可复核平账">
              <Button
                size="small"
                type="link"
                icon={<CheckCircleOutlined />}
                disabled={!anchorReadyToSettle(coats, record)}
                onClick={() => void handleSettle(record)}
              >
                复核平账
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  const claimCoatOptions = coats
    .filter((coat) => coat.bodyId === claiming?.bodyId)
    .sort((a, b) => a.seq - b.seq)
    .map((coat) => ({
      value: coat.seq,
      label: `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName}（${COAT_STATE_LABEL[coat.state]}）`,
    }));

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>质检室</h2>
          <p>质检室只管质检结论与返工定位；髹涂道次与漆种归工序台，越权改道次会被挡下。返工定位打回的道次须工序台按当前顺序逐道重确认，全部完成前不再判合格。</p>
        </div>
        <Space wrap>
          <Button
            icon={<FileTextOutlined />}
            onClick={() => {
              const filename = exportReworkList(bodies, coats, rooms, inspects, anchors);
              message.success(`已导出 ${filename}`);
            }}
          >
            导出返工清单
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增质检
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="质检记录" value={stat.total} suffix="条" tone="primary" />
        <StatBadge label="合格率" value={`${stat.passPercent}%`} percent={stat.passPercent} tone="success" />
        <StatBadge label="合格" value={stat.pass} suffix="条" tone="info" />
        <StatBadge label="返工待重确认" value={stat.active} suffix="条" tone="danger" />
        <StatBadge label="待认领/挂起" value={stat.waiting} suffix="条" tone="warning" />
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card className="gb-table-card" title="质检结论台账" styles={{ body: { padding: 0 } }}>
            {inspects.length === 0 ? (
              <EmptyPanel
                title="还没有质检记录"
                description="登记成品质检结论；判定返工必须定位到具体道次，系统按胎体编号+道次序号与工序台对账。"
                actionText="新增质检"
                onAction={openCreate}
                size="small"
              />
            ) : (
              <Table<Inspect> rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={inspectColumns} dataSource={inspects} />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="返工定位台账（质检室管）" styles={{ body: { padding: 0 } }}>
            <Table<ReworkAnchor>
              rowKey="id"
              size="small"
              pagination={{ pageSize: 5 }}
              columns={anchorColumns}
              dataSource={anchors.filter((anchor) => !anchor.settled)}
            />
          </Card>
        </Col>
      </Row>

      {migrateIssues.filter((item) => !item.resolved).length > 0 ? (
        <Card title="旧数据升级异常（补不出固定标识，单列）" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={migrateIssues.filter((item) => !item.resolved)}
            columns={[
              { title: '来源质检单', dataIndex: 'inspectId', width: 180, render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
              { title: '胎体', dataIndex: 'bodyCode', width: 110 },
              { title: '原定位道次', dataIndex: 'coatSeq', width: 100, render: (v: number | null) => (v === null ? '未指定' : `第 ${v} 道`) },
              { title: '原因', dataIndex: 'reason' },
              { title: '类型', dataIndex: 'kind', width: 180, render: () => MIGRATE_ISSUE_LABEL['anchor-unmatched'] },
            ]}
          />
        </Card>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          返工清单文本可在本页「导出返工清单」取得。当前返工清单预览：
        </Typography.Paragraph>
        <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{reworkText}</pre>
      </Card>

      <Modal
        open={open}
        title={editing ? '编辑质检记录（质检室）' : '新增质检记录（质检室）'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="bodyId" label="质检胎体" rules={[{ required: true }]}>
            <Select
              options={bodies.map((body) => ({ value: body.id, label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}` }))}
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
          <Form.Item
            name="defectNote"
            label="缺陷说明"
            rules={watchedVerdict === 'rework' ? [{ required: true, message: '返工必须填写缺陷说明' }] : []}
          >
            <Select
              allowClear
              showSearch
              placeholder="如：起皱（荫干过快）"
              options={['漆面流挂', '起皱（荫干过快）', '针孔气泡', '边缘露底', '推光不匀', '镶嵌脱落'].map((item) => ({
                value: item,
                label: item,
              }))}
            />
          </Form.Item>
          {watchedVerdict === 'rework' ? (
            <>
              <Space size={12} style={{ display: 'flex' }}>
                <Form.Item name="defectCoatSeq" label="返工定位道次" rules={[{ required: true, message: '返工必须定位到道次' }]} style={{ flex: 1 }}>
                  <Select
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
              {watchedBodyId && watchedSeq !== undefined ? (
                (() => {
                  const matched = draftCoats.some((coat) => coat.seq === watchedSeq);
                  return matched ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="登记后：定位道及其后序道次立即打回，不算完成；须工序台按当前顺序逐道重确认，全部确认完前这件胎体不能再判合格。"
                    />
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="按胎体编号+道次序号在工序台账对不上该道次，定位先挂起，等工序台补登后自动对账。"
                    />
                  );
                })()
              ) : null}
            </>
          ) : (
            draftBlockReason ? (
              <Alert type="error" showIcon style={{ marginBottom: 12 }} message={draftBlockReason} />
            ) : null
          )}
        </Form>
      </Modal>

      <Modal
        open={claiming !== null}
        title="重新认领返工定位"
        onCancel={() => setClaiming(null)}
        onOk={() => void submitClaim()}
        okText="认领"
        cancelText="取消"
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          工序台调整或撤掉了道次，旧定位「{claiming?.id}」退回待认领。请按当前道次顺序重新指一道；指不到会继续挂起。
        </Typography.Paragraph>
        <Form form={claimForm} layout="vertical">
          <Form.Item name="coatSeq" label="定位到当前顺序的道次" rules={[{ required: true }]}>
            <Select options={claimCoatOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
