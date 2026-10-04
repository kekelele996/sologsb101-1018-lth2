/**
 * /export 数据导入导出（不含质检登记 —— 质检已划归 /qc 质检室）
 * 整库 JSON 备份/还原/清空重播种，工序台账 CSV，结构版本回显。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Popconfirm,
  Row,
  Space,
  Typography,
} from 'antd';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  FileExcelOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import { useQcStore } from '@/stores/qcStore';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  resetDatabase,
  validateSnapshot,
  writeLastBackupAt,
  type LacquerSnapshot,
} from '@/utils/db';
import { exportLedgerCsv, exportSnapshotJson } from '@/utils/export';

export default function ExportView() {
  const { message, modal } = AntdApp.useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const bodies = useBodyStore((state) => state.bodies);
  const loadBodies = useBodyStore((state) => state.loadBodies);
  const coats = useCoatStore((state) => state.coats);
  const loadCoats = useCoatStore((state) => state.loadCoats);
  const rooms = useRoomStore((state) => state.rooms);
  const loadRooms = useRoomStore((state) => state.loadRooms);
  const loadQc = useQcStore((state) => state.loadQc);
  const anchors = useQcStore((state) => state.anchors);
  const migrateIssues = useQcStore((state) => state.migrateIssues);

  const [lastBackupAt, setLastBackupAt] = useState<string | null>(readLastBackupAt());

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
      content: '导入会清空当前浏览器中的全部档案（含质检台账与返工定位），再写入备份内容，操作不可撤销。',
      okText: '确认导入',
      cancelText: '取消',
      onOk: async () => {
        await importSnapshot(parsed as LacquerSnapshot);
        await Promise.all([loadBodies(), loadCoats(), loadRooms(), loadQc()]);
        message.success('导入完成，数据已覆盖');
      },
    });
  };

  const handleReset = async (): Promise<void> => {
    await resetDatabase();
    await Promise.all([loadBodies(), loadCoats(), loadRooms(), loadQc()]);
    message.success('已清空并重新载入演示数据');
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>数据导入导出</h2>
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
        <StatBadge label="胎体" value={bodies.length} suffix="件" tone="primary" />
        <StatBadge label="髹涂道次" value={coats.length} suffix="道" tone="info" />
        <StatBadge label="荫房记录" value={rooms.length} suffix="条" tone="warning" />
        <StatBadge label="返工定位" value={anchors.filter((anchor) => !anchor.settled).length} suffix="条未平账" tone="danger" />
        <StatBadge label="升级异常" value={migrateIssues.filter((item) => !item.resolved).length} suffix="条" tone="warning" />
      </div>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card title="整库备份 / 还原">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                导出文件包含 8 张表全量数据（胎体、道次、荫房、打磨、镶嵌、质检、返工定位、升级异常）与结构版本号，可在其他设备通过「导入 JSON」还原。
              </Typography.Text>
              <Space wrap>
                <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => void handleExport()}>
                  JSON 备份
                </Button>
                <Button icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>
                  JSON 还原
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
        </Col>
        <Col xs={24} lg={12}>
          <Card title="工序台账导出">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                CSV 台账按胎体列出每道髹涂的漆种、色名、状态与「待重确认」挂账；返工清单文本请在「质检室」页导出。
              </Typography.Text>
              <Button
                icon={<FileExcelOutlined />}
                onClick={() => {
                  const filename = exportLedgerCsv(bodies, coats, rooms);
                  message.success(`已导出 ${filename}`);
                }}
              >
                工序台账 CSV
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
