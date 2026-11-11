# Synapse 3 · 审计面板（3.31.3）

本机只读数据看板：Vue 3 前端 + Node JSON API + Electron 桌面壳。
监听 **127.0.0.1:3120**（不对外），数据来自 `E:\BOT\audit\audit.db`、`E:\BOT\state`、qq-bridge 状态文件与 `E:\BOT` 下的业务文件。

## 结构

```
E:\BOT\panel\
  server.mjs          HTTP 入口：/api/* + 静态托管 /ui/（旧 / → 302 /ui/）
  lib\core.mjs        路径/时间/SQLite/价目表/告警配置/HTTP 小工具
  lib\sources.mjs     只读数据源（token、工具、B站、抖音、空间、表情、生图、记忆、生活…）
  lib\payload.mjs     旧 /api/data 兼容载荷
  lib\records.mjs     统一记录 API（SQL 分页 + 文件类记录 + 详情/关联）
  lib\overview.mjs    /api/overview、/api/costs、/api/health
  lib\actions.mjs     写操作与二进制/文本输出（人设、告警、生图设置、预览）
  lib\static.mjs      /ui 静态资源 + SPA fallback
  restart.ps1         杀 server.mjs 进程并用隐藏 VBS 拉起（自检/排障用）
  panel-hidden.vbs    隐藏启动（计划任务 PanelWatch 每 2 分钟探活自愈）
```

旧版（3.29.1 单文件版、3.26.0 残留、`_page_new.txt`、旧预览图）已于 2026-11-07 结构整理时
移出本目录，归档在 `E:\BOT\archive\panel\3.29.1\`（回滚用；同时可从 git tag `baseline-3.31.3` 取回）。
前端：`E:\BOT\panel-ui`（`npm run build` 输出 `dist`，由后端托管）。桌面端：`E:\BOT\panel-desktop`。

## 常用命令

```powershell
# 重启后端（开发后必做）
powershell -NoProfile -ExecutionPolicy Bypass -File E:\BOT\panel\restart.ps1

# 前端构建（改 panel-ui 后）
cd E:\BOT\panel-ui; npm run build

# 前端开发（代理 /api 到 3120）
cd E:\BOT\panel-ui; npm run dev -- --port 5173

# 桌面端构建 / 运行
cd E:\BOT\panel-desktop; npm run build        # 产出 dist\SynapsePanel.exe
$env:ELECTRON_RUN_AS_NODE=$null; npm start    # 本机环境里有 ELECTRON_RUN_AS_NODE=1，需清掉

# 开机自启
cd E:\BOT\panel-desktop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\status-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
```

## 主要 API

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 版本/DB/UI/内存/运行时长（不做外部请求，给 Electron 探活用） |
| `GET /api/overview?from&to&light=1` | 概览 KPI、告警、7 日趋势、下一件事、运行状态 |
| `GET /api/costs?from&to` | 花费总览、按日/模型/会话、缓存命中、均价、月度预测 |
| `GET /api/records/:type` | 统一列表：`page/pageSize/q/from/to/sort/dir`（SQL 分页） |
| `GET /api/records/:type/:id` | 详情：完整字段 + 原始 JSON + 关联 + 文件 |
| `GET /api/latest` | 各板块最新时间（侧边栏未读黄点） |
| `GET /api/life` `/api/qzone` `/api/album` `/api/memory` | 生活 / 空间 / 相册 / 记忆聚合 |
| `GET /api/data` | 旧版整包（兼容保留） |
| `GET /api/export/{tokens,tools,activity,audit,bili,bilinotes,fs}` | CSV 导出 |
| `GET /api/preview?path=` `/api/media?path=` | 文本预览 / 图片（仅 E:\BOT 与 qq-bridge\personas） |

记录类型：`tool_call` `audit_event` `bili_event` `bili_note` `douyin_event` `qzone_action` `gen_image` `persona` `sticker` `memory_doc` `fs_event` `free_time` `activity`

## 注意

- 只监听 127.0.0.1；不打印/落盘 token、key。
- 时间统一 Asia/Shanghai（库里 UTC，接口同时给 `t` 与 `tLocal`）。
- 本机还有 PanelWatch（2 分钟）与 start-panel.bat（15 秒轮询）两个旧看护，与 Electron 看护并存；杀后端时可能相互抢先拉起，属正常。
- 旧启动器独占 `panel.log` 时 Electron 后端日志回退到 `logs\panel.electron.log`。
