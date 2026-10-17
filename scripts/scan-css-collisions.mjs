/**
 * 跨插件 CSS 撞名扫描器。
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 * DSH 会把**所有插件**的 `<style>` 注入同一个文档，而 esbuild 的 local-css
 * 作用域名固定为 `[CSS 文件名]_[类名]`、**不含包名**（CLI 也没有开关能改这个模板）。
 * 于是两个插件只要 CSS 文件名与类名前缀相同，作用域名就完全一样，
 * 后注入的那份会覆盖先注入的那份的同名规则 —— 症状通常是**另一个插件的界面被改乱**，
 * 而且完全不报错，很难定位。
 *
 * 本脚本扫描 profile 里所有已装插件的客户端产物，列出**任意两个插件之间**重名的
 * 作用域类名，并进一步区分危害等级：
 *   - 🔴 重名且**属性值不同** → 真的会互相覆盖，必须处理（改前缀或加盐）；
 *   - 🟡 重名但属性值完全相同 → 目前无害，但一旦任一方改动就会变成 🔴。
 *
 * 用法（默认扫 desktop profile，可用 DSH_PROFILE_DIR 覆盖）：
 *   node scripts/scan-css-collisions.mjs
 *   node scripts/scan-css-collisions.mjs --json     # 机器可读输出
 *
 * 退出码：发现 🔴 → 1；否则 0（便于接进 CI / 安装后自检）。
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ??
  path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? "", ".dsh"), "profiles", process.env.DSH_PROFILE ?? "desktop")
const NM = path.join(PROFILE_DIR, "node_modules")
const AS_JSON = process.argv.includes("--json")

/**
 * 收集所有可扫描的插件包（junction/symlink 也要跟进去）。
 *
 * 按**包自己的 name 字段**去重：同一个包常同时存在两份 ——
 * 裸名软链（`node_modules/delivery-board-dsh` → 开发树）与
 * 作用域实体目录（`node_modules/@gxx-labs/delivery-board-dsh`）。
 * 它们是磁盘上**不同**的文件（realpath 也不同），只有包名相同；
 * 不去重就会拿它跟自己比对，报出一堆假阳性。
 *
 * @returns `{ name, file }[]`
 */
function findPlugins() {
  const out = []
  const seen = new Set()
  const dirs = [NM, path.join(NM, "@gxx-labs")].filter((d) => fs.existsSync(d))
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue
      const pkgDir = path.join(dir, entry)
      try {
        /* 用 statSync（跟随链接）：Windows 上 dirent 会把 junction 报成 symlink */
        if (!fs.statSync(pkgDir).isDirectory()) continue
      } catch {
        continue
      }
      const client = path.join(pkgDir, "dist", "client.js")
      const manifest = path.join(pkgDir, "package.json")
      if (!fs.existsSync(client) || !fs.existsSync(manifest)) continue
      let pkgName = entry
      try {
        pkgName = JSON.parse(fs.readFileSync(manifest, "utf8")).name ?? entry
      } catch {
        /* 清单坏了就用目录名 */
      }
      if (seen.has(pkgName)) continue
      seen.add(pkgName)
      out.push({ name: pkgName, file: client })
    }
  }
  return out
}

/**
 * 从一个 bundle 里取出「真实类名 → 该类的 CSS 声明文本」，用于比对是否真的冲突。
 *
 * @param bundlePath - dist/client.js
 * @returns `{ classes: Map<string, string>, prefix: string|null }`
 */
function readBundle(bundlePath) {
  const js = fs.readFileSync(bundlePath, "utf8")
  const mapMatch = js.match(/var (\w+)_default = \{([\s\S]*?)\};/)
  const classes = new Map()
  if (mapMatch === null) return { classes, prefix: null }

  /* 取 CSS 文本（构建脚本把它内联进 style 标签的 textContent） */
  const cssMatch = js.match(/__styleTag\.textContent = "((?:[^"\\]|\\.)*)"/)
  let css = ""
  if (cssMatch !== null) {
    try {
      css = JSON.parse(`"${cssMatch[1]}"`)
    } catch {
      css = ""
    }
  }

  for (const m of mapMatch[2].matchAll(/(\w+):\s*"([^"]+)"/g)) {
    const real = m[2]
    /* 抓这个类名对应的规则体（可能有多条，拼起来比对） */
    const bodies = [...css.matchAll(new RegExp(`\\.${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{([^}]*)\\}`, "g"))]
      .map((x) => x[1].replace(/\s+/g, " ").trim())
      .sort()
      .join(" | ")
    classes.set(real, bodies)
  }
  return { classes, prefix: mapMatch[1] }
}

const plugins = findPlugins()
if (!AS_JSON) {
  console.log(`扫描 profile: ${PROFILE_DIR}`)
  console.log(`发现 ${plugins.length} 个带客户端产物的插件\n`)
}
const info = new Map(plugins.map((p) => [p.name, readBundle(p.file)]))

/**
 * 实现指纹：类名 → 声明的完整映射。
 *
 * 用于跳过「同一个实现装了两份」的配对（常见：裸名软链 + 作用域实体目录，
 * 包名不同但代码相同）。拿它跟自己比对只会产生假阳性。
 *
 * ⚠️ 零个自定义类（纯 primitives 的插件）**不参与**指纹比对：它们的映射都是空的，
 * 空指纹会让互不相干的插件被判成"同一实现"（实测踩过：sapbuddy 与 agent-team
 * 都没有自己的 CSS，被误判成同一个）。这类插件本来就不会有类名冲突。
 */
function signatureOf(entry) {
  if (entry.classes.size === 0) return null
  const pairs = [...entry.classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex").slice(0, 12)
}
const signatures = new Map(plugins.map((p) => [p.name, signatureOf(info.get(p.name))]))

const conflicts = []
const sameImpl = []
for (let i = 0; i < plugins.length; i += 1) {
  for (let j = i + 1; j < plugins.length; j += 1) {
    const a = plugins[i]
    const b = plugins[j]
    const sa = signatures.get(a.name)
    if (sa !== null && sa === signatures.get(b.name)) {
      sameImpl.push([a.name, b.name])
      continue
    }
    const ca = info.get(a.name).classes
    const cb = info.get(b.name).classes
    const shared = [...ca.keys()].filter((k) => cb.has(k))
    if (shared.length === 0) continue
    const differing = shared.filter((k) => ca.get(k) !== cb.get(k))
    conflicts.push({
      a: a.name,
      b: b.name,
      shared,
      differing,
      severity: differing.length > 0 ? "critical" : "latent",
    })
  }
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      { profile: PROFILE_DIR, plugins: plugins.map((p) => p.name), sameImplementation: sameImpl, conflicts },
      null,
      2,
    ),
  )
} else if (conflicts.length === 0) {
  console.log("✅ 未发现任何跨插件作用域类名重名。")
  if (sameImpl.length > 0) {
    console.log(`（已跳过 ${sameImpl.length} 组"同一实现装了两份"的配对：${sameImpl.map(([a, b]) => `${a} = ${b}`).join("；")}）`)
  }
} else {
  for (const c of conflicts) {
    const icon = c.severity === "critical" ? "🔴" : "🟡"
    console.log(`${icon} ${c.a}  ×  ${c.b}   重名 ${c.shared.length} 个（其中属性值不同 ${c.differing.length} 个）`)
    console.log(`   重名: ${c.shared.slice(0, 8).join(", ")}${c.shared.length > 8 ? " …" : ""}`)
    if (c.differing.length > 0) {
      console.log(`   会互相覆盖: ${c.differing.slice(0, 8).join(", ")}${c.differing.length > 8 ? " …" : ""}`)
      console.log(`   → 处理：把其中一方的 CSS 文件名 + 类名前缀改成全局唯一（见本插件 README「复用优先」一节）`)
    } else {
      console.log(`   属性值恰好相同，**当前**无可见影响；但任一方改动即变为红色，建议尽早改前缀。`)
    }
    console.log("")
  }
}

process.exit(conflicts.some((c) => c.severity === "critical") ? 1 : 0)
