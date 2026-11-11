// 面板 API 客户端（同源，无外部依赖）

function qs(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request(path, { params, method = 'GET', body, timeout = 30000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path + qs(params), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store'
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('请求超时（后端可能繁忙或未启动）');
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => request('/api/health', { timeout: 8000 }),
  version: () => request('/api/version', { timeout: 8000 }),
  meta: () => request('/api/meta', { timeout: 8000 }),
  latest: () => request('/api/latest', { timeout: 8000 }),
  overview: (range = {}, light = false) => request('/api/overview', { params: { from: range.from, to: range.to, light: light ? 1 : '' }, timeout: 25000 }),
  costs: (range = {}) => request('/api/costs', { params: range, timeout: 25000 }),
  records: (type, query = {}) => request(`/api/records/${encodeURIComponent(type)}`, { params: query, timeout: 25000 }),
  record: (type, id) => request(`/api/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, { timeout: 20000 }),
  life: () => request('/api/life', { timeout: 15000 }),
  qzone: () => request('/api/qzone', { timeout: 15000 }),
  album: () => request('/api/album', { timeout: 15000 }),
  memory: () => request('/api/memory', { timeout: 15000 }),
  sessionMemory: (params = {}) => request('/api/session-memory', { params, timeout: 15000 }),

  petGet: () => request('/api/pet', { timeout: 20000 }),
  petSave: (body) => request('/api/pet/config', { method: 'POST', body, timeout: 15000 }),

  voiceGet: () => request('/api/voice', { timeout: 30000 }),
  voiceSave: (body) => request('/api/voice/save', { method: 'POST', body, timeout: 15000 }),
  voicePersona: (body) => request('/api/voice/persona', { method: 'POST', body, timeout: 15000 }),
  voiceTest: (body = {}) => request('/api/voice/test', { method: 'POST', body, timeout: 130000 }),

  alertsGet: () => request('/api/alerts', { timeout: 8000 }),
  alertsSave: (cfg) => request('/api/alerts', { method: 'POST', body: cfg, timeout: 8000 }),
  refsGet: () => request('/api/refs/config', { timeout: 8000 }),
  refsSave: (patch) => request('/api/refs/config', { method: 'POST', body: patch, timeout: 8000 }),
  refNote: (file, policySafe) => request('/api/ref-note', { method: 'POST', body: { file, policySafe }, timeout: 8000 }),

  personaSave: (body) => request('/api/persona/save', { method: 'POST', body, timeout: 20000 }),
  personaCreate: (body) => request('/api/persona/create', { method: 'POST', body, timeout: 60000 }),
  personaDelete: (body) => request('/api/persona/delete', { method: 'POST', body, timeout: 30000 }),
  personaTemplate: () => request('/api/persona/template', { timeout: 8000 }),
  personaApply: (role) => request('/api/persona/apply', { method: 'POST', body: { role }, timeout: 65000 }),
  personaSwitch: (name, key = '') => request('/api/persona/switch', { method: 'POST', body: { name, key }, timeout: 12000 }),

  whitelistGet: () => request('/api/config/whitelist', { timeout: 10000 }),
  whitelistSave: (body) => request('/api/config/whitelist', { method: 'POST', body, timeout: 45000 }),

  memoryShareGet: () => request('/api/memory-sharing', { timeout: 10000 }),
  memoryShareSave: (body) => request('/api/memory-sharing', { method: 'POST', body, timeout: 15000 }),

  masterGet: () => request('/api/master', { timeout: 10000 }),
  masterSet: (action) => request('/api/master', { method: 'POST', body: { action }, timeout: 45000 }),

  restartDsh: () => request('/api/restart-dsh', { method: 'POST', timeout: 15000 }),
  restartDshStatus: () => request('/api/restart-dsh', { timeout: 8000 }),

  reconnectDsh: () => request('/api/reconnect-dsh', { method: 'POST', timeout: 15000 }),
  reconnectDshStatus: () => request('/api/reconnect-dsh', { timeout: 8000 }),

  breezeClaimGet: () => request('/api/breeze-claim', { timeout: 15000 }),
  breezeClaimCheck: () => request('/api/breeze-claim', { method: 'POST', body: { action: 'check' }, timeout: 20000 }),
  breezeClaimMark: () => request('/api/breeze-claim', { method: 'POST', body: { action: 'mark' }, timeout: 20000 }),

  settingsGet: () => request('/api/settings', { timeout: 20000 }),
  settingsSave: (body) => request('/api/settings', { method: 'POST', body, timeout: 60000 }),
  conversationRemove: (key) => request('/api/conversations/remove', { method: 'POST', body: { key, confirm: true }, timeout: 60000 }),

  slangGet: (q = '', status = '') => request('/api/slang', { params: { q, status }, timeout: 20000 }),
  slangConfirm: (ids) => request('/api/slang/confirm', { method: 'POST', body: { ids }, timeout: 30000 }),
  slangReject: (ids) => request('/api/slang/reject', { method: 'POST', body: { ids }, timeout: 30000 }),
  slangUpdate: (id, patch) => request('/api/slang/update', { method: 'POST', body: { id, patch }, timeout: 30000 }),

  messageStats: (day = '') => request('/api/message-stats', { params: { day }, timeout: 15000 }),

  brainMemory: (role) => request('/api/brain-memory', { params: { role }, timeout: 20000 }),
  brainAction: (body) => request('/api/brain-memory', { method: 'POST', body, timeout: 20000 }),

  vitalsGet: (role) => request('/api/vitals', { params: { role }, timeout: 15000 }),
  vitalsTimeline: (role, day = '') => request('/api/vitals/timeline', { params: { role, day }, timeout: 15000 }),
  vitalsEvent: (body) => request('/api/vitals/event', { method: 'POST', body, timeout: 15000 }),

  genDelete: (name) => request('/api/gen-delete', { params: { name }, timeout: 10000 }),
  genResend: (name) => request('/api/gen-resend', { params: { name }, timeout: 60000 }),

  previewText: async (path) => {
    const res = await fetch('/api/preview?path=' + encodeURIComponent(path), { cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    return text;
  },

  genImageUrl: (name) => `/api/gen-image?name=${encodeURIComponent(name)}`,
  refImageUrl: (name) => `/api/ref-image?name=${encodeURIComponent(name)}`,
  avatarUrl: (role) => `/api/persona/avatar?role=${encodeURIComponent(role)}`,
  mediaUrl: (p) => `/api/media?path=${encodeURIComponent(p)}`,
  exportUrl: (kind, range = {}) => '/api/export/' + encodeURIComponent(kind) + qs(range)
};

export function fmtNum(n, digits = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtMoney(n, digits = 3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtPct(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
export function fmtCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}
export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts : String(ts));
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}
export function fmtClock(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
