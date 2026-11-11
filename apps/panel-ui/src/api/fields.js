// 详情页字段标签与格式化
import { fmtNum, fmtBytes, fmtMoney, fmtTime } from './client.js';

export const FIELD_LABELS = {
  id: '记录 ID',
  t: '时间（UTC）',
  tLocal: '时间（北京）',
  type: '类型 / 阶段',
  convKey: '会话',
  conv: '会话',
  sessionId: '会话 ID',
  tool: '工具',
  ok: '结果',
  error: '错误',
  args: '调用参数',
  raw: '原始记录',
  name: '名称',
  bytes: '大小',
  lines: '行数',
  url: '链接',
  imgUrl: '图片',
  kind: '类型',
  path: '路径',
  op: '操作',
  exists: '文件存在',
  source: '来源',
  action: '动作',
  target: '对象',
  detail: '详情',
  bvid: 'BV 号',
  title: '标题',
  up: 'UP 主',
  awemeId: '视频 ID',
  author: '作者',
  note: '她的感受',
  summary: '摘要',
  tid: '说说 ID',
  content: '内容',
  mood: '心情',
  image: '配图',
  nickname: '昵称',
  displayName: '显示名',
  role: '当前角色',
  note2: '备注',
  isCurrent: '当前人设',
  stickers: '专属表情数',
  hasAvatar: '有头像',
  avatarBytes: '头像大小',
  hasPersonaMd: '有角色卡',
  personaBytes: '角色卡大小',
  updatedAt: '更新时间',
  sourcePath: '来源路径',
  useCount: '使用次数',
  lastUsedAt: '最近使用',
  createdAt: '创建时间',
  desc: '备注',
  localNote: '本地笔记',
  tags: '标签',
  personas: '使用人设',
  preview: '摘要',
  mtime: '修改时间',
  prob: '概率',
  hit: '命中',
  freeze: '冻结',
  dry: '演练',
  version: '版本',
  pid: '进程 ID'
};

export const HIDDEN_FIELDS = new Set(['raw', 'args', 'columns', 'personaMd', 'content']);

export function fmtField(key, value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'bytes' || key === 'avatarBytes' || key === 'personaBytes') return fmtBytes(value);
  if (key === 'lastUsedAt' || key === 'createdAt' || key === 'wakeAt' || key === 'nextAt' || key === 'at') return fmtTime(Number(value) || value);
  if (typeof value === 'number') return fmtNum(value);
  if (Array.isArray(value)) return value.length ? value.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('、') : '—';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

export function fieldLabel(key) {
  return FIELD_LABELS[key] || key;
}

export function exportFieldValue(key, value) {
  if (key === 'error' || key === 'detail' || key === 'args') return value;
  return value;
}

export { fmtMoney };
