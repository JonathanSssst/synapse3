<script setup>
import { computed } from 'vue';

const props = defineProps({
  source: { type: String, default: '' },
  highlight: { type: String, default: '' }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function safeUrl(u) {
  const s = String(u || '');
  return /^https?:\/\//i.test(s) ? s : '';
}

// 极简 Markdown：标题 / 列表 / 引用 / 代码块 / 行内代码 / 粗斜体 / 链接
function render(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let listType = '';
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = ''; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      flushPara(); closeList();
      if (inCode) out.push('</code></pre>');
      else out.push('<pre class="md-code"><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw) + '\n'); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if (/^---+$/.test(line.trim())) { flushPara(); closeList(); out.push('<hr>'); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    para.push(inline(line));
  }
  flushPara();
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  return s;
}

const html = computed(() => render(props.source));
</script>

<template>
  <div class="markdown" v-html="html" />
</template>

<style scoped>
.markdown { font-size: var(--fs-13); line-height: 1.85; color: var(--text-2); word-break: break-word; }
.markdown :deep(h1) { font-size: 19px; margin: 22px 0 10px; color: var(--text); font-weight: 650; }
.markdown :deep(h2) { font-size: 16px; margin: 20px 0 8px; color: var(--text); font-weight: 650; }
.markdown :deep(h3) { font-size: 14px; margin: 16px 0 6px; color: var(--text); font-weight: 600; }
.markdown :deep(h4) { font-size: 13px; margin: 14px 0 6px; color: var(--text); font-weight: 600; }
.markdown :deep(p) { margin: 7px 0; }
.markdown :deep(ul), .markdown :deep(ol) { margin: 6px 0; padding-left: 22px; }
.markdown :deep(li) { margin: 3px 0; }
.markdown :deep(blockquote) { margin: 8px 0; padding: 4px 12px; border-left: 2px solid var(--accent); background: var(--surface-2); border-radius: 0 var(--radius-xs) var(--radius-xs) 0; color: var(--muted); }
.markdown :deep(code) { font-family: var(--font-mono); font-size: 11.8px; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; color: var(--accent-2); }
.markdown :deep(.md-code) { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; overflow: auto; }
.markdown :deep(.md-code code) { background: none; padding: 0; color: var(--text-2); font-size: 11.5px; }
.markdown :deep(hr) { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }
.markdown :deep(a) { color: var(--accent); }
.markdown :deep(strong) { color: var(--text); }
</style>
