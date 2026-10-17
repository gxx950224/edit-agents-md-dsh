/**
 * 「立即刷新」：让刚保存的指令文件**真正**对当前会话生效。
 *
 * ============================================================================
 * 机制（读 app.asar 核验，勿凭记忆改）
 * ============================================================================
 *
 * @deepseek-ai/dsh-agent-instructions 不会自己监听指令文件的变化。它只在
 * **第一方 read/write/edit 工具的执行结果**上收集「触碰」(touch)：
 *
 *   const FILE_TOUCH_TOOL_NAMES = new Set(["read", "write", "edit"])   // 1087-1091
 *   function filePathFromExecution(exec) {                             // 1092-1098
 *     if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
 *     ... exec.arguments.file_path 必须是字符串 ...
 *   }
 *   ctx.on("tools/result", (exec, result) => {                         // 1290-1309
 *     if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
 *       const ownPath = filePathFromExecution(exec)
 *       if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath })
 *     }
 *     if (exec.parent !== undefined) { ...上浮到父执行...; return }
 *     for (const touch of touches) projectTouch(touch)
 *   })
 *
 * 三条硬条件，缺一不可：
 *   1. `exec.name ∈ {read, write, edit}`；
 *   2. `exec.arguments.file_path` 是非空字符串；
 *   3. **`exec.agent !== undefined`** —— 没有 agent 的调用不产生 touch。
 *   4. 结果必须 `isError === false` 且 `signal` 未中止。
 *
 * 生效路径（1254-1263 行 projectTouch）**无需等下一步**：
 *   - 当前没有开启的步骤 → `queueProjection` → `composeAndSync` →
 *     `agent.inbox.prepend("next-step", desired)`：立刻排进该 agent 的下一步收件箱；
 *   - 恰有步骤开启 → 累积到 `step/end`（`session/event` 监听，1264-1270 行）再投影。
 *
 * ============================================================================
 * 本模块怎么做到
 * ============================================================================
 *
 * 用 `ctx.get("tools").execute({ ... })` —— ToolRuntime 的公开方法，会走完整的
 * pre-policy / guards / post-policy 流水线。因此：
 *   - 这是**真实**的一次第一方工具调用，不是伪造事件；
 *   - 但它也可能被权限策略、guard 或沙箱拒绝，或工具本身报错。
 *
 * ⚠️ 已知现实约束（必须诚实对待，不许假装成功）：
 *   - 用户全局指令在 `$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`），通常
 *     **位于当前 workspace 之外**。read 工具在受限沙箱策略下可能拒绝读取
 *     workspace 外的路径。此时本次触碰不会发生。
 *   - `tools.execute` 需要 `exec.agent`；没有活跃 agent 就没有可关联的会话，
 *     触碰无处投影。
 *
 * 因此本模块的策略是：**逐个候选方案真实尝试，记录每一个的原始结果**，
 * 只有确实有一条成功时才返回 `ok: true`；否则返回 `ok: false` 并把真实原因
 * （含工具返回的 error 文本）交给前端如实展示。绝不把「文件写成功了」当成
 * 「指令已刷新」——那是两件事。
 */

/** 刷新尝试中使用的工具名（必须 ∈ FILE_TOUCH_TOOL_NAMES，否则不产生 touch）。 */
export const TOUCH_TOOL_NAME = "read"

/** 单次 tools.execute 的超时（毫秒）。 */
export const EXECUTE_TIMEOUT_MS = 8000

/**
 * 选一个可用的 agent（touch 必须有 agent 才会上浮）。
 *
 * 优先级：
 *   1. 请求体显式指定的 `agentId`（前端知道用户正在哪个会话里点按钮）；
 *   2. `ctx.get("agents").currentInitiator()` —— 进程本地异步驱动链上的发起者；
 *   3. 活跃 agent 列表里**最近**的一个（list() 的末尾通常是最新的）。
 *
 * @param ctx - 宿主插件上下文
 * @param agentId - 请求体里的会话 id（可选）
 * @returns `{ agent, source }` 或 `{ agent: undefined, reason }`
 */
export function pickAgent(ctx, agentId) {
  let agents
  try {
    agents = ctx?.get?.("agents")
  } catch (error) {
    return { agent: undefined, reason: `agents 服务不可用：${error instanceof Error ? error.message : String(error)}` }
  }
  if (agents === undefined || agents === null) {
    return { agent: undefined, reason: "agents 服务不可用（headless profile？）" }
  }

  if (typeof agentId === "string" && agentId.trim() !== "") {
    const wanted = agentId.trim()
    let found
    try {
      found = agents.get?.(wanted)
    } catch {
      found = undefined
    }
    if (found !== undefined && found !== null) return { agent: found, source: `agentId=${wanted}` }
    /* 显式给了 id 但找不到：继续往下试，但把这件事记进 reason 供诊断。 */
  }

  try {
    const initiator = agents.currentInitiator?.()
    if (initiator !== undefined && initiator !== null) return { agent: initiator, source: "currentInitiator" }
  } catch {
    /* 忽略：继续兜底 */
  }

  try {
    const live = agents.list?.() ?? []
    const last = live[live.length - 1]
    if (last !== undefined && last !== null) return { agent: last, source: "agents.list[-1]" }
  } catch {
    /* 忽略 */
  }

  return {
    agent: undefined,
    reason:
      typeof agentId === "string" && agentId.trim() !== ""
        ? `找不到会话 ${agentId.trim()}，且当前没有活跃 agent`
        : "当前没有活跃会话/agent，无法把指令变更投影到任何会话",
  }
}

/**
 * 取 tools 服务；不可用返回 undefined。
 *
 * @param ctx - 宿主插件上下文
 * @returns tools 服务或 undefined
 */
export function getToolsService(ctx) {
  try {
    const tools = ctx?.get?.("tools")
    if (tools === undefined || tools === null) return undefined
    if (typeof tools.execute !== "function") return undefined
    return tools
  } catch {
    return undefined
  }
}

/**
 * 判断一个工具是否在当前作用域可见（不可见时 execute 会直接 UNKNOWN_TOOL）。
 *
 * @param tools - tools 服务
 * @param name - 工具名
 * @param agent - agent 作用域
 * @returns 是否可见
 */
export function toolVisible(tools, name, agent) {
  try {
    return tools.get?.(name, agent) !== undefined
  } catch {
    return true /* 查不了就不预判，交给 execute 报真错 */
  }
}

/**
 * 执行一次触碰调用，返回原始结果（不抛错，错误也作为数据回传）。
 *
 * 刻意**不吞掉**任何信息：调用方要把真实结果交给前端，所以这里把
 * `isError` / `value` / `error.message` 原样带出来。
 *
 * @param tools - tools 服务
 * @param options - `{ name, filePath, agent }`
 * @returns `{ ok, toolName, filePath, raw }` 或 `{ ok:false, ... , error }`
 */
async function attemptTouch(tools, { name, filePath, agent, extraArguments }) {
  const callId = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `edit-agents-${Date.now()}`
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(EXECUTE_TIMEOUT_MS) : undefined

  let result
  try {
    result = await tools.execute({
      callId,
      name,
      /* file_path 必须是**绝对路径**：filePathFromExecution 只做 trim，
         不做 cwd 解析，相对路径会被当成另一个文件。 */
      arguments: { file_path: filePath, ...(extraArguments ?? {}) },
      agent,
      signal,
    })
  } catch (error) {
    return {
      ok: false,
      toolName: name,
      filePath,
      error: error instanceof Error ? error.message : String(error),
      phase: "execute-threw",
    }
  }

  if (result === undefined || result === null) {
    return { ok: false, toolName: name, filePath, error: "tools.execute 未返回结果", phase: "no-result" }
  }
  if (result.isError === true) {
    const detail = result.error?.message ?? result.error?.code ?? "工具调用失败"
    return {
      ok: false,
      toolName: name,
      filePath,
      error: String(detail),
      code: result.error?.code,
      isError: true,
      phase: "tool-error",
    }
  }
  return { ok: true, toolName: name, filePath, isError: false, phase: "ok" }
}

/**
 * 触发一次真实的指令刷新。
 *
 * 尝试顺序（全部真实执行，记录每一步结果）：
 *   1. `read` 目标文件 —— 最自然：文件已存在且用户刚保存，读它必然成功；
 *      文件不存在（用户删了内容 / 从未建过）时跳过。
 *   2. 若 read 失败，退到 `edit` 空操作（oldString === newString）—— `edit`
 *      同样在 touch 白名单里，且它不需要「读得到 content」这件事本身成功，
 *      但需要 oldString 在文件里真实存在，所以用文件首行做锚点。
 *
 * @param ctx - 宿主插件上下文
 * @param options - `{ path, agentId, readContent }`
 * @returns 结构化结果（始终 resolve，不 reject）
 */
export async function refreshInstructions(ctx, { path: filePath, agentId, readContent } = {}) {
  const attempts = []

  if (typeof filePath !== "string" || filePath.trim() === "") {
    return {
      ok: false,
      refreshed: false,
      reason: "缺少要刷新的文件路径",
      fallback: "下次工具触碰该路径时生效",
      attempts,
    }
  }

  const tools = getToolsService(ctx)
  if (tools === undefined) {
    return {
      ok: false,
      refreshed: false,
      reason: "宿主 tools 服务不可用，无法发起第一方工具调用（指令刷新只在 read/write/edit 的结果上触发）",
      fallback: "下次工具触碰该路径时生效；或新会话开始时重读",
      attempts,
    }
  }

  const picked = pickAgent(ctx, agentId)
  if (picked.agent === undefined) {
    return {
      ok: false,
      refreshed: false,
      reason: picked.reason,
      fallback: "下次工具触碰该路径时生效；或新会话开始时重读",
      attempts,
    }
  }

  let content
  if (typeof readContent === "string") {
    content = readContent
  } else {
    try {
      const fsService = ctx?.get?.("fs")
      const target = await fsService.resolve(filePath)
      const info = await fsService.stat(target)
      if (info !== undefined && info.type === "file") content = await fsService.readText(target)
    } catch {
      /* 读不到内容不影响 read 触碰本身（那是工具自己的事）。 */
      content = undefined
    }
  }

  /* 方案 1：read（最可靠——文件存在即可成功，无需锚点）。 */
  if (content !== undefined) {
    if (!toolVisible(tools, TOUCH_TOOL_NAME, picked.agent)) {
      attempts.push({
        toolName: TOUCH_TOOL_NAME,
        ok: false,
        error: `工具 "${TOUCH_TOOL_NAME}" 在当前作用域不可见（可能被 restrict 屏蔽）`,
        phase: "not-visible",
      })
    } else {
      const attempt = await attemptTouch(tools, {
        name: TOUCH_TOOL_NAME,
        filePath,
        agent: picked.agent,
      })
      attempts.push(attempt)
      if (attempt.ok) {
        return {
          ok: true,
          refreshed: true,
          method: `${TOUCH_TOOL_NAME} ${filePath}`,
          agentSource: picked.source,
          agentId: String(picked.agent?.id ?? ""),
          detail:
            "已发起一次真实的第一方 read 调用，DSH 的 agent-instructions 会在其 tools/result 上收集触碰并投影到当前会话",
          attempts,
        }
      }
    }
  }

  /* 方案 2：edit 空操作（oldString === newString）。
     同样在 touch 白名单里；read 失败时（例如文件不存在）用它兜底。
     注意 filePathFromExecution **只读 file_path**，所以 old_string/new_string
     只是为了让 edit 工具自身跑通，DSH 侧并不需要看到它们。 */
  const anchor = pickAnchor(content)
  if (anchor !== undefined && toolVisible(tools, "edit", picked.agent)) {
    const attempt = await attemptTouch(tools, {
      name: "edit",
      filePath,
      agent: picked.agent,
      extraArguments: { old_string: anchor, new_string: anchor, replace_all: false },
    })
    attempts.push({ ...attempt, note: "edit 空操作（内容不变）" })
    if (attempt.ok) {
      return {
        ok: true,
        refreshed: true,
        method: `edit ${filePath}（空操作）`,
        agentSource: picked.source,
        agentId: String(picked.agent?.id ?? ""),
        detail:
          "已发起一次真实的第一方 edit 空操作调用，DSH 的 agent-instructions 会在其 tools/result 上收集触碰并投影到当前会话",
        attempts,
      }
    }
  }

  return {
    ok: false,
    refreshed: false,
    reason: buildReason(attempts, content !== undefined),
    fallback: "下次工具触碰该路径时生效；或新会话开始时重读",
    agentSource: picked.source,
    agentId: String(picked.agent?.id ?? ""),
    attempts,
  }
}

/**
 * 取一个可用作（未来的）编辑锚点的字符串。
 *
 * @param content - 文件内容（可能 undefined）
 * @returns 锚点或 undefined
 */
export function pickAnchor(content) {
  if (typeof content !== "string" || content === "") return undefined
  const firstLine = content.split(/\r?\n/, 1)[0]
  return firstLine === "" ? undefined : firstLine
}

/**
 * 把多次尝试压成一句可读原因（不要只回 ok:false）。
 *
 * 带上 `code`（若有）而不仅是 message：工具失败常常 message 笼统而 code
 * 才是可执行的线索（例如 `FS_DENIED` / `UNKNOWN_TOOL`），用户与后续排查都需要它。
 *
 * @param attempts - 尝试记录
 * @param fileExisted - 文件是否读到了内容
 * @returns 可读原因
 */
function buildReason(attempts, fileExisted) {
  if (attempts.length === 0) {
    return fileExisted
      ? "没有任何可行的刷新方案"
      : "文件当前不存在或读不到内容，无法发起触碰调用（请先保存文件）"
  }
  const parts = attempts.map((attempt) => {
    const detail = attempt.error ?? "失败"
    return attempt.code === undefined || attempt.code === null
      ? `${attempt.toolName}: ${detail}`
      : `${attempt.toolName}: ${detail} [${attempt.code}]`
  })
  return `无法触发指令刷新（${parts.join("；")}）。指令刷新只在第一方 read/write/edit 的结果上触发，且需要带上 agent`
}

/**
 * 描述刷新能力的真实边界（README 与 UI 文案共用，避免两处说法不一致）。
 *
 * @returns 边界说明
 */
export function describeRefreshLimits() {
  return [
    "刷新依赖一次真实的第一方 read 调用（DSH 只在 read/write/edit 的 tools/result 上收集触碰）。",
    "调用会走完整的权限/守卫流水线，因此可能被拒绝。",
    "用户全局指令位于 $DSH_HOME/AGENTS.md，通常在 workspace 之外；受限沙箱策略下可能读不到。",
    "没有活跃 agent 时没有可投影的会话，无法刷新。",
    "无法刷新时改动不会丢失：下次工具触碰该路径、或新会话开始时仍会生效。",
  ]
}
