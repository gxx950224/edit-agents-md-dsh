/**
 * 提权写入回归测试：保存**不使用会话沙箱策略**，固定用插件自己的最高权限。
 *
 * ============================================================================
 * 历史（勿删，两个方向都别再退回）
 * ============================================================================
 * 1. 第一版真机缺陷 B1：插件省略 `writeText` 第 5 个参数 → fs 服务按「部署默认」
 *    （workspace-write）围栏，`$DSH_HOME/AGENTS.md` 在工作区之外，**保存 100% 失败**。
 * 2. 第二版修法：把**会话策略**传下去。会话是 workspace-write 时仍被拒，用户必须
 *    先切「完全权限」——用户 2026-10-17 明确要求不要这个前提。
 * 3. 现版本：固定传 `danger-full-access`（`elevatedWritePolicy()`），与当前会话
 *    权限模式无关；保存不再依赖 `sandboxPolicy` / `agents` 服务。
 *
 * 本文件锁四件事：
 *   1. 第 5 个参数必须是 `{ mode: "danger-full-access" }`（删掉/换成会话策略即红）；
 *   2. 与 ctx 是否提供 `sandboxPolicy`、会话是什么模式都无关；
 *   3. 即便全权仍被拒（只读/ACL 等异常），也必须映射成 403 + 可读中文，且不能再
 *      让用户去切会话权限；
 *   4. `/state` 的 `writing` 如实声明高权限写入，不再出现「请放宽为 danger-full-access」。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { fakeCtx, fakeFs, fakeAgents, callRoute, annotate, json } from "./helpers.mjs"
import {
  ELEVATED_WRITE_MODE,
  SANDBOX_DENIED,
  describePolicy,
  elevatedWritePolicy,
  errorCodeOf,
  isPermissionError,
  writeInstructionFile,
} from "../lib/store.js"
import { ROUTES, buildRouteSpecs } from "../lib/impl.js"

const HOME = "C:\\dsh-home"
const AUTH = path.join(HOME, "AGENTS.md")

/**
 * 只用于证明「保存不再调用 sandboxPolicy」：一旦被调用就抛错。
 *
 * @returns 伪服务（含 `__requests`）
 */
function refusingSandboxPolicy() {
  const requests = []
  return {
    __requests: requests,
    defaultMode: "workspace-write",
    workspaceRoot: "D:\\ws",
    resolve(...args) {
      requests.push(args)
      throw new Error("保存不应再调用 sandboxPolicy.resolve()")
    },
    overrideOf: () => undefined,
  }
}

function makeCtx({ services = {}, deny = true } = {}) {
  const fs = fakeFs({ [AUTH]: "# seed\n" })
  fs.__sandboxDeny = deny
  return { fs, ...fakeCtx({ services: { fs, ...services } }) }
}

/** 从 annotate() 的数组里按路径取路由规格。 */
const routeOf = (specs, routePath) => {
  const spec = specs.find((candidate) => candidate.path === routePath)
  assert.ok(spec !== undefined, `未找到路由 ${routePath}`)
  return spec
}

/**
 * 临时把 DSH_HOME 指向假 HOME 并跑一段逻辑。
 *
 * 候选白名单由 `planCandidates` 从 DSH_HOME 派生，所以**必须**改环境变量，
 * 否则假路径不在白名单里，保存会在白名单处就被 403（测不到写入分支）。
 */
async function withFakeHome(run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/* ================= 1. 写入策略固定为最高权限 ================= */
test("writeInstructionFile：第 5 参固定是 danger-full-access 策略（与沙箱围栏无关）", async () => {
  const { fs, ctx } = makeCtx()
  const version = fs.__files.get(path.resolve(AUTH)).version

  await writeInstructionFile(ctx, { path: AUTH, content: "# new\n", version })

  assert.equal(fs.__writes.length, 1)
  const written = fs.__writes[0]
  assert.equal(written.sandboxPolicy?.mode, ELEVATED_WRITE_MODE, "必须显式传最高权限策略")
  assert.equal(
    written.sandboxPolicy?.workspaceRoot,
    path.dirname(path.resolve(AUTH)),
    "workspaceRoot 取目标目录（全权模式下不参与围栏，仅用于日志/诊断）",
  )
  assert.equal(fs.__files.get(path.resolve(AUTH)).content, "# new\n")
})

test("writeInstructionFile：ctx 有 workspace-write 会话时也不调用 sandboxPolicy（保存与会话无关）", async () => {
  const policy = refusingSandboxPolicy()
  const agent = { id: "session-ws", session: { header: { cwd: "D:\\ws" } } }
  const { fs, ctx } = makeCtx({ services: { sandboxPolicy: policy, agents: fakeAgents([agent]) } })
  const version = fs.__files.get(path.resolve(AUTH)).version

  await writeInstructionFile(ctx, { path: AUTH, content: "# via elevated\n", version })

  assert.deepEqual(policy.__requests, [], "保存路径不得调用 sandboxPolicy.resolve（那正是旧行为）")
  assert.equal(fs.__writes[0].sandboxPolicy.mode, ELEVATED_WRITE_MODE)
})

test("writeInstructionFile：没有 sandboxPolicy 服务也能写（不依赖宿主服务）", async () => {
  const { fs, ctx } = makeCtx()
  const version = fs.__files.get(path.resolve(AUTH)).version

  const result = await writeInstructionFile(ctx, { path: AUTH, content: "# ok\n", version })

  assert.equal(result.policy.mode, ELEVATED_WRITE_MODE)
  assert.equal(result.version !== null, true)
  assert.equal(fs.__files.get(path.resolve(AUTH)).content, "# ok\n")
})

/* ================= 2. 路由层：workspace-write 会话也能保存 ================= */
test("POST /save：workspace-write 会话 + 沙箱围栏开启 → 200，文件真的写入（用户需求回归锁）", async () => {
  await withFakeHome(async () => {
    const agent = { id: "session-ws", session: { header: { cwd: "D:\\ws" } } }
    const { fs, ctx } = makeCtx({ services: { agents: fakeAgents([agent]) } })
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: AUTH, content: "# saved without switching permission\n", version },
    })

    assert.equal(res.status, 200, `期望 200，实际 ${res.status} / ${JSON.stringify(json(res)).slice(0, 200)}`)
    assert.equal(fs.__writes[0].sandboxPolicy.mode, ELEVATED_WRITE_MODE, "路由必须把全权策略交给 fs 服务")
    assert.equal(fs.__files.get(path.resolve(AUTH)).content, "# saved without switching permission\n")
  })
})

test("POST /save：没有 agents 服务也 200（保存不再依赖会话解析）", async () => {
  await withFakeHome(async () => {
    const { fs, ctx } = makeCtx()
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: AUTH, content: "# no agents needed\n", version },
    })

    assert.equal(res.status, 200, `期望 200，实际 ${res.status} / ${JSON.stringify(json(res)).slice(0, 200)}`)
    assert.equal(fs.__files.get(path.resolve(AUTH)).content, "# no agents needed\n")
  })
})

/* ================= 3. state：如实声明高权限写入 ================= */
test("GET /state：writing 声明高权限写入，不再提示切会话权限", async () => {
  await withFakeHome(async () => {
    const agent = { id: "session-ws", session: { header: { cwd: "D:\\ws" } } }
    const { ctx } = makeCtx({ services: { agents: fakeAgents([agent]) } })
    const routes = annotate(buildRouteSpecs(ctx))

    const body = json(await callRoute(routeOf(routes, ROUTES.state), { method: "GET" }))

    assert.equal(body.writing.allowed, true)
    assert.equal(body.writing.elevated, true)
    assert.equal(body.writing.mode, ELEVATED_WRITE_MODE)
    assert.equal(body.writing.reason, undefined, "普通文件不应再给出「会被拒绝」的原因")
  })
})

test("GET /state：无 agents / 无 sandboxPolicy 服务时也不崩（不依赖会话）", async () => {
  await withFakeHome(async () => {
    const { ctx } = makeCtx()
    const routes = annotate(buildRouteSpecs(ctx))

    const res = await callRoute(routeOf(routes, ROUTES.state), { method: "GET" })
    const body = json(res)

    assert.equal(res.status, 200)
    assert.equal(body.writing.mode, ELEVATED_WRITE_MODE)
    assert.equal(body.writing.allowed, true)
  })
})

/* ================= 4. 全权仍被拒 → 403 + 可读中文（不再让用户切权限） ================= */
test("writeInstructionFile：即使全权仍被拒 → 403 + FS_SANDBOX_DENIED + 说明「已提权」", async () => {
  const { fs, ctx } = makeCtx({ deny: false })
  /* 模拟 ACL / 只读 / provider 不识别策略等异常拒绝：不看策略，直接拒。 */
  fs.writeText = async () => {
    const error = new Error('cannot write "AGENTS.md": file access denied under danger-full-access mode')
    error.code = "FS_SANDBOX_DENIED"
    throw error
  }
  const version = fs.__files.get(path.resolve(AUTH)).version

  await assert.rejects(
    () => writeInstructionFile(ctx, { path: AUTH, content: "# x\n", version }),
    (error) => {
      assert.equal(error.status, 403, "必须是 403，而不是 500")
      assert.equal(error.code, SANDBOX_DENIED)
      assert.match(error.message, /最高权限/, "文案必须说明插件已使用最高权限")
      assert.match(error.message, /danger-full-access/, "文案必须带实际策略，便于排查")
      assert.doesNotMatch(error.message, /放宽为|切换.*权限|切.*完全权限/, "不得再要求用户切换会话权限")
      assert.equal(error.extra.sandboxMode, ELEVATED_WRITE_MODE)
      return true
    },
  )
})

test("POST /save：权限类错误映射为 403 而不是 500", async () => {
  await withFakeHome(async () => {
    const { fs, ctx } = makeCtx({ deny: false })
    fs.writeText = async () => {
      const error = new Error("EPERM: operation not permitted")
      error.code = "EPERM"
      throw error
    }
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: AUTH, content: "# x\n", version },
    })

    assert.equal(res.status, 403, `期望 403，实际 ${res.status}`)
    assert.equal(json(res).code, SANDBOX_DENIED)
  })
})

/* ================= 5. 辅助函数 ================= */
test("isPermissionError：识别 FS_SANDBOX_DENIED / EPERM / EACCES 及 message 兜底", () => {
  for (const code of ["FS_SANDBOX_DENIED", "EPERM", "EACCES", "EROFS", "FS_NOT_REGULAR_FILE"]) {
    const error = new Error("x")
    error.code = code
    assert.equal(isPermissionError(error), true, `${code} 应判定为权限错误`)
  }
  assert.equal(isPermissionError(new Error("EPERM: operation not permitted")), false, "只有 code 命中或沙箱措辞才算")
  const byMessage = new Error('cannot write "x": file access denied under workspace-write mode')
  assert.equal(isPermissionError(byMessage), true, "无 code 时应从沙箱措辞识别")
  const stale = new Error("FS_STALE_VERSION")
  stale.code = "FS_STALE_VERSION"
  assert.equal(isPermissionError(stale), false, "版本冲突不是权限错误")
})

test("errorCodeOf：能从 code / info.code / cause.code 取码", () => {
  assert.equal(errorCodeOf({ code: "A" }), "A")
  assert.equal(errorCodeOf({ info: { code: "B" } }), "B")
  assert.equal(errorCodeOf({ cause: { code: "C" } }), "C")
  assert.equal(errorCodeOf({}), "")
})

test("describePolicy：压成可读描述；无效输入安全降级", () => {
  assert.equal(describePolicy({ mode: "workspace-write", workspaceRoot: "D:\\ws" }), "mode=workspace-write, workspaceRoot=D:\\ws")
  assert.equal(describePolicy({ mode: "read-only" }), "mode=read-only")
  assert.equal(describePolicy(undefined), "")
  assert.equal(describePolicy(null), "")
})

test("elevatedWritePolicy：模式固定最高权限，workspaceRoot 取目标目录", () => {
  assert.deepEqual(elevatedWritePolicy(AUTH), {
    mode: ELEVATED_WRITE_MODE,
    workspaceRoot: path.dirname(path.resolve(AUTH)),
  })
  assert.equal(elevatedWritePolicy("").mode, ELEVATED_WRITE_MODE, "空路径也必须安全降级")
})
