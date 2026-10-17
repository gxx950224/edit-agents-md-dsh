/**
 * 宿主半测试的共享桩件：伪 Cordis 上下文 + 伪 fs 服务 + 伪 tools 服务。
 *
 * 刻意**不依赖真实 DSH**：本文件用最小桩件复刻宿主服务契约，这样测试能在纯
 * node 进程里跑，也能精确构造「版本冲突」「工具报错」这类现实中难以触发的
 * 分支。桩件的形状照抄 cordis_inspect_query 查到的真实契约（fs / tools）。
 */
import { EventEmitter } from "node:events"
import path from "node:path"

/**
 * 伪 fs 服务：内存文件表 + **真实的版本守卫语义**。
 *
 * 关键行为（必须与宿主一致，否则测试会放过真实缺陷）：
 *   - `stat(不存在)` 返回 undefined（不是抛错）；
 *   - `writeText` 带 `{kind:'replaceIfVersion', version}` 时版本不符抛
 *     `FS_STALE_VERSION`（code 挂在 error.code 上）；
 *   - `{kind:'createIfAbsent'}` 时目标已存在则抛 FS_EXISTS；
 *   - 省略 expected → 无条件覆盖。
 *
 * @param initial - 初始文件表 `{ [绝对路径]: 内容 }`
 * @returns fs 服务桩件（含 `__files` / `__writes` 供断言）
 */
export function fakeFs(initial = {}) {
  const files = new Map()
  const dirs = new Set()
  let counter = 0
  const writes = []

  for (const [filePath, content] of Object.entries(initial)) {
    files.set(path.resolve(filePath), { content, version: `v${(counter += 1)}` })
  }

  const key = (p) => path.resolve(p)

  return {
    __files: files,
    __dirs: dirs,
    __writes: writes,
    /** 直接塞一个文件（模拟外部修改）。 */
    __put(filePath, content) {
      files.set(key(filePath), { content, version: `v${(counter += 1)}` })
    },
    /** 模拟外部修改：换新版本号，旧 version 立刻过期。 */
    __touch(filePath) {
      const existing = files.get(key(filePath))
      if (existing === undefined) return
      existing.version = `v${(counter += 1)}`
    },
    async resolve(p) {
      return { targetKey: key(p), displayPath: key(p) }
    },
    async stat(target) {
      const resolved = target?.targetKey ?? key(target)
      const entry = files.get(resolved)
      if (entry !== undefined) {
        return {
          version: entry.version,
          type: "file",
          size: Buffer.byteLength(entry.content, "utf8"),
        }
      }
      if (dirs.has(resolved)) return { version: `d${(counter += 1)}`, type: "directory" }
      return undefined
    },
    async readText(target) {
      const entry = files.get(target?.targetKey ?? key(target))
      if (entry === undefined) {
        const error = new Error(`ENOENT: ${target?.displayPath ?? target}`)
        error.code = "ENOENT"
        throw error
      }
      return entry.content
    },
    async writeText(target, content, expected, signal, sandboxPolicy) {
      const resolved = target?.targetKey ?? key(target)
      const before = files.get(resolved)

      /*
       * 模拟真机沙箱围栏（SandboxedFileSystem 的真实语义）：
       * 置位后 writeText 只放行 `danger-full-access`，其余模式一律拒（且**在版本
       * 守卫之前**，与 SandboxedFileSystem 的真实顺序一致：它先 checkedTarget
       * 再进 LocalFileSystem.writeText）。
       *
       * 本插件的保存固定自带 danger-full-access 策略（不需要会话权限），因此：
       *   - 调用点真的传了全权策略 → 写入放行（本文件专门锁这条）；
       *   - 将来有人把第 5 参删掉/改成会话策略 → 这里立刻拒绝，测试变红。
       */
      if (this.__sandboxDeny === true && sandboxPolicy?.mode !== "danger-full-access") {
        const error = new Error(
          `cannot write "${target?.displayPath ?? resolved}": file access denied under ${sandboxPolicy?.mode ?? "workspace-write"} mode`,
        )
        error.code = "FS_SANDBOX_DENIED"
        throw error
      }

      if (expected?.kind === "createIfAbsent" && before !== undefined) {
        const error = new Error("file exists")
        error.code = "FS_EXISTS"
        throw error
      }
      if (expected?.kind === "replaceIfVersion") {
        if (before === undefined || before.version !== expected.version) {
          const error = new Error("FS_STALE_VERSION: file changed on disk")
          error.code = "FS_STALE_VERSION"
          throw error
        }
      }

      const version = `v${(counter += 1)}`
      files.set(resolved, { content, version })
      /* 记录第 5 个参数：保存提权的回归锁就是「必须显式传全权策略」。 */
      writes.push({ path: resolved, content, expected, version, sandboxPolicy })
      return {
        operation: before === undefined ? "create" : "update",
        version,
        before: before?.content ?? null,
        after: content,
      }
    },
    async editText(target, edit, expected) {
      const resolved = target?.targetKey ?? key(target)
      const before = files.get(resolved)
      if (before === undefined) {
        const error = new Error("ENOENT")
        error.code = "ENOENT"
        throw error
      }
      if (expected?.version !== undefined && expected.version !== before.version) {
        const error = new Error("FS_STALE_VERSION")
        error.code = "FS_STALE_VERSION"
        throw error
      }
      const after = before.content.split(edit.oldString).join(edit.newString)
      const version = `v${(counter += 1)}`
      files.set(resolved, { content: after, version })
      return { version, before: before.content, after }
    },
  }
}

/**
 * 伪 tools 服务：记录每次 execute 调用，可按脚本返回成功/失败。
 *
 * @param options - `{ result, error, visible }`
 * @returns tools 服务桩件（含 `__calls` 供断言）
 */
export function fakeTools({ result, error, visible } = {}) {
  const calls = []
  const defaultResult = { isError: false, value: { content: "ok" }, content: [] }
  return {
    __calls: calls,
    get(name) {
      if (typeof visible === "function") return visible(name) ? { name } : undefined
      if (Array.isArray(visible)) return visible.includes(name) ? { name } : undefined
      return { name }
    },
    schemas: () => [],
    async execute(exec) {
      calls.push(exec)
      if (error !== undefined) throw error
      if (typeof result === "function") return result(exec)
      return result ?? defaultResult
    },
  }
}

/** 伪 agents 服务。 */
export function fakeAgents(list = []) {
  const byId = new Map(list.map((agent) => [String(agent.id), agent]))
  return {
    get: (id) => byId.get(String(id)),
    list: () => [...list],
    roots: () => [...list],
    currentInitiator: () => list[0],
  }
}

/**
 * 构造伪 Cordis 上下文。
 *
 * @param options - `{ services, agent, agents, tools, fs }`
 * @returns 上下文桩件（含 `routes` / `request` 便于驱动路由）
 */
export function fakeCtx({ services = {}, cwd } = {}) {
  const table = { ...services }
  if (cwd !== undefined) table.__cwd = cwd
  const logs = { info: [], warn: [] }

  const scope = {
    get: (name) => table[name],
    effect: (cb) => {
      const disposer = cb()
      return () => {
        if (typeof disposer === "function") disposer()
      }
    },
  }

  const ctx = {
    ...scope,
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
    inject: (_dependencies, callback) => {
      callback(scope)
      return { dispose() {} }
    },
  }

  return { ctx, services: table, logs }
}

/**
 * 伪 req（我的 readBody 用 req.on('data'|'end')）。
 *
 * 默认带 `application/json` Content-Type：宿主半现在要求 POST 必须是 JSON
 * （见 lib/impl.js 的 isJsonContentType）；需要测非 JSON 时用 `headers` 覆盖。
 * `origin` / `secFetchSite` 用于测跨站拒绝。
 *
 * @param options - `{ method, url, body, rawBody, remoteAddress, headers, origin, secFetchSite }`
 */
export function fakeReq({
  method = "GET",
  url = "/",
  body,
  remoteAddress = "127.0.0.1",
  rawBody,
  headers,
  origin,
  secFetchSite,
} = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {
    host: "127.0.0.1:19387",
    "content-type": "application/json",
    ...(origin === undefined ? {} : { origin }),
    ...(secFetchSite === undefined ? {} : { "sec-fetch-site": secFetchSite }),
    ...headers,
  }
  req.socket = { remoteAddress }
  setImmediate(() => {
    if (rawBody !== undefined) req.emit("data", Buffer.from(rawBody))
    else if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)))
    req.emit("end")
  })
  return req
}

/** 伪 res。 */
export function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

/** 解析响应体 JSON。 */
export const json = (res) => JSON.parse(res.body)

/**
 * 驱动一条路由 handler。
 *
 * @param spec - 路由规格（buildRouteSpecs 的产物）
 * @param options - `{ method, url, body, remoteAddress, rawBody }`
 * @returns 伪 res
 */
export async function callRoute(spec, options = {}) {
  const res = fakeRes()
  await spec.handler(fakeReq({ method: spec.__method ?? options.method ?? "GET", ...options }), res)
  return res
}

/**
 * 把 buildRouteSpecs 的结果包成「按路径 + 方法」可查询的结构。
 *
 * 路由规格本身不带 method 字段（方法由 handler 内部按契约判定），因此这里
 * 显式维护一份契约表：**这份表就是宿主半对外的接口契约**，与浏览器半必须一致。
 */
export const METHOD_BY_PATH = {
  "/api/edit-agents/state": "GET",
  "/api/edit-agents/files": "GET",
  "/api/edit-agents/save": "POST",
  "/api/edit-agents/refresh": "POST",
}

/**
 * 给路由规格标注方法（仅测试用，不污染生产对象）。
 *
 * @param specs - buildRouteSpecs 的产物
 * @returns 带 __method 的规格数组
 */
export function annotate(specs) {
  return specs.map((spec) => ({ ...spec, __method: METHOD_BY_PATH[spec.path] ?? "GET" }))
}
