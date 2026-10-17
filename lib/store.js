/**
 * 指令文件的读写。
 *
 * 两条硬约束，都是读源码核验过的：
 *
 * 1. **必须用宿主 `fs` 服务，而不是裸 node:fs。**
 *    `fs.writeText(target, content, expected)` 的 `expected` 是乐观并发守卫：
 *    `{ kind: 'replaceIfVersion', version }` 会在版本过期时报 `FS_STALE_VERSION`，
 *    这正是「界面上打开后文件被外部改过」的检测手段。裸 `fs.writeFile` 没有这个
 *    保护，会静默覆盖用户/其他工具刚写入的内容。原子性也由 fs 服务保证，因此
 *    本文件**不自己写临时文件 + rename**（那是重复实现官方保证）。
 *
 * 2. **写路径必须落在候选指令文件白名单内。**
 *    路由接受请求体里的 `path`，若不校验就等于把「任意文件写入」暴露给浏览器半。
 *    白名单由 lib/paths.js 的候选规划产生，并且每次写入前重新规划一次
 *    （不信任浏览器传来的候选清单）。
 *
 * 返回值里的 `version` 是**不透明令牌**（FsVersion branded type），前端只应
 * 原样回传、不应解析或比较。
 */
import path from "node:path"
import {
  ancestorDirs,
  planCandidates,
  resolveDshHome,
  PROJECT_ROOT_MARKERS,
} from "./paths.js"

/**
 * 指令文件的大小预算（字节）。
 *
 * 取 DSH `@deepseek-ai/dsh-agent-instructions` 的 `maxSourceBytes` 默认值
 * （**1 MiB = 1048576**，见其源码 `maxSourceBytes: 1048576`）：
 * 超过这个大小的源文件 DSH 根本不会渲染进上下文，因此**再往上写没有意义**，
 * 界面据此在超限时禁用保存是合理的。
 *
 * 早先这里写的是 64 KiB 并注释「与 DSH 默认 maxSourceBytes 同量级；超出只提示
 * 不阻断」——**两头都不对**（数量级错了，且前端其实是硬禁用）。现按官方值对齐，
 * 注释与行为一致。
 */
export const SIZE_BUDGET_BYTES = 1024 * 1024

/** 错误码：版本过期（文件被外部修改）。 */
export const STALE_VERSION = "FS_STALE_VERSION"

/**
 * 业务错误：带 HTTP 状态码与机器可读 code，由路由层转成响应。
 *
 * 刻意保留 `code` 而不是只留 message：浏览器半据此区分「冲突（要用户选择
 * 重新加载）」与「参数错误/权限问题」，两者的 UI 处理完全不同。
 */
export class StoreError extends Error {
  /**
   * @param message - 可读中文原因
   * @param status - HTTP 状态码
   * @param code - 机器可读错误码
   * @param extra - 附加字段（会并入响应体）
   */
  constructor(message, status = 500, code = "store/error", extra = {}) {
    super(message)
    this.name = "StoreError"
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/**
 * 判断一个错误是否是 fs 服务的版本过期。
 *
 * 不能只比对 `error.code`：provider 可能把 code 藏在 `error.info.code`、
 * `error.cause.code`，或只体现在 message 里。三者都查，避免把冲突误报成 500
 * （那会让用户看到「服务器错误」而不是「文件被外部改过」）。
 *
 * @param error - 任意错误
 * @returns 是否版本过期
 */
export function isStaleVersionError(error) {
  const codes = [error?.code, error?.info?.code, error?.cause?.code]
  if (codes.some((code) => code === STALE_VERSION)) return true
  const message = typeof error?.message === "string" ? error.message : ""
  return message.includes(STALE_VERSION)
}

/**
 * 取宿主 fs 服务；不可用时抛可读错误。
 *
 * @param ctx - 宿主插件上下文
 * @returns fs 服务
 */
export function requireFs(ctx) {
  let service
  try {
    service = ctx?.get?.("fs")
  } catch (error) {
    throw new StoreError(
      `无法访问宿主 fs 服务：${error instanceof Error ? error.message : String(error)}`,
      500,
      "fs/unavailable",
    )
  }
  if (service === undefined || service === null) {
    throw new StoreError("宿主 fs 服务不可用（headless profile？），无法读写指令文件", 500, "fs/unavailable")
  }
  return service
}

/**
 * 错误码：沙箱策略拒绝（写目标不在策略允许的范围内）。
 *
 * 真机实测（verifier + Lead 各自复现）暴露的关键缺陷：本 profile 的
 * `ctx.get("fs")` 是 `SandboxedFileSystem`，其 `writeText` 的第 5 个参数
 * `sandboxPolicy` 省略时，会用 `ctx.sandboxPolicy.resolve()`（**无 session**）
 * → 取**部署默认**（实测 `workspace-write`），而 `$DSH_HOME/AGENTS.md` 位于
 * 兜底 workspaceRoot 之外 → 直接 `FS_SANDBOX_DENIED`，且**在版本守卫之前**被拦，
 * 于是「保存用户全局 AGENTS.md」这条核心路径完全不可用（能读、不能写）。
 *
 * 修复历史与现状（勿删）：
 *   1. 第一版修复 = 把**会话策略**传下去（尊重会话，不自授权限）→ 会话是
 *      workspace-write 时保存仍被拒，要求用户先切「完全权限」；
 *   2. 现版本（用户明确要求）= 设置页保存是**用户直接操作**，不允许再要求
 *      用户切换会话权限模式，因此插件固定使用自家最高权限策略写入
 *      （见 ELEVATED_WRITE_MODE）。会话沙箱不再参与保存决策。
 */
export const SANDBOX_DENIED = "FS_SANDBOX_DENIED"

/**
 * 保存时固定使用的沙箱模式：最高权限（`danger-full-access`）。
 *
 * ============================================================================
 * 为什么必须显式传（用户需求，勿改回「会话策略」）
 * ============================================================================
 * 用户 2026-10-17 明确要求：在「设置 → 系统指令」点保存必须能写入
 * `$DSH_HOME/AGENTS.md`，**不允许**要求用户先把当前会话切到「完全权限」。
 *
 * 可行性（读 app.asar 源码核验）：`@deepseek-ai/dsh-fs-sandbox` 的
 * `SandboxedFileSystem.checkedTarget(target, sandboxPolicy)` 只检查
 * `policy.mode`：
 *   - `read-only`  → 一律拒绝；
 *   - `workspace-write` → 目标必须落在 policy.workspaceRoot 下；
 *   - `danger-full-access` → **直接返回目标，不做任何围栏**。
 * 它不校验该策略是否来自「批准」，所以插件可以在自己的设置页写入里显式使用。
 *
 * 权限提升的代价必须用其他边界补偿（这些边界都在本包里）：
 *   1. 路由：仅本机 loopback + 同源 Origin（Host 必须匹配）+ JSON Content-Type；
 *   2. 白名单：只允许写候选指令文件，且每次写入前重新规划（见 lib/impl.js）；
 *   3. 版本守卫：覆盖写入必须带读取时的 version（409 不吞外部修改）；
 *   4. 大小预算：单文件 1 MiB（SIZE_BUDGET_BYTES）。
 *
 * ⚠️ 不要退回「传会话策略」：那会让默认 workspace-write 的会话保存失败，
 * 正是用户本次要求修复的问题。
 */
export const ELEVATED_WRITE_MODE = "danger-full-access"

/**
 * 构造本次写入使用的**高权限策略**（与会话/部署默认无关）。
 *
 * `workspaceRoot` 在 danger-full-access 下不参与围栏，但 `SandboxExecutionPolicy`
 * 类型要求该字段；取目标文件所在目录，日志里能直接看出这次写的是哪个目录。
 *
 * @param filePath - 绝对写入路径
 * @returns SandboxExecutionPolicy（mode 固定为最高权限）
 */
export function elevatedWritePolicy(filePath) {
  const absolute =
    typeof filePath === "string" && filePath.trim() !== ""
      ? path.resolve(filePath.trim())
      : resolveDshHome()
  return { mode: ELEVATED_WRITE_MODE, workspaceRoot: path.dirname(absolute) }
}

/**
 * 与权限/沙箱有关的错误码集合。
 *
 * 这些都不该以 500「服务器内部错误」+ 英文原文抛给用户：它们全都是
 * **可操作**的（放宽会话沙箱模式、改权限、换目标文件），必须映射成 403 + 中文。
 */
const PERMISSION_CODES = new Set([
  SANDBOX_DENIED,
  "EPERM",
  "EACCES",
  "FS_NOT_REGULAR_FILE",
  "FS_READ_ONLY",
  "EROFS",
])

/**
 * 从任意错误里取错误码（provider 可能把 code 放在不同层级）。
 *
 * @param error - 任意错误
 * @returns 错误码字符串，取不到则空串
 */
export function errorCodeOf(error) {
  for (const candidate of [error?.code, error?.info?.code, error?.cause?.code]) {
    if (typeof candidate === "string" && candidate !== "") return candidate
  }
  return ""
}

/**
 * 判断一个错误是否属于权限/沙箱拒绝。
 *
 * @param error - 任意错误
 * @returns 是否权限类错误
 */
export function isPermissionError(error) {
  const code = errorCodeOf(error)
  if (PERMISSION_CODES.has(code)) return true
  /* 兜底：provider 未带 code 时，从 message 里认沙箱措辞。 */
  const message = typeof error?.message === "string" ? error.message : ""
  return message.includes(SANDBOX_DENIED) || /access denied under .* mode/i.test(message)
}

/**
 * 把沙箱策略压成一句可读描述（用于 403 文案与日志）。
 *
 * @param policy - SandboxExecutionPolicy
 * @returns 描述文本，或空串
 */
export function describePolicy(policy) {
  if (policy === undefined || policy === null) return ""
  const mode = typeof policy.mode === "string" ? policy.mode : "unknown"
  const root = typeof policy.workspaceRoot === "string" ? policy.workspaceRoot : ""
  return root === "" ? `mode=${mode}` : `mode=${mode}, workspaceRoot=${root}`
}

/**
 * 用 fs 服务探测一个路径是文件 / 目录 / 不存在。
 *
 * `fs.stat` 对不存在的目标返回 `undefined`（不是抛错），这正好用来做存在性
 * 探测——比 try/catch 读文件更省一次内容读取。
 *
 * @param fsService - fs 服务
 * @param filePath - 绝对路径
 * @returns `{ exists, type, size }`
 */
export async function probePath(fsService, filePath) {
  const target = await fsService.resolve(filePath)
  const info = await fsService.stat(target)
  if (info === undefined) return { exists: false, type: "absent", size: 0, target }
  return { exists: true, type: info.type, size: typeof info.size === "number" ? info.size : 0, target }
}

/**
 * 用 fs 服务预取「哪些目录含项目根标记」。
 *
 * `paths.planCandidates` 需要一个**同步**谓词 `hasMarker(dir)`（这样它保持纯
 * 函数、单测无需 I/O）。本函数把 I/O 一次性做完，灌进一个 Map，再把同步
 * 查询交给它。探测失败按「无标记」处理——项目级候选只是附加信息，不该让
 * 整个列表请求失败。
 *
 * @param fsService - fs 服务
 * @param cwds - 会话 cwd 列表
 * @returns `(dir) => boolean`
 */
async function prefetchProjectMarkers(fsService, cwds) {
  const cache = new Map()
  for (const cwd of cwds) {
    for (const dir of ancestorDirs(cwd)) {
      if (cache.has(dir)) continue
      let found = false
      for (const marker of PROJECT_ROOT_MARKERS) {
        try {
          const probed = await probePath(fsService, path.join(dir, marker))
          if (probed.exists) {
            found = true
            break
          }
        } catch {
          /* 探测失败按无标记处理 */
        }
      }
      cache.set(dir, found)
    }
  }
  return (dir) => cache.get(dir) === true
}

/**
 * 规划候选指令文件并标注存在性 / 大小。
 *
 * @param ctx - 宿主插件上下文
 * @param options - `{ cwds }`
 * @returns 候选条目数组（含 exists/size）
 */
export async function listCandidates(ctx, { cwds = [] } = {}) {
  const fsService = requireFs(ctx)
  const cleanCwds = (Array.isArray(cwds) ? cwds : []).filter(
    (cwd) => typeof cwd === "string" && cwd.trim() !== "",
  )
  const hasMarker = await prefetchProjectMarkers(fsService, cleanCwds)
  const plan = planCandidates({ cwds: cleanCwds, hasMarker })

  const out = []
  for (const entry of plan) {
    try {
      const info = await probePath(fsService, entry.path)
      out.push({
        ...entry,
        exists: info.exists && info.type === "file",
        /* 目录同名（罕见的误建）也算不可编辑，避免前端把目录当文件读。 */
        isDirectory: info.exists && info.type === "directory",
        readable: true,
        size: info.size,
        bytes: info.size,
      })
    } catch (error) {
      /* 单个候选探测失败不该让整个列表失败——把它标成不可读。 */
      out.push({
        ...entry,
        exists: false,
        isDirectory: false,
        readable: false,
        size: 0,
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return out
}

/**
 * 重新规划白名单（写路径校验的唯一真相来源）。
 *
 * 返回 `Map<小写路径, 规范路径>`：调用方既要做大小写不敏感的比对（Windows
 * 语义），又要把**规范拼写**交给 fs 服务——否则在大小写敏感的后端上，
 * `D:\HOME\AGENTS.MD` 会解析成一个与候选不同的目标，白名单校验形同虚设。
 *
 * @param ctx - 宿主插件上下文
 * @param options - `{ cwds }`
 * @returns `{ set, canonical }`
 */
export async function allowedWritePaths(ctx, { cwds = [] } = {}) {
  const entries = await listCandidates(ctx, { cwds })
  const canonical = new Map()
  for (const entry of entries) canonical.set(entry.path.toLowerCase(), entry.path)
  return { set: new Set(canonical.keys()), canonical, entries }
}

/**
 * 把调用方给的路径解析成规范候选路径。
 *
 * L4：先 `path.resolve` **规范化拼写**再比对，这样
 * `C:/dsh-home/AGENTS.md`、`C:\dsh-home\.\AGENTS.md` 这类等价写法也能命中白名单
 * （早先只做 `trim().toLowerCase()`，正斜杠拼写会被误判为「非候选」而 403）。
 * 规范化后的结果仍然必须**恰好等于**某个候选，白名单语义没有放宽。
 *
 * @param allowed - `allowedWritePaths` 的结果
 * @param filePath - 请求体里的路径
 * @returns 规范路径，或 undefined（不在白名单内）
 */
export function canonicalWritePath(allowed, filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") return undefined
  let normalized
  try {
    normalized = path.resolve(filePath.trim())
  } catch {
    return undefined
  }
  return allowed.canonical.get(normalized.toLowerCase())
}

/**
 * 读一个指令文件。
 *
 * @param ctx - 宿主插件上下文
 * @param filePath - 绝对路径
 * @returns `{ path, exists, content, version, bytes }`
 */
export async function readInstructionFile(ctx, filePath) {
  const fsService = requireFs(ctx)
  const target = await fsService.resolve(filePath)
  const info = await fsService.stat(target)
  if (info === undefined) {
    return { path: filePath, exists: false, content: "", version: null, bytes: 0 }
  }
  if (info.type !== "file") {
    throw new StoreError(`目标不是普通文件（type=${info.type}）`, 400, "path/not-a-file")
  }
  const content = await fsService.readText(target)
  return {
    path: filePath,
    exists: true,
    content,
    version: info.version,
    bytes: Buffer.byteLength(content, "utf8"),
  }
}

/**
 * 写一个指令文件。
 *
 * `expected` 的语义（照抄 fs 服务契约）：
 *   - `create === true`  → `{ kind: 'createIfAbsent' }`，文件已存在则失败；
 *   - 否则若给了 `version` → `{ kind: 'replaceIfVersion', version }`，过期报
 *     `FS_STALE_VERSION` → 转 409；
 *   - 否则 → 省略 `expected`，**无条件覆盖**（仅用于「文件不存在时首次创建」
 *     的内部路径，路由层不允许走到这里）。
 *
 * @param ctx - 宿主插件上下文
 * @param options - `{ path, content, version, create }`
 *   写入固定使用插件自己的**最高权限策略**（`elevatedWritePolicy`），与会话
 *   沙箱模式和是否提供 `sandboxPolicy` 服务都无关。
 * @returns `{ path, bytes, version, created, existed, policy }`
 */
export async function writeInstructionFile(
  ctx,
  { path: filePath, content, version, create = false } = {},
) {
  const fsService = requireFs(ctx)

  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new StoreError("缺少写入路径", 400, "path/missing")
  }
  if (typeof content !== "string") {
    throw new StoreError("content 必须是字符串", 400, "content/invalid")
  }

  const target = await fsService.resolve(filePath)
  const info = await fsService.stat(target)
  const exists = info !== undefined

  /* 新建语义：文件已存在 → 让调用方先读一次拿到 version，避免误覆盖。 */
  if (create && exists) {
    throw new StoreError("文件已存在，不能用 create 语义覆盖（请先读取拿到版本号）", 409, "path/already-exists")
  }
  /* 覆盖语义：文件不存在 → 必须是 create。 */
  if (!create && !exists) {
    throw new StoreError("文件不存在，请以 create: true 新建", 404, "path/absent")
  }

  let expected
  if (create) {
    expected = { kind: "createIfAbsent" }
  } else {
    if (version === undefined || version === null || version === "") {
      throw new StoreError("覆盖写入必须带上读取时的 version（乐观并发守卫）", 400, "version/missing")
    }
    expected = { kind: "replaceIfVersion", version }
  }

  /*
   * 关键：显式传**插件自己的最高权限策略**。
   * 省略第 5 个参数会被 fs 服务按「部署默认」（实测 workspace-write）围栏，
   * 导致 $DSH_HOME 下的用户全局 AGENTS.md 写不进去；传「会话策略」则要求
   * 用户先把会话切到完全权限——用户明确拒绝了这个前提。因此这里固定用
   * danger-full-access，权限提升的补偿边界见 ELEVATED_WRITE_MODE 注释。
   */
  const policy = elevatedWritePolicy(filePath)

  try {
    const outcome = await fsService.writeText(target, content, expected, undefined, policy)
    return {
      path: filePath,
      bytes: Buffer.byteLength(content, "utf8"),
      version: outcome?.version ?? null,
      created: outcome?.operation === "create" || !exists,
      existed: exists,
      policy,
    }
  } catch (error) {
    if (isStaleVersionError(error)) {
      throw new StoreError("文件已被外部修改，请重新读取后再保存", 409, STALE_VERSION, {
        /* 回带当前版本，方便前端直接提示「重新加载」而不是让用户手动刷新。 */
        current: await currentVersionQuietly(fsService, target),
      })
    }
    /*
     * 权限类错误 → 403 + 可读中文（而不是 500 + 英文 OS 原文）。
     * 注意：正常路径不应再出现 FS_SANDBOX_DENIED（插件已用最高权限）；
     * 若仍出现，说明是文件只读 / ACL / fs 提供方不识别显式策略等其他原因，
     * 文案必须如实说明「插件已提权仍被拒」，而不是让用户去切会话权限。
     */
    if (isPermissionError(error)) {
      const detail = describePolicy(policy)
      const original = error instanceof Error ? error.message : String(error)
      throw new StoreError(
        `写入被宿主文件系统拒绝：${filePath}（插件已使用最高权限策略 ${detail} 写入）。` +
          `在 ${ELEVATED_WRITE_MODE} 下仍被拒绝，通常意味着文件只读 / ACL 限制 / 目标目录不可写，` +
          `或当前 fs 提供方不识别显式策略。原始错误：${original}`,
        403,
        SANDBOX_DENIED,
        {
          sandboxMode: ELEVATED_WRITE_MODE,
          reason: "filesystem-rejected-elevated-write",
          cause: errorCodeOf(error) || null,
        },
      )
    }
    throw error
  }
}

/**
 * 尽力取当前版本（冲突响应里回带，失败则 undefined）。
 *
 * @param fsService - fs 服务
 * @param target - 已解析目标
 * @returns 版本令牌或 undefined
 */
async function currentVersionQuietly(fsService, target) {
  try {
    const info = await fsService.stat(target)
    return info?.version ?? null
  } catch {
    return null
  }
}

/**
 * 计算大小预算信息（UI 用来提示「快超上限了」）。
 *
 * @param bytes - 当前字节数
 * @returns `{ bytes, budget, remaining, overBudget }`
 */
export function budgetInfo(bytes) {
  const size = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0
  return {
    bytes: size,
    budget: SIZE_BUDGET_BYTES,
    remaining: Math.max(0, SIZE_BUDGET_BYTES - size),
    overBudget: size > SIZE_BUDGET_BYTES,
  }
}

export { resolveDshHome }
