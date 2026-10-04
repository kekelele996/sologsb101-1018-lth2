/**
 * <StageTag> 阶段标签
 * 按胎体状态（待髹涂/髹涂中/待荫干/已完成）与道次状态（待涂/已涂/待打磨/已完成）渲染底色，
 * 并支持荫房异常回写的「待复检」提示；被胎体页、道次页、打磨页消费。
 */
import { Tag, Tooltip } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { BODY_STATE_COLOR, BODY_STATE_LABEL, type BodyState } from '@/types/body';
import { COAT_STATE_COLOR, COAT_STATE_LABEL, type CoatState } from '@/types/coat';

export type StageKey = BodyState | CoatState;

export interface StageTagProps {
  /** 状态键：胎体状态或道次状态 */
  state: StageKey;
  /** 是否需要复检（荫房温湿度越界后回写） */
  needRecheck?: boolean;
  /** 返工失效，待工序台按现在的顺序重新确认 */
  pendingReconfirm?: boolean;
  /** 两侧对账挂起，等质检室补齐返工定位 */
  syncHold?: boolean;
  /** 道次序号，传入时前缀显示「第 n 道」 */
  seq?: number;
  /** 追加文案，如「已完成 2/4」 */
  suffix?: string;
}

const LABEL: Record<string, string> = { ...BODY_STATE_LABEL, ...COAT_STATE_LABEL };
const COLOR: Record<string, string> = { ...BODY_STATE_COLOR, ...COAT_STATE_COLOR };

export function StageTag({ state, needRecheck = false, pendingReconfirm = false, syncHold = false, seq, suffix }: StageTagProps) {
  const label = LABEL[state] ?? state;
  const color = COLOR[state] ?? '#8c8c8c';
  const text = `${seq === undefined ? '' : `第 ${seq} 道 · `}${label}${suffix ? ` · ${suffix}` : ''}`;
  const hasExtra = needRecheck || pendingReconfirm || syncHold;

  return (
    <>
      <Tag color={color} style={{ marginInlineEnd: hasExtra ? 4 : 0 }}>
        {text}
      </Tag>
      {needRecheck ? (
        <Tooltip title="关联荫房温湿度越界，需复检漆层">
          <Tag icon={<ExclamationCircleOutlined />} color="warning">
            待复检
          </Tag>
        </Tooltip>
      ) : null}
      {pendingReconfirm ? (
        <Tooltip title="质检返工生效中：本道不算完成，待工序台按现在的顺序重新确认">
          <Tag color="volcano">待重确认</Tag>
        </Tooltip>
      ) : null}
      {syncHold ? (
        <Tooltip title="两侧对账不符，已挂起等质检室补齐返工定位">
          <Tag color="purple">对账挂起</Tag>
        </Tooltip>
      ) : null}
    </>
  );
}

export default StageTag;
