/**
 * 构建浏览器半 dist/client.js。
 *
 * 实现说明（重要）：这里**直接调用 esbuild 可执行文件**，而不是 `import { build } from "esbuild"`。
 * 原因：esbuild 的 JS API 会以 piped stdio 启动一个子进程，在受限沙箱下会
 * `spawn EPERM`。直接跑二进制并把产物写到文件即可绕开该限制，且行为等价。
 *
 * 依赖解析（本目录没有自己的 node_modules 依赖树）：
 *   参考实现 mcp-ui-dsh 的依赖装在
 *     C:\Users\24990\Documents\deepseek-harness\default-workspace\mcp-ui-dsh\node_modules
 *   本脚本用 **两级解析**：
 *     1. 常规 createRequire（本包 node_modules —— 已用 `mklink /J` 目录联接把
 *        `node_modules/@esbuild` 与 `node_modules/esbuild` 指向参考实现，
 *        见下方 FALLBACK_ROOT 注释；联接对 Node 模块解析是透明的）；
 *     2. 解析不到时回退到 FALLBACK_ROOT 下的同一个包。
 *   两级都失败才报错。换机器时只需重做一次联接：
 *     cmd /c mklink /J "<root>\node_modules\@esbuild" "<ref>\node_modules\@esbuild"
 *     cmd /c mklink /J "<root>\node_modules\esbuild"  "<ref>\node_modules\esbuild"
 *
 * 输出必须符合 DSH 客户端模块契约：
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => module.exports })
 *
 * 四个容易踩的坑（写在这里避免回归）：
 *   1. **bundle 的 id 必须等于 package.json 的 name** —— 客户端加载器按包名建
 *      模块表键，写错会在浏览器里才炸。因此这里从 package.json 读取，不硬编码。
 *   2. **必须用 --format=cjs，不能用 iife** —— 入口是 ESM，esbuild 的 iife 输出
 *      **不会**把导出挂到 module.exports 上，包装层的 `return module.exports`
 *      会拿到空对象，浏览器侧表现为"模块加载了但 apply 未定义"。
 *   3. **CSS 必须由 JS `import`** —— local-css 会给类名加作用域前缀，JS 里读到的
 *      是映射后的类名。若只靠本脚本单独编 CSS 而 JS 不 import，两边类名不一致，
 *      样式会全部失效。本脚本兼容两种情形：优先用 JS 产物里的映射，回退到
 *      独立抽取的 CSS。
 *   4. **CSS 抽取要以 CSS 为入口** —— 入口是 JS 时 esbuild 会把 JS 文本写进
 *      `--outfile=x.css`（同名不同扩展），拿到的"CSS"其实是 JS。
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")

/** 依赖回退根：参考实现的 node_modules（见文件头「依赖解析」）。 */
const FALLBACK_ROOT =
  process.env.EDIT_AGENTS_ESBUILD_ROOT ??
  "C:\\Users\\24990\\Documents\\deepseek-harness\\default-workspace\\mcp-ui-dsh"

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const BUNDLE_ID = pkg.name

const CSS_MODULE_ID = `${pkg.name}/Eam.module.css`
const outFile = path.join(root, "dist", "client.js")
const tmpDir = path.join(root, ".build-tmp")

/** 解析 esbuild 二进制路径：本包 node_modules 优先，其次回退根。 */
function esbuildBin() {
  const candidates = [
    "@esbuild/win32-x64/esbuild.exe",
    "@esbuild/linux-x64/bin/esbuild",
    "@esbuild/darwin-x64/bin/esbuild",
    "@esbuild/darwin-arm64/bin/esbuild",
  ]
  const resolvers = [
    (spec) => require.resolve(spec),
    (spec) => createRequire(path.join(FALLBACK_ROOT, "package.json")).resolve(spec),
  ]
  for (const c of candidates) {
    for (const resolve of resolvers) {
      try {
        const p = resolve(c)
        if (fs.existsSync(p)) return p
      } catch {
        /* 换下一个解析器 / 下一个平台包 */
      }
    }
  }
  throw new Error(
    `未找到 esbuild 可执行文件。请安装对应平台的 @esbuild/<platform> 包，或做一次目录联接：\n` +
      `  cmd /c mklink /J "${path.join(root, "node_modules", "@esbuild")}" "${path.join(FALLBACK_ROOT, "node_modules", "@esbuild")}"`,
  )
}

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true })
fs.mkdirSync(path.join(root, "dist"), { recursive: true })
fs.rmSync(tmpDir, { recursive: true, force: true })
fs.mkdirSync(tmpDir, { recursive: true })

const externals = ["react", "react/jsx-runtime", "react-dom", ...(pkg.dsh?.client?.external ?? [])]
const externalArgs = [...new Set(externals)].map((m) => `--external:${m}`)

/*
 * 浏览器半**禁止**引用宿主专有模块：它们只存在于 app.asar
 * （dsh/node_modules/...），浏览器侧解析不到。这里列进 external 让 esbuild
 * 直接报「找不到」而不是打进来一个注定运行不了的 require（fail loud）。
 */
const hostOnly = [
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-agent-instructions",
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-slots",
]
const hostOnlyArgs = hostOnly.map((m) => `--external:${m}`)

const commonArgs = [
  path.join(root, "client", "index.jsx"),
  "--bundle",
  /* 见文件头第 2 条：cjs 才会把导出挂到 module.exports。 */
  "--format=cjs",
  "--platform=browser",
  "--target=es2022",
  "--jsx=automatic",
  "--loader:.css=local-css",
  "--log-level=warning",
  "--legal-comments=none",
  ...externalArgs,
  ...hostOnlyArgs,
]

/*
 * 第一遍：以 CSS 为入口单独抽取样式（见文件头第 4 条）。
 * 该结果既作为 style 注入内容，也用于校验类名对齐。
 */
const cssEntry = path.join(tmpDir, "entry.css")
fs.writeFileSync(cssEntry, `@import "../client/Eam.module.css";\n`)
const cssStage = path.join(tmpDir, "stage.css")
execFileSync(
  esbuildBin(),
  [cssEntry, "--bundle", "--loader:.css=local-css", "--log-level=warning", `--outfile=${cssStage}`],
  { stdio: "inherit", cwd: root },
)
const css = fs.existsSync(cssStage) ? fs.readFileSync(cssStage, "utf8") : ""

/* 第二遍：正式产出 JS（写到 dist，与临时目录隔离）。 */
execFileSync(esbuildBin(), [...commonArgs, `--outfile=${outFile}`], { stdio: "ignore" })

/*
 * ============================================================================
 * 作用域名「加盐」：把 `Eam_Eam_page` 重写成 `Eam_<包名哈希>_page`
 * ============================================================================
 *
 * 为什么必须自己做这一步（esbuild 帮不了）：
 *   esbuild 的 local-css 作用域名**固定**为 `[文件名]_[类名]`，且 CLI **没有**
 *   任何开关能改这个模板（实测 `esbuild --help` 里只有 `--asset-names` /
 *   `--entry-names` / `--chunk-names` 这类**输出路径**模板）。也就是说作用域名
 *   **不含包名** —— 两个插件只要 CSS 文件名与类名前缀相同，类名就完全相同。
 *
 * 后果（本项目真实事故）：DSH 会把所有插件的 <style> 注入同一个文档，
 *   后注入者覆盖前者的同名规则。本插件曾与 mcp-ui-dsh 撞 10 个类名，
 *   把对方的 MCP 表单样式改乱。
 *
 * 所以这里在产物上做一次确定性重写，把「靠自觉的前缀」升级为「结构性保证」：
 *   Eam_Eam_page  →  Eam_<sha256(包名) 前 8 位>_page
 *
 *   - **确定性**：只取决于包名，同一包每次构建结果一致（可复现、可 diff）；
 *   - **唯一性**：不同包名极难得到同一 8 位十六进制（32 bit），
 *     第三方插件就算也叫 `Eam_` 前缀也不会撞；
 *   - **可读性**：保留 `Eam_` 前缀与原始类名，调试时仍看得懂；
 *   - 只改**映射表的值**与 **CSS 选择器**；JS 里的 `css.Eam_page` 属性名不变，
 *     因此源码零改动。
 */
const SCOPE_HASH = createHash("sha256").update(BUNDLE_ID).digest("hex").slice(0, 8)
const RAW_LOCAL_PREFIX = "Eam_Eam_" /* esbuild 的 `[name]_[local]` 产物 */
const SCOPED_LOCAL_PREFIX = `Eam_${SCOPE_HASH}_`
/** 把产物里所有 `Eam_Eam_xxx` 换成 `Eam_<hash>_xxx`。 */
const rescope = (text) => text.split(RAW_LOCAL_PREFIX).join(SCOPED_LOCAL_PREFIX)

const cssScoped = rescope(css)
const jsScoped = rescope(fs.readFileSync(outFile, "utf8"))
if (css !== "" && cssScoped === css) {
  console.error(`构建自检失败：未能在 CSS 里找到 esbuild 的作用域前缀 ${RAW_LOCAL_PREFIX}`)
  process.exit(1)
}

/* 注入 ModuleLoader 包装 + CSS style 标签。 */
const banner =
  `/* ${BUNDLE_ID} client bundle (esbuild) */\n` +
  `window.__ModuleLoader__.load({\n` +
  `  id: ${JSON.stringify(BUNDLE_ID)},\n` +
  `  factory: (require) => {\n` +
  `    var module = { exports: {} };\n` +
  `    var exports = module.exports;\n`

const footer = `\n    return module.exports;\n  }\n});\n`

const cssTag =
  cssScoped.trim() === ""
    ? ""
    : `var __cssTagId = ${JSON.stringify(CSS_MODULE_ID)};\n` +
      `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(__cssTagId) + "]") === null) {\n` +
      `  var __styleTag = document.createElement("style");\n` +
      `  __styleTag.dataset.plugin = ${JSON.stringify(BUNDLE_ID)};\n` +
      `  __styleTag.dataset.pluginCss = __cssTagId;\n` +
      `  __styleTag.textContent = ${JSON.stringify(cssScoped)};\n` +
      `  document.head.appendChild(__styleTag);\n` +
      `}\n`

fs.writeFileSync(outFile, banner + jsScoped + cssTag + footer)
fs.writeFileSync(path.join(root, "dist", "client.css"), cssScoped)

/* 清掉临时目录。 */
fs.rmSync(tmpDir, { recursive: true, force: true })

/*
 * 构建期自检：CSS 里的类名必须与 JS 映射表的值一一对应。
 * 这条曾经真的断过（CSS 编出 Eam_Eam_page 而 JS 用 Eam_page），导致整套样式失效，
 * 所以放在构建里当硬失败。现在两边都已加盐，正则按加盐后的形态匹配。
 */
const built = fs.readFileSync(outFile, "utf8")
const cssClasses = new Set((cssScoped.match(/\.(Eam_[0-9a-f]{8}_[\w-]+)/g) ?? []).map((s) => s.slice(1)))
const mapMatch = built.match(/var Eam_default = \{([\s\S]*?)\};/)
if (mapMatch === null) {
  console.error("构建自检失败：未找到 local-css 类名映射表（Eam_default）")
  process.exit(1)
}
const mapped = [...mapMatch[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => m[2])
const missing = mapped.filter((v) => !cssClasses.has(v))
if (missing.length > 0) {
  console.error(`构建自检失败：有 ${missing.length} 个类名在 CSS 中不存在：${missing.join(", ")}`)
  process.exit(1)
}
/* 自检：每个作用域名都必须带本包专属的哈希盐，否则等于没防住撞名。 */
const unSalted = [...mapped, ...cssClasses].filter((v) => !v.startsWith(SCOPED_LOCAL_PREFIX))
if (unSalted.length > 0) {
  console.error(
    `构建自检失败：有 ${unSalted.length} 个作用域名未带本包哈希盐（${SCOPED_LOCAL_PREFIX}）：` +
      `${[...new Set(unSalted)].slice(0, 8).join(", ")}`,
  )
  process.exit(1)
}

/* 自检：bundle id 必须等于包名（见文件头第 1 条）。 */
if (!built.includes(`id: ${JSON.stringify(BUNDLE_ID)}`)) {
  console.error(`构建自检失败：bundle id 不等于包名 ${BUNDLE_ID}`)
  process.exit(1)
}

console.log(
  `built ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB) ` +
    `id=${BUNDLE_ID} scope=${SCOPED_LOCAL_PREFIX} css=${cssScoped.length}B classes=${cssClasses.size}/${mapped.length} ✓`,
)
