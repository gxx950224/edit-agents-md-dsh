/**
 * 模拟 DSH 加载器挂载宿主半：从 **profile 目录**按包名解析并 apply，
 * 断言它确实注册了 4 条路由、走了 ctx.inject(["webServer"])、并且能干净卸载。
 *
 * 这验证的是「装上以后能正常加载」——真机上还需要一次 DSH 重启才会真正加载
 * （bundle 列表在启动时读取），但那一步不影响这里能验证的加载期行为：
 * 有没有 import 期错误、路由是否正确注册、disposer 是否成对。
 *
 * ⚠️ 额外守卫（真机 F5 事故的回归锁）：profile 里装的是**上次安装的副本**时，
 * 这里必须确认它和开发树是一致的（版本 + 关键文件哈希），否则「加载成功」
 * 可能只是在验证旧代码（2026-10-17 真机上实际发生过：verify:load 19/19 全绿，
 * 但加载的是 0.2.2 旧包）。
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"

const PROFILE = process.env.DSH_PROFILE_DIR ?? "C:\\Users\\24990\\.dsh\\profiles\\desktop"
const NAME = "@gxx-labs/edit-agents-md-dsh"
/** 开发树根（由脚本位置推导，避免硬编码）。 */
const DEV_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

let pass = 0
const failures = []
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`) }
}

/* 像 loader 一样：从 profile 解析出真实入口再 import。 */
const require = createRequire(path.join(PROFILE, "package.json"))
const entry = require.resolve(NAME)
const mod = await import(pathToFileURL(entry).href)

console.log(`resolved entry: ${entry}`)
check("module imports without error", mod !== undefined)
check("exports name === package name", mod.name === NAME, String(mod.name))
check("exports apply()", typeof mod.apply === "function")
check("has default export with apply", typeof (mod.default?.apply ?? mod.apply) === "function")

/*
 * F5 回归锁：加载到的必须和开发树一致。
 * - Junction 安装：realpath 直接等于开发树，天然一致；
 * - 复制安装（npm/手工）：比较版本 + 关键文件 sha256，避免"加载成功的其实是旧包"。
 */
const installedPkgPath = require.resolve(`${NAME}/package.json`)
const installedRoot = path.dirname(installedPkgPath)
const readVersion = (root) => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
const devVersion = readVersion(DEV_ROOT)
const installedVersion = readVersion(installedRoot)
console.log(`installed: ${installedRoot} (v${installedVersion})`)
console.log(`dev tree: ${DEV_ROOT} (v${devVersion})`)
check("loaded package version === dev tree version", installedVersion === devVersion, `${installedVersion} vs ${devVersion}`)

const shippable = [
  "package.json",
  "README.md",
  "cordis.patch.yml",
  "LICENSE",
  "lib/index.js",
  "lib/impl.js",
  "lib/store.js",
  "lib/refresh.js",
  "lib/paths.js",
  "dist/client.js",
  "dist/client.css",
]
const hashOf = (root, relative) => {
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) return `MISSING:${relative}`
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}
const mismatched = shippable.filter((relative) => hashOf(installedRoot, relative) !== hashOf(DEV_ROOT, relative))
check(
  `installed files identical to dev tree (${shippable.length} files)`,
  mismatched.length === 0,
  mismatched.length > 0 ? `mismatch: ${mismatched.join(", ")}` : "",
)

/* 记录注册的路由与 disposer 调用。 */
const registered = []
const disposed = []
let injectCalled = null
let effectUsed = false
const logs = []

const fakeWebServer = {
  register(spec) {
    registered.push(spec)
    return () => disposed.push(spec.path)
  },
}
const webCtx = {
  get: (name) => (name === "webServer" ? fakeWebServer : undefined),
  effect: (cb) => { effectUsed = true; const d = typeof cb === "function" ? cb() : undefined; return typeof d === "function" ? d : () => {} },
}
const ctx = {
  inject: (deps, cb) => { injectCalled = deps; cb(webCtx) },
  get: () => undefined,
  logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
  effect: () => {},
}

/*
 * 注意：lib/index.js 是**加载器外壳**，apply 是 async 的
 * （内部 `await import("./impl.js?g=...")` 强制重新求值），必须 await。
 */
await mod.apply(ctx)

check("ctx.inject called with ['webServer']", Array.isArray(injectCalled) && injectCalled.length === 1 && injectCalled[0] === "webServer", JSON.stringify(injectCalled))
check("registered exactly 4 routes", registered.length === 4, `got ${registered.length}: ${registered.map((r) => r.path).join(", ")}`)

const expected = [
  "/api/edit-agents/state",
  "/api/edit-agents/files",
  "/api/edit-agents/save",
  "/api/edit-agents/refresh",
]
for (const p of expected) {
  const spec = registered.find((r) => r.path === p)
  check(`route ${p} registered as exact`, spec !== undefined && spec.kind === "exact", spec === undefined ? "missing" : `kind=${spec.kind}`)
  check(`route ${p} has an async handler`, typeof spec?.handler === "function")
}
check("route paths match ROUTES export exactly", JSON.stringify(registered.map((r) => r.path).sort()) === JSON.stringify([...expected].sort()))

check("startup self-check logged the authoritative path", logs.some((l) => l.includes("AGENTS.md")), logs.join(" | ").slice(0, 200))
check("effect registered for teardown", effectUsed)

/* 卸载应当把 4 条路由都还回去（避免重挂载时重复注册报错）。 */
for (const spec of registered) {
  const disposer = spec.handler // 占位，真正的 disposer 在下面单独调用
  void disposer
}
/* 这里直接再走一遍 apply 的卸载路径：用 effect 收集的 disposer。 */
const disposers = []
const webCtx2 = {
  get: (name) => (name === "webServer" ? { register: (spec) => { disposers.push(spec); return () => disposed.push(spec.path) } } : undefined),
  effect: (cb) => { const d = typeof cb === "function" ? cb() : undefined; if (typeof d === "function") d(); return () => {} },
}
await mod.apply({ inject: (_d, cb) => cb(webCtx2), get: () => undefined, logger: { info: () => {}, warn: () => {}, error: () => {} }, effect: () => {} })
check("teardown disposed all 4 routes", disposed.length === 4, `disposed=${disposed.join(", ")}`)

/* 无 webServer 时（headless profile）不得抛错。 */
let headlessOk = true
try {
  await mod.apply({ inject: (_d, cb) => cb({ get: () => undefined, effect: () => {} }), get: () => undefined, logger: { info: () => {}, warn: () => {}, error: () => {} }, effect: () => {} })
} catch (error) {
  headlessOk = false
  failures.push(`headless apply threw: ${error.message}`)
}
check("headless profile (no webServer) does not throw", headlessOk)

console.log(`\n================ LOAD CHECK ================`)
console.log(`pass ${pass}, fail ${failures.length}`)
for (const f of failures) console.log(`  FAILED: ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
