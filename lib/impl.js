/**
 * edit-agents-md-dsh 宿主半实现：注册「设置 → AGENT」页签所需的同源 HTTP 路由。
 *
 * 为什么必须有宿主半：
 *   浏览器半拿不到文件系统，也没法发起第一方工具调用。DSH 的指令文件
 *   （`$DSH_HOME/AGENTS.md`）只有宿主进程能读写；而「立即刷新」还必须调用
 *   宿主 `tools` 服务。同源 webServer 路由是本类插件读写宿主能力的可行路径
 *   （delivery-board-dsh、sapbuddy-dsh、session-manager-dsh、mcp-ui-dsh 同模式）。
 *
 * 安全模型（写入已提权，边界全部在这里，见 lib/store.js 的 ELEVATED_WRITE_MODE）：
 *   - 读：同源、只读本插件**规划出的候选指令文件**，不返回任意路径内容。
 *   - 写：仅本机 loopback + 同源 Origin（Origin.host 必须等于 Host 头）+
 *     JSON Content-Type，且路径必须落在候选白名单内（每次写入前重新规划，
 *     不信任浏览器传来的清单）。
 *   - 写入本身固定使用插件自己的**最高权限策略**（danger-full-access），不再
 *     受会话沙箱模式限制（用户明确要求不切换会话权限）。因此**上面这几道路由
 *     与白名单校验就是唯一的写入边界**，任何一条都不许为方便而删除。
 *   - 服务只监听本机（DSH webServer 即如此）。
 *
 * 本文件用 `impl.js` 命名是为了配合 lib/index.js 的**加载器外壳**：外壳每次
 * apply 用唯一查询串动态 import 本文件，从而绕开 ESM 按包名缓存，便于迭代。
 */
import {
  ELEVATED_WRITE_MODE,
  SIZE_BUDGET_BYTES,
  StoreError,
  budgetInfo,
  allowedWritePaths,
  canonicalWritePath,
  listCandidates,
  readInstructionFile,
  writeInstructionFile,
} from "./store.js"
import { resolveSessionCwds, resolveDshHome } from "./paths.js"
import { describeRefreshLimits, refreshInstructions } from "./refresh.js"

/** 全部路由路径（浏览器半必须与此**逐字一致**，字段名漂移会导致页签空白）。 */
export const ROUTES = {
  state: "/api/edit-agents/state",
  files: "/api/edit-agents/files",
  save: "/api/edit-agents/save",
  refresh: "/api/edit-agents/refresh",
}

/** 仅允许本机回环访问写操作。 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ""
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

/**
 * 可信的 Host 主机名白名单：只接受**字面量回环名**。
 *
 * 为什么必须做绝对校验（DNS-rebinding，勿删）：
 * 如果只比较「Origin.host === Host」，攻击者可让浏览器访问 `http://evil.example:<port>`
 * 并把该域名的 DNS 解析到 127.0.0.1；此时页面与请求同源，Host/Origin 都是
 * `evil.example`，相对比较会通过 → 任意公网页面可经 loopback 改写全局 AGENTS.md。
 * 因此 Host 必须是回环字面量（或等于 DSH webServer 公布 origin 的 host），
 * 任何别的域名一律拒绝。
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

/**
 * 解析 Host/Origin 里的 host 部分。
 *
 * @param raw - 头部原始值（例如 `127.0.0.1:5380`）
 * @returns `{ host, hostname }` 或 undefined（不可解析）
 */
function parseAuthority(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  try {
    const url = new URL(`http://${raw.trim()}`)
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase() }
  } catch {
    return undefined
  }
}

/**
 * 从宿主的 webServer 取「本 GUI 公布的 origin」，解析失败返回 undefined。
 *
 * 只用它来放宽「非回环字面量但确实是本 GUI」的场景（例如部署在自定义主机名），
 * 不参与任何权限判断 —— 校验失败方向永远是拒绝。
 *
 * @param ctx - 宿主插件上下文
 * @returns `URL` 或 undefined
 */
export function servedOriginOf(ctx) {
  let raw
  try {
    raw = ctx?.get?.("webServer")?.getOrigin?.()
  } catch {
    return undefined
  }
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url
  } catch {
    return undefined
  }
}

/**
 * POST 请求必须是**同源浏览器请求**，或来自本机非浏览器客户端。
 *
 * 为什么需要：写入已提升到 danger-full-access，若允许跨站请求，任意网页都能
 * 通过 loopback 上的本插件路由改写用户的全局 AGENTS.md（指令注入 → 后续会话
 * 被操纵）。
 *
 * 校验顺序（任何一步失败都拒绝）：
 *   1. `sec-fetch-site` 为 cross-site / same-site → 拒绝；
 *   2. Host 必须是回环字面量，或恰好等于 webServer 公布 origin 的 host
 *      （挡 DNS-rebinding；见 LOOPBACK_HOSTNAMES 注释）；
 *   3. 有 Origin 时：必须是 http(s)，且 `Origin.host` 必须等于 Host；
 *   4. 没有 Origin（curl/脚本等非浏览器客户端）放行 —— 这是本机可信前提下的
 *      既有约定，残余风险已在 README 明示。
 *
 * @param req - 请求
 * @param servedOrigin - webServer.getOrigin() 解析结果（可为 undefined）
 * @returns 是否允许该请求进入写入 handler
 */
export function isSameOriginRequest(req, servedOrigin) {
  const headers = req?.headers ?? {}
  const site = typeof headers["sec-fetch-site"] === "string" ? headers["sec-fetch-site"].toLowerCase() : ""
  if (site === "cross-site" || site === "same-site") return false

  const host = parseAuthority(headers.host)
  if (host === undefined) return false
  const servedHost = servedOrigin instanceof URL ? servedOrigin.host.toLowerCase() : ""
  if (!LOOPBACK_HOSTNAMES.has(host.hostname) && host.host !== servedHost) return false

  const origin = typeof headers.origin === "string" ? headers.origin.trim() : ""
  if (origin === "") return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  /* `Origin: null`（file://、sandboxed iframe）与自定义协议一律不可信。 */
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  return parsed.host.toLowerCase() === host.host
}

/**
 * POST 必须是 `application/json`。
 *
 * 浏览器跨站的「简单请求」只能是三种 Content-Type，其中 `text/plain` 可以让
 * JSON 文本绕过预检直接打到 loopback。强制 JSON 会触发预检（跨站被拦），
 * 同时也是明确的前后端契约。
 *
 * @param req - 请求
 * @returns Content-Type 是否为 JSON
 */
export function isJsonContentType(req) {
  const raw = typeof req?.headers?.["content-type"] === "string" ? req.headers["content-type"] : ""
  return /^application\/json\s*(;|$)/i.test(raw.trim())
}

/** 统一 JSON 响应。 */
function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

/** 请求体上限（字节）。指令文件本身有 1 MiB 预算，留足 JSON 转义余量即可。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * 读取请求体并解析 JSON（空体 → `{}`）。
 *
 * L3：带 `MAX_BODY_BYTES` 上限。以前只做 `Buffer.concat(chunks)`，
 * 任意大的请求体都会被完整缓冲（虽限 loopback，仍是不必要的内存风险）。
 *
 * @param req - 请求
 * @returns 解析后的对象
 * @throws 体过大（`body/too-large`）或非法 JSON
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on("data", (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        const error = new Error(`请求体超过上限（${MAX_BODY_BYTES} 字节）`)
        error.code = "body/too-large"
        error.status = 413
        fail(error)
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on("error", fail)
  })
}

/**
 * 把业务错误转成 HTTP 响应。
 *
 * `StoreError` 自带 status/code（例如版本冲突 → 409），其余一律 500。
 * 刻意保留 `code`：浏览器半据此区分「冲突，要用户选择重新加载」与
 * 「参数/权限问题」，两者 UI 处理完全不同。
 */
function toErrorResponse(res, error) {
  if (error instanceof StoreError) {
    return json(res, error.status, { ok: false, error: error.message, code: error.code, ...error.extra })
  }
  const message = error instanceof Error ? error.message : String(error)
  return json(res, 500, { ok: false, error: message, code: "internal/error" })
}

/**
 * 取当前会话的 cwd 列表（用于规划项目级候选）。
 *
 * @param ctx - 宿主插件上下文
 * @param agentId - 请求体里的会话 id（可选）
 * @returns 绝对路径数组
 */
function cwdsFor(ctx, agentId) {
  let agents = []
  try {
    const service = ctx?.get?.("agents")
    if (typeof agentId === "string" && agentId.trim() !== "") {
      const one = service?.get?.(agentId.trim())
      if (one !== undefined && one !== null) agents.push(one)
    }
    for (const agent of service?.list?.() ?? []) agents.push(agent)
  } catch {
    /* agents 不可用：只用进程 cwd 兜底 */
  }
  return resolveSessionCwds(ctx, agents)
}

/**
 * 组装 state 响应。
 *
 * 契约（浏览器半依赖，改这里必须同步改 client）：
 * ```
 * {
 *   ok: true,
 *   home,                         // DSH_HOME 绝对路径
 *   authoritativePath,            // DSH 真正读取的用户全局 AGENTS.md
 *   files: [{ path, filename, scope, role, overlay, authoritative,
 *             exists, isDirectory, readable, size, bytes }],
 *   selected: { path, exists, content, version, bytes, ...budgetInfo }
 *   budget: { bytes, budget, remaining, overBudget },
 *   refreshLimits: string[],
 *   writing: { allowed: boolean, reason?: string }
 * }
 * ```
 *
 * @param ctx - 宿主插件上下文
 * @param options - `{ path, agentId }`
 * @returns state 载荷
 */
export async function presentState(ctx, { path: requestedPath, agentId } = {}) {
  const cwds = cwdsFor(ctx, agentId)
  const files = await listCandidates(ctx, { cwds })

  const authoritative = files.find((entry) => entry.authoritative) ?? files[0]
  const home = resolveDshHome()

  /* 选中优先级：显式请求 > 权威文件 > 第一个存在的 > 第一个候选。 */
  const target =
    (typeof requestedPath === "string" && requestedPath.trim() !== ""
      ? files.find((entry) => entry.path.toLowerCase() === requestedPath.trim().toLowerCase())
      : undefined) ??
    authoritative ??
    files.find((entry) => entry.exists) ??
    files[0]

  if (target === undefined) {
    throw new StoreError(
      `无法规划任何候选指令文件（DSH_HOME=${home}）：请检查环境变量与权限`,
      500,
      "paths/none",
    )
  }

  /*
   * L1：候选与**目录**同名时（例如把 AGENTS.md 建成了目录）不要整页失败。
   * 以前这里让 `path/not-a-file` 冒到 400，结果是 GET /state 全部失败、
   * 页签变成一片错误，用户连「切到另一个候选文件」都做不到。
   * 现在降级为空内容 + isDirectory，让 UI 能提示并允许改选。
   */
  let selected
  try {
    selected = await readInstructionFile(ctx, target.path)
  } catch (error) {
    if (error instanceof StoreError && error.code === "path/not-a-file") {
      selected = { path: target.path, exists: true, content: "", version: null, bytes: 0, notAFile: true }
    } else {
      throw error
    }
  }
  const selectedFile = files.find((entry) => entry.path === target.path) ?? target

  /*
   * 写能力：本插件固定以最高权限写入（见 store.js 的 ELEVATED_WRITE_MODE），
   * 因此**不再**依赖会话沙箱模式，也不再提示用户去切「完全权限」。
   * 唯一的不可写情形是目标本身是目录。这里如实回报，让 UI 在保存前就能提示。
   */
  const outsideWorkspaceHint =
    selectedFile.isDirectory === true ? "目标是一个目录，不能作为指令文件" : undefined

  return {
    ok: true,
    home,
    authoritativePath: authoritative?.path ?? null,
    files,
    selected: {
      ...selectedFile,
      path: target.path,
      exists: selected.exists,
      content: selected.content,
      version: selected.version,
      bytes: selected.bytes,
      ...budgetInfo(selected.bytes),
    },
    budget: budgetInfo(selected.bytes),
    refreshLimits: describeRefreshLimits(),
    writing: {
      allowed: selectedFile.isDirectory !== true,
      reason: outsideWorkspaceHint,
      /* 插件固定使用最高权限写入：不随会话模式变化，UI 可据此解释「为什么不用切权限」。 */
      elevated: true,
      mode: ELEVATED_WRITE_MODE,
    },
  }
}

/**
 * 构造全部路由规格（纯数据，不触碰 webServer，便于单测）。
 *
 * @param ctx - 宿主插件上下文
 * @returns 路由规格数组（kind 均为 'exact'）
 */
export function buildRouteSpecs(ctx) {
  /* webServer 公布的 origin（可能没有：headless/测试）；仅用于 Host 白名单放宽。 */
  const servedOrigin = servedOriginOf(ctx)
  const get = (path, handler) => ({
    kind: "exact",
    path,
    async handler(req, res) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return json(res, 405, { ok: false, error: "仅支持 GET", code: "method/not-allowed" })
      }
      try {
        return json(res, 200, await handler(req, res))
      } catch (error) {
        return toErrorResponse(res, error)
      }
    },
  })

  const post = (path, handle) => ({
    kind: "exact",
    path,
    async handler(req, res) {
      if (req.method !== "POST") {
        return json(res, 405, { ok: false, error: "仅支持 POST", code: "method/not-allowed" })
      }
      if (!isLoopback(req)) {
        return json(res, 403, { ok: false, error: "仅允许本机访问", code: "auth/not-loopback" })
      }
      /*
       * 写入已提权到 danger-full-access：跨站页面（恶意网页）如果能打到
       * loopback 路由，就能改写全局 AGENTS.md。因此 POST 必须来自同源页面
       * 且是 JSON —— 这两条是权限提升后的必要补偿，不要因为"本机"就跳过。
       */
      if (!isSameOriginRequest(req, servedOrigin)) {
        return json(res, 403, { ok: false, error: "拒绝跨源写入请求", code: "auth/cross-origin" })
      }
      if (!isJsonContentType(req)) {
        return json(res, 415, {
          ok: false,
          error: "写入请求必须使用 application/json",
          code: "content/type-required",
        })
      }
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        /* 体过大（413）与非法 JSON（400）要分开，前端提示不同。 */
        return json(res, error?.status ?? 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: typeof error?.code === "string" ? error.code : "body/invalid-json",
        })
      }
      try {
        return json(res, 200, await handle(body))
      } catch (error) {
        return toErrorResponse(res, error)
      }
    },
  })

  return [
    /* 主状态：候选清单 + 选中文件内容 + 预算 + 刷新能力边界。 */
    get(ROUTES.state, async (req) => {
      const url = new URL(req.url ?? ROUTES.state, "http://127.0.0.1")
      return presentState(ctx, {
        path: url.searchParams.get("path") ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
      })
    }),

    /* 重扫候选（只读，供页面在「重新读取」时调用）。 */
    get(ROUTES.files, async () => {
      const files = await listCandidates(ctx, { cwds: cwdsFor(ctx, undefined) })
      const authoritative = files.find((entry) => entry.authoritative) ?? null
      return { ok: true, files, authoritativePath: authoritative?.path ?? null }
    }),

    /*
     * 保存：写指令文件。
     * 请求体：{ path, content, version, create? }
     *   - version 是 GET /state 拿到的**不透明令牌**，覆盖写入必须回传；
     *   - create:true 用于新建（文件必须不存在）。
     */
    post(ROUTES.save, async (body) => {
      const filePath = body?.path
      if (typeof filePath !== "string" || filePath.trim() === "") {
        throw new StoreError("请求体缺少 path", 400, "path/missing")
      }

      /* 白名单：写路径必须落在候选指令文件里（每次重新规划，不信任前端）。
         命中的**规范拼写**才是真正写入的目标——大小写敏感的后端上，原始拼写
         可能指向另一个文件，让校验失去意义。 */
      const allowed = await allowedWritePaths(ctx, { cwds: cwdsFor(ctx, body?.agentId) })
      const target = canonicalWritePath(allowed, filePath)
      if (target === undefined) {
        throw new StoreError(
          `拒绝写入非候选指令文件：${filePath.trim()}。只允许写 $DSH_HOME 下或项目根的 AGENTS.md 族文件`,
          403,
          "path/not-allowed",
        )
      }

      const create = body?.create === true
      const content = typeof body?.content === "string" ? body.content : null
      if (content === null) {
        throw new StoreError("请求体缺少 content（必须是字符串；允许空串以清空文件）", 400, "content/missing")
      }

      /*
       * 服务端强制 1 MiB 预算（与 README 声称一致）。
       * 浏览器半在超限时会禁用保存，但 API 不能把 UI 当安全边界：
       * 超限的 AGENTS.md 不会被 DSH 渲染进上下文，写进去只会得到"保存成功但
       * 不生效"的假象，因此直接拒绝更诚实。
       */
      const contentBytes = Buffer.byteLength(content, "utf8")
      if (contentBytes > SIZE_BUDGET_BYTES) {
        throw new StoreError(
          `内容超过上限：${contentBytes} / ${SIZE_BUDGET_BYTES} 字节（DSH 不会渲染超限的指令文件）`,
          413,
          "content/too-large",
          { bytes: contentBytes, budget: SIZE_BUDGET_BYTES },
        )
      }

      /*
       * 写入固定使用插件自己的最高权限策略（store.js 的 elevatedWritePolicy）：
       * 不再解析/传递会话沙箱策略，也就不依赖当前会话的权限模式。
       */
      const result = await writeInstructionFile(ctx, {
        path: target,
        content,
        version: body?.version,
        create,
      })

      /* 回带最新文件状态，省掉前端一次请求；注意这里**不**自动刷新，
         刷新是用户显式动作（POST /refresh），因为刷新会发起真实工具调用。 */
      const files = await listCandidates(ctx, { cwds: cwdsFor(ctx, body?.agentId) })
      return {
        ok: true,
        saved: {
          path: result.path,
          version: result.version,
          bytes: result.bytes,
          created: result.created,
          ...budgetInfo(result.bytes),
        },
        files,
      }
    }),

    /*
     * 立即刷新：发起一次**真实的**第一方 read 调用来触发 DSH 的指令触碰机制。
     *
     * 请求体：{ path, agentId? }
     * 响应：{ ok, refreshed, method?, detail?, reason?, fallback?, attempts? }
     *
     * ⚠️ 诚实性要求：只有确实成功发起触碰调用时才 ok:true。失败时如实回
     * ok:false + 真实原因 + fallback 说明，**绝不**把「文件已保存」当成
     * 「指令已刷新」。详见 lib/refresh.js 文件头。
     */
    post(ROUTES.refresh, async (body) => {
      const filePath = body?.path
      if (typeof filePath !== "string" || filePath.trim() === "") {
        throw new StoreError("请求体缺少 path", 400, "path/missing")
      }

      /* 与 save 同一条白名单：不接受对任意路径发起工具调用。 */
      const allowed = await allowedWritePaths(ctx, { cwds: cwdsFor(ctx, body?.agentId) })
      const target = canonicalWritePath(allowed, filePath)
      if (target === undefined) {
        throw new StoreError(
          `拒绝为非候选指令文件发起刷新：${filePath.trim()}`,
          403,
          "path/not-allowed",
        )
      }

      /* refreshInstructions 始终 resolve（失败作为数据返回），因此这里不会
         因刷新失败而抛错——前端拿到的是带真实原因的 200。这正是我们要的：
         文件保存成功了，刷新失败是另一件事，不该用 5xx 混淆。 */
      return refreshInstructions(ctx, {
        path: target,
        agentId: body?.agentId,
      })
    }),
  ]
}

/**
 * 注册全部路由。返回 disposer 列表；调用方负责并入 ctx.effect。
 *
 * 注册是「全有或全无」的：webServer 对重复的 (kind,path) 会抛错，若中途失败
 * 就把已注册的路由回滚掉再抛出，避免留下半套路由却没人卸载。
 *
 * @param webServer - 宿主 webServer 服务
 * @param ctx - 宿主插件上下文
 * @returns disposer 数组
 */
export function installRoutes(webServer, ctx) {
  const specs = buildRouteSpecs(ctx)
  const disposers = []
  try {
    for (const spec of specs) disposers.push(webServer.register(spec))
  } catch (error) {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        /* 回滚失败不再掩盖原始错误 */
      }
    }
    throw error
  }
  return disposers
}

/**
 * 插件入口。用 ctx.inject 而非硬依赖，这样 headless profile（无 webServer）下
 * 插件仍能正常加载，只是不注册路由。
 *
 * @param ctx - 宿主插件上下文
 */
export function apply(ctx) {
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.get("webServer")
    if (webServer === undefined) return
    const disposers = installRoutes(webServer, ctx)

    /* 启动自检（只记日志，不阻塞加载）：把权威路径打出来，便于用户在
       「保存没反应」时第一时间确认插件写的是哪个文件。 */
    try {
      ctx.logger?.info?.(`edit-agents: 用户全局指令 = ${resolveDshHome()}/AGENTS.md`)
    } catch (error) {
      ctx.logger?.warn?.(`edit-agents: ${error instanceof Error ? error.message : String(error)}`)
    }

    webCtx.effect(() => () => {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          /* 单个卸载失败不影响其余 */
        }
      }
    })
    // eslint-disable-next-line no-console
    console.log(`[@gxx-labs/edit-agents-md-dsh] 已注册 ${disposers.length} 条 AGENTS.md 编辑路由`)
  })
}

export const name = "@gxx-labs/edit-agents-md-dsh"

export default { name, apply }
