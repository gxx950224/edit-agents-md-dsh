/**
 * edit-agents-md-dsh 浏览器半冒烟测试（jsdom + React）。
 *
 * 为什么需要它：verify-bundle.mjs 只能证明「产物里有这些字符串、注册了槽位」，
 * 证明不了**渲染与交互真的工作**。这里把 **dist/client.js（真实产物）** 加载进
 * jsdom，用假 fetch 打桩四条路由，驱动真实 React 渲染与事件。
 *
 * 覆盖（对齐原始设计的 9 项意图）：
 *   1. 初次加载 → 渲染编辑器，文件列表 / refreshLimits / budget 正确
 *   2. 编辑 → 出现 dirty 标记
 *   3. 保存成功 → 发出的 body 字段名正确（path/content/version），收 nested saved{}
 *   4. 保存 409 → 冲突提示 + 「重新加载」，且**不自动重试覆盖**
 *   5. refresh 降级（HTTP 200 + ok:false）→ 显示 fallback + reason，
 *      **不得**出现「已立即生效」类文案
 *   6. refresh 真成功（ok && refreshed）→ 显示「已刷新：…」并报告投影目标（不谎称"当前会话生效"）
 *   7. **ok:true 但缺 refreshed → 仍必须降级**（两档判读的回归锁）
 *   8. 注册契约：settings.section / id=agents-md / order=27 / label 是 thunk
 *   9. 全程不得调用 window.confirm / window.alert
 *
 * @deepseek-ai/dsh-client-ui-primitives 只存在于 app.asar，无法在此加载，
 * 因此用最小 React 桩件替代 —— 验证的是**本插件的逻辑**，不是 DSH 组件库。
 * 测试名用 ASCII，避免 Windows 控制台把中文回显成乱码造成误判。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { JSDOM } from "jsdom"

const require = createRequire(import.meta.url)
const BUNDLE = path.resolve("dist", "client.js")
const PKG = JSON.parse(fs.readFileSync("package.json", "utf8"))

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

/* ---------------- jsdom 环境（须在 require react-dom 之前建好） ---------------- */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://127.0.0.1:19387/",
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
/* Node 24 的 globalThis.navigator 只有 getter，必须用 defineProperty 覆盖。 */
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* 第 9 项：拦截 confirm/alert，任何调用都记为违规。 */
const violativeDialogs = []
window.confirm = (m) => { violativeDialogs.push(`confirm:${m}`); return true }
window.alert = (m) => { violativeDialogs.push(`alert:${m}`) }

const React = require("react")
const ReactDOMClient = require("react-dom/client")
let act = React.act
if (typeof act !== "function") act = require("react-dom/test-utils").act

/* ---------------- primitives 桩件 ---------------- */
const stub = (tag) => (props) => React.createElement(tag, { "data-stub": tag }, props?.children)
const base = {
  /* 透传 title：有断言就落在按钮的 title 属性上（诚实说明现在收在 tooltip 里）。 */
  Button: (props) => React.createElement("button", { type: "button", disabled: props.disabled, onClick: props.onClick, title: props.title }, props.children),
  /* Modal 桩件也要渲染 footer —— 丢弃确认的按钮在那里（标题/描述一并渲染便于断言）。 */
  Modal: (props) => (props.open === false ? null : React.createElement("div", { "data-modal": "1" }, props.title, props.description, props.children, props.footer)),
  Toast: (props) => React.createElement("div", { "data-toast": "1" }, props.text),
  Tag: (props) => React.createElement("span", { "data-tag": "1" }, props.children),
  Input: (props) => React.createElement("input", props),
  Tooltip: (props) => React.createElement("span", null, props.children),
  Switch: (props) => React.createElement("input", { type: "checkbox" }),
  PathLabel: (props) => React.createElement("span", null, props.path ?? props.children),
  /* 预览用；把 text 渲染出来，才能断言"预览确实显示了内容" */
  MarkdownText: (props) => React.createElement("div", { "data-markdown": "1" }, props.text),
}
const primitives = new Proxy(base, {
  get(target, prop) {
    if (prop in target) return target[prop]
    if (typeof prop !== "string") return undefined
    return stub("span") /* 图标等未知名字 → 无害 span */
  },
})

/* ---------------- 加载真实产物 ---------------- */
let captured = null
window.__ModuleLoader__ = { load(spec) { captured = spec } }
window.eval(fs.readFileSync(BUNDLE, "utf8"))

/* ---------------- 假 fetch ---------------- */
const HOME = "C:\\fake-dsh-home"
const AUTH = `${HOME}\\AGENTS.md`
const SEED = "# seed instructions\n"
const NEW = "# edited instructions\n"
const V1 = "version-one"
const V2 = "version-two"

const calls = []
let scripted = {}
function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}
const PROJ_DIR = "D:\\proj"
const PROJ_AUTH = `${PROJ_DIR}\\AGENTS.md`
const COMPAT = `${HOME}\\AGENT.md` /* 单数：DSH 不加载 */
const OVERLAY = `${HOME}\\AGENTS.local.md` /* 不存在 → 默认应被折叠 */

/** 一个候选条目的完整形状（严格照宿主契约，不多不少）。 */
function entry(path, filename, extra) {
  const bytes = extra?.bytes ?? 0
  return {
    path, filename, scope: extra?.scope ?? "user", role: extra?.role ?? "user-compat",
    overlay: extra?.overlay ?? false, authoritative: extra?.authoritative ?? false,
    exists: extra?.exists ?? false, isDirectory: false,
    readable: extra?.readable ?? true, size: bytes, bytes,
  }
}

function stateBody(content = SEED, version = V1) {
  const bytes = Buffer.byteLength(content, "utf8")
  const file = {
    path: AUTH, filename: "AGENTS.md", scope: "user", role: "authoritative",
    overlay: false, authoritative: true, exists: true, isDirectory: false,
    readable: true, size: bytes, bytes,
  }
  /* 刻意混入：已存在的兼容名（会被标"DSH 不加载"）、不存在的 overlay（默认折叠）、
     项目级同名（必须显示所在目录才能区分）。 */
  const files = [
    file,
    entry(COMPAT, "AGENT.md", { exists: true, bytes: 20 }),
    entry(`${HOME}\\CLAUDE.md`, "CLAUDE.md", { exists: true, bytes: 10 }),
    entry(OVERLAY, "AGENTS.local.md", { overlay: true }),
    entry(PROJ_AUTH, "AGENTS.md", { scope: "project", role: "project", exists: true, bytes: 8 }),
  ]
  return {
    ok: true, home: HOME, authoritativePath: AUTH, files,
    selected: { ...file, content, version },
    budget: { bytes, budget: 1048576, remaining: 1048576 - bytes, overBudget: false },
    refreshLimits: ["$DSH_HOME/AGENTS.md 在 workspace 之外时，受限沙箱可能拒绝读取"],
    writing: { allowed: true, elevated: true, mode: "danger-full-access" },
  }
}
async function fakeFetch(url, init = {}) {
  const u = String(url)
  const body = init.body === undefined ? undefined : JSON.parse(init.body)
  calls.push({ url: u, method: init.method ?? "GET", body })
  if (u.includes("/state")) return respond(200, scripted.state ?? stateBody())
  if (u.includes("/files")) {
    const s = scripted.state ?? stateBody()
    return respond(200, { ok: true, files: s.files, authoritativePath: AUTH })
  }
  if (u.includes("/save")) {
    return respond(
      scripted.save?.status ?? 200,
      scripted.save?.body ?? { ok: true, saved: { path: AUTH, version: V2, bytes: Buffer.byteLength(NEW), created: false }, files: [] },
    )
  }
  if (u.includes("/refresh")) {
    return respond(200, scripted.refresh?.body ?? { ok: false, refreshed: false, reason: "no agent", fallback: "下次工具触碰该路径时生效" })
  }
  return respond(404, { ok: false })
}
window.fetch = fakeFetch
globalThis.fetch = fakeFetch

/* ---------------- 断言辅助 ---------------- */
const text = () => window.document.getElementById("root").textContent ?? ""
const findButton = (label) => [...window.document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label))
/* 精确匹配：冲突条的同名按钮会"包含"弹窗确认按钮的文字，必须区分开。 */
const findButtonExact = (label) => [...window.document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label)
const flush = async () => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function click(label) {
  const btn = findButton(label)
  if (btn === undefined) return false
  await act(async () => { btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })) })
  await flush()
  return true
}
async function type(next) {
  const area = window.document.querySelector("textarea")
  if (area === null) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set
  await act(async () => {
    setter.call(area, next)
    area.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
  await flush()
  return true
}
const saveCallCount = () => calls.filter((c) => c.url.includes("/save")).length

/* ================= 1. 模块契约与注册 ================= */
console.log("\n=== 1. module contract + registration ===")
check("bundle registered via __ModuleLoader__.load", captured !== null)
check(`bundle id === ${PKG.name}`, captured?.id === PKG.name, `got ${captured?.id}`)
const mod = captured.factory((name) => (name === "react" ? React : primitives))
check("exports apply()", typeof mod.apply === "function")
const inject = mod.inject?.default ?? mod.inject
check("inject includes 'slots'", Array.isArray(inject) && inject.includes("slots"), `got ${JSON.stringify(inject)}`)

let registration = null
let Component = null
/*
 * 槽位 shell 会给 section 传 t（见 mcp-ui-dsh 同款写法：
 * 组件内 `const { t } = props`，注册处 `inject: () => ({})`）。
 * 这里没有 shell，所以我们用假 locale 服务**捕获真实字典**，
 * 再据此造出与 apply 内部等价的 t —— 这样断言打在**真实出厂的文案**上，
 * 而不是测试里另抄一份。
 */
let capturedDict = null
let registeredNs = null
mod.apply({
  get: () => undefined,
  /*
   * effect 必须**真的调用**回调：apply 把 locale.register 放在 effect 里
   * （`ctx.effect(() => locale.register(...))`）。若这里忽略回调，
   * 字典就永远注册不上，t 会退化成返回 key —— 那是测试桩的错，不是插件的错。
   */
  effect: (cb) => {
    const disposer = typeof cb === "function" ? cb() : undefined
    return typeof disposer === "function" ? disposer : () => {}
  },
  slots: {
    inject: (_name, cb) => { cb() },
    register: (options, component) => { registration = options; Component = component; return () => {} },
  },
  locale: {
    register: (ns, dict) => { registeredNs = ns; capturedDict = dict },
    bind: () => (key) => capturedDict?.zh?.[key] ?? key,
  },
})
check("dictionaries registered", capturedDict !== null && registeredNs === "edit-agents-md", `ns=${registeredNs}`)
check("dictionary has zh + en", capturedDict?.zh !== undefined && capturedDict?.en !== undefined)
const t = (key) => capturedDict?.zh?.[key] ?? key
check('slot name === "settings.section"', registration?.name === "settings.section", `got ${registration?.name}`)
check('slot id === "agents-md"', registration?.id === "agents-md", `got ${registration?.id}`)
check("slot order === 27", registration?.order === 27, `got ${registration?.order}`)
check("label is a thunk (locale-following)", typeof registration?.label === "function")
check('label() returns "系统指令"', registration?.label?.() === "系统指令", `got ${registration?.label?.()}`)
check("component captured", typeof Component === "function")

/* ================= 2. 初次加载渲染 ================= */
console.log("\n=== 2. initial render ===")
const container = window.document.getElementById("root")
const root = ReactDOMClient.createRoot(container)
await act(async () => { root.render(React.createElement(Component, { t })) })
await flush()
check("renders without crashing", container.innerHTML.length > 0)
check("shows page title", text().includes("系统指令"), text().slice(0, 120))
check("editor is a textarea", window.document.querySelector("textarea") !== null)
check("textarea holds /state selected.content", window.document.querySelector("textarea")?.value === SEED, JSON.stringify(window.document.querySelector("textarea")?.value))
check("GET /state requested", calls.some((c) => c.url.includes("/api/edit-agents/state") && c.method === "GET"))
check("targets the authoritative AGENTS.md path", text().includes(AUTH), text().slice(0, 200))
/* 刷新机制说明已从页面正文收进按钮 tooltip（用户要求删掉冗余提示文案），
   因此这里改从 title 属性断言：诚实说明仍随按钮在。 */
const refreshBtn = findButton(t("refresh"))
check("refresh button explains the real mechanism in its tooltip", /第一方\s*read|触碰/.test(refreshBtn?.getAttribute("title") ?? ""), refreshBtn?.getAttribute("title") ?? "(no title)")
check("shows byte budget info", /\d+\s*\/\s*\d+/.test(text()), text().slice(0, 200))
check("no dirty flag initially", text().includes("有未保存的修改") === false)

/* ---------- 2b. 简化后不应再有候选列表 ---------- */
console.log("\n=== 2b. no candidate sidebar (simplified to a single file) ===")
check("no show-all checkbox", window.document.querySelector("input[type=checkbox]") === null)
check("no file-group headings", text().includes("用户级") === false && text().includes("项目级") === false, text().slice(0, 200))
check("no rescan button", findButton("重新扫描") === undefined)
check("no 'not loaded by DSH' badge", text().includes("DSH 不加载") === false, text().slice(0, 200))
check("shows the single target path", text().includes("AGENTS.md"), text().slice(0, 200))

/* ---------- 2c. 编辑 / 预览 两种模式 ---------- */
console.log("\n=== 2c. edit / preview modes ===")
check("starts in edit mode (textarea present)", window.document.querySelector("textarea") !== null)
check("preview button rendered", findButton(t("viewPreview")) !== undefined)
await click(t("viewPreview"))
check("preview mode swaps out the textarea", window.document.querySelector("textarea") === null)
const md = window.document.querySelector("[data-markdown]")
check("preview renders the file content via MarkdownText", md !== null && (md.textContent ?? "").includes("seed instructions"), (md?.textContent ?? "").slice(0, 80))
await click(t("viewEdit"))
check("edit mode restores the textarea", window.document.querySelector("textarea") !== null)
check("switching views does not lose unsaved content", window.document.querySelector("textarea")?.value === SEED)

/* ================= 3. 脏标记 ================= */
console.log("\n=== 3. dirty flag ===")
await type(NEW)
check("editing shows dirty flag", text().includes("有未保存的修改"), text().slice(0, 220))
check("textarea keeps the edit", window.document.querySelector("textarea")?.value === NEW)

/* ================= 4. 保存成功 ================= */
console.log("\n=== 4. save happy path ===")
scripted.save = { status: 200, body: { ok: true, saved: { path: AUTH, version: V2, bytes: Buffer.byteLength(NEW), created: false }, files: [] } }
check("save button found", await click("保存"))
const saveCall = calls.filter((c) => c.url.includes("/save")).pop()
check("POST /api/edit-agents/save issued", saveCall?.method === "POST")
check("save body {path,content,version}", saveCall?.body?.path === AUTH && saveCall?.body?.content === NEW && saveCall?.body?.version === V1, JSON.stringify(saveCall?.body)?.slice(0, 160))
check("success feedback shown", /已保存|保存成功/.test(text()), text().slice(0, 220))

/* ================= 5. 409 冲突 ================= */
console.log("\n=== 5. save 409 conflict ===")
await type(`${NEW}# more\n`)
scripted.save = { status: 409, body: { ok: false, error: "文件已被外部修改，请重新读取后再保存", code: "FS_STALE_VERSION", current: V2 } }
const before409 = saveCallCount()
await click("保存")
await flush()
check("conflict title shown", text().includes("文件已被外部修改"), text().slice(0, 260))
check("offers reload-and-discard", text().includes("重新加载"), text().slice(0, 320))
check("no auto-retry overwrite (exactly one save sent)", saveCallCount() === before409 + 1, `before=${before409} after=${saveCallCount()}`)

/* ================= 6. 重新读取的丢弃保护 + refresh 降级 ================= */
console.log("\n=== 6. reload guard + refresh degraded ===")
/*
 * 此时仍是 dirty（第 5 节把内容改成了 "# more"）。
 * 「重新读取」= 从磁盘**拉回**编辑区，会覆盖未保存内容 → 必须先确认；
 * 「立即刷新」= 把内容**推送**进会话，因此 dirty 时禁用（避免把没保存的文本当成已生效）。
 */
scripted.state = stateBody(NEW, V2)
check("editor is dirty before reload", text().includes("有未保存的修改"))
check("refresh is disabled while dirty", findButton(t("refresh"))?.disabled === true)
await click(t("reload"))
await flush()
check("reload with unsaved changes opens the confirm dialog", window.document.querySelector("[data-modal]") !== null)
check("reload did NOT silently discard the edit", window.document.querySelector("textarea")?.value !== NEW, JSON.stringify(window.document.querySelector("textarea")?.value))
const confirmReload = findButtonExact(t("discardGo"))
check("confirm dialog offers the reload action", confirmReload !== undefined)
if (confirmReload !== undefined) {
  await act(async () => { confirmReload.dispatchEvent(new window.MouseEvent("click", { bubbles: true })) })
  await flush()
}
check("confirming reloads from disk and clears dirty", window.document.querySelector("textarea")?.value === NEW && text().includes("有未保存的修改") === false, text().slice(0, 200))
check("reload tooltip is about the disk (distinct from refresh)", /磁盘/.test(findButton(t("reload"))?.getAttribute("title") ?? ""), findButton(t("reload"))?.getAttribute("title") ?? "(none)")

scripted.refresh = { body: { ok: false, refreshed: false, reason: "workspace 外路径被沙箱拒绝", fallback: "下次工具触碰该路径时生效" } }
await click(t("refresh"))
await flush()
check("shows honest fallback text", text().includes("下次工具触碰该路径或新会话时生效"), text().slice(0, 320))
check("surfaces host reason", text().includes("沙箱") || text().includes("workspace"), text().slice(0, 320))
check("does NOT claim immediate effect", text().includes("已刷新：") === false, text().slice(0, 320))

/* ================= 7. ok:true 但缺 refreshed → 仍须降级（回归锁） ================= */
console.log("\n=== 7. ok:true without refreshed must still degrade ===")
scripted.refresh = { body: { ok: true, detail: "触发了一次 read 调用" } }
await click(t("refresh"))
await flush()
check("missing refreshed -> treats as degraded", text().includes("下次工具触碰该路径或新会话时生效"), text().slice(0, 320))
check("missing refreshed -> never claims success", text().includes("已刷新：") === false, text().slice(0, 320))

/* ================= 8. refresh 真成功 ================= */
console.log("\n=== 8. refresh real success (ok && refreshed) ===")
scripted.refresh = { body: { ok: true, refreshed: true, method: `read ${AUTH}`, agentSource: "currentInitiator", agentId: "session-e2e", detail: "ok" } }
await click(t("refresh"))
await flush()
check("shows success text", text().includes("已刷新："), text().slice(0, 320))
check("success text does NOT overclaim 'this session is live'", text().includes("当前会话生效") === false, text().slice(0, 320))
check("success text reports the actual projection target", text().includes("session-e2e"), text().slice(0, 320))

/* ================= 9. 无 confirm/alert ================= */
console.log("\n=== 9. no native dialogs ===")
check("no window.confirm/alert used", violativeDialogs.length === 0, violativeDialogs.join(", "))

/* ================= 收尾 ================= */
await act(async () => { root.unmount() })
dom.window.close()

console.log("\n================ SMOKE SUMMARY ================")
console.log(`pass ${pass}, fail ${failures.length}`)
for (const f of failures) console.log(`  FAILED: ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
