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
  if (tab === 'setup') { refreshSetup(); refreshCheck(); }
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

// ── 配置向导 ───────────────────────────────────────────────────────────────
// 字段定义、校验、落盘全在主进程（firstrun.cjs）；这里只负责把 spec 画成表单、
// 把用户填的值原样交回去。校验结果的 key 与 input 的 data-key 对应。

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fieldEl(f, value) {
  const id = `fld-${f.key}`;
  const el = document.createElement('div');
  el.className = 'field';
  el.innerHTML = `
    <div class="flabel">${escapeHtml(f.label)}${f.required ? '<span class="req">必填</span>' : ''}</div>
    <div class="frow">
      <input id="${id}" data-key="${escapeAttr(f.key)}"
             type="${f.type === 'secret' ? 'password' : 'text'}"
             value="${escapeAttr(value)}"
             placeholder="${escapeAttr(f.placeholder || '')}"
             spellcheck="false" autocomplete="off" />
      ${f.detect === 'dsh' ? '<button type="button" class="ghost mini" data-detect="dsh">自动探测</button>' : ''}
      ${f.type === 'secret' ? `<button type="button" class="ghost mini" data-reveal="${id}">显示</button>` : ''}
    </div>
    ${f.hint ? `<div class="fhint">${escapeHtml(f.hint)}</div>` : ''}
    <div class="ferr" data-err="${escapeAttr(f.key)}"></div>`;
  return el;
}

function renderForm(data) {
  STATE.form = data;
  const box = $('#setup-form');
  box.innerHTML = '';
  for (const g of data.groups) {
    const sec = document.createElement('section');
    sec.className = 'fgroup';
    const head = document.createElement('div');
    head.className = 'fg-head';
    head.innerHTML = `<div class="fg-title">${escapeHtml(g.title)}</div><div class="fg-desc">${escapeHtml(g.desc)}</div>`;
    sec.appendChild(head);
    for (const f of g.fields) sec.appendChild(fieldEl(f, data.values[f.key] ?? ''));
    box.appendChild(sec);
  }
  $('#setup-path').textContent = data.configPath ? `写入：${data.configPath}` : '';
}

function collectForm() {
  const out = {};
  $$('#setup-form input[data-key]').forEach((el) => { out[el.dataset.key] = el.value; });
  return out;
}

function clearFormErrors() {
  $$('#setup-form .ferr').forEach((el) => { el.textContent = ''; });
  $$('#setup-form input').forEach((el) => el.classList.remove('bad'));
}

function showFormErrors(errors) {
  for (const [key, msg] of Object.entries(errors || {})) {
    const box = $(`#setup-form .ferr[data-err="${key}"]`);
    if (box) box.textContent = msg;
    const inp = $(`#setup-form input[data-key="${key}"]`);
    if (inp) inp.classList.add('bad');
  }
  const first = $('#setup-form input.bad');
  if (first) first.focus();
}

function setBanner(text, kind) {
  const el = $('#setup-banner');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  el.className = `banner ${kind || 'warn'}`;
}

async function refreshSetup() {
  let data;
  try { data = await window.hub.configForm(); }
  catch (e) { setBanner(`读取配置失败：${e.message || e}`, 'bad'); return; }
  renderForm(data);
  setBanner(data.needsSetup
    ? '还差关键配置：把第 1 步填完，机器人才能认出你。'
    : '', data.needsSetup ? 'warn' : '');
}

async function saveSetup() {
  const btn = $('#setup-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  clearFormErrors();
  try {
    const res = await window.hub.configSave(collectForm());
    if (!res || !res.ok) {
      showFormErrors(res && res.errors);
      toast('还有几项要改');
      return;
    }
    setBanner((res.warnings || []).join('；'), res.warnings && res.warnings.length ? 'warn' : '');
    if (!res.changed) { toast('没有变化'); return; }

    // 配置是启动时读的，不重启桥接等于白改。
    // 坑在于：桥接可能是用户自己从旧目录起的（不归本程序托管）。
    // 这时 restart 会「成功」拉起一个新进程，但新进程撞端口自己退了，
    // 端口仍被旧进程占着 —— 配置根本没生效。所以要回头看一眼究竟谁在服务。
    try {
      await window.hub.restart('bridge');
      await new Promise((r) => setTimeout(r, 2500));
      const snap = await window.hub.services();
      const b = (snap || []).find((s) => s.id === 'bridge');
      if (b && b.status === 'up' && !b.pid) {
        toast('已保存。但桥接是外部启动的，得手动重启它才会用上新配置');
      } else {
        toast('已保存，桥接已重启');
      }
    } catch (e) {
      toast(`已保存，但桥接没重启：${e.message || e}（手动重启一次才会生效）`);
    }
    refreshCheck();
  } catch (e) {
    toast(`保存失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function detectDshFromForm(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '探测中…';
  try {
    const r = await window.hub.detectDsh();
    const inp = $('#fld-dshBaseUrl');
    if (r && r.baseUrl) {
      if (inp) inp.value = r.baseUrl;
      toast(`找到了：${r.baseUrl}`);
    } else {
      toast('没找到在跑的 DSH，先把它启动起来再点一次');
    }
  } catch (e) {
    toast(`探测失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
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

// ── 开机自启 ───────────────────────────────────────────────────────────────
// 只是把系统登录项写/删掉，真正的"自启后干什么"在主进程（--autostart → 只进托盘 + 拉起服务）。
async function loadAutoStart() {
  const box = $('#autostart');
  const row = $('#autostart-row');
  try {
    const st = await window.hub.autostart();
    if (!st.supported) {
      row.classList.add('off');
      row.title = '当前系统不支持由本程序设置开机自启';
      box.disabled = true;
      return;
    }
    box.checked = Boolean(st.enabled);
    if (st.exe) row.title = `开机启动项：${st.exe}`;
  } catch (e) {
    row.classList.add('off');
    row.title = `读取开机自启状态失败：${e.message || e}`;
  }
}

async function toggleAutoStart(on) {
  const box = $('#autostart');
  box.disabled = true;
  try {
    const st = await window.hub.autostart(Boolean(on));
    box.checked = Boolean(st.enabled);
    toast(st.enabled ? '已开启：下次开机自动在后台运行' : '已关闭：下次开机需手动打开');
  } catch (e) {
    box.checked = !on;
    toast(`设置失败：${e.message || e}`);
  } finally {
    box.disabled = false;
  }
}

// ── 绑定 ───────────────────────────────────────────────────────────────────
$$('.nav').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#log-filter').addEventListener('change', (e) => { STATE.logFilter = e.target.value; refreshLogs(); });
$('#log-clear').addEventListener('click', () => { $('#log-box').innerHTML = ''; });
$('#open-panel').addEventListener('click', () => window.hub.openPanel().catch((e) => toast(e.message)));
$('#reveal-data').addEventListener('click', () => window.hub.reveal('data').catch((e) => toast(e.message)));
$('#autostart').addEventListener('change', (e) => toggleAutoStart(e.target.checked));
$('#setup-save').addEventListener('click', saveSetup);
$('#setup-form').addEventListener('click', (e) => {
  const det = e.target.closest('[data-detect]');
  if (det) { detectDshFromForm(det); return; }
  const rev = e.target.closest('[data-reveal]');
  if (rev) {
    const inp = document.getElementById(rev.dataset.reveal);
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    rev.textContent = inp.type === 'password' ? '显示' : '隐藏';
  }
});

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
  loadAutoStart();
  // 配置还没成形就直接把人领到配置页 —— 让他对着空白服务列表发懵没意义
  try {
    const f = await window.hub.configForm();
    if (f.needsSetup) switchTab('setup');
  } catch {}
  setInterval(() => { if (STATE.tab !== 'services') refreshPending(); }, 5000);
})();
