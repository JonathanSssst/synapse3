# 扩展

主包（裸机）只带三件事：**收发消息、主动唤醒、人设与记忆**。B 站、抖音、QQ 空间、联网搜索、电脑助手、读书、生图这些都以**扩展**形式提供——装了才出现在机器人的能力里，卸了就消失。

两套来源：

| 来源 | 代码在哪 | 怎么装 |
|---|---|---|
| **内置扩展**（13 个） | 随程序发布 | 点一下就装，不下载 |
| **远端扩展** | 从扩展市场下载 | 拉索引 → 下载 → 校验 → 解压安装 |

注册表在 `packages/extensions/index.mjs`：`CORE_TOOLS` 是核心工具白名单，`PACKAGES` 是内置扩展清单。**新增工具必须归到其中一处**，否则运行期按「未注册」处理，并且启动日志会点名。

---

## 索引格式（`index.json`）

由独立公开仓 `synapse3-extensions` 维护，本目录的 `index.json` 是内置样本。

```json
{
  "schema": 1,
  "updatedAt": "2026-11-13T00:00:00+08:00",
  "packages": [
    {
      "id": "desktop-pet",
      "name": "桌面宠物",
      "version": "0.1.0",
      "desc": "桌面上养一只会动的她",
      "author": "",
      "tags": ["fun"],
      "download": {
        "url": "https://github.com/<owner>/<repo>/releases/download/v0.1.0/desktop-pet-0.1.0.zip",
        "sha256": "<64 位小写十六进制>",
        "size": 1234567
      }
    }
  ]
}
```

`sha256` **必填**。没有它程序会直接拒绝安装——无法校验的东西不该被执行。

## 扩展包结构

```
desktop-pet-0.1.0.zip
└─ manifest.json         必填，且必须在包根（或唯一的顶层目录里）
   server.mjs            你的 MCP server 入口（相对 manifest 所在目录）
   ...其它文件
```

`manifest.json`：

```json
{
  "id": "desktop-pet",
  "name": "桌面宠物",
  "version": "0.1.0",
  "desc": "桌面上养一只会动的她",
  "mcpServers": [
    {
      "id": "mcp-desktop-pet",
      "serverName": "desktop-pet",
      "script": "server.mjs",
      "toolCallTimeoutMs": 60000
    }
  ]
}
```

- `id` 必须与索引里的 `id` 完全一致，否则拒绝安装
- `mcpServers[].id` 是 DSH 配置里的条目 id，建议加 `mcp-` 前缀避免撞名
- `script` 相对包根目录
- 你的 server 用什么运行时、提供哪些工具，由你自己决定——只要按 MCP 协议走 stdio，宿主的模型就能调用它们

## 声明「什么时候适合做」

扩展不能自己写定时器。想让「刷视频」「发说说」这类事在她空闲时发生，就在包定义里声明活动，
由 `activity-time` 统一调度：

```js
activities: [
  {
    id: 'video-binge',          // 全局唯一
    label: '连着刷会儿视频',     // 给她看的名字
    hint: '用 qq_video_binge。', // 说清「想做的话怎么做」，但不要写成命令
    window: '20:00-23:30',      // 允许的时段，支持跨天（如 23:00-01:00）
    cooldownMin: 300,           // 两次提议之间至少隔多久
    dailyLimit: 1               // 每天最多提议几次（按提议次数算，不是执行次数）
  }
]
```

三条规矩：

1. **只描述能力，不描述指令**。`hint` 写「用 qq_video_binge 可以连着刷」，不要写「现在去刷视频」。
   做不做是她的决定。
2. **日限额按提议次数算**。她每次都拒绝时不该被反复追问。
3. **不给危险能力排活动**。文件读写、命令执行、电脑操作这类，永远只能被动触发。

`activity-time` 自己还带四个基础活动（早安、晚安、自由时间、休息提醒），不依赖任何扩展。

> 当前只有**内置扩展**支持 `activities`。远端扩展的 manifest 里还没有接入这个字段——
> 它的工具能用，但不会被自动安排活动。

## 安装时会发生什么

1. 拉索引（缓存 10 分钟，可手动刷新）
2. 下载 zip（只允许 https + 白名单域名，重定向的每一跳都重新校验）
3. 校验 sha256、`manifest.id`
4. 解压到 `data/extensions/<id>/`，逐条检查路径不越界、不许符号链接、文件数 ≤ 4000、解压后 ≤ 256MB
5. 写安装记录，把它的 MCP server 写进 DSH 的 profile 配置
6. 重启桥接；**DSH 需要用户手动重启一次**才会读到新 server

卸载：从 DSH 配置移除该条目、删掉 `data/extensions/<id>/`、删安装记录。你自己配的 MCP 不会被碰——程序只删它认得 id 的条目（账本在 `data/extensions.json` 的 `knownMcpIds`）。

## 收录要求

- 附 `LICENSE` 与第三方素材署名
- 不得内置任何密钥、个人聊天记录或人设记忆
- 不得读写宿主的 `config/`、`data/` 之外的用户文件
- 需要额外费用的能力（如生图）必须在 `desc` 里写明

## 还没做的

这些在早期方案里提过，当前版本**没有实现**，别按它们写包：

- `type: service` / `type: window` 两种运行形态（扩展目前只能是 MCP server）
- 声明式权限系统（`permissions` 字段）
- 扩展版本原地升级（现在是卸了重装）
- 扩展包代码签名（只有 sha256 校验，索引仓被攻破时拦不住）
