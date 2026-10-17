/**
 * 健壮性回归测试：L1–L4（独立验证者 verifier 在 task-3 报告中提出的次要缺陷）。
 *
 *   L1 候选与**目录**同名时，以前整页 400，用户连改选文件都做不到；
 *   L2 大小预算原写 64 KiB，与 DSH `maxSourceBytes` 默认 1 MiB 数量级不符；
 *   L3 `readBody` 无上限，任意大的请求体都被完整缓冲；
 *   L4 白名单按字面比较，`C:/…/AGENTS.md` 这类等价拼写被误判 403。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { fakeCtx, fakeFs, callRoute, annotate, json } from "./helpers.mjs"
import { SIZE_BUDGET_BYTES } from "../lib/store.js"
import { MAX_BODY_BYTES, ROUTES, buildRouteSpecs } from "../lib/impl.js"

const HOME = "C:\\dsh-home"
const AUTH = path.join(HOME, "AGENTS.md")

const routeOf = (specs, routePath) => {
  const spec = specs.find((candidate) => candidate.path === routePath)
  assert.ok(spec !== undefined, `未找到路由 ${routePath}`)
  return spec
}

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

/* ================= L1：候选是目录 → 降级而不是整页失败 ================= */
test("L1：AGENTS.md 是目录时 GET /state 仍 200，允许改选其它候选", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({})
    /* 把权威候选建成目录：stat 返回 type=directory，读取会抛 path/not-a-file。 */
    fs.__dirs.add(path.resolve(AUTH))
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))

    const res = await callRoute(routeOf(routes, ROUTES.state), { method: "GET" })
    const body = json(res)

    assert.equal(res.status, 200, "目录候选不应让整个 state 失败")
    assert.equal(body.ok, true)
    assert.equal(body.selected.content, "", "降级为空内容")
    assert.equal(body.writing.allowed, false, "目录不可写")
    assert.match(String(body.writing.reason), /目录/, "应说明原因是目录")
    assert.equal(body.files.length > 0, true, "候选列表仍要返回，用户才能改选")
  })
})

/* ================= L2：预算与 DSH maxSourceBytes 对齐 ================= */
test("L2：大小预算 = DSH maxSourceBytes 默认值 1 MiB（不再是 64 KiB）", async () => {
  assert.equal(SIZE_BUDGET_BYTES, 1024 * 1024)
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))
    const body = json(await callRoute(routeOf(routes, ROUTES.state), { method: "GET" }))
    assert.equal(body.budget.budget, 1024 * 1024)
    assert.equal(body.budget.overBudget, false)
  })
})

/* ================= L3：请求体上限 ================= */
test("L3：超过 MAX_BODY_BYTES 的请求体 → 413 body/too-large（不是默默全缓冲）", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))

    /* 比上限多 1 KiB 的填充，保证跨过阈值。 */
    const filler = "x".repeat(MAX_BODY_BYTES + 1024)
    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      rawBody: `{"path":"${AUTH.replace(/\\/g, "\\\\")}","content":"${filler}"}`,
    })
    const body = json(res)

    assert.equal(res.status, 413, `期望 413，实际 ${res.status}`)
    assert.equal(body.code, "body/too-large")
  })
})

test("L3：上限之内的请求体不受影响（边界内仍可保存）", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    /* 约 100 KiB 内容：超过旧的 64 KiB 硬上限，但在 1 MiB 预算内。 */
    const content = "# heading\n".repeat(10240)
    assert.equal(Buffer.byteLength(content, "utf8") > 64 * 1024, true, "本用例内容必须超过旧的 64 KiB 上限")
    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: AUTH, content, version },
    })

    assert.equal(res.status, 200, `期望 200，实际 ${res.status} / ${JSON.stringify(json(res)).slice(0, 160)}`)
  })
})

/* ================= L4：等价拼写应命中白名单 ================= */
test("L4：正斜杠拼写 / 冗余 . 段 也能命中白名单（规范化后再比对）", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    const forwardSlashes = AUTH.replace(/\\/g, "/")
    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: forwardSlashes, content: "# via forward slashes\n", version },
    })

    assert.equal(res.status, 200, `正斜杠拼写应被接受，实际 ${res.status} / ${JSON.stringify(json(res)).slice(0, 160)}`)
    assert.equal(json(res).saved.path, AUTH, "写入目标必须回正为规范拼写")
  })
})

test("L4：规范化不会放宽白名单（非候选仍然 403）", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    for (const attempt of ["C:/Windows/win.ini", "C:\\dsh-home\\..\\outside.md", "C:\\dsh-home\\.\\..\\evil.md"]) {
      const res = await callRoute(routeOf(routes, ROUTES.save), {
        method: "POST",
        body: { path: attempt, content: "x", version },
      })
      assert.equal(res.status, 403, `${attempt} 应仍然 403，实际 ${res.status}`)
      assert.equal(json(res).code, "path/not-allowed")
    }
  })
})

/* ================= 预算：服务端硬强制 1 MiB（README 声称的硬边界） ================= */
test("预算：超过 1 MiB（多 1 字节）→ 413 content/too-large，且零写入", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: AUTH, content: "x".repeat(SIZE_BUDGET_BYTES + 1), version },
    })
    const body = json(res)

    assert.equal(res.status, 413, `期望 413，实际 ${res.status}`)
    assert.equal(body.code, "content/too-large")
    assert.equal(body.bytes, SIZE_BUDGET_BYTES + 1)
    assert.equal(fs.__writes.length, 0, "超限内容不得写入磁盘")
    assert.equal(fs.__files.get(path.resolve(AUTH)).content, "# seed\n", "原文件必须保持不变")
  })
})

test("预算：恰好 1 MiB 允许保存（边界内不误杀）", async () => {
  await withFakeHome(async () => {
    const fs = fakeFs({ [AUTH]: "# seed\n" })
    const ctx = fakeCtx({ services: { fs } }).ctx
    const routes = annotate(buildRouteSpecs(ctx))
    const version = fs.__files.get(path.resolve(AUTH)).version

    const content = "y".repeat(SIZE_BUDGET_BYTES)
    const res = await callRoute(routeOf(routes, ROUTES.save), {
      method: "POST",
      body: { path: AUTH, content, version },
    })

    assert.equal(res.status, 200, `恰好 1 MiB 应允许，实际 ${res.status}`)
    assert.equal(json(res).saved.bytes, SIZE_BUDGET_BYTES)
  })
})
