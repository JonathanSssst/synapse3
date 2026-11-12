// services.cjs · 进程编排
//
// 只有这里能起停子进程。P2 之后，原先 4 条看守 + 12 个计划任务全部由它取代。
//
// 设计要点：
// 1. 外部服务（DSH / SnowLuma）只探测、不代管 —— 它们是第三方程序，生命周期归用户。
// 2. 托管服务崩溃后退避重启；连续失败 5 次进入 needsHuman，不再无限拉起
//    （旧看守互相抢着拉起，正是 EADDRINUSE 的成因）。
// 3. Node 运行时优先用随包的 runtime/node.exe，开发期回落到 PATH 里的 node。

const { spawn, execFileSync, execFile } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { loadPaths, runtimeNode } = require('./resolve-packages.cjs');

let P = null;
async function paths() {
  if (!P) P = await loadPaths();
  return P;
}

function nodeExe() {
  // 路径差异与 packages 同源：源码在 <repo>/runtime，打包后在 resources/runtime。
  return runtimeNode();
}

function probe(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeout, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

/**
 * 「端口开着但进程卡死」是真实发生过的故障：SnowLuma 曾经 CPU 满载近 4 小时，
 * 3000/3001 依然 LISTENING，但一个请求都不处理（事件循环被堵死）。
 * 纯 TCP 探测会把这种状态报成「运行中」，正好掩盖故障，所以要对关键服务做**深层探测**。
 */
async function httpJson(url, { method = 'GET', token, body, timeout = 3000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 从桥接配置读 SnowLuma 的 HTTP 地址与 token（OneBot 鉴权用） */
async function snowLumaEndpoint() {
  try {
    const p = await paths();
    const cfg = JSON.parse(fs.readFileSync(path.join(p.CONFIG, 'bridge.json'), 'utf8'));
    return {
      httpUrl: cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000',
      token: cfg?.snowluma?.accessToken || ''
    };
  } catch {
    return { httpUrl: 'http://127.0.0.1:3000', token: '' };
  }
}

/**
 * DSH 桌面版的 API 端口每次启动都变，所以交给 scripts/detect-dsh.mjs 统一判定
 * （按 `dsh web authentication required` 指纹扫描回环端口），避免两处各写一套逻辑。
 */
function detectDsh() {
  return new Promise((resolve) => {
    const script = path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'detect-dsh.mjs');
    if (!fs.existsSync(script)) return resolve(null);
    execFile(process.execPath, [script, '--json'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(String(stdout));
        resolve(j?.baseUrl || null);
      } catch { resolve(null); }
    });
  });
}


const MAX_RESTARTS = 5;

class Supervisor {
  constructor({ onLog } = {}) {
    this.children = new Map();  // id -> { child, startedAt, stopping }
    this.state = new Map();     // id -> { status, pid, since, restarts, error }
    this.restarts = new Map();  // id -> 连续失败次数
    this.onLog = onLog || (() => {});
    this.defs = null;
  }

  async init() {
    const p = await paths();
    this.defs = [
      {
        id: 'bridge', name: 'QQ 桥接', kind: 'managed', port: 3100, healthPath: '/api/status',
        cwd: p.BRIDGE_ROOT, entry: path.join(p.BRIDGE_ROOT, 'src', 'bridge.js'),
        desc: 'QQ ↔ DSH 消息主循环 + 控制台'
      },
      {
        id: 'panel', name: '数据面板', kind: 'managed', port: 3120, healthPath: '/api/health',
        cwd: p.PANEL_ROOT, entry: path.join(p.PANEL_ROOT, 'server.mjs'),
        desc: '只读看板（审计库 / 人设 / 成本）'
      },
      {
        id: 'qzone', name: 'QQ 空间', kind: 'managed', port: 0, healthPath: '',
        cwd: p.QZONE_ROOT, entry: path.join(p.QZONE_ROOT, 'qzone-bot.mjs'),
        pidFile: path.join(p.QZONE_DATA, 'qzone-bot.pid'),
        desc: '定时说说 + 评论回复（无常驻端口）'
      },
      { id: 'dsh', name: 'DSH 运行时', kind: 'external', port: 0, desc: '第三方 Agent 运行时；端口每次启动都变，由 detect-dsh 指纹探测' },
      { id: 'snowluma', name: 'SnowLuma 网关', kind: 'external', port: 3000, desc: 'OneBot v11 网关，只探测' }
    ];
    for (const d of this.defs) this.state.set(d.id, { status: 'unknown', restarts: 0 });
    return this.defs;
  }

  async refresh() {
    for (const d of this.defs) {
      const st = this.state.get(d.id) || {};
      if (d.kind === 'external') {
        if (d.id === 'snowluma') {
          // 深层探测：端口在 ≠ 能用。卡死时 TCP 依然连得上，但 /get_status 没响应。
          const tcp = await probe(d.port);
          if (!tcp) {
            st.status = 'down';
            st.detail = '端口未监听（进程没起或已退出）';
          } else {
            const { httpUrl, token } = await snowLumaEndpoint();
            const r = await httpJson(`${httpUrl.replace(/\/$/, '')}/get_status`, { method: 'POST', token, body: {}, timeout: 3000 });
            if (!r.ok) {
              st.status = 'hung';
              st.detail = `端口在但接口无响应（${r.error || `HTTP ${r.status}`}）——事件循环多半卡死了，需重启`;
            } else if (r.data?.data?.online === false) {
              st.status = 'degraded';
              st.detail = '网关在线，但机器人号已离线（去 WebUI 重新登录）';
            } else {
              st.status = 'up';
              st.detail = r.data?.data?.good === false ? '在线（连接质量异常）' : '在线';
            }
          }
        } else if (d.id === 'dsh') {
          const found = await detectDsh();
          st.status = found ? 'up' : 'down';
          st.detail = found ? `API ${found}` : '未发现 DSH 实例（未启动或端口未开放）';
        } else {
          st.status = (await probe(d.port)) ? 'up' : 'down';
        }
      } else if (d.port) {
        const up = await probe(d.port);
        st.status = up ? 'up' : (this.children.has(d.id) ? 'starting' : 'down');
      } else {
        // 无端口服务（qzone）用 pid 文件 + 进程存活判断，避免"明明在跑却显示未运行"
        let alive = false;
        if (this.children.has(d.id)) alive = true;
        else if (d.pidFile) {
          try {
            const pid = Number(fs.readFileSync(d.pidFile, 'utf8').trim());
            if (pid > 0) {
              // 用 signal 0 探活：不依赖 tasklist（中文系统下输出是 GBK，解析不可靠）
              try { process.kill(pid, 0); alive = true; }
              catch (e) { alive = e.code === 'EPERM'; }
            }
          } catch {}
        }
        st.status = alive ? 'up' : 'down';
      }
      const rec = this.children.get(d.id);
      st.pid = rec?.child?.pid ?? null;
      st.since = rec?.startedAt ?? null;
      st.restarts = this.restarts.get(d.id) ?? 0;
      this.state.set(d.id, st);
    }
    return this.snapshot();
  }

  snapshot() {
    return this.defs.map((d) => ({ ...d, ...(this.state.get(d.id) || {}) }));
  }

  // 开机自启进来时拉起"必须在线上"的服务。只挑 bridge / panel：
  // qzone 是定时发说说的，用户不一定希望每次开机就自动往外发内容。
  // 先 refresh 是为了尊重"已经在跑"的实例 —— 重复起会撞端口。
  async startAutos() {
    const snap = await this.refresh();
    for (const d of snap) {
      if (!['bridge', 'panel'].includes(d.id)) continue;
      if (d.status === 'up' || d.status === 'starting') continue;
      try {
        this.start(d.id, { auto: true });
      } catch (e) {
        this.onLog({ id: 'hub', stream: 'err', line: `自启 ${d.name} 失败：${e.message}` });
      }
    }
    return this.snapshot();
  }

  start(id, { auto = false } = {}) {
    const d = this.defs.find((x) => x.id === id);
    if (!d) throw new Error(`未知服务 ${id}`);
    if (d.kind === 'external') throw new Error(`${d.name} 是第三方程序，请手动启动`);
    if (this.children.has(id)) return { ok: true, already: true };
    if (!fs.existsSync(d.entry)) throw new Error(`入口不存在：${d.entry}`);
    if (!auto) this.restarts.set(id, 0);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(nodeExe(), [d.entry], {
      cwd: d.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false
    });
    const rec = { child, startedAt: Date.now(), stopping: false };
    this.children.set(id, rec);
    this.state.set(id, { status: 'starting', pid: child.pid, since: rec.startedAt, restarts: this.restarts.get(id) ?? 0 });
    this.onLog({ id, stream: 'hub', line: `启动 ${d.name}（pid ${child.pid}）` });

    const pipe = (stream) => (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.onLog({ id, stream, line });
      }
    };
    child.stdout.on('data', pipe('out'));
    child.stderr.on('data', pipe('err'));

    child.on('exit', (code, signal) => {
      const stopping = rec.stopping;
      this.children.delete(id);
      this.state.set(id, { status: 'down', pid: null, since: null, restarts: this.restarts.get(id) ?? 0, error: `exit ${code ?? signal}` });
      this.onLog({ id, stream: 'hub', line: `退出（${code ?? signal}）` });
      if (stopping) return;

      const attempts = (this.restarts.get(id) || 0) + 1;
      this.restarts.set(id, attempts);
      if (attempts > MAX_RESTARTS) {
        this.state.set(id, { status: 'needsHuman', pid: null, restarts: attempts, error: `连续失败 ${attempts} 次，已停止自动重启` });
        this.onLog({ id, stream: 'hub', line: `连续失败 ${attempts} 次：停止自动重启，等待人工处理` });
        return;
      }
      const delay = Math.min(30000, 2000 * Math.pow(2, attempts - 1));
      this.onLog({ id, stream: 'hub', line: `${Math.round(delay / 1000)} 秒后自动重启（第 ${attempts}/${MAX_RESTARTS} 次）` });
      setTimeout(() => {
        if (this.children.has(id)) return;
        try { this.start(id, { auto: true }); } catch (e) { this.onLog({ id, stream: 'hub', line: `重启失败：${e.message}` }); }
      }, delay);
    });

    return { ok: true, pid: child.pid };
  }

  stop(id) {
    const d = this.defs.find((x) => x.id === id);
    if (!d) throw new Error(`未知服务 ${id}`);
    if (d.kind === 'external') throw new Error(`${d.name} 由用户自行管理`);
    const rec = this.children.get(id);
    if (!rec) return { ok: true, already: true };
    rec.stopping = true;
    const pid = rec.child.pid;
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch {}
    this.children.delete(id);
    this.restarts.set(id, 0);
    this.state.set(id, { status: 'down', pid: null, since: null, restarts: 0 });
    this.onLog({ id, stream: 'hub', line: `已停止（pid ${pid}）` });
    return { ok: true };
  }

  restart(id) {
    this.stop(id);
    return this.start(id);
  }

  stopAll() {
    for (const id of [...this.children.keys()]) {
      try { this.stop(id); } catch {}
    }
  }
}

module.exports = { Supervisor, probe, nodeExe, MAX_RESTARTS };
