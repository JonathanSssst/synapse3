# NOTICE · 第三方来源与改动声明

本仓库同时包含自有代码与派生代码。派生部分**保留原许可与版权声明**。

## 1. qq-bridge（MIT）

- 来源：https://github.com/Derpyu520/qq-bridge
- 原版权：`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`
- 原版本：`v0.2.0-r4`
- 位置：`apps/bridge/`、`packages/dsh-preset/`
- 改动范围（相对上游）：
  - `src/bridge.js`：消息触发策略、社交 v2、黑话学习、贴纸库、语音、记忆与状态系统、token 记账、控制台端点扩展
  - `src/mcp-snowluma-safe.js`：新增 QQ 空间楼中楼/点赞/转发等工具
  - `plugins/qq-agent-presets`、`plugins/qq-mode-console`、`dsh/agent-presets/*`：preset 与工具白名单调整
  - 新增 `src/mcp-pcops.js`、`src/memory-*.js`、`src/vitals-service.js`、`src/activity-log.js`
- 本地路径硬编码已改为经 `packages/paths` 解析（不改变行为）。

## 2. 未随包分发的第三方组件

以下组件**不在本仓库、不在 Release 中**，由用户自行获取安装：

| 组件 | 许可 / 性质 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | 第三方应用 | Agent 运行时，需用户自行安装并登录 |
| SnowLuma | 第三方应用 | OneBot v11 网关，需用户自行安装并扫码 |
| Live2D 模型（whalemaid） | **CC BY-NC-SA 4.0** | 署名 `@ZipZipPipe`；禁商用；仅通过扩展市场由用户主动获取 |

## 3. 内容合规

默认人设正文为本项目原创化改写稿，不含第三方作品的角色设定、台词或美术素材。
用户自行导入的人设与素材，其合规责任由用户承担。
