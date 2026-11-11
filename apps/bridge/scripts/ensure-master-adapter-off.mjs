// 主人自己的号不该在网关上暴露 OneBot 适配器。
// 每次拉起 SnowLuma 前，把它的 per-account onebot 配置写成空网络，
// 避免和机器人号的 3000/3001 抢端口。
//
// 号码来源：桥接 config.json 的 ownerQQ（不再写死）。网关目录由 SNOWLUMA_HOME 指定。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.SNOWLUMA_HOME || '';
if (!HOME) {
  console.error('[ensure-master-adapter-off] 缺少 SNOWLUMA_HOME（SnowLuma 安装目录），跳过');
  process.exit(0);
}
const CONFIG_DIR = path.join(HOME, 'config');

let ownerQQ = Number(process.env.OWNER_QQ || 0);
if (!ownerQQ) {
  for (const f of [path.join(HERE, '..', 'config.json'), path.join(HERE, '..', '..', 'config', 'bridge.json')]) {
    try {
      ownerQQ = Number(JSON.parse(fs.readFileSync(f, 'utf8'))?.ownerQQ || 0);
      if (ownerQQ) break;
    } catch {}
  }
}
if (!ownerQQ) {
  console.log('[ensure-master-adapter-off] 未配置 ownerQQ，无需处理');
  process.exit(0);
}

const targets = [`onebot_${ownerQQ}.json`];

for (const name of targets) {
  const file = path.join(CONFIG_DIR, name);
  const data = {
    mode: 'snapshot',
    networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] }
  };
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`[ensure-master-adapter-off] 已清空 ${name} 的 OneBot 网络`);
  } catch (error) {
    console.error(`[ensure-master-adapter-off] 写入失败 ${file}: ${error?.message ?? error}`);
  }
}
