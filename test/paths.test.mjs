/**
 * lib/paths.js 单测：候选解析与三级 profile 兜底。
 *
 * 运行：node --test test/
 */
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import test from "node:test"

import {
  PROJECT_LEVEL_CANDIDATES,
  PROJECT_ROOT_MARKERS,
  USER_GLOBAL_FILENAME,
  USER_LEVEL_CANDIDATES,
  ancestorDirs,
  findProjectRoot,
  planCandidates,
  resolveDshHome,
  resolvePatchPath,
  resolveProfileDir,
  resolveSessionCwds,
} from "../lib/paths.js"

/* ── DSH_HOME 解析 ─────────────────────────────────────── */

test("resolveDshHome：env 优先，缺省回落 ~/.dsh", () => {
  assert.equal(resolveDshHome({ DSH_HOME: "D:\\custom" }), path.resolve("D:\\custom"))
  assert.equal(resolveDshHome({}), path.join(os.homedir(), ".dsh"))
  /* 空白串视为未设置（不能当成相对路径）。 */
  assert.equal(resolveDshHome({ DSH_HOME: "   " }), path.join(os.homedir(), ".dsh"))
})

test("权威文件名是复数 AGENTS.md（不是 AGENT.md）", () => {
  assert.equal(USER_GLOBAL_FILENAME, "AGENTS.md")
  assert.equal(USER_LEVEL_CANDIDATES[0], "AGENTS.md")
  assert.ok(USER_LEVEL_CANDIDATES.includes("AGENT.md"), "AGENT.md 必须作为兼容候选存在")
  assert.ok(USER_LEVEL_CANDIDATES.includes("CLAUDE.md"), "CLAUDE.md 必须作为兼容候选存在")
  assert.ok(USER_LEVEL_CANDIDATES.includes("AGENTS.local.md"), "AGENTS.local.md 必须作为 overlay 存在")
  assert.deepEqual(PROJECT_ROOT_MARKERS, [".git"])
})

/* ── profile 三级兜底 ──────────────────────────────────── */

test("resolveProfileDir：profileContext.patchPath 优先级最高", () => {
  const ctx = { get: (name) => (name === "profileContext" ? { patchPath: "D:\\p\\profiles\\mine\\cordis.patch.yml" } : undefined) }
  assert.equal(resolveProfileDir(ctx, { DSH_PROFILE_DIR: "D:\\ignored", DSH_HOME: "D:\\ignored2" }), "D:\\p\\profiles\\mine")
})

test("resolveProfileDir：无 profileContext 时用 DSH_PROFILE_DIR", () => {
  const ctx = { get: () => undefined }
  assert.equal(resolveProfileDir(ctx, { DSH_PROFILE_DIR: "D:\\prof" }), path.resolve("D:\\prof"))
})

test("resolveProfileDir：再退回 DSH_HOME/profiles/<DSH_PROFILE||desktop>", () => {
  const ctx = { get: () => undefined }
  assert.equal(
    resolveProfileDir(ctx, { DSH_HOME: "D:\\home" }),
    path.join(path.resolve("D:\\home"), "profiles", "desktop"),
  )
  assert.equal(
    resolveProfileDir(ctx, { DSH_HOME: "D:\\home", DSH_PROFILE: "work" }),
    path.join(path.resolve("D:\\home"), "profiles", "work"),
  )
})

test("resolveProfileDir：三级全不可用 → undefined（不编造路径）", () => {
  const ctx = {
    get() {
      throw new Error("service missing")
    },
  }
  assert.equal(resolveProfileDir(ctx, {}), undefined)
  assert.equal(resolvePatchPath(ctx, {}), undefined)
})

test("resolveProfileDir：profileContext 抛错时不中断，继续走 env", () => {
  const ctx = {
    get() {
      throw new Error("boom")
    },
  }
  assert.equal(resolveProfileDir(ctx, { DSH_PROFILE_DIR: "D:\\p" }), path.resolve("D:\\p"))
})

/* ── 项目根 ────────────────────────────────────────────── */

test("ancestorDirs：从自身到根，不含越界", () => {
  const dirs = ancestorDirs("D:\\a\\b\\c")
  assert.equal(dirs[0], path.resolve("D:\\a\\b\\c"))
  assert.ok(dirs.length >= 2)
  assert.equal(dirs[dirs.length - 1], path.parse(path.resolve("D:\\a\\b\\c")).root)
})

test("ancestorDirs：空/非字符串 → 空数组", () => {
  assert.deepEqual(ancestorDirs(""), [])
  assert.deepEqual(ancestorDirs(undefined), [])
})

test("findProjectRoot：最近的 .git 祖先胜出", () => {
  const markers = new Set([path.resolve("D:\\repo")])
  const found = findProjectRoot("D:\\repo\\packages\\app", (dir) => markers.has(path.resolve(dir)))
  assert.equal(found, path.resolve("D:\\repo"))
})

test("findProjectRoot：没有标记 → undefined", () => {
  assert.equal(findProjectRoot("D:\\x\\y", () => false), undefined)
  assert.equal(findProjectRoot("D:\\x", undefined), undefined)
})

/* ── 候选规划 ──────────────────────────────────────────── */

test("planCandidates：用户级 5 个候选，第一个是权威 AGENTS.md", () => {
  const plan = planCandidates({ env: { DSH_HOME: "D:\\home" }, cwds: [], hasMarker: () => false })
  const userEntries = plan.filter((entry) => entry.scope === "user")
  assert.equal(userEntries.length, USER_LEVEL_CANDIDATES.length)

  const authoritative = plan.filter((entry) => entry.authoritative)
  assert.equal(authoritative.length, 1, "权威条目必须有且只有一个")
  assert.equal(authoritative[0].path, path.join(path.resolve("D:\\home"), "AGENTS.md"))
  assert.equal(authoritative[0].role, "authoritative")

  const roles = new Set(userEntries.map((entry) => entry.role))
  assert.deepEqual([...roles].sort(), ["authoritative", "user-compat"])
})

test("planCandidates：overlay 文件被标记（叠加载而非取代）", () => {
  const plan = planCandidates({ env: { DSH_HOME: "D:\\home" }, cwds: [], hasMarker: () => false })
  const overlay = plan.filter((entry) => entry.overlay).map((entry) => entry.filename)
  assert.deepEqual(overlay.sort(), ["AGENTS.local.md", "CLAUDE.local.md"])
})

test("planCandidates：有 .git 时项目级落在项目根而不是 cwd", () => {
  const root = path.resolve("D:\\repo")
  const plan = planCandidates({
    env: { DSH_HOME: "D:\\home" },
    cwds: ["D:\\repo\\packages\\app"],
    hasMarker: (dir) => path.resolve(dir) === root,
  })
  const project = plan.filter((entry) => entry.scope === "project")
  assert.equal(project.length, PROJECT_LEVEL_CANDIDATES.length)
  for (const entry of project) {
    assert.equal(path.dirname(entry.path), root, `项目级候选应落在项目根：${entry.path}`)
  }
})

test("planCandidates：没有 .git 时项目级退回 cwd", () => {
  const cwd = path.resolve("D:\\loose\\dir")
  const plan = planCandidates({ env: { DSH_HOME: "D:\\home" }, cwds: [cwd], hasMarker: () => false })
  const project = plan.filter((entry) => entry.scope === "project")
  assert.equal(project.length, PROJECT_LEVEL_CANDIDATES.length)
  assert.equal(path.dirname(project[0].path), cwd)
})

test("planCandidates：cwd 就是 DSH_HOME 时不重复列出项目级", () => {
  const home = path.resolve("D:\\home")
  const plan = planCandidates({ env: { DSH_HOME: "D:\\home" }, cwds: [home], hasMarker: () => false })
  assert.equal(plan.filter((entry) => entry.scope === "project").length, 0)
})

test("planCandidates：路径去重（大小写不敏感，Windows 语义）", () => {
  const plan = planCandidates({
    env: { DSH_HOME: "D:\\home" },
    cwds: ["D:\\repo", "d:\\REPO"],
    hasMarker: () => false,
  })
  const keys = plan.map((entry) => entry.path.toLowerCase())
  assert.equal(new Set(keys).size, keys.length, "候选路径不得重复")
})

/* ── 会话 cwd ──────────────────────────────────────────── */

test("resolveSessionCwds：agent 的 session.header.cwd 优先，且含进程 cwd 兜底", () => {
  const ctx = { get: () => undefined }
  const cwds = resolveSessionCwds(ctx, [{ session: { header: { cwd: "D:\\proj" } } }, { session: { header: {} } }])
  assert.ok(cwds.includes(path.resolve("D:\\proj")))
  assert.ok(cwds.includes(path.resolve(process.cwd())))
})

test("resolveSessionCwds：agents 服务不可用时不抛错", () => {
  const ctx = {
    get() {
      throw new Error("no agents")
    },
  }
  const cwds = resolveSessionCwds(ctx, [])
  assert.deepEqual(cwds, [path.resolve(process.cwd())])
})
