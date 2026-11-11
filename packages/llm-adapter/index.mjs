// packages/llm-adapter · 模型侧接口层
//
// 为什么要这一层：
//   现在桥接直接讲 DSH 的私有协议（Cookie 鉴权 / slash-RPC / remote.mux），
//   版本一变就要跟着改，而且"零基础用户必须装 DSH"这道门槛无法绕开（方案 B/C）。
//
// 这一层只定义三个方法，把"谁在思考"从桥接里剥出来：
//   prompt(session, text)   → 投递一轮用户输入
//   events(session, onEvent)→ 订阅回复/工具调用/审批事件
//   approve(session, id, ok)→ 回应审批
//
// 现状：DshAdapter 直接包住现有 dsh-client.js，行为与现在完全一致；
// 未来：新增 OpenAiAdapter（直连兼容端点 + 轻量工具循环）即可实现方案 C，桥接不用改。

/**
 * @typedef {Object} Adapter
 * @property {(session:Object, text:string) => Promise<void>} prompt
 * @property {(session:Object, onEvent:Function) => () => void} events
 * @property {(session:Object, approvalId:string, allowed:boolean) => Promise<void>} approve
 * @property {() => Promise<{ok:boolean, detail:string}>} health
 */

/** DSH 实现：薄包装，不改变任何现有行为。 */
export class DshAdapter {
  /**
   * @param {{ client:any, config:any }} opts client = bridge/src/dsh-client.js 的 NodeApiClient 实例
   */
  constructor({ client, config }) {
    if (!client) throw new Error('DshAdapter 需要 dsh-client 实例');
    this.client = client;
    this.config = config || {};
    this.kind = 'dsh';
  }

  async prompt(session, text) {
    // TODO(P3.5)：把 bridge.js 里投递 prompt 的那段搬进来，桥接改为调用本方法。
    // 目前保持抛错，避免"看起来能用其实没接线"。
    throw new Error('DshAdapter.prompt 尚未接线（P3.5）');
  }

  events(session, onEvent) {
    throw new Error('DshAdapter.events 尚未接线（P3.5）');
  }

  async approve(session, approvalId, allowed) {
    throw new Error('DshAdapter.approve 尚未接线（P3.5）');
  }

  async health() {
    try {
      const base = this.config?.dsh?.baseUrl || 'http://127.0.0.1:1918';
      const res = await fetch(base, { signal: AbortSignal.timeout(2000) });
      return { ok: res.ok || res.status < 500, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }
}

/** 直连 OpenAI 兼容端点：方案 C 的骨架。当前只做与 DSH 的能力对照说明，不实现工具循环。 */
export class OpenAiAdapter {
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.kind = 'openai';
  }

  async prompt() { throw new Error('OpenAiAdapter 尚未实现（方案 C，v1.0 目标）'); }
  events() { throw new Error('OpenAiAdapter 尚未实现（方案 C，v1.0 目标）'); }
  async approve() { throw new Error('OpenAI 兼容端点没有审批模型，需在本层自建'); }

  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(3000)
      });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }
}

/**
 * 能力对照：迁移到方案 C 时需要自己补的东西，写在这里以免低估工作量。
 *
 *   DSH 提供                      方案 C 需要自建
 *   ─────────────────────────     ─────────────────────────
 *   会话与上下文裁剪                context 管理
 *   工具调用循环                     ReAct 循环 + 并发上限
 *   审批流（approval 事件）          策略引擎 + 挂起队列（packages/policy 已备）
 *   预算/用量统计                   token 记账（bridge/token-ledger.js 已有）
 *   会话级隔离与复用                 session store
 */
export function capabilityGap() {
  return ['context 管理', 'ReAct 工具循环', '审批与挂起队列', 'token 记账', 'session store'];
}

export default { DshAdapter, OpenAiAdapter, capabilityGap };
