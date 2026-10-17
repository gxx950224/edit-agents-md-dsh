/**
 * 把 edit-agents-md-dsh 以「本地 link」方式装进 desktop profile，用于真机验证。
 *
 * 依据本机既有先例（mcp-ui-dsh 就是这么装的，见 profiles/desktop/node_modules/@gxx-labs/mcp-ui-dsh
 * 是指向开发树 Junction），安装 = 三件事：
 *   1. 在 profiles/desktop/node_modules/ 下建 Junction 指向开发树
 *   2. profile package.json 的 dependencies 里加一条
 *   3. profile package.json 的 dsh.profile.bundles 里追加包名（决定 Loader 是否会加载它）
 *
 * 不做 npm install：Junction 已让 Node 能解析到包，且能避开沙箱下 pnpm 的 EPERM。
 * 重要的是**幂等**：重复执行不产生重复条目。
 *
 * 用法：
 *   node install-live.mjs            # 安装/刷新
 *   node install-live.mjs --uninstall # 移除（恢复安装前的 profile 状态）
 *   node install-live.mjs --status    # 只看当前状态，不改动
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const PKG_NAME = "@gxx-labs/edit-agents-md-dsh"
/* 由脚本自身位置推导包根；profile 目录优先取 DSH 注入的 DSH_PROFILE_DIR。 */
const DEV_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? "", ".dsh"), "profiles", process.env.DSH_PROFILE ?? "desktop")
const PROFILE_PKG = path.join(PROFILE_DIR, "package.json")
const NM_DIR = path.join(PROFILE_DIR, "node_modules")
const LINK_PATH = path.join(NM_DIR, PKG_NAME)

const mode = process.argv.includes("--uninstall")
  ? "uninstall"
  : process.argv.includes("--status")
    ? "status"
    : "install"

function readProfile() {
  return JSON.parse(fs.readFileSync(PROFILE_PKG, "utf8"))
}

function status() {
  const pkg = readProfile()
  const linked = fs.existsSync(LINK_PATH)
  const inDeps = Object.hasOwn(pkg.dependencies ?? {}, PKG_NAME)
  const inBundles = (pkg.dsh?.profile?.bundles ?? []).includes(PKG_NAME)
  const entry = path.join(DEV_TREE, "package.json")
  return {
    linked,
    inDeps,
    inBundles,
    devTreeExists: fs.existsSync(entry),
    devVersion: fs.existsSync(entry) ? JSON.parse(fs.readFileSync(entry, "utf8")).version : null,
  }
}

const before = status()
console.log(`[install-live] 模式=${mode}`)
console.log(`  开发树存在: ${before.devTreeExists}${before.devVersion ? ` (v${before.devVersion})` : ""}`)
console.log(`  已建 Junction: ${before.linked}`)
console.log(`  dependencies 含: ${before.inDeps}`)
console.log(`  bundles 含: ${before.inBundles}`)

if (mode === "status") process.exit(0)

if (mode === "uninstall") {
  /* 先改 package.json 再删链接：若中途失败，至少配置是干净的。 */
  const pkg = readProfile()
  if (pkg.dependencies) delete pkg.dependencies[PKG_NAME]
  if (Array.isArray(pkg.dsh?.profile?.bundles)) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME)
  }
  fs.writeFileSync(PROFILE_PKG, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
  /* Junction 用 rmdir 删（不能用 rm -r，那会穿透进目标目录删掉开发树！）。 */
  if (fs.existsSync(LINK_PATH)) fs.rmdirSync(LINK_PATH)
  console.log("[install-live] 已卸载")
  process.exit(0)
}

/* ---------- 安装 ---------- */
if (!fs.existsSync(DEV_TREE)) {
  console.error(`[install-live] 开发树不存在：${DEV_TREE}`)
  process.exit(1)
}

/* 1. Junction。已存在且指向正确就跳过；指向别处则报错而不是静默覆盖。 */
if (fs.existsSync(LINK_PATH)) {
  const real = fs.realpathSync(LINK_PATH)
  if (path.resolve(real) !== path.resolve(DEV_TREE)) {
    console.error(`[install-live] ${LINK_PATH} 已存在但指向 ${real}，不是 ${DEV_TREE}；请先排查。`)
    process.exit(1)
  }
  console.log("  链接已存在且指向正确，跳过创建")
} else {
  fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true })
  /*
   * 用 cmd 的 mklink /J 建目录联接：不需要管理员权限（符号链接需要），
   * 且 loader 解析 package.json 时把它当普通目录，行为与 npm link 等价。
   */
  execFileSync("cmd.exe", ["/c", "mklink", "/J", LINK_PATH, DEV_TREE], { stdio: "inherit" })
}

/* 2/3. profile package.json 的 dependencies 与 bundles。 */
const pkg = readProfile()
const devVersion = JSON.parse(fs.readFileSync(path.join(DEV_TREE, "package.json"), "utf8")).version
pkg.dependencies ??= {}
pkg.dependencies[PKG_NAME] = `link:${DEV_TREE.replace(/\\/g, "/")}`
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME)
fs.writeFileSync(PROFILE_PKG, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")

const after = status()
console.log(`[install-live] 安装完成 → linked=${after.linked} deps=${after.inDeps} bundles=${after.inBundles}`)
console.log("[install-live] 注意：Loader 需要一次插件重挂载或应用重启才会加载新 bundle。")
