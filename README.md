# Synapse 3

把 QQ 变成一个「有记忆、有生活、能自己决定回不回」的 AI 角色，并给它一个能看住所有动作的控制台。

> **状态：结构整改中（P0）。** 当前仓库只有骨架与规范，可运行代码将在 P1/P2 迁入。
> 现网实例仍在 `E:\BOT` 与 DSH 工作区的 `qq-bridge` 目录中运行，本仓库尚未接管。

## 它由什么组成

```
QQ 客户端
   │
SnowLuma（OneBot v11 网关）
   │
qq-bridge（触发策略 / 分条 / 审计 / 控制台）
   │
DeepSeek Harness（Agent 运行时：会话、工具、审批）
   │
MCP 工具集（38 个 qq_* 工具）
   │
回到 QQ
```

旁路：面板（只读数据看板）、审计库、QQ 空间、扩展包。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/hub` | 总控台，打包为 `SynapseHub.exe`（进程编排、审批中心、配置、备份） |
| `apps/bridge` | QQ 桥接（派生自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT） |
| `apps/panel-server` `apps/panel-ui` | 数据面板后端与前端 |
| `apps/qzone` `apps/audit-jobs` `apps/tools` | 空间助手、审计任务、内容采集 |
| `packages/paths` | 统一路径解析（`SYNAPSE_HOME`），全仓唯一真源 |
| `packages/policy` | 审批策略引擎，所有写操作的唯一闸门 |
| `packages/llm-adapter` | 模型侧接口层（DSH / OpenAI 兼容端点） |
| `extensions` | 扩展市场索引与骨架 |
| `docs` | 方案、规范、交接文档 |

## 相关仓库

| 仓库 | 可见性 | 用途 |
| --- | --- | --- |
| `synapse3` | 公开 | 源码（本仓） |
| `synapse3-data` | 私有 | 人设成品、记忆、配置实例 |
| `synapse3-extensions` | 公开 | 扩展索引与扩展包 Release |

## 运行前提

本程序**不打包、不镜像**第三方组件，需要用户自行安装：

- **DeepSeek Harness**（Agent 运行时，需登录账号）
- **SnowLuma** 或其他 OneBot v11 网关（需扫码登录 QQ）

首次启动向导会检测两者并引导配置。

## 快速开始（源码运行）

```bash
# 1) 面板前端（发版必需，开发期可选）
cd apps/panel-ui && npm ci && npm run build

# 2) 总控台
cd apps/hub && npm ci
start.cmd            # Windows：双击或执行，会自动清掉 ELECTRON_RUN_AS_NODE

# 3) 自检
node scripts/check-boundaries.mjs      # 边界：硬编码 / 个人信息 / 密钥
node tests/paths.test.mjs              # 路径解析（legacy 与 v2 双布局）
node tests/policy.test.mjs             # 审批策略
```

**两个容易卡住的点**

| 现象 | 原因 | 处理 |
|---|---|---|
| Electron 下载卡住 / `dist` 为空 | postinstall 从 GitHub 拉二进制 | `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重装 |
| `npm start` 不弹窗，报 `ipcMain is undefined` | 环境里有 `ELECTRON_RUN_AS_NODE`，Electron 会以 Node 模式启动；设成空串也无效（底层用 getenv 判断） | 用 `start.cmd`，它会真正删掉这个变量 |

打包：`node scripts/build-hub.mjs --with-deps` 之后 `cd apps/hub && npm run build`。
若 electron-builder 卡在下载工具，加 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 状态与待决

- 阶段进度与验收证据：`docs/工作交接-20261112-P1-P4.md`
- 需要拍板的事项：`DECISIONS.md`

## 许可

本项目代码以 MIT 发布，见 `LICENSE`。`apps/bridge` 与 `packages/dsh-preset` 派生自
`Derpyu520/qq-bridge`（MIT），原版权与改动范围见 `NOTICE.md`。

**不含**：任何第三方应用二进制、Live2D 模型、个人人设与聊天记忆。
