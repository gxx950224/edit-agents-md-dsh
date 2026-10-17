/**
 * 路径解析：定位「指令文件」（AGENTS.md 族）的候选落盘位置。
 *
 * ⚠️ 运行时事实（读 app.asar 核验，勿凭记忆推翻）：
 *   DSH 真正加载的**用户全局指令文件是 `AGENTS.md`（复数）**，位于
 *   `$DSH_HOME/AGENTS.md`，`DSH_HOME` 默认 `~/.dsh`。见
 *   @deepseek-ai/dsh-agent-instructions/lib/index.js：
 *       const USER_GLOBAL_FILE = "AGENTS.md"          // 第 141 行
 *   加载候选名（config 默认）：
 *       基础      ['AGENTS.md', 'CLAUDE.md']
 *       本地 overlay ['AGENTS.local.md', 'CLAUDE.local.md']
 *       项目根标记  ['.git']
 *
 * 因此本模块区分「权威路径」（DSH 一定会读的 `$DSH_HOME/AGENTS.md`）与
 * 「兼容发现」路径（同目录或项目树里 DSH 也认、但可能不存在或已被弃用的
 * 拼写，如 AGENT.md / CLAUDE.md）。UI 必须能把二者区分开——只有前者是
 * 真正的用户全局指令；后者存在与否都不改变 DSH 的基线行为。
 */
import path from "node:path"
import os from "node:os"

/** DSH 权威读取的用户全局指令文件名（复数 AGENTS.md）。 */
export const USER_GLOBAL_FILENAME = "AGENTS.md"

/**
 * 用户级「兼容发现」候选文件名。
 *
 * 顺序即优先级：AGENTS.md 第一（权威），其余为兼容/历史拼写。
 * 注意 AGENTS.local.md / CLAUDE.local.md 是 **overlay**，DSH 会叠加而非
 * 取代基线文件，所以 UI 里它们是独立条目而不是 AGENTS.md 的替代品。
 */
export const USER_LEVEL_CANDIDATES = [
  "AGENTS.md",
  "AGENT.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
]

/** 项目根标记（DSH 用 .git 判定项目根）。 */
export const PROJECT_ROOT_MARKERS = [".git"]

/** 项目级候选文件名（与用户级同名，只是落在项目树里）。 */
export const PROJECT_LEVEL_CANDIDATES = USER_LEVEL_CANDIDATES

/**
 * 解析 DSH_HOME：env 优先，其次 `~/.dsh`（与 DSH 自身一致）。
 *
 * @param env - 环境变量表（默认 process.env，测试可注入）
 * @returns 绝对路径
 */
export function resolveDshHome(env = process.env) {
  const explicit = env?.DSH_HOME
  if (typeof explicit === "string" && explicit.trim() !== "") return path.resolve(explicit)
  return path.join(os.homedir(), ".dsh")
}

/**
 * 解析 profile 目录。
 *
 * 优先级（照抄 mcp-ui-dsh/lib/paths.js 的三级兜底）：
 *   1. 宿主服务 `profileContext.patchPath` 的 dirname —— 唯一能反映
 *      `--profile` / 自定义 profile 目录的权威值；
 *   2. 环境变量 `DSH_PROFILE_DIR`；
 *   3. `$DSH_HOME/profiles/<DSH_PROFILE || 'desktop'>`。
 *
 * **刻意不做「dirname 向上找」这类启发式**：写错文件比报错更糟（会污染别的
 * profile 或别的目录）。三条全失败时返回 undefined，由调用方降级为「无
 * profile 信息」而不是编一个路径出来。
 *
 * @param ctx - 宿主插件上下文（可为 undefined）
 * @param env - 环境变量表
 * @returns 绝对路径，或 undefined
 */
export function resolveProfileDir(ctx, env = process.env) {
  /* 1) 官方 profileContext：config-editor 的 documentPath 来源。 */
  try {
    const profileContext = ctx?.get?.("profileContext")
    const patchPath = profileContext?.patchPath
    if (typeof patchPath === "string" && patchPath.trim() !== "") return path.dirname(patchPath)
  } catch {
    /* 服务未就绪：继续走环境变量 */
  }

  /* 2) DSH_PROFILE_DIR。 */
  const dir = env?.DSH_PROFILE_DIR
  if (typeof dir === "string" && dir.trim() !== "") return path.resolve(dir)

  /* 3) DSH_HOME + profile 名。 */
  const profile = typeof env?.DSH_PROFILE === "string" && env.DSH_PROFILE.trim() !== "" ? env.DSH_PROFILE : "desktop"
  const home = env?.DSH_HOME
  if (typeof home === "string" && home.trim() !== "") {
    return path.join(path.resolve(home), "profiles", profile)
  }
  return undefined
}

/**
 * 解析 profile 的 cordis.patch.yml 绝对路径（诊断日志用）。
 *
 * @param ctx - 宿主插件上下文
 * @param env - 环境变量表
 * @returns 绝对路径，或 undefined
 */
export function resolvePatchPath(ctx, env = process.env) {
  const dir = resolveProfileDir(ctx, env)
  return dir === undefined ? undefined : path.join(dir, "cordis.patch.yml")
}

/**
 * 取当前会话的 cwd 候选。
 *
 * 「会话 cwd」优先从 agent 上取（`agent.session.header.cwd`），拿不到再用
 * `ctx.get('agents')` 的活跃 agent 兜底，最后才用进程 cwd。刻意保持宽容：
 * 项目级候选只是**附加**信息，取不到不影响用户级编辑。
 *
 * @param ctx - 宿主插件上下文
 * @param agents - 已选定的 agent 列表（可选）
 * @returns 绝对路径数组（去重）
 */
export function resolveSessionCwds(ctx, agents = []) {
  const out = []
  const push = (value) => {
    if (typeof value === "string" && value.trim() !== "") {
      const resolved = path.resolve(value.trim())
      if (!out.includes(resolved)) out.push(resolved)
    }
  }

  for (const agent of agents ?? []) push(agent?.session?.header?.cwd)

  try {
    const service = ctx?.get?.("agents")
    for (const agent of service?.list?.() ?? []) push(agent?.session?.header?.cwd)
    for (const agent of service?.roots?.() ?? []) push(agent?.session?.header?.cwd)
  } catch {
    /* agents 服务不可用：项目级候选退化，不影响用户级 */
  }

  push(process.cwd())
  return out
}

/**
 * 从一个目录逐级上溯，返回**所有**祖先目录（含自身，直到盘符/文件系统根）。
 *
 * 纯路径运算、不做 I/O：这样单测不需要真实文件系统，I/O 集中在 store 层。
 *
 * @param cwd - 起始目录
 * @param maxDepth - 防御性上限
 * @returns 绝对路径数组，从自身向外
 */
export function ancestorDirs(cwd, maxDepth = 64) {
  if (typeof cwd !== "string" || cwd.trim() === "") return []
  const out = []
  let current = path.resolve(cwd)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    out.push(current)
    const parent = path.dirname(current)
    if (parent === current) break /* 到根了 */
    current = parent
  }
  return out
}

/**
 * 找项目根：从 cwd 向上第一个含根标记的目录（DSH 用 `.git`）。
 *
 * `hasMarker` 是同步谓词 `(dir) => boolean`，由调用方用 fs 服务预取后注入，
 * 因此本函数保持纯函数。
 *
 * @param cwd - 起始目录
 * @param hasMarker - 同步谓词
 * @returns 项目根绝对路径，或 undefined
 */
export function findProjectRoot(cwd, hasMarker) {
  if (typeof hasMarker !== "function") return undefined
  for (const dir of ancestorDirs(cwd)) {
    if (hasMarker(dir)) return dir
  }
  return undefined
}

/**
 * 生成用户级候选（不做存在性探测，纯路径计算）。
 *
 * @param env - 环境变量表
 * @returns `{ path, filename, scope, overlay }[]`
 */
export function userLevelCandidates(env = process.env) {
  const home = resolveDshHome(env)
  return USER_LEVEL_CANDIDATES.map((filename) => ({
    path: path.join(home, filename),
    filename,
    scope: "user",
    /* overlay 文件是叠加语义，DSH 不会用它们取代基线，UI 要区别对待。 */
    overlay: filename.endsWith(".local.md"),
  }))
}

/**
 * 生成项目级候选（不做存在性探测）。
 *
 * @param dir - 放置候选的目录（项目根或 cwd）
 * @returns `{ path, filename, scope, overlay }[]`
 */
export function projectLevelCandidates(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return []
  return PROJECT_LEVEL_CANDIDATES.map((filename) => ({
    path: path.join(path.resolve(dir), filename),
    filename,
    scope: "project",
    overlay: filename.endsWith(".local.md"),
  }))
}

/**
 * 组装完整的候选清单（纯数据，便于单测）。
 *
 * 每个条目都带 `role`：
 *   - `"authoritative"` —— DSH 一定会读取的用户全局 AGENTS.md（唯一权威）；
 *   - `"user-compat"`   —— `$DSH_HOME` 下的兼容/overlay 拼写；
 *   - `"project"`       —— 项目树里的候选（含本地 overlay）。
 *
 * @param options - `{ env, cwds, hasMarker }`
 * @returns 候选条目数组（未做存在性探测）
 */
export function planCandidates({ env = process.env, cwds = [], hasMarker } = {}) {
  const out = []
  const seen = new Set()
  const push = (entry, role) => {
    const key = entry.path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...entry, role, authoritative: role === "authoritative" })
  }

  const home = resolveDshHome(env)
  const authoritativePath = path.join(home, USER_GLOBAL_FILENAME).toLowerCase()
  for (const entry of userLevelCandidates(env)) {
    push(entry, entry.path.toLowerCase() === authoritativePath ? "authoritative" : "user-compat")
  }

  for (const cwd of cwds) {
    const root = findProjectRoot(cwd, hasMarker)
    /* 有 .git 就只用项目根（更贴近 DSH 的实际读取面）；没有则退回 cwd 本身，
       让用户仍能就地新建项目级指令。 */
    const dir = root ?? cwd
    if (path.resolve(dir).toLowerCase() === path.resolve(home).toLowerCase()) continue
    for (const entry of projectLevelCandidates(dir)) push(entry, "project")
  }

  return out
}
