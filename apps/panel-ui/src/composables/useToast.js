// 轻量 toast
import { reactive } from 'vue';

export const toasts = reactive([]);
let seq = 0;

export function dismissToast(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

export function toast(message, tone = '') {
  const id = ++seq;
  toasts.push({ id, message: String(message), tone });
  setTimeout(() => dismissToast(id), tone === 'bad' ? 5000 : 3200);
  return id;
}

export function toastError(e) {
  toast(e && e.message ? e.message : String(e), 'bad');
}
