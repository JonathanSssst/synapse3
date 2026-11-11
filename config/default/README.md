# 配置模板（出厂默认）

本目录只放**模板**，文件名统一 `<name>.example.json`；用户实例在安装根的 `config\` 下，不进仓库。

## 规划中的模板

| 模板 | 来源 | 说明 |
| --- | --- | --- |
| `bridge.example.json` | `qq-bridge/config.example.json` | 桥接主配置（P1 迁入，去掉本机绝对路径与个人 QQ） |
| `panel.example.json` | `panel/alerts.json` + 面板设置 | 面板告警阈值、端口 |
| `cost-guard.example.json` | `audit/cost-guard.json` | 成本阈值（注意：与运行时 `cost-guard-state.json` 同名不同义，P2 改名） |
| `qzone.example.json` | `qzone/config.json` | 空间助手 |
| `imagegen.example.json` | `imagegen/config.json` | 生图（key 由用户填，不含出厂值） |

## 硬规则

1. **模板里不得有任何真实密钥、token、QQ 号、群号。**
2. **不得出现绝对路径**：一律写成相对 `SYNAPSE_HOME` 的形式，由 `packages/paths` 解析。
3. 首启向导把模板复制成实例后，必须立即收紧 ACL（仅当前用户 + SYSTEM）。
4. 升级时**不覆盖**已有实例，只在字段新增时做合并。
