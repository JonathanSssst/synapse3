# 扩展市场

主包只带核心（QQ 桥接 + 面板 + 审计）。桌宠、视频通话、生图等以**扩展包**形式从市场安装。

## 索引

由独立公开仓 `synapse3-extensions` 维护，根目录 `index.json`（schema 1）。
本目录下的 `index.json` 是**开发期内置样本**，正式版本运行时优先拉远端索引，失败回落内置。

```json
{
  "schema": 1,
  "packages": [{
    "id": "video-call",
    "name": "视频通话",
    "version": "0.1.0",
    "type": "service",
    "minCore": "3.33.0",
    "desc": "Live2D 视频通话（需 ASR + TTS）",
    "assets": { "url": "https://…/video-call-0.1.0.zip", "sha256": "…", "size": 1234567 },
    "ports": [3130],
    "dataDir": "video-call",
    "permissions": ["net.local", "fs.data"]
  }]
}
```

## 扩展包结构

```
<id>-<version>.zip
├─ ext.manifest.json     必填
├─ main.cjs / main.mjs   type=window 时的 Electron 入口
├─ server.mjs            type=service 时的服务入口
└─ web\                  （可选）前端静态资源
```

`ext.manifest.json`：

```json
{
  "id": "desktop-pet",
  "version": "0.1.0",
  "type": "window",
  "entry": "main.cjs",
  "minCore": "3.33.0",
  "ports": [],
  "permissions": ["fs.data", "screen.capture"],
  "requires": ["dsh"]
}
```

## 类型

| type | 运行方式 | 例子 |
| --- | --- | --- |
| `service` | Hub 用内置 `node.exe` 拉起，绑定 3140+ 端口 | video-call、imagegen |
| `window` | Hub 用同一 Electron 二进制以 `--module=<id>` 启动独立窗口 | desktop-pet |

## 安装与安全

1. 拉索引（缓存 24 h）→ 列表 → 用户点击安装。
2. 下载 → **校验 sha256** → 解压到 `app\ext\<id>\<version>\`（不覆盖运行中版本）。
3. 权限声明制：默认**禁止**读 `config\secrets`，禁止写其他扩展目录。
4. 首次启用弹风险确认（第三方可执行代码）。
5. 支持本地 zip / Git URL 手动安装（开发模式，界面打红标）。

## 收录要求

- 附 `LICENSE` 与第三方素材署名（如 Live2D 的 CC BY-NC-SA 需署名原作者、禁商用）。
- 不得内置任何密钥、个人聊天记录或人设记忆。
- 不得修改宿主 `config\secrets`。
