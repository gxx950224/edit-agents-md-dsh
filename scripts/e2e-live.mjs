/**
 * edit-agents-md-dsh 端到端验证（真 HTTP + 真文件系统）。
 *
 * 与 test/*.test.mjs 的区别：那些用桩件（证明逻辑正确）；这里**真的**起一个
 * http.Server、真的读写磁盘、真的按 fs 服务契约做版本守卫 —— 证明这些 handler
 * 在真实 I/O 与真实 HTTP 语义下确实工作。
 *
 * fs 服务适配器严格照抄宿主契约：
 *   resolve(path) -> FsTarget{targetKey, displayPath}
 *   stat(target)  -> { version, type, size } | undefined
 *   readText(target) -> string
 *   writeText(target, content, expected) -> { operation, version, before, after }
 *     expected = {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version}
 *   version 用内容 sha1（内容不变则不变，变了必变）。
 *
 * 所有写入都发生在临时目录里，**绝不触碰用户的真实 ~/.dsh/AGENTS.md**；
 * 真实文件只做一次只读校验。
 */
import http from "node:http"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { pathToFileURL, fileURLToPath } from "node:url"

/* 由脚本自身位置推导包根，便于在任何 checkout 下运行。 */
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const { buildRouteSpecs, ROUTES } = await import(pathToFileURL(path.join(PLUGIN, "lib", "impl.js")).href)

/* ---------------- 极小断言框架 ---------------- */
let pass = 0
const failures = []
function check(name, condition, detail = "") {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` :: ${detail}` : ""}`)
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`)
  }
}

/* ---------------- 临时环境 ---------------- */
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "edit-agents-e2e-"))
const homeDir = path.join(tmpRoot, "dsh-home")
const projectDir = path.join(tmpRoot, "project")
await fsp.mkdir(homeDir, { recursive: true })
await fsp.mkdir(path.join(projectDir, ".git"), { recursive: true })

const SEED = "# global instructions\n\nrule: be precise\n"
const COMPAT = "# compat spelling (NOT loaded by DSH)\n"
await fsp.writeFile(path.join(homeDir, "AGENTS.md"), SEED, "utf8")
await fsp.writeFile(path.join(homeDir, "AGENT.md"), COMPAT, "utf8")
await fsp.writeFile(path.join(homeDir, "CLAUDE.md"), "# claude\n", "utf8")
await fsp.writeFile(path.join(projectDir, "AGENTS.md"), "# project instructions\n", "utf8")

/* 让 DSH_HOME 指向临时目录（paths.js 每次调用都读 process.env）。 */
process.env.DSH_HOME = homeDir

/* ---------------- fs 服务适配器（照抄契约） ---------------- */
const hash = (text) => crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16)
function fsError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
const fsService = {
  /** 记录每次真实 writeText 的第 5 参策略，供提权回归断言用。 */
  __writes: [],
  async resolve(p) {
    const abs = path.resolve(p)
    return { targetKey: abs, displayPath: abs }
  },
  async stat(target) {
    try {
      const st = await fsp.stat(target.targetKey)
      if (!st.isFile()) return { version: `dir-${st.size}`, type: st.isDirectory() ? "directory" : "other", size: st.size }
      const text = await fsp.readFile(target.targetKey, "utf8")
      return { version: hash(text), type: "file", size: st.size }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    return fsp.readFile(target.targetKey, "utf8")
  },
  async writeText(target, content, expected, signal, sandboxPolicy) {
    /*
     * 忠实模拟 SandboxedFileSystem 的围栏（本插件的场景 = 目标在会话 workspace
     * 之外）：只有显式传入 danger-full-access 才放行，其余模式一律
     * FS_SANDBOX_DENIED，且拒绝发生在版本守卫之前。
     *
     * 插件的保存固定自带全权策略，因此本文件里所有正常保存都必须带着它；
     * 如果将来有人删掉第 5 个参数，这里会立刻变成 403 —— 这就是回归锁。
     */
    const policy = sandboxPolicy ?? { mode: "workspace-write", workspaceRoot: path.join(tmpRoot, "workspace") }
    if (policy.mode !== "danger-full-access") {
      throw fsError("FS_SANDBOX_DENIED", `cannot write "${target.displayPath}": file access denied under ${policy.mode} mode`)
    }
    this.__writes.push({ path: target.targetKey, policy })
    let before = null
    let exists = false
    try {
      before = await fsp.readFile(target.targetKey, "utf8")
      exists = true
    } catch {
      exists = false
    }
    if (expected?.kind === "createIfAbsent" && exists) {
      throw fsError("FS_EXISTS", "target already exists")
    }
    if (expected?.kind === "replaceIfVersion") {
      const current = exists ? hash(before) : undefined
      if (current !== expected.version) {
        throw fsError("FS_STALE_VERSION", `expected ${expected.version}, found ${current}`)
      }
    }
    await fsp.mkdir(path.dirname(target.targetKey), { recursive: true })
    await fsp.writeFile(target.targetKey, content, "utf8")
    return { operation: exists ? "update" : "create", version: hash(content), before, after: content }
  },
}

/**
 * 造一个 ctx。
 * @param options - `{ tools, agents }` 桩件（省略即为"服务不可用"的降级场景）
 */
function makeCtx({ tools, agents } = {}) {
  const services = { fs: fsService, profileContext: { patchPath: path.join(tmpRoot, "cordis.patch.yml") } }
  if (tools !== undefined) services.tools = tools
  if (agents !== undefined) services.agents = agents
  return {
    get: (name) => services[name],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject: () => {},
    effect: () => {},
  }
}

/* ---------------- 真 HTTP 服务器 ---------------- */
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname
  const spec = specs.find((s) => s.path === pathname)
  if (spec === undefined) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: false, error: "no route" }))
    return
  }
  spec.handler(req, res)
})
let specs = []
function mount(ctx) {
  specs = buildRouteSpecs(ctx)
  return specs
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

async function call(method, routePath, body) {
  const res = await fetch(BASE + routePath, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}
/** 发一个**非法 JSON** 体（测 400）。 */
async function callRaw(method, routePath, raw) {
  const res = await fetch(BASE + routePath, {
    method,
    headers: { "content-type": "application/json" },
    body: raw,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

/**
 * 发一个**原始 HTTP** 请求（fetch 不允许改 Host 头）。
 *
 * 用来复现 DNS-rebinding 形态：浏览器访问 evil.example（DNS 指向 127.0.0.1）时，
 * Host 与 Origin 都是 evil.example，相对比较会骗过「Origin.host === Host」。
 *
 * @param options - `{ method, routePath, headers, body }`
 * @returns `{ status, data }`
 */
function rawRequest({ method = "POST", routePath, headers = {}, body = "" } = {}) {
  return new Promise((resolve) => {
    const port = server.address().port
    const req = http.request(
      { host: "127.0.0.1", port, path: routePath, method, headers },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString("utf8") }),
        )
      },
    )
    req.on("error", () => resolve({ status: 0, data: "" }))
    req.end(body)
  })
}

/** 尽力解析原始响应的 JSON。 */
function parseBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const AUTH_FILE = path.join(homeDir, "AGENTS.md")
const COMPAT_FILE = path.join(homeDir, "AGENT.md")

/* ================= 1. 读取（无 tools/agents → 降级场景） ================= */
console.log("\n=== 1. GET state / files (no tools, no agents) ===")
mount(makeCtx())

const state1 = await call("GET", ROUTES.state)
check("state 200", state1.status === 200, `got ${state1.status}`)
check("state ok=true", state1.data?.ok === true)
check("home === temp DSH_HOME", state1.data?.home === homeDir, `got ${state1.data?.home}`)
check("authoritativePath = $DSH_HOME/AGENTS.md", state1.data?.authoritativePath === AUTH_FILE, `got ${state1.data?.authoritativePath}`)
check("selected.content = seeded text", state1.data?.selected?.content === SEED)
check("selected.version present", typeof state1.data?.selected?.version === "string" && state1.data.selected.version.length > 0)
check("budget.budget is a number", typeof state1.data?.budget?.budget === "number")
check("writing.allowed = true", state1.data?.writing?.allowed === true)
check("writing.mode = danger-full-access (插件固定提权写入)", state1.data?.writing?.mode === "danger-full-access", `got ${String(state1.data?.writing?.mode)}`)
check("writing.elevated = true", state1.data?.writing?.elevated === true)
check("writing 不再提示切会话权限（reason 为空）", state1.data?.writing?.reason === undefined, `got ${String(state1.data?.writing?.reason)}`)
check("refreshLimits is a non-empty array", Array.isArray(state1.data?.refreshLimits) && state1.data.refreshLimits.length > 0)
const files1 = state1.data?.files ?? []
check("files include AGENTS.md as authoritative", files1.some((f) => f.filename === "AGENTS.md" && f.authoritative === true && f.role === "authoritative"))
check("files include singular AGENT.md as user-compat (NOT authoritative)", files1.some((f) => f.filename === "AGENT.md" && f.role === "user-compat" && f.authoritative === false))
check("files include project-level AGENTS.md (scope=project)", files1.some((f) => f.scope === "project" && f.filename === "AGENTS.md"))
check("no top-level 'active'/'maxBytes'/'writable' drift", state1.data?.active === undefined && state1.data?.maxBytes === undefined && state1.data?.writable === undefined)

const filesRoute = await call("GET", ROUTES.files)
check("files 200 + ok", filesRoute.status === 200 && filesRoute.data?.ok === true)
check("files has no 'selected'", filesRoute.data?.selected === undefined)
check("files.authoritativePath matches", filesRoute.data?.authoritativePath === AUTH_FILE)

/* ================= 2. 写入守卫 ================= */
console.log("\n=== 2. POST save guards ===")
const v1 = state1.data.selected.version

const stale = await call("POST", ROUTES.save, { path: AUTH_FILE, content: "# stale write\n", version: "deadbeefdeadbeef" })
check("stale version -> 409", stale.status === 409, `got ${stale.status}`)
check("409 code = FS_STALE_VERSION", stale.data?.code === "FS_STALE_VERSION", `got ${stale.data?.code}`)
check("409 carries current version for reload", typeof stale.data?.current === "string" && stale.data.current === v1, `got ${stale.data?.current}`)
const onDiskAfter409 = await fsp.readFile(AUTH_FILE, "utf8")
check("409 did NOT overwrite the file", onDiskAfter409 === SEED)

const outside = path.join(tmpRoot, "..", "outside-not-a-candidate.md")
const forbidden = await call("POST", ROUTES.save, { path: outside, content: "x", version: v1 })
check("non-candidate path -> 403", forbidden.status === 403, `got ${forbidden.status}`)
check("403 code = path/not-allowed", forbidden.data?.code === "path/not-allowed", `got ${forbidden.data?.code}`)

const traversal = await call("POST", ROUTES.save, { path: path.join(homeDir, "..", "escape.md"), content: "x", version: v1 })
check("traversal-ish path -> 403", traversal.status === 403, `got ${traversal.status}`)

const createExisting = await call("POST", ROUTES.save, { path: AUTH_FILE, content: "x", create: true })
check("create on existing -> 409 path/already-exists", createExisting.status === 409 && createExisting.data?.code === "path/already-exists", `got ${createExisting.status}/${createExisting.data?.code}`)

const missingVersion = await call("POST", ROUTES.save, { path: AUTH_FILE, content: "x" })
check("overwrite without version -> 400 version/missing", missingVersion.status === 400 && missingVersion.data?.code === "version/missing", `got ${missingVersion.status}/${missingVersion.data?.code}`)

const missingContent = await call("POST", ROUTES.save, { path: AUTH_FILE, version: v1 })
check("missing content -> 400 content/missing", missingContent.status === 400 && missingContent.data?.code === "content/missing", `got ${missingContent.status}/${missingContent.data?.code}`)

const missingPath = await call("POST", ROUTES.save, { content: "x" })
check("missing path -> 400 path/missing", missingPath.status === 400 && missingPath.data?.code === "path/missing", `got ${missingPath.status}/${missingPath.data?.code}`)

/* 近邻白名单：另一个目录下的同名 AGENTS.md 不是候选，必须 403（F8 回归锁）。 */
const neighborDir = path.join(tmpRoot, "elsewhere")
await fsp.mkdir(neighborDir, { recursive: true })
const neighbor = path.join(neighborDir, "AGENTS.md")
await fsp.writeFile(neighbor, "# neighbor\n", "utf8")
const neighborRes = await call("POST", ROUTES.save, { path: neighbor, content: "PWNED", version: v1 })
check(
  "near-neighbor AGENTS.md in another dir -> 403 path/not-allowed",
  neighborRes.status === 403 && neighborRes.data?.code === "path/not-allowed",
  `got ${neighborRes.status}/${neighborRes.data?.code}`,
)
check("near-neighbor file untouched", (await fsp.readFile(neighbor, "utf8")) === "# neighbor\n")

/* 同目录前缀近邻与 NTFS ADS：都不能命中白名单（M4 的 e2e 补洞）。 */
for (const [label, candidatePath] of [
  ["same-dir prefix sibling AGENTS.md.bak", path.join(homeDir, "AGENTS.md.bak")],
  ["NTFS ADS AGENTS.md:evil", path.join(homeDir, "AGENTS.md:evil")],
]) {
  const res = await call("POST", ROUTES.save, { path: candidatePath, content: "PWNED", version: v1 })
  check(
    `${label} -> 403 path/not-allowed`,
    res.status === 403 && res.data?.code === "path/not-allowed",
    `got ${res.status}/${res.data?.code}`,
  )
}
check("prefix/ADS attempts did not create files", !fs.existsSync(path.join(homeDir, "AGENTS.md.bak")))

/* 预算硬边界：超过 DSH maxSourceBytes（1 MiB）→ 413 且不落盘。 */
const stateForBudget = await call("GET", ROUTES.state)
const budgetVersion = stateForBudget.data?.selected?.version
const tooLarge = await call("POST", ROUTES.save, {
  path: AUTH_FILE,
  content: "x".repeat(1024 * 1024 + 1),
  version: budgetVersion,
})
check(
  "content > 1 MiB -> 413 content/too-large",
  tooLarge.status === 413 && tooLarge.data?.code === "content/too-large",
  `got ${tooLarge.status}/${tooLarge.data?.code}`,
)
check("oversized save did not modify the file", (await fsp.readFile(AUTH_FILE, "utf8")) === SEED)

/* ================= 3. 正常写入 ================= */
console.log("\n=== 3. POST save happy path ===")
const NEW = "# global instructions\n\nrule: be precise\nrule2: be honest\n"
const saved = await call("POST", ROUTES.save, { path: AUTH_FILE, content: NEW, version: v1 })
check("save 200 ok", saved.status === 200 && saved.data?.ok === true, `got ${saved.status}`)
check("saved nested shape (path/version/bytes/created)", typeof saved.data?.saved?.version === "string" && typeof saved.data?.saved?.bytes === "number" && saved.data?.saved?.created === false)
check("saved.path = canonical absolute", saved.data?.saved?.path === AUTH_FILE, `got ${saved.data?.saved?.path}`)
check("no top-level version/bytes drift", saved.data?.version === undefined && saved.data?.bytes === undefined)
const onDisk = await fsp.readFile(AUTH_FILE, "utf8")
check("file actually changed on disk", onDisk === NEW)
check(
  "save 使用了插件的最高权限策略（danger-full-access）",
  fsService.__writes.at(-1)?.policy?.mode === "danger-full-access",
  `got ${String(fsService.__writes.at(-1)?.policy?.mode)}`,
)
check("new version differs from old", saved.data?.saved?.version !== v1)
check("save response carries files[]", Array.isArray(saved.data?.files))

const afterSave = await call("GET", ROUTES.state)
check("re-read returns new content", afterSave.data?.selected?.content === NEW)
check("re-read version matches saved version", afterSave.data?.selected?.version === saved.data?.saved?.version)

/* 新建候选（AGENTS.local.md 尚不存在） */
const LOCAL_FILE = path.join(homeDir, "AGENTS.local.md")
const created = await call("POST", ROUTES.save, { path: LOCAL_FILE, content: "# local overlay\n", create: true })
check("create new candidate -> 200 created", created.status === 200 && created.data?.saved?.created === true, `got ${created.status}/${created.data?.saved?.created}`)
check("created file exists on disk", fs.existsSync(LOCAL_FILE))

/* 空串清空是合法操作 */
const cleared = await call("POST", ROUTES.save, { path: LOCAL_FILE, content: "", version: created.data?.saved?.version })
check("empty content allowed (clear file)", cleared.status === 200 && (await fsp.readFile(LOCAL_FILE, "utf8")) === "")

/* ================= 4. 方法/协议边界 ================= */
console.log("\n=== 4. method + protocol boundaries ===")
const wrongMethodGet = await call("POST", ROUTES.state, {})
check("POST on GET route -> 405", wrongMethodGet.status === 405, `got ${wrongMethodGet.status}`)
const wrongMethodPost = await call("GET", ROUTES.save)
check("GET on POST route -> 405", wrongMethodPost.status === 405, `got ${wrongMethodPost.status}`)
const badJson = await callRaw("POST", ROUTES.save, "{not json")
check("bad JSON body -> 400 body/invalid-json", badJson.status === 400 && badJson.data?.code === "body/invalid-json", `got ${badJson.status}/${badJson.data?.code}`)

/* 提权后的 CSRF 防线：跨站 Origin 与非 JSON Content-Type 必须在 handler 之前被拒。 */
const writesBeforeCsrf = fsService.__writes.length
const crossOrigin = await fetch(BASE + ROUTES.save, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://evil.example" },
  body: JSON.stringify({ path: AUTH_FILE, content: "# PWNED BY CROSS SITE\n", version: "whatever" }),
})
const crossOriginBody = await crossOrigin.json().catch(() => null)
check(
  "cross-origin save -> 403 auth/cross-origin",
  crossOrigin.status === 403 && crossOriginBody?.code === "auth/cross-origin",
  `got ${crossOrigin.status}/${crossOriginBody?.code}`,
)
check("cross-origin save did NOT write", fsService.__writes.length === writesBeforeCsrf)
const plainText = await fetch(BASE + ROUTES.save, {
  method: "POST",
  headers: { "content-type": "text/plain;charset=UTF-8" },
  body: JSON.stringify({ path: AUTH_FILE, content: "# PWNED VIA TEXT/PLAIN\n", version: "whatever" }),
})
const plainTextBody = await plainText.json().catch(() => null)
check(
  "text/plain save -> 415 content/type-required",
  plainText.status === 415 && plainTextBody?.code === "content/type-required",
  `got ${plainText.status}/${plainTextBody?.code}`,
)
check("text/plain save did NOT write", fsService.__writes.length === writesBeforeCsrf)
const onDiskAfterCsrf = await fsp.readFile(AUTH_FILE, "utf8")
check("CSRF attempts did not modify the file", onDiskAfterCsrf === NEW)

/*
 * DNS-rebinding 形态（F1 回归锁）：Host 与 Origin 互相自洽，但 Host 不是回环
 * 字面量。只比较 Origin.host === Host 的旧实现会放行；绝对 Host 校验必须拒绝。
 */
const writesBeforeRebinding = fsService.__writes.length
const rebinding = await rawRequest({
  routePath: ROUTES.save,
  headers: {
    host: "evil.example:5380",
    origin: "http://evil.example:5380",
    "content-type": "application/json",
  },
  body: JSON.stringify({ path: AUTH_FILE, content: "# PWNED BY DNS REBINDING\n", version: "whatever" }),
})
check(
  "DNS-rebinding save -> 403 auth/cross-origin",
  rebinding.status === 403 && parseBody(rebinding.data)?.code === "auth/cross-origin",
  `got ${rebinding.status}/${parseBody(rebinding.data)?.code}`,
)
check("DNS-rebinding did not write", fsService.__writes.length === writesBeforeRebinding)
const rebindingNoOrigin = await rawRequest({
  routePath: ROUTES.save,
  headers: { host: "evil.example:5380", "content-type": "application/json" },
  body: JSON.stringify({ path: AUTH_FILE, content: "# PWNED WITHOUT ORIGIN\n", version: "whatever" }),
})
check(
  "non-loopback Host without Origin -> 403",
  rebindingNoOrigin.status === 403 && parseBody(rebindingNoOrigin.data)?.code === "auth/cross-origin",
  `got ${rebindingNoOrigin.status}/${parseBody(rebindingNoOrigin.data)?.code}`,
)
const ipv6Loopback = await rawRequest({
  routePath: ROUTES.save,
  headers: { host: "[::1]:5380", origin: "http://[::1]:5380", "content-type": "application/json" },
  body: JSON.stringify({}),
})
check(
  "IPv6 loopback Host accepted (reaches field validation)",
  ipv6Loopback.status === 400 && parseBody(ipv6Loopback.data)?.code === "path/missing",
  `got ${ipv6Loopback.status}/${parseBody(ipv6Loopback.data)?.code}`,
)
check("post-rebinding disk unchanged", (await fsp.readFile(AUTH_FILE, "utf8")) === NEW)
const unknown = await call("GET", "/api/edit-agents/nope")
check("unknown route -> 404", unknown.status === 404)

/* 非 loopback：直接调 handler（loopback 判定先于读体，无需真网络） */
const saveSpec = specs.find((s) => s.path === ROUTES.save)
let nonLoopStatus = 0
await new Promise((resolve) => {
  saveSpec.handler(
    { method: "POST", socket: { remoteAddress: "10.20.30.40" }, on: () => {}, headers: {} },
    { writeHead: (s) => { nonLoopStatus = s }, end: () => resolve() },
  )
  setTimeout(resolve, 50)
})
check("non-loopback POST -> 403", nonLoopStatus === 403, `got ${nonLoopStatus}`)

/* ================= 5. state 不回传任意文件内容 ================= */
console.log("\n=== 5. state must not leak arbitrary files ===")
const secret = path.join(tmpRoot, "secret.txt")
await fsp.writeFile(secret, "TOP SECRET\n", "utf8")
const leak = await call("GET", `${ROUTES.state}?path=${encodeURIComponent(secret)}`)
check("?path=<non-candidate> falls back to authoritative", leak.data?.selected?.content === NEW, `got ${String(leak.data?.selected?.content).slice(0, 40)}`)
check("?path=<non-candidate> does NOT leak secret", JSON.stringify(leak.data ?? {}).includes("TOP SECRET") === false)

/* ================= 6. 刷新：诚实降级 + 真实成功分支 ================= */
console.log("\n=== 6. refresh honesty ===")
const noServices = await call("POST", ROUTES.refresh, { path: AUTH_FILE })
check("refresh without tools/agents -> HTTP 200", noServices.status === 200, `got ${noServices.status}`)
check("refresh degraded ok=false", noServices.data?.ok === false, `got ${noServices.data?.ok}`)
check("refresh degraded refreshed=false", noServices.data?.refreshed === false)
check("refresh degraded has readable reason", typeof noServices.data?.reason === "string" && noServices.data.reason.length > 0)
check("refresh degraded has fallback guidance", typeof noServices.data?.fallback === "string" && noServices.data.fallback.length > 0)

/* 真实成功分支：给出 agents + tools 桩件，验证我们确实发起了带 agent 的 read 调用 */
let seenExec = null
const goodAgent = { id: "session-e2e", session: { header: { cwd: projectDir } } }
mount(
  makeCtx({
    agents: { list: () => [goodAgent], roots: () => [goodAgent], get: (id) => (id === "session-e2e" ? goodAgent : undefined), currentInitiator: () => goodAgent },
    tools: {
      get: () => ({ name: "read" }),
      execute: async (exec) => {
        seenExec = exec
        return { isError: false, value: { ok: true }, content: [] }
      },
    },
  }),
)
const okRefresh = await call("POST", ROUTES.refresh, { path: AUTH_FILE })
check("refresh success -> ok=true", okRefresh.data?.ok === true, `got ${JSON.stringify(okRefresh.data)?.slice(0, 200)}`)
check("refresh success -> refreshed=true", okRefresh.data?.refreshed === true)
check("refresh used a touch-eligible tool name (read/write/edit)", ["read", "write", "edit"].includes(seenExec?.name), `got ${seenExec?.name}`)
check("refresh passed file_path = the saved file (absolute)", seenExec?.arguments?.file_path === AUTH_FILE, `got ${seenExec?.arguments?.file_path}`)
check("refresh passed an agent (mandatory for touch)", seenExec?.agent !== undefined && seenExec.agent?.id === "session-e2e")
check("refresh passed a callId", typeof seenExec?.callId === "string" && seenExec.callId.length > 0)
check("refresh passed a signal", seenExec?.signal !== undefined)

/* 工具报错 → 必须诚实降级，不能谎报成功 */
mount(
  makeCtx({
    agents: { list: () => [goodAgent], roots: () => [], get: () => goodAgent, currentInitiator: () => goodAgent },
    tools: { get: () => ({ name: "read" }), execute: async () => ({ isError: true, error: { message: "denied outside workspace", info: { code: "FS_DENIED" } }, content: [] }) },
  }),
)
const toolError = await call("POST", ROUTES.refresh, { path: AUTH_FILE })
check("tool isError -> ok=false (never fakes success)", toolError.data?.ok === false, `got ${JSON.stringify(toolError.data)?.slice(0, 200)}`)
check("tool error reason surfaces the tool code/message", /FS_DENIED|denied/i.test(String(toolError.data?.reason)), `got ${String(toolError.data?.reason).slice(0, 160)}`)

/* 有 agent 但 tools 服务缺失 */
mount(makeCtx({ agents: { list: () => [goodAgent], roots: () => [], get: () => goodAgent, currentInitiator: () => goodAgent } }))
const noTools = await call("POST", ROUTES.refresh, { path: AUTH_FILE })
check("agent but no tools -> ok=false with reason", noTools.data?.ok === false && typeof noTools.data?.reason === "string")

/* refresh 也受白名单限制 */
mount(makeCtx())
const refreshForbidden = await call("POST", ROUTES.refresh, { path: secret })
check("refresh on non-candidate -> 403", refreshForbidden.status === 403, `got ${refreshForbidden.status}`)

/* ================= 7. 真实 DSH_HOME 只读校验 ================= */
console.log("\n=== 7. read-only check against the REAL DSH_HOME ===")
const realHome = path.join(os.homedir(), ".dsh")
const realAgents = path.join(realHome, "AGENTS.md")
if (fs.existsSync(realAgents)) {
  process.env.DSH_HOME = realHome
  mount(makeCtx())
  const realState = await call("GET", ROUTES.state)
  const realDisk = await fsp.readFile(realAgents, "utf8")
  check("real DSH_HOME authoritativePath correct", realState.data?.authoritativePath === realAgents, `got ${realState.data?.authoritativePath}`)
  check("real AGENTS.md content read correctly (byte-identical)", realState.data?.selected?.content === realDisk, `state=${realState.data?.selected?.content?.length ?? 0} chars, disk=${realDisk.length} chars`)
  check("real file reports exists + version", realState.data?.selected?.exists === true && typeof realState.data?.selected?.version === "string")
  console.log(`  note  real AGENTS.md = ${Buffer.byteLength(realDisk, "utf8")} bytes (read-only, unmodified)`)
} else {
  check("real AGENTS.md present", false, realAgents)
}
process.env.DSH_HOME = homeDir

/* ================= 收尾 ================= */
server.close()
await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})

console.log(`\n================ E2E SUMMARY ================`)
console.log(`pass ${pass}, fail ${failures.length}`)
for (const f of failures) console.log(`  FAILED: ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
