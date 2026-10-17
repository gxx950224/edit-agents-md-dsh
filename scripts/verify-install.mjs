/**
 * 校验 edit-agents-md-dsh 是否被正确"装进"了 desktop profile。
 *
 * 目标是复现 DSH 加载器真正会做的解析步骤，而不是只看文件在不在：
 *   1. 从 profile 目录能否用 Node 解析到包（loader 用 createRequire(baseUrl).resolve(...)）；
 *   2. main / exports / ./client 三个入口是否都指向真实存在的文件；
 *   3. 包内 cordis.patch.yml 的 Loader 行名是否 === 包名；
 *   4. profile 的 dsh.profile.bundles 是否包含包名（决定 Loader 会不会加载它）；
 *   5. dist/client.js 的 bundle id 是否 === 包名（客户端模块表按包名建键）。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const PROFILE = process.env.DSH_PROFILE_DIR ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? "", ".dsh"), "profiles", process.env.DSH_PROFILE ?? "desktop")
const NAME = "@gxx-labs/edit-agents-md-dsh"
const LINK = path.join(PROFILE, "node_modules", NAME)
/* 包自身根目录（由脚本位置推导，避免硬编码机器路径）。 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

let pass = 0
const failures = []
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { failures.push(`${name}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`) }
}

const profilePkg = JSON.parse(fs.readFileSync(path.join(PROFILE, "package.json"), "utf8"))
const require = createRequire(path.join(PROFILE, "package.json"))

/* 1. Node 解析 */
let mainPath = null
let pkgJsonPath = null
let clientPath = null
try { mainPath = require.resolve(NAME) } catch (e) { mainPath = `ERR ${e.code}` }
try { pkgJsonPath = require.resolve(`${NAME}/package.json`) } catch (e) { pkgJsonPath = `ERR ${e.code}` }
try { clientPath = require.resolve(`${NAME}/client`) } catch (e) { clientPath = `ERR ${e.code}` }

console.log("resolution results:")
console.log(`  main        -> ${mainPath}`)
console.log(`  package.json-> ${pkgJsonPath}`)
console.log(`  ./client    -> ${clientPath}`)

check("junction exists", fs.existsSync(LINK))
check("junction target correct", fs.existsSync(LINK) && path.resolve(fs.realpathSync(LINK)) === path.resolve(PLUGIN_DIR))
check("require.resolve(name) resolves", typeof mainPath === "string" && !mainPath.startsWith("ERR"), mainPath)
check("resolved main exists on disk", typeof mainPath === "string" && !mainPath.startsWith("ERR") && fs.existsSync(mainPath))
check("require.resolve(name/package.json) resolves", typeof pkgJsonPath === "string" && !pkgJsonPath.startsWith("ERR"), pkgJsonPath)
check("require.resolve(name/client) resolves", typeof clientPath === "string" && !clientPath.startsWith("ERR"), clientPath)
check("./client points at dist/client.js", typeof clientPath === "string" && clientPath.endsWith(path.join("dist", "client.js")), String(clientPath))

/* 2. profile 配置 */
check("profile dependencies has the package", Object.hasOwn(profilePkg.dependencies ?? {}, NAME))
check("profile dsh.profile.bundles has the package", (profilePkg.dsh?.profile?.bundles ?? []).includes(NAME), JSON.stringify(profilePkg.dsh?.profile?.bundles))
check("package NOT listed twice in bundles", (profilePkg.dsh?.profile?.bundles ?? []).filter((b) => b === NAME).length === 1)

/* 3. 包自身元数据 */
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"))
check("package name matches install name", pkg.name === NAME, pkg.name)
check("dsh.bundle.patch declared", typeof pkg.dsh?.bundle?.patch === "string")
check("patch file exists", fs.existsSync(path.join(PLUGIN_DIR, pkg.dsh.bundle.patch)))
check("dsh.client.platform === web", pkg.dsh?.client?.platform === "web")
check("client inject declares ui-settings", (pkg.dsh?.client?.inject ?? []).includes("@deepseek-ai/dsh-client-ui-settings"))
const ext = pkg.dsh?.client?.external ?? []
check("client external keeps primitives + react external", ext.includes("@deepseek-ai/dsh-client-ui-primitives") && ext.includes("react"), JSON.stringify(ext))

/* 4. patch 行名 === 包名（loader 用它解析） */
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, pkg.dsh.bundle.patch), "utf8")
check("patch declares a loader row with the exact bare package name", patchText.includes(`name: ${NAME}`) || patchText.includes(`name: '${NAME}'`) || patchText.includes(`name: "${NAME}"`), patchText.split("\n").slice(-4).join(" | "))

/* 5. bundle id === 包名 */
const bundle = fs.readFileSync(path.join(PLUGIN_DIR, "dist", "client.js"), "utf8")
check("bundle id === package name", bundle.includes(`id: ${JSON.stringify(NAME)}`))
check("bundle sets data-plugin === package name", bundle.includes(`__styleTag.dataset.plugin = ${JSON.stringify(NAME)}`))
check("bundle registers settings.section", bundle.includes('"settings.section"'))
check("bundle uses section id agents-md", bundle.includes('"agents-md"'))

console.log(`\n================ INSTALL CHECK ================`)
console.log(`pass ${pass}, fail ${failures.length}`)
for (const f of failures) console.log(`  FAILED: ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
