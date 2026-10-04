# 漆器髹涂工序与荫房环境档案（gblacquer）

面向漆艺工作室工序管理员的本地化档案工具：把每件漆器的髹涂道次、荫干时长与打磨推光逐道记录，并同步留存荫房温湿度，作为漆层缺陷回溯依据。

核心动作：**登记胎体与器型 → 编排髹涂道次与漆种 → 记录荫房温湿度 → 登记打磨与推光 → 登记镶嵌纹饰 → 质检室判结论/返工定位（与工序台分账、对账）→ 导出**。

**质检室与髹涂工序台两摊分开记（v3 起）**：质检室管质检结论与返工定位（固定标识），工序台管髹涂道次与漆种；服务层按角色拦截，越权改对方那份会被 `PermissionDeniedError` 挡下。返工定位到某一道后，该道及其后序道次立即不算完成（打回待打磨并挂「重确认」账），由工序台按当前顺序逐道重新确认，全部复核平账前这件胎体不再判合格；工序台调序或撤道时旧定位退回「待认领」。两边按**胎体编号 + 道次序号**对账，对不上先挂起等对方补登，跨侧联动分步提交（saga），**哪侧失败只退哪侧**。旧数据升级到 v3 时按当时道次顺序为返工定位补固定标识，补不出的单列「升级异常」。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Zustand + React Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22818**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gblacquer}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、表单、对话框、拖拽排序、徽标 |
| 构建工具 | Vite 5 | 开发服务器端口 22818 |
| 状态管理 | Zustand 4 | `bodyStore` / `coatStore` / `roomStore` / `qcStore`，写入经 `src/services/` 领域服务鉴权 |
| 路由 | React Router 6（`createBrowserRouter`，history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2、v2→v3 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22818
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22818）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/bodies` | 胎体与器型台账 | 新建胎体、按材质与器型筛选（同步 URL query），卡片回显已完成道次与最近荫房记录 | Body、Coat、Room |
| `/coats` | 髹涂工序台（道次编排） | 拖拽调整道次先后并重编号、批量改漆种与状态、同器型带出建议；展示返工挂账并逐道「返工重确认」，调序/撤道联动退回旧定位 | Coat、Body、ReworkAnchor |
| `/rooms` | 荫房温湿度记录 | 按区间判定适宜 / 偏干 / 偏湿，越界经工序台服务回写关联道次为「待复检」，支持日期区间筛选 | Room、Coat |
| `/polish` | 打磨与推光工序 | 按道次生成目数序列（320→2000），未打磨完的道次禁止进入下一道罩漆；挂返工账的道次须回工序台重确认 | Polish、Coat |
| `/inlays` | 镶嵌纹饰登记 | 螺钿 / 蛋壳 / 描金 / 戗金登记与批量调整分类，器型示意区叠加显示 | Inlay、Body |
| `/qc` | 质检室 | 质检登记（合格/返工）、返工定位固定标识台账（active / 待认领 / 挂起 / 平账）、重新认领、复核平账、返工清单 TXT、升级异常单列表 | Inspect、ReworkAnchor、MigrateIssue 及 Coat/Room |
| `/export` | 数据导入导出 | JSON 备份/还原/清空重播种、工序台账 CSV、结构版本回显（不含质检登记） | 全部模型 |

`/` 与未匹配路径重定向到 `/bodies`。筛选条件写入 URL query（`?kw=&paintType=&state=` 等），刷新后条件保留，可直接分享链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Body 胎体 | `src/types/body.ts` | `id` `code` `material`（木/脱胎/金属） `shape`（碗/盘/盒/瓶） `sizeMm` `ownerName` `state`（待髹涂/髹涂中/待荫干/已完成） | 新建后进入道次编排，卡片回显进度与最近荫房 |
| Coat 髹涂道次（工序台账） | `src/types/coat.ts` | `id` `bodyId` `seq` `paintType`（生漆/色漆/罩漆） `colorName` `coatDate` `thicknessUm` `state`（待涂/已涂/待打磨/已完成） `needRecheck` `reconfirmBy` | 只允许工序台身份（`ACTOR_COAT`）写入；`reconfirmBy` 为返工定位 id 列表，挂账期间即使 state=done 也「不算完成」 |
| Room 荫房记录 | `src/types/room.ts` | `id` `bodyId` `date` `tempC` `humidityPct` `inAt` `outAt` `verdict`（适宜/偏干/偏湿） | 越界经工序台服务回写关联道次为待复检 |
| Polish 打磨推光 | `src/types/polish.ts` | `id` `bodyId` `seq` `grit` `method`（水砂/推光/揩清） `durationMin` `operator` | 按道次生成目数序列；挂返工账的道次不在此直接置完成 |
| Inlay 镶嵌 | `src/types/inlay.ts` | `id` `bodyId` `type`（螺钿/蛋壳/描金/戗金） `pattern` `position` `materialNote` | 器型示意区叠加显示，支持批量改分类 |
| Inspect 质检结论（质检台账） | `src/types/inspect.ts` | `id` `bodyId` `verdict`（合格/返工） `defectNote` `inspector` `date` `defectCoatSeq` `defectRoomId` | 只允许质检室身份（`ACTOR_QC`）写入；返工必须定位道次，未平账时禁止判合格 |
| ReworkAnchor 返工定位（质检台账） | `src/types/rework.ts` | `id`（固定标识 `rwa_*`） `bodyId` `bodyCode` `coatSeq` `status`（active/pendingClaim/hung） `inspectId` `reconfirmed` `settled` | 定位不随调序漂移；调序/撤道→待认领；对账键 `bodyId#seq`，对不上→挂起 |
| MigrateIssue 升级异常 | `src/types/migrateIssue.ts` | `id` `kind` `inspectId` `bodyId` `coatSeq` `reason` `resolved` | v2→v3 补不出固定标识的旧返工单列 |

**领域服务与 saga（`src/services/`）**：`coatService.ts`（工序侧，只事务写 coats）、`inspectService.ts`（质检侧，只事务写 inspects/reworkAnchors/migrateIssues）、`permission.ts`（`ACTOR_QC` / `ACTOR_COAT` / `ACTOR_SYSTEM` 与越权拦截）、`workflow.ts`（判返工登记、调序撤道、逐道重确认、补道对账等跨侧编排：两侧各自独立事务分步提交，失败只补偿/回退本侧并提示重试）。派生判定统一走 `src/utils/reworkView.ts`。

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 **v3**：新增 `reworkAnchors`、`migrateIssues` 两表，`coats` 增加 `reconfirmBy`；Dexie `.upgrade()` 中为每条旧返工质检记录按**当时道次顺序**补 `rwa_<inspectId>` 固定标识（命中道及后序打回挂账），道次序号对不上的写一条 `migrateIssues` 单列。v1→v2 历史迁移（Coat 回填 `paintType` 等）保留。

---

## 六、目录结构

```
sologsb101-1018/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # body.ts coat.ts room.ts polish.ts inlay.ts inspect.ts rework.ts migrateIssue.ts
│   │   ├── services/             # permission.ts coatService.ts inspectService.ts workflow.ts（两摊分账 + saga）
│   │   ├── stores/               # bodyStore.ts coatStore.ts roomStore.ts qcStore.ts
│   │   ├── components/common/    # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
│   │   ├── hooks/                # useCoatProgress.ts useIdbTable.ts
│   │   ├── pages/                # BodyList.tsx CoatBoard.tsx RoomLog.tsx PolishBoard.tsx InlayBoard.tsx QualityRoom.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   ├── utils/                # humidity.ts db.ts export.ts reworkView.ts
│   │   ├── styles/               # main.css
│   │   ├── App.tsx main.tsx
│   ├── scripts/smoke.ts          # 两摊分账 / 迁移 / saga 的运行时冒烟测试（fake-indexeddb + tsx）
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 Zustand store，跨页状态不留在组件内部 `useState`；IndexedDB 读写统一走 `useIdbTable()` 封装；筛选派生逻辑统一走 store 导出的选择器函数。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gblacquer`）**：8 张表 `bodies` / `coats` / `rooms` / `polishes` / `inlays` / `inspects` / `reworkAnchors` / `migrateIssues`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 在首次打开时自动播种**三层互相引用**的演示数据（Body → Coat / Room → Polish / Inlay → Inspect / ReworkAnchor，固定 id 如 `body_01`、`coat_0101`、`rwa_inspect_0102`），播种幂等。
- **localStorage**：仅存元数据 —— `gblacquer:db-version`（本地结构版本）、`gblacquer:last-backup-at`（最近导出时间）、`gblacquer:ui-prefs`（当前选中胎体）。
- **备份**：`/export` 页可导出 JSON（8 张表全量数据 + 结构版本号，旧版 v2 备份导入时自动补 `reconfirmBy` 空列），导入时校验 `app` 字段与各核心集合数组完整性，覆盖导入前二次确认；另有返工清单 TXT（`/qc` 页）与工序台账 CSV。
- **运行时冒烟验证**：`cd frontend && npx tsx scripts/smoke.ts`（需 `fake-indexeddb`，已在开发机验证），覆盖 v2→v3 迁移补标识/异常单列、越权拦截、返工打回与禁判合格、逐道重确认平账、调序退回待认领、挂起与补登自动对账、撤道退回等关键路径。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22818`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gblacquer` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
