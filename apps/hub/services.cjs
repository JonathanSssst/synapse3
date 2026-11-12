// services.cjs · 进程编排
//
// 只有这里能起停子进程。P2 之后，原先 4 条看守 + 12 个计划任务全部由它取代。
//
// 设计要点：
// 1. 外部服务（DSH / SnowLuma）只探测、不代管 —— 它们是第三方程序，生命周期归用户。
// 2. 托管服务崩溃后退避重启；连续失败 5 次进入 needsHuman，不再无限拉起
//    （旧看守互相抢着拉起，正是 EADDRINUSE 的成因）。
// 3. Node 运行时优先用随包的 runtime/node.exe，开发期回落到 PATH 里的 node。

const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

let P = null;
async function paths() {
  if (!P) P = await import('../../packages/paths/index.mjs');
  return P;
}

function nodeExe() {
  if (process.env.SYNAPSE_NODE) return process.env.SYNAPSE_NODE;
  const bundled = path.resolve(__dirname, '..', '..', 'runtime', 'node.exe');
  try { if (fs.existsSync(bundled)) return bundled; } catch {}
  return process.platform === 'win32' ? 'node.exe' : 'node';
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
      { id: 'dsh', name: 'DSH 运行时', kind: 'external', port: 1918, desc: '第三方 Agent 运行时，只探测' },
      { id: 'snowluma', name: 'SnowLuma 网关', kind: 'external', port: 3000, desc: 'OneBot v11 网关，只探测' }
    ];
    for (const d of this.defs) this.state.set(d.id, { status: 'unknown', restarts: 0 });
    return this.defs;
  }

  async refresh() {
    for (const d of this.defs) {
      const st = this.state.get(d.id) || {};
      if (d.kind === 'external') {
        st.status = (await probe(d.port)) ? 'up' : 'down';
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
