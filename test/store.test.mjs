/**
 * lib/store.js 单测：fs 服务契约、版本冲突、白名单、预算。
 *
 * 重点覆盖「版本冲突 → 409」这条路径——它是本插件对用户的核心安全承诺
 * （绝不静默覆盖外部改动）。
 */
import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  SIZE_BUDGET_BYTES,
  STALE_VERSION,
  StoreError,
  allowedWritePaths,
  budgetInfo,
  canonicalWritePath,
  isStaleVersionError,
  listCandidates,
  readInstructionFile,
  requireFs,
  writeInstructionFile,
} from "../lib/store.js"
import { fakeFs, fakeCtx } from "./helpers.mjs"

const HOME = path.resolve("D:\\fakehome")
const AGENTS = path.join(HOME, "AGENTS.md")

/** 造一个注入了 fakeFs 的 ctx。 */
function ctxWith(fsService) {
  return fakeCtx({ services: { fs: fsService } }).ctx
}

/* ── fs 服务可用性 ─────────────────────────────────────── */

test("requireFs：fs 服务缺失 → 可读的 500（不是 TypeError）", () => {
  const ctx = fakeCtx({ services: {} }).ctx
  assert.throws(() => requireFs(ctx), (error) => {
    assert.ok(error instanceof StoreError)
    assert.equal(error.status, 500)
    assert.equal(error.code, "fs/unavailable")
    assert.match(error.message, /fs 服务不可用/)
    return true
  })
})

test("requireFs：ctx.get 抛错 → 转成可读的 500", () => {
  const ctx = {
    get() {
      throw new Error("scope disposed")
    },
  }
  assert.throws(() => requireFs(ctx), (error) => {
    assert.equal(error.code, "fs/unavailable")
    assert.match(error.message, /scope disposed/)
    return true
  })
})

/* ── 读取 ──────────────────────────────────────────────── */

test("readInstructionFile：存在 → 返回 content/version/bytes", async () => {
  const fsService = fakeFs({ [AGENTS]: "# hello\n" })
  const result = await readInstructionFile(ctxWith(fsService), AGENTS)
  assert.equal(result.exists, true)
  assert.equal(result.content, "# hello\n")
  assert.equal(typeof result.version, "string")
  assert.equal(result.bytes, Buffer.byteLength("# hello\n", "utf8"))
})

test("readInstructionFile：不存在 → exists:false 且不抛错（UI 要能新建）", async () => {
  const fsService = fakeFs({})
  const result = await readInstructionFile(ctxWith(fsService), AGENTS)
  assert.equal(result.exists, false)
  assert.equal(result.content, "")
  assert.equal(result.version, null)
  assert.equal(result.bytes, 0)
})

test("readInstructionFile：目标是目录 → 400 path/not-a-file", async () => {
  const fsService = fakeFs({})
  fsService.__dirs.add(path.resolve(AGENTS))
  await assert.rejects(() => readInstructionFile(ctxWith(fsService), AGENTS), (error) => {
    assert.equal(error.status, 400)
    assert.equal(error.code, "path/not-a-file")
    return true
  })
})

/* ── 写入：版本守卫（核心） ────────────────────────────── */

test("writeInstructionFile：版本一致 → 成功写入并返回新 version", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  const read = await readInstructionFile(ctx, AGENTS)
  const written = await writeInstructionFile(ctx, {
    path: AGENTS,
    content: "new",
    version: read.version,
  })
  assert.equal(written.bytes, Buffer.byteLength("new", "utf8"))
  assert.equal(written.existed, true)
  assert.notEqual(written.version, read.version, "写入后应产生新版本")
  assert.equal(fsService.__files.get(path.resolve(AGENTS)).content, "new")
})

test("writeInstructionFile：版本过期 → FS_STALE_VERSION 转 409（绝不静默覆盖）", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  const read = await readInstructionFile(ctx, AGENTS)

  /* 模拟外部工具改了这个文件。 */
  fsService.__touch(AGENTS)

  await assert.rejects(
    () => writeInstructionFile(ctx, { path: AGENTS, content: "clobber", version: read.version }),
    (error) => {
      assert.ok(error instanceof StoreError)
      assert.equal(error.status, 409, "冲突必须是 409")
      assert.equal(error.code, STALE_VERSION, "code 必须是 FS_STALE_VERSION，前端据此走冲突 UI")
      assert.match(error.message, /文件已被外部修改/)
      return true
    },
  )
  assert.equal(fsService.__files.get(path.resolve(AGENTS)).content, "old", "冲突时磁盘内容必须保持原样")
  assert.equal(fsService.__writes.length, 0, "冲突时不得发生任何写入")
})

test("writeInstructionFile：409 响应回带当前版本，前端可直接提示重新加载", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  const read = await readInstructionFile(ctx, AGENTS)
  fsService.__touch(AGENTS)
  const currentVersion = fsService.__files.get(path.resolve(AGENTS)).version

  await assert.rejects(
    () => writeInstructionFile(ctx, { path: AGENTS, content: "x", version: read.version }),
    (error) => {
      assert.equal(error.extra.current, currentVersion)
      return true
    },
  )
})

test("writeInstructionFile：覆盖已存在文件但缺 version → 400（不放行无条件覆盖）", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  for (const version of [undefined, null, ""]) {
    await assert.rejects(() => writeInstructionFile(ctx, { path: AGENTS, content: "x", version }), (error) => {
      assert.equal(error.status, 400)
      assert.equal(error.code, "version/missing")
      return true
    })
  }
})

/* ── 写入：create 语义 ─────────────────────────────────── */

test("writeInstructionFile：create 新建成功，operation 记为 create", async () => {
  const fsService = fakeFs({})
  const ctx = ctxWith(fsService)
  const written = await writeInstructionFile(ctx, { path: AGENTS, content: "# new", create: true })
  assert.equal(written.created, true)
  assert.equal(written.existed, false)
  assert.equal(fsService.__files.get(path.resolve(AGENTS)).content, "# new")
})

test("writeInstructionFile：create 但文件已存在 → 409（不误覆盖）", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  await assert.rejects(() => writeInstructionFile(ctx, { path: AGENTS, content: "x", create: true }), (error) => {
    assert.equal(error.status, 409)
    assert.equal(error.code, "path/already-exists")
    return true
  })
  assert.equal(fsService.__files.get(path.resolve(AGENTS)).content, "old")
})

test("writeInstructionFile：非 create 但文件不存在 → 404（提示显式新建）", async () => {
  const fsService = fakeFs({})
  const ctx = ctxWith(fsService)
  await assert.rejects(() => writeInstructionFile(ctx, { path: AGENTS, content: "x", version: "v1" }), (error) => {
    assert.equal(error.status, 404)
    assert.equal(error.code, "path/absent")
    return true
  })
})

/* ── 参数校验 ──────────────────────────────────────────── */

test("writeInstructionFile：缺 path / content 非字符串 → 400", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  await assert.rejects(() => writeInstructionFile(ctx, { path: "", content: "x" }), (error) => {
    assert.equal(error.code, "path/missing")
    return true
  })
  await assert.rejects(() => writeInstructionFile(ctx, { path: AGENTS, content: 123 }), (error) => {
    assert.equal(error.code, "content/invalid")
    return true
  })
})

test("writeInstructionFile：允许空串（用户清空文件是合法操作）", async () => {
  const fsService = fakeFs({ [AGENTS]: "old" })
  const ctx = ctxWith(fsService)
  const read = await readInstructionFile(ctx, AGENTS)
  const written = await writeInstructionFile(ctx, { path: AGENTS, content: "", version: read.version })
  assert.equal(written.bytes, 0)
  assert.equal(fsService.__files.get(path.resolve(AGENTS)).content, "")
})

/* ── isStaleVersionError 的多种错误形状 ────────────────── */

test("isStaleVersionError：code 在 error.code / info.code / cause.code / message 都能识别", () => {
  assert.equal(isStaleVersionError({ code: "FS_STALE_VERSION" }), true)
  assert.equal(isStaleVersionError({ info: { code: "FS_STALE_VERSION" } }), true)
  assert.equal(isStaleVersionError({ cause: { code: "FS_STALE_VERSION" } }), true)
  assert.equal(isStaleVersionError(new Error("thrown FS_STALE_VERSION by provider")), true)
  assert.equal(isStaleVersionError({ code: "FS_EXISTS" }), false)
  assert.equal(isStaleVersionError(undefined), false)
})

/* ── 候选探测与白名单 ──────────────────────────────────── */

test("listCandidates：用 fs 探测存在性，并标出权威条目", async () => {
  const fsService = fakeFs({ [AGENTS]: "# a" })
  const ctx = ctxWith(fsService)
  /* 用 DSH_HOME 让候选落在假 HOME 下。 */
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const files = await listCandidates(ctx, { cwds: [] })
    const authoritative = files.filter((entry) => entry.authoritative)
    assert.equal(authoritative.length, 1)
    assert.equal(authoritative[0].exists, true)
    assert.equal(authoritative[0].size, Buffer.byteLength("# a", "utf8"))

    const agentMd = files.find((entry) => entry.filename === "AGENT.md")
    assert.equal(agentMd.exists, false, "未创建的兼容候选应标为不存在")
    assert.equal(agentMd.readable, true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test("listCandidates：探测抛错只标该条不可读，不影响整个列表", async () => {
  const fsService = fakeFs({ [AGENTS]: "# a" })
  const originalResolve = fsService.resolve
  fsService.resolve = async (p) => {
    if (String(p).endsWith("CLAUDE.md")) throw new Error("EACCES")
    return originalResolve(p)
  }
  const ctx = ctxWith(fsService)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const files = await listCandidates(ctx, { cwds: [] })
    const broken = files.find((entry) => entry.filename === "CLAUDE.md" && entry.scope === "user")
    assert.equal(broken.readable, false)
    assert.match(broken.error, /EACCES/)
    assert.ok(files.some((entry) => entry.readable && entry.exists), "其余候选仍应正常")
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test("allowedWritePaths：只包含候选路径（小白名单语义）", async () => {
  const fsService = fakeFs({})
  const ctx = ctxWith(fsService)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const allowed = await allowedWritePaths(ctx, { cwds: [] })
    assert.ok(allowed.set.has(AGENTS.toLowerCase()))
    assert.ok(!allowed.set.has(path.resolve("D:\\evil\\passwd").toLowerCase()), "任意路径不得进入白名单")
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test("allowedWritePaths + canonicalWritePath：返回规范拼写（大小写敏感后端上必须）", async () => {
  const fsService = fakeFs({})
  const ctx = ctxWith(fsService)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const allowed = await allowedWritePaths(ctx, { cwds: [] })
    /* 请求体传大写拼写，应解析回候选里的规范拼写。 */
    assert.equal(canonicalWritePath(allowed, AGENTS.toUpperCase()), AGENTS)
    assert.equal(canonicalWritePath(allowed, `  ${AGENTS}  `), AGENTS, "应 trim 空白")
    assert.equal(canonicalWritePath(allowed, path.resolve("D:\\evil\\passwd")), undefined)
    assert.equal(canonicalWritePath(allowed, undefined), undefined)
    assert.equal(canonicalWritePath(allowed, 42), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

/* ── 预算 ──────────────────────────────────────────────── */

test("budgetInfo：正常 / 恰好 / 超限三种情况", () => {
  assert.deepEqual(budgetInfo(0), { bytes: 0, budget: SIZE_BUDGET_BYTES, remaining: SIZE_BUDGET_BYTES, overBudget: false })
  const exact = budgetInfo(SIZE_BUDGET_BYTES)
  assert.equal(exact.overBudget, false, "恰好等于上限不算超")
  assert.equal(exact.remaining, 0)
  const over = budgetInfo(SIZE_BUDGET_BYTES + 1)
  assert.equal(over.overBudget, true)
  assert.equal(over.remaining, 0, "remaining 不得为负")
})

test("budgetInfo：非数字输入安全降级为 0", () => {
  for (const value of [undefined, null, Number.NaN, "12", {}]) {
    assert.equal(budgetInfo(value).bytes, 0)
  }
})
