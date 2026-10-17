/**
 * 产物契约与规范校验。发布前跑一遍，把最容易在浏览器里才炸的问题挡在构建期。
 *
 * 校验项：
 *   1. bundle 包装的 id 必须等于 package.json 的 name；
 *   2. 必须导出 apply / inject，且 inject 含 "slots"（没有它拿不到槽位）；
 *   3. 声明的 external 必须保持 external（不能被打进 bundle）；
 *   4. CSS 已注入且带 data-plugin / data-plugin-css 两个属性；
 *   5. CSS 只用 --dsw-* 令牌，无硬编码颜色；
 *   6. 无 window.confirm / window.alert（破坏性操作必须走 Modal）；
 *   7. CSS 类名与 JS 映射表逐一对齐（曾经因此整套样式失效）；
 *   8. 浏览器半不得 import 宿主专有模块（app.asar 内的包浏览器解析不到）；
 *   9. 注册的是 settings.section 槽位且 id 为 agents-md（order 校验读**源码**，
 *      因为 esbuild 不会把具名常量折叠进产物，产物里只有 `order: SECTION_ORDER`）；
 *  10. 前后端契约：只允许请求本插件自己那组 /api/edit-agents/* 路由；
 *  11. 诚实性：产物里必须同时存在「降级」与「真刷新」两套文案分支，
 *      且不存在「已立即生效」这类不区分降级的说法。
 *
 * 三个容易把**假阳性**当缺陷的坑（写在这里避免误报）：
 *   a. esbuild 在 --target=es2022 下会把非 ASCII 转义成 `\uXXXX`，所以任何
 *      中文文案的直接 `includes` 都会失败 —— 必须先 `unescape` 再匹配。
 *   b. esbuild 保留注释，源码里解释性的「不要用 window.confirm」注释本身
 *      就会被朴素正则命中 —— 必须先剥注释再查禁用 API。
 *   c. 具名常量（SECTION_ORDER = 27）不会被折叠，产物里查不到字面量 27 ——
 *      order 必须回源码里查。
 *
 * 注意：bundle 用 --format=cjs 构建，esbuild 产出的是**普通** `require("x")`，
 * 而不是 iife 模式下的 `__require("x")` —— 校验必须匹配实际形态。
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const bundlePath = path.join(root, "dist", "client.js")
const srcPath = path.join(root, "client", "index.jsx")

const failures = []
const notes = []
const fail = (msg) => failures.push(msg)
const pass = (msg) => notes.push(`  ok  ${msg}`)

if (!fs.existsSync(bundlePath)) {
  console.error("dist/client.js 不存在，请先运行 npm run build")
  process.exit(1)
}
const js = fs.readFileSync(bundlePath, "utf8")
const src = fs.readFileSync(srcPath, "utf8")

/**
 * 见文件头坑 (a)：把 esbuild 产出的 `\uXXXX` 转义还原成真实字符，
 * 否则所有中文文案匹配都是假阴性。
 * 用 JSON.parse 还原最稳（产物里的字符串就是合法 JSON 字面量）。
 */
function unescapeUnicode(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}
/** 去掉注释，见文件头坑 (b)。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

const jsText = unescapeUnicode(js)
const jsCode = stripComments(jsText)

/* 1. bundle id === 包名。 */
if (!js.includes(`id: ${JSON.stringify(pkg.name)}`)) {
  fail(`bundle 的 id 不等于包名 ${pkg.name}（client-modules 按包名建模块表键，写错会在浏览器里才炸）`)
} else {
  pass(`bundle id === ${pkg.name}`)
}

/* 2. 导出面。 */
for (const name of ["apply", "inject"]) {
  if (!new RegExp(`\\b${name}\\b`).test(js)) fail(`bundle 未导出 ${name}`)
  else pass(`导出 ${name}`)
}
if (!js.includes('"slots"')) fail('inject 未包含 "slots"，无法注册槽位')
else pass("inject 含 slots")

/* 3. external 纯度：声明为 external 的模块必须仍以 require 引用。 */
const declaredExternal = [...new Set(["react", ...(pkg.dsh?.client?.external ?? [])])]
for (const mod of declaredExternal) {
  if (!js.includes(`require(${JSON.stringify(mod)})`)) {
    fail(`声明为 external 但未以 require 方式引用 ${mod}（声明与实现不一致）`)
  } else {
    pass(`external ${mod}`)
  }
}
if (/react\.production\.min\.js|ReactCurrentDispatcher/.test(js)) {
  fail("bundle 里疑似打进了 React 本体，必须保持 external")
} else {
  pass("未打进 React 本体")
}

/* 4/5/7. CSS 注入、令牌与类名对齐。 */
const cssMatch = js.match(/__styleTag\.textContent = "((?:[^"\\]|\\.)*)"/)
if (cssMatch === null) {
  fail("bundle 未注入 CSS（claimStyles 找不到可认领的 style）")
} else {
  const css = JSON.parse(`"${cssMatch[1]}"`)
  const standaloneCssPath = path.join(root, "dist", "client.css")
  if (!fs.existsSync(standaloneCssPath)) {
    fail("dist/client.css 不存在")
  } else if (fs.readFileSync(standaloneCssPath, "utf8") !== css) {
    fail("dist/client.css 与 bundle 注入的 CSS 不一致")
  } else {
    pass("dist/client.css 与 bundle 注入的 CSS 完全一致")
  }
  if (!js.includes("__styleTag.dataset.plugin") || !js.includes("__styleTag.dataset.pluginCss")) {
    fail("style 标签缺少 data-plugin / data-plugin-css（卸载时无法清理，会残留）")
  } else {
    pass("CSS 注入带 data-plugin / data-plugin-css")
  }

  const hardcoded = [...css.matchAll(/(?:^|[:\s(,])(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/g)].map((m) => m[1])
  if (hardcoded.length > 0) {
    fail(`CSS 存在硬编码颜色：${[...new Set(hardcoded)].join(", ")}（必须只用 --dsw-* 令牌）`)
  } else {
    pass("CSS 无硬编码颜色")
  }

  const vars = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
  const nonDsw = vars.filter((v) => !v.startsWith("--dsw-"))
  if (nonDsw.length > 0) fail(`CSS 使用了非 --dsw-* 变量：${nonDsw.join(", ")}`)
  else pass(`CSS 变量全部为 --dsw-*（${vars.length} 个）`)

  /*
   * 复用优先守卫：几何值也要走令牌，不许写死魔数。
   *
   * DSH 提供 --dsw-radius-xs/sm/md/lg/xl/panel，官方 primitives 的
   * settings-form/fields.module.css 与 SettingsForm.module.css 都用
   * var(--dsw-radius-md)。插件自己写 `border-radius: 8px` 会导致 DSH 调整圆角
   * 体系时本插件不跟随 —— 这正是"该复用却没复用"的典型。
   */
  const magicRadii = [...new Set([...css.matchAll(/border-radius:\s*([^;{}]*\d(?:px|rem|em)[^;{}]*)/g)].map((m) => m[1].trim()))]
  if (magicRadii.length > 0) {
    fail(`CSS 有硬编码圆角：${magicRadii.join(" | ")}（应使用 --dsw-radius-* 令牌）`)
  } else {
    pass("CSS 圆角全部走 --dsw-radius-* 令牌（无硬编码魔数）")
  }

  /*
   * 类名对齐：映射表是 { Eam_page: "Eam_<hash>_page" }，**值**才是真实类名，
   * 必须逐个出现在 CSS 里。（`<hash>` 是构建期按包名加的盐，见下。）
   */
  const cssClasses = new Set([...css.matchAll(/\.(Eam_[0-9a-f]{8}_[\w-]+)/g)].map((m) => m[1]))
  const mapMatch = js.match(/var Eam_default = \{([\s\S]*?)\};/)
  if (mapMatch === null) {
    fail("未找到 local-css 的类名映射表（Eam_default）")
  } else {
    const values = [...mapMatch[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => m[2])
    const missing = values.filter((v) => !cssClasses.has(v))
    if (missing.length > 0) {
      fail(`有 ${missing.length} 个映射类名在 CSS 中不存在：${missing.join(", ")}`)
    } else {
      pass(`CSS 类名与 JS 映射对齐（${values.length} 个）`)
    }

    /*
     * ⚠️ 跨插件撞名守卫（真实事故的回归锁，勿删）
     *
     * esbuild 的 local-css 作用域名固定为 `[文件名]_[类名]`，**不含包名**，
     * 且 CLI 没有开关能改（只有 --asset-names/--entry-names 这类输出路径模板）。
     * 于是两个插件只要 CSS 文件名与类名前缀相同，类名就**完全相同**；
     * 而 DSH 把所有插件的 <style> 都注入同一个文档，后注入者覆盖前者。
     *
     * 本项目实测踩过：与 @gxx-labs/mcp-ui-dsh 撞了 10 个类名
     * （Mui_Mui_page / Mui_Mui_hint / Mui_Mui_toolbar …），把对方的 MCP 表单样式改乱。
     *
     * 现在由 scripts/build-client.mjs 在产物上做确定性重写，把作用域名升级为
     * `Eam_<sha256(包名) 前 8 位>_<原始类名>`：**不依赖任何人自觉遵守前缀约定**，
     * 第三方插件就算也叫 Eam_ 前缀也撞不上（32 bit 哈希空间）。
     * 这里把两件事钉死：全部带盐；且盐必须**等于本包名的哈希**（防手改、防复制到别的包）。
     */
    const EXPECTED_SALT = `Eam_${createHash("sha256").update(pkg.name).digest("hex").slice(0, 8)}_`
    const alien = values.filter((v) => !v.startsWith(EXPECTED_SALT))
    if (alien.length > 0) {
      fail(
        `有 ${alien.length} 个作用域类名未带本包哈希盐 ${EXPECTED_SALT}：${alien.slice(0, 8).join(", ")}` +
          `（作用域名必须唯一到包，否则会与其他插件的全局样式互相覆盖）`,
      )
    } else {
      pass(`CSS 作用域名全部带本包哈希盐 ${EXPECTED_SALT}（跨插件撞名结构性免疫）`)
    }
  }
}

/* 6. 禁止 window.confirm / window.alert（查**去注释**后的代码，见坑 b）。 */
if (/window\.confirm|window\.alert|(?<![\w.])confirm\(/.test(jsCode)) {
  fail("产物中存在 window.confirm/alert（破坏性操作必须走 Modal 组件）")
} else {
  pass("无 window.confirm/alert")
}

/*
 * 8. 浏览器半不得 import 宿主专有模块。
 *    这些包只存在于 app.asar（dsh/node_modules/...），浏览器侧解析不到，
 *    esbuild 会尝试打包它们并因找不到而失败，或产出无法运行的 require。
 *    本插件**唯一**允许从宿主侧引用的东西是通过 HTTP 路由拿数据。
 */
const forbidden = [
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-agent-instructions",
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-slots",
  "node:",
]
let hostLeak = false
for (const mod of forbidden) {
  if (js.includes(`require(${JSON.stringify(mod)})`)) {
    fail(`浏览器半引用了宿主专有模块 ${mod}（应改为走 /api/edit-agents/* 路由）`)
    hostLeak = true
  }
}
if (!hostLeak) pass("浏览器半未引用宿主专有模块")

/*
 * 9. 槽位注册的 id / order。
 *
 * ⚠️ 不能只查产物里有没有字符串 `"agents-md"` —— `SECTION_ID = "agents-md"`
 * 这行常量定义本身就会命中，注册处改成别的 id 也照样"通过"（负向对照抓到过
 * 这个漏洞）。所以拆成三条**互相独立**的检查：
 *   a. 注册对象里用的确实是 `id: SECTION_ID`（不是内联字面量绕开常量）；
 *   b. 源码里 `SECTION_ID` 的值就是 "agents-md"；
 *   c. order 是 27（读源码，见坑 c）。
 * 三者同时成立，才等价于"注册的 id 是 agents-md"。
 */
if (!/"settings\.section"/.test(jsCode)) fail("未注册 settings.section 槽位（设置页签不会出现）")
else pass("注册 settings.section")

/* a. 注册处必须用常量，且与槽位定义在同一段（防内联字面量绕过）。 */
const regUsesConst = /id:\s*SECTION_ID/.test(jsCode)
if (!regUsesConst) {
  fail("注册对象未使用 `id: SECTION_ID`（可能被内联成别的 id，绕开了常量检查）")
} else {
  pass("注册对象使用 id: SECTION_ID")
}

/* b. 常量值必须是 agents-md。 */
const idConst = src.match(/SECTION_ID\s*=\s*"([^"]+)"/)
if (idConst?.[1] !== "agents-md") {
  fail(`SECTION_ID 不是 "agents-md"（实际 ${idConst?.[1] ?? "未找到"}）`)
} else {
  pass('SECTION_ID === "agents-md"')
}

/*
 * order 必须避开已占用值（mcp 用了 26）。
 * 见文件头坑 (c)：`SECTION_ORDER = 27` 是具名常量，esbuild 不折叠，
 * 产物里查不到 27 —— 回**源码**查，且要求注册处用常量、常量值正确。
 */
if (!/order:\s*SECTION_ORDER/.test(jsCode)) {
  fail("注册对象未使用 `order: SECTION_ORDER`（可能被内联成别的 order）")
}
const orderConst = src.match(/SECTION_ORDER\s*=\s*(\d+)/)
if (orderConst?.[1] !== "27") {
  fail(`页签 order 不是 27（实际 ${orderConst?.[1] ?? "未找到"}；26 已被 mcp 占用，重复会让排序不确定）`)
} else {
  pass("页签 order === 27（源 client/index.jsx）")
}

/*
 * 10. 前后端契约：只允许请求本插件自己的路由组。
 *     客户端是渲染进程，任何跨路由拼写错误都只会在运行时 404。
 */
/*
 * 注意 `/api/edit-agents/files`（候选清单）**宿主半仍然提供**，但界面已简化为
 * "只维护 $DSH_HOME/AGENTS.md"，因此浏览器半**不再请求**它 —— 这里只要求
 * 界面真正用到的那三条必须出现，且所有出现的路径都必须在契约组内。
 */
const urls = [...new Set([...js.matchAll(/["'`](\/api\/[\w\-/]+)/g)].map((m) => m[1]))]
const contractUrls = [
  "/api/edit-agents/state",
  "/api/edit-agents/save",
  "/api/edit-agents/refresh",
  /* 宿主仍暴露、界面已不再使用：留在契约组里，避免被误判成拼写错误 */
  "/api/edit-agents/files",
]
/** 简化后的界面**必须**使用的三条。 */
const requiredUrls = [
  "/api/edit-agents/state",
  "/api/edit-agents/save",
  "/api/edit-agents/refresh",
]
const unexpected = urls.filter((u) => !contractUrls.includes(u))
if (unexpected.length > 0) fail(`产物里出现了非预期 API 路径：${unexpected.join(", ")}`)
else pass(`API 路径均属 /api/edit-agents/*（${urls.length} 条：${urls.join(", ")}）`)
for (const u of requiredUrls) {
  if (!urls.includes(u)) fail(`产物未使用界面必需的契约路径 ${u}`)
}
if (requiredUrls.every((u) => urls.includes(u))) pass("state / save / refresh 三条界面必需路由全部被使用")

/*
 * 11. 诚实性（本次交付的关键风险点，见坑 a：必须先还原 \uXXXX）。
 *
 * 必须同时存在两套分支文案：
 *   - 真刷新的正向反馈（只看 ok:true && refreshed:true 才给）
 *   - 降级说明（其余一切情况都走这里，含 ok:true 但缺 refreshed）
 * 并且**不得**出现「已立即生效」「已对当前会话生效」这类不区分降级 / 无法证实的说法。
 *
 * 注意正向文案本身刻意**不**断言「当前会话生效」：宿主挑会话有
 * agents.list()[-1] 兜底（真机实测），多会话时那个未必是用户正看的会话。
 * 因此正向文案陈述的是「已发起一次真实的第一方 read 调用」并附实际投影目标。
 */
const hasDegraded = jsText.includes("下次工具触碰该路径或新会话")
const hasRefreshSuccess = jsText.includes("已刷新：") && /第一方\s*read/.test(jsText)
if (!hasDegraded) {
  fail("产物缺少「降级」文案（宿主无法真正触发刷新时必须如实告知：下次工具触碰或新会话生效）")
} else {
  pass("含诚实降级文案（下次工具触碰该路径 / 新会话生效）")
}
if (!hasRefreshSuccess) {
  fail("产物缺少真刷新成功的正向文案（ok:true && refreshed:true 时的反馈，且须陈述确已发生的事）")
} else {
  pass("含真刷新成功分支文案（陈述已发起真实 read 调用 + 投影目标）")
}
/* 两档判读的两个条件必须都在：ok 与 refreshed 成对出现。 */
if (!/refreshed\s*===\s*!0|refreshed\s*===\s*true/.test(jsCode)) {
  fail("未找到 `refreshed === true` 判读（必须两档：只有 refreshed 为真才算真刷新）")
} else {
  pass("按 refreshed === true 判读真刷新")
}
/* 成功文案必须带上真实的投影目标（agentId / agentSource），而不是含糊其辞。 */
if (!/agentId/.test(jsCode) || !/agentSource/.test(jsCode)) {
  fail("刷新成功文案未使用宿主回带的 agentId / agentSource（无法说明到底投影到哪个会话）")
} else {
  pass("刷新成功文案回显真实投影目标（agentId / agentSource）")
}
if (/已立即生效|已对当前会话生效|立即生效，无需|applied immediately|live in this session/.test(jsText)) {
  fail("产物存在「已立即生效 / 已对当前会话生效」这类不区分降级或无法证实的说法（会谎报刷新成功）")
} else {
  pass("无夸大刷新的文案")
}
/*
 * 刷新降级走的是 HTTP 200 + ok:false，不是异常。若实现用会抛错的
 * postJson 调 refresh，降级就会被误报成「请求失败」—— 这是一条真实的
 * 回归风险（本项目已犯过一次），因此把「refresh 走 requestRaw」钉住。
 *
 * 注意别从 `API.refresh` 切片：那是 API 表里的定义处，不是调用处。
 * 要定位**调用** `requestRaw(API.refresh` 的地方，再看附近有没有 postJson。
 */
const refreshCall = /requestRaw\(\s*API\.refresh/.test(jsCode)
const refreshPostJson = /postJson\(\s*API\.refresh/.test(jsCode)
if (refreshPostJson || !refreshCall) {
  fail(
    "refresh 未使用 requestRaw：ok:false 的降级会被 postJson 抛成异常，" +
      "用户看不到 fallback/reason（降级路径不可达）",
  )
} else {
  pass("refresh 走 requestRaw（降级不被误判为异常）")
}

console.log(`verify-bundle: ${pkg.name}@${pkg.version}`)
console.log(notes.join("\n"))
if (failures.length > 0) {
  console.error(`\n校验失败 ${failures.length} 项：`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\n全部校验通过（${notes.length} 项）`)
