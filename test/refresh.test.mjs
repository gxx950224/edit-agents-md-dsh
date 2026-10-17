/**
 * lib/refresh.js 单测：「立即刷新」的诚实性。
 *
 * 这组测试的核心目的**不是**证明刷新能成功，而是证明它**不会谎报成功**：
 *   - 只有真正发起了一次带 agent 的第一方 read 调用，才允许 ok:true；
 *   - 缺 agent / 缺 tools / 工具报错 / 工具抛错 / 工具不可见 → 一律 ok:false，
 *     且必须带回可读 reason 与 fallback。
 *
 * 依据（读 app.asar 核验）：@deepseek-ai/dsh-agent-instructions 只在
 * read/write/edit 的 tools/result 上收集触碰，且硬性要求 exec.agent 存在。
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  EXECUTE_TIMEOUT_MS,
  TOUCH_TOOL_NAME,
  describeRefreshLimits,
  getToolsService,
  pickAgent,
  pickAnchor,
  refreshInstructions,
  toolVisible,
} from "../lib/refresh.js"
import { fakeAgents, fakeCtx, fakeFs, fakeTools } from "./helpers.mjs"

const FILE = "D:\\fakehome\\AGENTS.md"

/** 造一个「什么都有、刷新必然成功」的 ctx。 */
function happyPath() {
  const agent = { id: "session-1", session: { header: { cwd: "D:\\proj" } } }
  const tools = fakeTools({})
  const fsService = fakeFs({ [FILE]: "# hello\nworld\n" })
  const { ctx } = fakeCtx({
    services: { fs: fsService, tools, agents: fakeAgents([agent]) },
  })
  return { ctx, agent, tools, fsService }
}

/* ── 工具名常量必须与运行时白名单一致 ──────────────────── */

test("TOUCH_TOOL_NAME 必须是 read（DSH FILE_TOUCH_TOOL_NAMES 只认 read/write/edit）", () => {
  assert.equal(TOUCH_TOOL_NAME, "read")
  assert.ok(["read", "write", "edit"].includes(TOUCH_TOOL_NAME))
})

/* ── 成功路径 ──────────────────────────────────────────── */

test("刷新成功：真正 execute 了 read，参数是绝对 file_path 且带 agent", async () => {
  const { ctx, agent, tools } = happyPath()
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, true)
  assert.equal(result.refreshed, true)
  assert.match(result.method, /^read /)

  assert.equal(tools.__calls.length, 1, "必须且只发起一次工具调用")
  const call = tools.__calls[0]
  assert.equal(call.name, "read")
  assert.equal(call.arguments.file_path, FILE, "file_path 必须是绝对路径（DSH 不做 cwd 解析）")
  assert.equal(call.agent, agent, "exec.agent 是 DSH 收集触碰的硬条件，必须带上")
  assert.equal(typeof call.callId, "string")
  assert.ok(call.callId.length > 0, "callId 必须非空")
  assert.ok(call.signal !== undefined, "应带超时 signal 以免工具卡死请求")
})

test("刷新成功：读工具返回的 isError 如实反映为 ok:false（不把工具错误当成功）", async () => {
  const agent = { id: "s", session: { header: {} } }
  const tools = fakeTools({
    result: { isError: true, error: { message: "读取被沙箱策略拒绝", code: "FS_DENIED" }, content: [] },
  })
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.equal(result.refreshed, false)
  assert.match(result.reason, /读取被沙箱策略拒绝/)
  assert.match(result.reason, /FS_DENIED/)
  assert.ok(result.fallback.length > 0, "失败必须给出 fallback 说明")
})

test("刷新成功：工具抛错 → ok:false 且带原因（execute-threw）", async () => {
  const agent = { id: "s", session: { header: {} } }
  const tools = fakeTools({ error: new Error("pipeline exploded") })
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.match(result.reason, /pipeline exploded/)
  assert.equal(result.attempts[0].phase, "execute-threw")
})

test("刷新成功：execute 返回空 → ok:false（no-result）", async () => {
  const agent = { id: "s", session: { header: {} } }
  const tools = fakeTools({ result: () => null })
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })
  assert.equal(result.ok, false)
  assert.equal(result.attempts[0].phase, "no-result")
})

/* ── 诚实降级：无 agent ────────────────────────────────── */

test("无 agent → ok:false，且**不发起任何工具调用**（没有 agent 就没有触碰）", async () => {
  const tools = fakeTools({})
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.equal(result.refreshed, false)
  assert.match(result.reason, /没有活跃会话|没有活跃 agent/)
  assert.match(result.fallback, /下次工具触碰/)
  assert.equal(tools.__calls.length, 0, "无 agent 时不应浪费一次工具调用")
})

test("agents 服务整个缺失 → ok:false，reason 说明服务不可用", async () => {
  const tools = fakeTools({})
  const { ctx } = fakeCtx({ services: { fs: fakeFs({ [FILE]: "# a\n" }), tools } })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.match(result.reason, /agents 服务不可用/)
  assert.equal(tools.__calls.length, 0)
})

test("显式 agentId 找不到会话 → 回落到活跃 agent（并在 reason 中可诊断）", async () => {
  const agent = { id: "session-live", session: { header: {} } }
  const tools = fakeTools({})
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE, agentId: "session-missing" })
  assert.equal(result.ok, true, `应回落到活跃 agent：${result.reason ?? ""}`)
  assert.equal(tools.__calls[0].agent, agent)
})

test("显式 agentId 命中时优先使用它", async () => {
  const first = { id: "session-a", session: { header: {} } }
  const second = { id: "session-b", session: { header: {} } }
  const tools = fakeTools({})
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([first, second]) },
  })
  await refreshInstructions(ctx, { path: FILE, agentId: "session-b" })
  assert.equal(tools.__calls[0].agent, second)
})

/* ── 诚实降级：无 tools ────────────────────────────────── */

test("tools 服务缺失 → ok:false，reason 指出刷新只在 read/write/edit 上触发", async () => {
  const agent = { id: "s", session: { header: {} } }
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.match(result.reason, /tools 服务不可用/)
  assert.match(result.reason, /read\/write\/edit/)
})

test("tools 服务存在但没有 execute 方法 → 视为不可用（防御未知形状）", async () => {
  const agent = { id: "s", session: { header: {} } }
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools: { get: () => ({}) }, agents: fakeAgents([agent]) },
  })
  assert.equal(getToolsService(ctx), undefined)
  const result = await refreshInstructions(ctx, { path: FILE })
  assert.equal(result.ok, false)
})

/* ── 降级到 edit ───────────────────────────────────────── */

test("read 不可见时退到 edit 空操作（oldString === newString），仍算真实触碰", async () => {
  const agent = { id: "s", session: { header: {} } }
  const tools = fakeTools({ visible: (name) => name === "edit" })
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# title\nbody\n" }), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, true, `edit 兜底应成功：${result.reason ?? ""}`)
  assert.match(result.method, /edit /)
  assert.match(result.method, /空操作/)

  const editCall = tools.__calls.find((call) => call.name === "edit")
  assert.ok(editCall, "必须发起过 edit 调用")
  assert.equal(editCall.arguments.file_path, FILE)
  assert.equal(editCall.arguments.old_string, "# title", "锚点取首行")
  assert.equal(editCall.arguments.new_string, editCall.arguments.old_string, "必须是空操作，内容不变")
})

test("read 与 edit 都不可见 → ok:false 并记录 not-visible 诊断", async () => {
  const agent = { id: "s", session: { header: {} } }
  const tools = fakeTools({ visible: () => false })
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({ [FILE]: "# a\n" }), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.equal(tools.__calls.length, 0, "不可见的工具不应被调用")
  assert.ok(result.attempts.some((attempt) => attempt.phase === "not-visible"))
})

test("文件不存在且读不到内容 → ok:false，提示先保存", async () => {
  const agent = { id: "s", session: { header: {} } }
  const tools = fakeTools({})
  const { ctx } = fakeCtx({
    services: { fs: fakeFs({}), tools, agents: fakeAgents([agent]) },
  })
  const result = await refreshInstructions(ctx, { path: FILE })

  assert.equal(result.ok, false)
  assert.match(result.reason, /文件当前不存在|读不到内容/)
  assert.equal(tools.__calls.length, 0)
})

test("缺 path → ok:false，不做任何调用", async () => {
  const { ctx, tools } = happyPath()
  for (const value of ["", "   ", undefined, null, 42]) {
    const result = await refreshInstructions(ctx, { path: value })
    assert.equal(result.ok, false)
  }
  assert.equal(tools.__calls.length, 0)
})

/* ── 辅助函数 ──────────────────────────────────────────── */

test("pickAnchor：取首行，空内容返回 undefined", () => {
  assert.equal(pickAnchor("# title\nbody"), "# title")
  assert.equal(pickAnchor("# title\r\nbody"), "# title", "CRLF 也要正确切分")
  assert.equal(pickAnchor(""), undefined)
  assert.equal(pickAnchor("\nbody"), undefined)
  assert.equal(pickAnchor(undefined), undefined)
})

test("toolVisible：查不到时不预判（交给 execute 报真错）", () => {
  assert.equal(toolVisible({ get: () => ({}) }, "read", {}), true)
  assert.equal(toolVisible({ get: () => undefined }, "read", {}), false)
  const throwing = {
    get() {
      throw new Error("boom")
    },
  }
  assert.equal(toolVisible(throwing, "read", {}), true, "查询抛错不应误判为不可见")
})

test("pickAgent：返回来源便于诊断", () => {
  const agent = { id: "a", session: { header: {} } }
  assert.equal(pickAgent({ get: () => fakeAgents([agent]) }, "a").source, "agentId=a")
  assert.equal(pickAgent({ get: () => fakeAgents([agent]) }, undefined).source, "currentInitiator")
  assert.equal(pickAgent({ get: () => fakeAgents([]) }, undefined).agent, undefined)
})

test("describeRefreshLimits：明确写出真实边界（供 UI/README 复用）", () => {
  const limits = describeRefreshLimits()
  assert.ok(limits.length >= 4)
  const text = limits.join("\n")
  assert.match(text, /read\/write\/edit/, "必须说明触碰机制")
  assert.match(text, /agent/, "必须说明需要 agent")
  assert.match(text, /下次工具触碰|新会话/, "必须说明失败时的兜底")
})

test("EXECUTE_TIMEOUT_MS：有超时上限，避免刷新请求悬挂", () => {
  assert.ok(Number.isFinite(EXECUTE_TIMEOUT_MS))
  assert.ok(EXECUTE_TIMEOUT_MS > 0 && EXECUTE_TIMEOUT_MS <= 30000)
})
