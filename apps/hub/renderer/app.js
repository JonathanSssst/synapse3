// 渲染层：只做展示与转发，所有动作都经 preload → IPC → 主进程。
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const STATE = { services: [], pending: [], tab: 'services', logFilter: '' };

function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function switchTab(tab) {
  STATE.tab = tab;
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => s.classList.add('hidden'));
  $(`#tab-${tab}`).classList.remove('hidden');
  if (tab === 'approvals') refreshPending();
  if (tab === 'checkup') refreshCheck();
  if (tab === 'logs') refreshLogs();
}

// ── 服务 ───────────────────────────────────────────────────────────────────
const STATUS_TEXT = { up: '运行中', down: '未运行', starting: '启动中', needsHuman: '需人工处理', unknown: '未知' };

function renderServices(list) {
  STATE.services = list;
  const box = $('#svc-list');
  box.innerHTML = '';
  for (const s of list) {
    const el = document.createElement('div');
    el.className = 'svc';
    const meta = [];
    if (s.port) meta.push(`:${s.port}`);
    if (s.pid) meta.push(`pid ${s.pid}`);
    if (s.restarts) meta.push(`重启 ${s.restarts} 次`);
    if (s.error) meta.push(s.error);

    el.innerHTML = `
      <span class="dot ${s.status}"></span>
      <div>
        <div class="svc-name">${s.name}</div>
        <div class="svc-desc">${s.desc || ''}</div>
      </div>
      <div class="svc-meta">${STATUS_TEXT[s.status] || s.status}<br>${meta.join(' · ')}</div>
      <div class="svc-actions"></div>`;

    const acts = el.querySelector('.svc-actions');
    if (s.kind === 'external') {
      acts.innerHTML = `<span class="svc-desc">第三方</span>`;
    } else {
      const bStart = document.createElement('button');
      bStart.className = 'btn primary'; bStart.textContent = '启动';
      bStart.disabled = s.status === 'up' || s.status === 'starting';
      bStart.onclick = () => act('start', s, bStart);
      const bStop = document.createElement('button');
      bStop.className = 'btn danger'; bStop.textContent = '停止';
      bStop.disabled = s.status !== 'up' && s.status !== 'starting';
      bStop.onclick = () => act('stop', s, bStop);
      const bRe = document.createElement('button');
      bRe.className = 'btn'; bRe.textContent = '重启';
      bRe.onclick = () => act('restart', s, bRe);
      acts.append(bStart, bStop, bRe);
    }
    box.appendChild(el);
  }
}

async function act(kind, svc, btn) {
  btn.disabled = true;
  try {
    await window.hub[kind](svc.id);
    toast(`${svc.name}：${kind === 'start' ? '已启动' : kind === 'stop' ? '已停止' : '已重启'}`);
  } catch (e) {
    toast(`失败：${e.message || e}`);
  } finally {
    setTimeout(refreshServices, 600);
  }
}

async function refreshServices() {
  try { renderServices(await window.hub.services()); } catch (e) { /* 忽略轮询错误 */ }
}

// ── 审批 ───────────────────────────────────────────────────────────────────
async function refreshPending() {
  let res;
  try { res = await window.hub.pending(); } catch (e) { res = { offline: true, error: e.message, pending: [] }; }
  STATE.pending = res.pending || [];

  const badge = $('#badge');
  if (STATE.pending.length) { badge.textContent = STATE.pending.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const box = $('#pending-list');
  box.innerHTML = '';
  $('#pending-empty').classList.toggle('hidden', STATE.pending.length > 0 || res.offline);

  if (res.offline) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = `读不到挂起队列：${res.error || '桥接未运行'}。桥接启动后才会有待审批项。`;
    box.appendChild(el);
    return;
  }

  for (const p of STATE.pending) {
    const el = document.createElement('div');
    el.className = `pending ${p.kind}`;
    const title = p.kind === 'approval' ? `工具请求：${p.toolName || '未知工具'}` : '向你提问';
    const body = p.kind === 'approval'
      ? (p.reason || '（无说明）')
      : (Array.isArray(p.questions) ? p.questions.map((q) => q.text || q.prompt || JSON.stringify(q)).join('\n') : '（无内容）');
    el.innerHTML = `
      <div class="kind">${p.kind === 'approval' ? '审批' : '提问'}</div>
      <div class="title">${escapeHtml(title)}</div>
      <div class="reason">${escapeHtml(body)}</div>
      <div class="key">${escapeHtml(p.key)}</div>
      <div class="acts"></div>`;
    const acts = el.querySelector('.acts');

    if (p.kind === 'approval') {
      const yes = document.createElement('button');
      yes.className = 'btn primary'; yes.textContent = '通过';
      yes.onclick = () => answer(p, '通过', yes);
      const no = document.createElement('button');
      no.className = 'btn danger'; no.textContent = '拒绝';
      no.onclick = () => answer(p, '拒绝', no);
      acts.append(yes, no);
    } else {
      const input = document.createElement('input');
      input.type = 'text'; input.placeholder = '输入回答后回车';
      input.onkeydown = (e) => { if (e.key === 'Enter') answer(p, input.value.trim(), input); };
      const send = document.createElement('button');
      send.className = 'btn primary'; send.textContent = '提交';
      send.onclick = () => answer(p, input.value.trim(), send);
      acts.append(input, send);
    }
    box.appendChild(el);
  }
}

async function answer(p, text, ctl) {
  if (!text) { toast('内容不能为空'); return; }
  ctl.disabled = true;
  try {
    await window.hub.answer(p.key, text);
    toast('已提交');
    setTimeout(refreshPending, 400);
  } catch (e) {
    toast(`提交失败：${e.message || e}`);
    ctl.disabled = false;
  }
}

// ── 体检 ───────────────────────────────────────────────────────────────────
async function refreshCheck() {
  const box = $('#check-list');
  let res;
  try { res = await window.hub.firstrun(); } catch (e) { box.textContent = e.message; return; }
  box.innerHTML = '';
  for (const it of res.items) {
    const el = document.createElement('div');
    el.className = 'check';
    el.innerHTML = `
      <div class="flag ${it.ok ? 'ok' : 'bad'}">${it.ok ? '✓' : '!'}</div>
      <div class="name">${escapeHtml(it.name)}</div>
      <div>
        <div class="detail">${escapeHtml(it.detail || '')}</div>
        ${it.hint ? `<div class="hint">${escapeHtml(it.hint)}</div>` : ''}
      </div>`;
    box.appendChild(el);
  }
  if (!res.ready) {
    const warn = document.createElement('div');
    warn.className = 'empty';
    warn.textContent = `还差：${res.blocking.join('、')}。补齐后才能正常收发消息。`;
    box.appendChild(warn);
  }
}

// ── 日志 ───────────────────────────────────────────────────────────────────
function renderLogLine(l) {
  const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
  const cls = l.stream === 'err' ? 'err' : '';
  return `<span class="t">${t}</span> <span class="id">[${l.id}]</span> <span class="${cls}">${escapeHtml(l.line)}</span>`;
}

async function refreshLogs() {
  const data = await window.hub.logs({ id: STATE.logFilter || undefined });
  const box = $('#log-box');
  box.innerHTML = data.map(renderLogLine).join('\n');
  box.scrollTop = box.scrollHeight;
}

function appendLog(l) {
  if (STATE.tab !== 'logs') return;
  if (STATE.logFilter && l.id !== STATE.logFilter) return;
  const box = $('#log-box');
  box.insertAdjacentHTML('beforeend', (box.innerHTML ? '\n' : '') + renderLogLine(l));
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 绑定 ───────────────────────────────────────────────────────────────────
$$('.nav').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#log-filter').addEventListener('change', (e) => { STATE.logFilter = e.target.value; refreshLogs(); });
$('#log-clear').addEventListener('click', () => { $('#log-box').innerHTML = ''; });
$('#open-panel').addEventListener('click', () => window.hub.openPanel().catch((e) => toast(e.message)));
$('#reveal-data').addEventListener('click', () => window.hub.reveal('data').catch((e) => toast(e.message)));

window.hub.onServices((list) => renderServices(list));
window.hub.onLog(appendLog);

(async function boot() {
  switchTab('services');
  await refreshServices();
  try {
    const p = await window.hub.paths();
    $('#path-line').textContent = `${p.home} · ${p.layout === 'v2' ? '新布局' : '旧布局'}`;
  } catch {}
  refreshPending();
  setInterval(() => { if (STATE.tab !== 'services') refreshPending(); }, 5000);
})();
