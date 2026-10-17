/**
 * 路由契约测试：方法、loopback、坏 JSON、白名单、正常路径。
 *
 * **这份测试就是宿主半对外的接口契约**，与浏览器半必须逐字一致。字段名漂移
 * 会让页签打开即空白，所以这里连响应字段名都逐一断言。
 */
import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { ROUTES, apply, buildRouteSpecs, installRoutes, isLoopback, presentState } from "../lib/impl.js"
import { fakeAgents, fakeCtx, fakeFs, fakeTools, json, METHOD_BY_PATH, annotate, callRoute } from "./helpers.mjs"

const HOME = path.resolve("D:\\fakehome")
const AGENTS = path.join(HOME, "AGENTS.md")

/** 造一个功能齐全的 ctx，并返回已注解的路由规格。 */
function boot({ files = {}, agents = [], tools = fakeTools({}), remoteAddress, webServer } = {}) {
  const fsService = fakeFs(files)
  const agentList =
    agents.length > 0 ? agents : [{ id: "session-1", session: { header: { cwd: path.resolve("D:\\proj") } } }]
  const services = { fs: fsService, tools, agents: fakeAgents(agentList) }
  if (webServer !== undefined) services.webServer = webServer
  const { ctx, services: registry, logs } = fakeCtx({ services })
  const specs = annotate(buildRouteSpecs(ctx))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME

  return {
    ctx,
    /* fakeCtx 的 services 是它内部实际读取的那份表（不是我们传进去的原对象），
       测试里替换服务必须改这份。 */
    services: registry,
    logs,
    fsService,
    tools,
    specs,
    specsByPath: new Map(specs.map((spec) => [spec.path, spec])),
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
    async call(url, options = {}) {
      /* 路由按 pathname 注册（kind:'exact' 不含查询串），因此这里按 pathname 查表，
         同时把带查询串的 url 原样交给 handler（handler 自己解析 searchParams）。 */
      const pathname = url.split("?")[0]
      const spec = specs.find((entry) => entry.path === pathname)
      assert.ok(spec, `未注册路由 ${pathname}（实际：${specs.map((s) => s.path).join(", ")}）`)
      return callRoute(spec, { ...options, url })
    },
  }
}

/* ── 路由表本身 ────────────────────────────────────────── */

test("ROUTES 常量就是契约：4 条路由，路径逐字固定", () => {
  assert.deepEqual(ROUTES, {
    state: "/api/edit-agents/state",
    files: "/api/edit-agents/files",
    save: "/api/edit-agents/save",
    refresh: "/api/edit-agents/refresh",
  })
})

test("buildRouteSpecs：4 条路由且 kind 均为 exact", () => {
  const app = boot()
  try {
    assert.equal(app.specs.length, 4)
    for (const spec of app.specs) {
      assert.equal(spec.kind, "exact", `${spec.path} 必须是 exact（前缀匹配会抢别的路由）`)
      assert.equal(typeof spec.handler, "function")
    }
    assert.deepEqual(
      app.specs.map((spec) => spec.path).sort(),
      Object.values(ROUTES).sort(),
    )
  } finally {
    app.restore()
  }
})

test("契约表与 buildRouteSpecs 一致（方法 + 路径）", () => {
  const app = boot()
  try {
    for (const spec of app.specs) {
      assert.equal(METHOD_BY_PATH[spec.path], spec.__method, `${spec.path} 的方法与契约表不符`)
    }
  } finally {
    app.restore()
  }
})

test("installRoutes：webServer.register 返回的 disposer 被收集；注册失败则全部回滚", () => {
  const registered = []
  const disposed = []
  const webServer = {
    register: (spec) => {
      registered.push(spec.path)
      return () => disposed.push(spec.path)
    },
  }
  const ctx = fakeCtx({ services: { fs: fakeFs({}) } }).ctx
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const disposers = installRoutes(webServer, ctx)
    assert.equal(disposers.length, 4)
    assert.equal(registered.length, 4)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }

  /* 第二个路由注册失败 → 第一个必须被回滚。
     注意：register 抛错时**不得**返回 disposer，因此只有第 1 条应被记录。 */
  const rolledBack = []
  const handedOut = []
  let count = 0
  const failing = {
    register: (spec) => {
      count += 1
      if (count === 2) throw new Error("duplicate route")
      const index = count
      handedOut.push(spec.path)
      return () => rolledBack.push(index)
    },
  }
  process.env.DSH_HOME = HOME
  try {
    assert.throws(() => installRoutes(failing, ctx), /duplicate route/)
    assert.equal(handedOut.length, 1, "只有第 1 条注册成功过")
    assert.deepEqual(rolledBack, [1], "已注册的路由必须被回滚")
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test("apply：headless（无 webServer）不抛错，也不注册任何东西", () => {
  const { ctx, logs } = fakeCtx({ services: {} })
  assert.doesNotThrow(() => apply(ctx))
  assert.deepEqual(logs.info, [])
})

test("apply：有 webServer 时注册 4 条路由并写启动日志", () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const routes = []
    const { ctx, services, logs } = fakeCtx({
      services: {
        fs: fakeFs({}),
        webServer: {
          register: (spec) => {
            routes.push(spec.path)
            return () => {}
          },
        },
      },
    })
    apply(ctx)
    assert.equal(routes.length, 4)
    assert.ok(
      logs.info.some((line) => line.includes("AGENTS.md")),
      `应记录权威路径，实际：${JSON.stringify(logs.info)}`,
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

/* ── loopback ──────────────────────────────────────────── */

test("isLoopback：只认三种本机地址形态", () => {
  assert.equal(isLoopback({ socket: { remoteAddress: "127.0.0.1" } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: "::1" } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true)
  assert.equal(isLoopback({ socket: { remoteAddress: "10.0.0.9" } }), false)
  assert.equal(isLoopback({ socket: { remoteAddress: "192.168.1.5" } }), false)
  assert.equal(isLoopback({}), false, "缺 socket 时必须判否（fail-closed）")
  assert.equal(isLoopback(undefined), false)
})

test("POST 路由：非本机 → 403，且不产生任何写入", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    for (const url of [ROUTES.save, ROUTES.refresh]) {
      const res = await app.call(url, {
        method: "POST",
        remoteAddress: "10.0.0.9",
        body: { path: AGENTS, content: "x", version: "v1" },
      })
      assert.equal(res.status, 403, `${url} 必须拒绝非本机`)
      assert.equal(json(res).code, "auth/not-loopback")
    }
    assert.equal(app.fsService.__writes.length, 0)
    assert.equal(app.tools.__calls.length, 0, "403 时不得发起工具调用")
  } finally {
    app.restore()
  }
})

test("GET 路由：非本机也能读（只读，与 mcp-ui-dsh 一致）", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.state, { remoteAddress: "10.0.0.9" })
    assert.equal(res.status, 200)
  } finally {
    app.restore()
  }
})

/* ── 写入请求的来源 / Content-Type（提权后的必要边界）──
 * 保存固定用 danger-full-access，若允许跨站请求，任意网页都能经 loopback
 * 改写全局 AGENTS.md。这组测试锁住 CSRF 防线。 */

test("POST 路由：跨站 Origin → 403 auth/cross-origin，且不写入、不发起工具调用", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    for (const url of [ROUTES.save, ROUTES.refresh]) {
      const res = await app.call(url, {
        method: "POST",
        origin: "http://evil.example",
        body: { path: AGENTS, content: "PWNED", version: "v1" },
      })
      assert.equal(res.status, 403, `${url} 必须拒绝跨站 Origin，实际 ${res.status}`)
      assert.equal(json(res).code, "auth/cross-origin")
    }
    assert.equal(app.fsService.__writes.length, 0, "跨站请求绝不能写入")
    assert.equal(app.tools.__calls.length, 0, "跨站请求绝不能发起工具调用")
  } finally {
    app.restore()
  }
})

test("POST 路由：同源 Origin（Origin.host === Host）→ 正常进入 handler", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      origin: "http://127.0.0.1:19387",
      body: {},
    })
    assert.equal(res.status, 400, `同源请求应进入字段校验（空体 → path/missing），实际 ${res.status}`)
    assert.equal(json(res).code, "path/missing")
  } finally {
    app.restore()
  }
})

test("POST 路由：Origin: null / 自定义协议 → 403（不可信来源 fail-closed）", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    for (const origin of ["null", "file:///tmp/evil.html", "app://dsh"]) {
      const res = await app.call(ROUTES.save, {
        method: "POST",
        origin,
        body: { path: AGENTS, content: "x", version: "v1" },
      })
      assert.equal(res.status, 403, `Origin=${origin} 必须被拒，实际 ${res.status}`)
      assert.equal(json(res).code, "auth/cross-origin")
    }
  } finally {
    app.restore()
  }
})

test("POST 路由：sec-fetch-site=cross-site → 403（即使没有 Origin）", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      secFetchSite: "cross-site",
      body: { path: AGENTS, content: "x", version: "v1" },
    })
    assert.equal(res.status, 403)
    assert.equal(json(res).code, "auth/cross-origin")
  } finally {
    app.restore()
  }
})

test("POST 路由：text/plain 夹 JSON → 415 content/type-required（挡简单请求绕过预检）", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      rawBody: JSON.stringify({ path: AGENTS, content: "PWNED", version: "v1" }),
    })
    assert.equal(res.status, 415, `期望 415，实际 ${res.status}`)
    assert.equal(json(res).code, "content/type-required")
    assert.equal(app.fsService.__writes.length, 0)
  } finally {
    app.restore()
  }
})

test("POST 路由：DNS-rebinding 形态（Host=Origin=evil.example）→ 403，即使头部自洽", async () => {
  /*
   * 攻击场景：浏览器访问 http://evil.example:19387/，该域名 DNS 解析到 127.0.0.1。
   * 此时请求发自页面自身 origin，Host 与 Origin 都是 evil.example —— 如果只比较
   * 「Origin.host === Host」就会放行。绝对 Host 校验必须拒绝非回环字面量。
   */
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      headers: { host: "evil.example:19387", origin: "http://evil.example:19387" },
      body: { path: AGENTS, content: "PWNED", version: "v1" },
    })
    assert.equal(res.status, 403, `DNS-rebinding 形态必须被拒，实际 ${res.status}`)
    assert.equal(json(res).code, "auth/cross-origin")
    assert.equal(app.fsService.__writes.length, 0)
  } finally {
    app.restore()
  }
})

test("POST 路由：Host 不是回环字面量且无 Origin → 403（绝对 Host 校验，不再只看 Origin）", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      headers: { host: "attacker.example:19387" },
      body: { path: AGENTS, content: "PWNED", version: "v1" },
    })
    assert.equal(res.status, 403, `非回环 Host 必须被拒，实际 ${res.status}`)
    assert.equal(json(res).code, "auth/cross-origin")
    assert.equal(app.fsService.__writes.length, 0)
  } finally {
    app.restore()
  }
})

test("POST 路由：webServer 公布的 host 被接受（支持自定义主机名部署）", async () => {
  const app = boot({
    files: { [AGENTS]: "# a" },
    webServer: { getOrigin: () => "http://dsh.internal:5380" },
  })
  try {
    const ok = await app.call(ROUTES.save, {
      method: "POST",
      headers: { host: "dsh.internal:5380", origin: "http://dsh.internal:5380" },
      body: {},
    })
    assert.equal(ok.status, 400, `同源 + 已公布 host 应进入字段校验，实际 ${ok.status}`)
    assert.equal(json(ok).code, "path/missing")

    const badHost = await app.call(ROUTES.save, {
      method: "POST",
      headers: { host: "evil.example:5380", origin: "http://evil.example:5380" },
      body: {},
    })
    assert.equal(badHost.status, 403, "未公布的 host 仍必须被拒（防止 getOrigin 放宽过度）")
  } finally {
    app.restore()
  }
})

test("POST 路由：IPv6 回环 Host（[::1]）被接受", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      headers: { host: "[::1]:19387", origin: "http://[::1]:19387" },
      body: {},
    })
    assert.equal(res.status, 400, `IPv6 回环应被接受，实际 ${res.status}`)
    assert.equal(json(res).code, "path/missing")
  } finally {
    app.restore()
  }
})

test("POST 路由：application/json; charset=utf-8 正常接受", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {},
    })
    assert.equal(res.status, 400)
    assert.equal(json(res).code, "path/missing", "带 charset 的 JSON 不应被 415 拦下")
  } finally {
    app.restore()
  }
})

/* ── 方法限制 ──────────────────────────────────────────── */

test("GET 路由收到 POST → 405", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    for (const url of [ROUTES.state, ROUTES.files]) {
      const res = await app.call(url, { method: "POST", body: {} })
      assert.equal(res.status, 405, `${url} 应只接受 GET`)
      assert.equal(json(res).code, "method/not-allowed")
    }
  } finally {
    app.restore()
  }
})

test("POST 路由收到 GET → 405（且不误判为 403）", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    for (const url of [ROUTES.save, ROUTES.refresh]) {
      const res = await app.call(url, { method: "GET" })
      assert.equal(res.status, 405, `${url} 应只接受 POST`)
    }
  } finally {
    app.restore()
  }
})

test("GET 路由接受 HEAD（与 mcp-ui-dsh 同约定）", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.state, { method: "HEAD" })
    assert.equal(res.status, 200)
  } finally {
    app.restore()
  }
})

/* ── 坏 JSON ───────────────────────────────────────────── */

test("POST 路由：坏 JSON → 400 且原因是可读中文", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    for (const url of [ROUTES.save, ROUTES.refresh]) {
      const res = await app.call(url, { method: "POST", rawBody: "{not json" })
      assert.equal(res.status, 400, `${url} 坏 JSON 应 400`)
      const body = json(res)
      assert.equal(body.ok, false)
      assert.equal(body.code, "body/invalid-json")
      assert.match(body.error, /合法 JSON/)
    }
  } finally {
    app.restore()
  }
})

test("POST 路由：空请求体 → 视为 {} 并走到字段校验（不是 400 解析错误）", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.save, { method: "POST" })
    const body = json(res)
    assert.equal(body.code, "path/missing", `缺 path 应报 path/missing，实际：${res.body}`)
  } finally {
    app.restore()
  }
})

/* ── state ─────────────────────────────────────────────── */

test("GET /state：返回候选清单、选中内容、预算与刷新边界", async () => {
  const app = boot({ files: { [AGENTS]: "# hello\n" } })
  try {
    const res = await app.call(ROUTES.state)
    assert.equal(res.status, 200, res.body)
    const body = json(res)

    assert.equal(body.ok, true)
    assert.equal(body.home, HOME)
    assert.equal(body.authoritativePath, AGENTS, "authoritativePath 必须是 $DSH_HOME/AGENTS.md")

    assert.ok(Array.isArray(body.files) && body.files.length >= 5)
    const authoritative = body.files.find((entry) => entry.authoritative)
    assert.equal(authoritative.path, AGENTS)
    for (const field of ["path", "filename", "scope", "role", "overlay", "exists", "readable", "size", "bytes"]) {
      assert.ok(field in authoritative, `候选条目缺少字段 ${field}`)
    }

    assert.equal(body.selected.path, AGENTS)
    assert.equal(body.selected.content, "# hello\n")
    assert.equal(typeof body.selected.version, "string")
    assert.equal(body.selected.exists, true)

    assert.equal(body.budget.bytes, Buffer.byteLength("# hello\n", "utf8"))
    assert.equal(typeof body.budget.budget, "number")
    assert.equal(body.budget.overBudget, false)

    assert.ok(Array.isArray(body.refreshLimits) && body.refreshLimits.length > 0)
    assert.equal(body.writing.allowed, true)
  } finally {
    app.restore()
  }
})

test("GET /state?path=...：可选中非权威候选（如 AGENT.md）", async () => {
  const agentMd = path.join(HOME, "AGENT.md")
  const app = boot({ files: { [AGENTS]: "# main", [agentMd]: "# singular" } })
  try {
    const res = await app.call(`${ROUTES.state}?path=${encodeURIComponent(agentMd)}`)
    assert.equal(res.status, 200, res.body)
    const body = json(res)
    assert.equal(body.selected.path, agentMd)
    assert.equal(body.selected.content, "# singular")
    assert.equal(body.authoritativePath, AGENTS, "选中别的文件不改变权威路径")
  } finally {
    app.restore()
  }
})

test("GET /state?path=非候选路径：忽略该参数并回落权威文件（不泄露任意文件内容）", async () => {
  const app = boot({ files: { [AGENTS]: "# main", [path.resolve("D:\\secret\\creds.txt")]: "SECRET" } })
  try {
    const res = await app.call(`${ROUTES.state}?path=${encodeURIComponent("D:\\secret\\creds.txt")}`)
    assert.equal(res.status, 200)
    const body = json(res)
    assert.equal(body.selected.path, AGENTS)
    assert.ok(!res.body.includes("SECRET"), "绝不能回传任意路径的文件内容")
  } finally {
    app.restore()
  }
})

test("presentState：没有可用 fs 服务 → 可读的 500（不是 TypeError）", async () => {
  const { ctx } = fakeCtx({ services: {} })
  await assert.rejects(() => presentState(ctx, {}), (error) => {
    assert.equal(error.status, 500)
    assert.equal(error.code, "fs/unavailable")
    return true
  })
})

/* ── files ─────────────────────────────────────────────── */

test("GET /files：重扫候选，响应含 files 与 authoritativePath", async () => {
  const app = boot({ files: {} })
  try {
    const first = json(await app.call(ROUTES.files))
    assert.equal(first.ok, true)
    assert.equal(first.authoritativePath, AGENTS)
    assert.ok(Array.isArray(first.files))
    assert.equal(first.files.find((entry) => entry.authoritative).exists, false)

    /* 外部新建文件后再扫应看到它。 */
    app.fsService.__put(AGENTS, "# created outside")
    const second = json(await app.call(ROUTES.files))
    assert.equal(second.files.find((entry) => entry.authoritative).exists, true)
  } finally {
    app.restore()
  }
})

/* ── save ──────────────────────────────────────────────── */

test("POST /save：正常保存 → ok:true，回带新 version 与预算", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const state = json(await app.call(ROUTES.state))
    const res = await app.call(ROUTES.save, {
      method: "POST",
      body: { path: AGENTS, content: "new content", version: state.selected.version },
    })
    assert.equal(res.status, 200, res.body)
    const body = json(res)

    assert.equal(body.ok, true)
    assert.equal(body.saved.path, AGENTS)
    assert.equal(body.saved.bytes, Buffer.byteLength("new content", "utf8"))
    assert.equal(typeof body.saved.version, "string")
    assert.notEqual(body.saved.version, state.selected.version)
    assert.equal(body.saved.created, false)
    assert.equal(body.saved.overBudget, false)
    assert.ok(Array.isArray(body.files), "save 应回带最新候选清单，省掉前端一次请求")
    assert.equal(body.saved.budget > 0, true)

    assert.equal(app.fsService.__files.get(path.resolve(AGENTS)).content, "new content")
  } finally {
    app.restore()
  }
})

test("POST /save：版本过期 → 409 FS_STALE_VERSION，且不覆盖", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const state = json(await app.call(ROUTES.state))
    app.fsService.__touch(AGENTS)

    const res = await app.call(ROUTES.save, {
      method: "POST",
      body: { path: AGENTS, content: "clobber", version: state.selected.version },
    })
    assert.equal(res.status, 409, res.body)
    const body = json(res)
    assert.equal(body.ok, false)
    assert.equal(body.code, "FS_STALE_VERSION")
    assert.match(body.error, /文件已被外部修改/)
    assert.equal(typeof body.current, "string", "409 应回带当前版本供前端提示重新加载")
    assert.equal(app.fsService.__files.get(path.resolve(AGENTS)).content, "old")
  } finally {
    app.restore()
  }
})

test("POST /save：新建 create:true → ok:true 且 created:true", async () => {
  const app = boot({ files: {} })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      body: { path: AGENTS, content: "# brand new", create: true },
    })
    assert.equal(res.status, 200, res.body)
    const body = json(res)
    assert.equal(body.ok, true)
    assert.equal(body.saved.created, true)
  } finally {
    app.restore()
  }
})

test("POST /save：白名单外的路径 → 403 path/not-allowed（防任意文件写入）", async () => {
  const evil = path.resolve("D:\\Windows\\System32\\drivers\\etc\\hosts")
  const app = boot({ files: { [AGENTS]: "old", [evil]: "127.0.0.1 localhost" } })
  try {
    const res = await app.call(ROUTES.save, {
      method: "POST",
      body: { path: evil, content: "pwned", version: "v1" },
    })
    assert.equal(res.status, 403, res.body)
    assert.equal(json(res).code, "path/not-allowed")
    assert.equal(app.fsService.__writes.length, 0, "白名单拒绝时不得发生写入")
    assert.equal(app.fsService.__files.get(path.resolve(evil)).content, "127.0.0.1 localhost")
  } finally {
    app.restore()
  }
})

test("POST /save：路径大小写不敏感（Windows 语义）", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const state = json(await app.call(ROUTES.state))
    const upper = AGENTS.toUpperCase()
    const res = await app.call(ROUTES.save, {
      method: "POST",
      body: { path: upper, content: "upper", version: state.selected.version },
    })
    assert.equal(res.status, 200, res.body)
  } finally {
    app.restore()
  }
})

test("POST /save：缺 content → 400 content/missing；缺 version → 400 version/missing", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const noContent = await app.call(ROUTES.save, { method: "POST", body: { path: AGENTS, version: "v1" } })
    assert.equal(json(noContent).code, "content/missing")

    const noVersion = await app.call(ROUTES.save, { method: "POST", body: { path: AGENTS, content: "x" } })
    assert.equal(json(noVersion).code, "version/missing")
  } finally {
    app.restore()
  }
})

test("POST /save：content 为空串是合法的（用户可以清空）", async () => {
  const app = boot({ files: { [AGENTS]: "old" } })
  try {
    const state = json(await app.call(ROUTES.state))
    const res = await app.call(ROUTES.save, {
      method: "POST",
      body: { path: AGENTS, content: "", version: state.selected.version },
    })
    assert.equal(res.status, 200, res.body)
    assert.equal(json(res).saved.bytes, 0)
  } finally {
    app.restore()
  }
})

/* ── refresh ───────────────────────────────────────────── */

test("POST /refresh：真实发起 read 触碰 → ok:true / refreshed:true", async () => {
  const app = boot({ files: { [AGENTS]: "# hello\n" } })
  try {
    const res = await app.call(ROUTES.refresh, { method: "POST", body: { path: AGENTS } })
    assert.equal(res.status, 200, res.body)
    const body = json(res)
    assert.equal(body.ok, true)
    assert.equal(body.refreshed, true)
    assert.match(body.method, /read/)
    assert.equal(app.tools.__calls.length, 1)
    assert.equal(app.tools.__calls[0].name, "read")
    assert.equal(app.tools.__calls[0].arguments.file_path, AGENTS)
    assert.ok(app.tools.__calls[0].agent, "必须带 agent")
  } finally {
    app.restore()
  }
})

test("POST /refresh：失败时如实 200 + ok:false（不谎报、也不当成 5xx）", async () => {
  const agent = { id: "session-1", session: { header: {} } }
  const failingTools = fakeTools({ result: { isError: true, error: { message: "权限被拒", code: "FS_DENIED" }, content: [] } })
  const app = boot({ files: { [AGENTS]: "# a" }, agents: [agent], tools: failingTools })
  try {
    const res = await app.call(ROUTES.refresh, { method: "POST", body: { path: AGENTS } })
    assert.equal(res.status, 200, "保存本身没失败，刷新失败用 ok:false 表达")
    const body = json(res)
    assert.equal(body.ok, false)
    assert.equal(body.refreshed, false)
    assert.match(body.reason, /权限被拒/)
    assert.ok(body.fallback.length > 0)
    assert.ok(Array.isArray(body.attempts) && body.attempts.length > 0, "必须回带真实尝试记录")
  } finally {
    app.restore()
  }
})

test("POST /refresh：无活跃 agent → ok:false 且原因可读，未发起调用", async () => {
  const tools = fakeTools({})
  const app = boot({ files: { [AGENTS]: "# a" }, agents: [], tools })
  /* boot 的 agents 默认兜底会补一个，这里显式清空。 */
  app.services.agents = fakeAgents([])
  try {
    const res = await app.call(ROUTES.refresh, { method: "POST", body: { path: AGENTS } })
    assert.equal(res.status, 200, res.body)
    const body = json(res)
    assert.equal(body.ok, false)
    assert.ok(body.reason.length > 0)
    assert.equal(tools.__calls.length, 0)
  } finally {
    app.restore()
  }
})

test("POST /refresh：白名单外路径 → 403（不对任意路径发起工具调用）", async () => {
  const evil = path.resolve("D:\\secret\\passwd")
  const app = boot({ files: { [AGENTS]: "# a", [evil]: "SECRET" } })
  try {
    const res = await app.call(ROUTES.refresh, { method: "POST", body: { path: evil } })
    assert.equal(res.status, 403, res.body)
    assert.equal(json(res).code, "path/not-allowed")
    assert.equal(app.tools.__calls.length, 0)
  } finally {
    app.restore()
  }
})

test("POST /refresh：缺 path → 400", async () => {
  const app = boot({ files: { [AGENTS]: "# a" } })
  try {
    const res = await app.call(ROUTES.refresh, { method: "POST", body: {} })
    assert.equal(json(res).code, "path/missing")
  } finally {
    app.restore()
  }
})

test("POST /refresh：可指定 agentId", async () => {
  const first = { id: "session-a", session: { header: {} } }
  const second = { id: "session-b", session: { header: {} } }
  const tools = fakeTools({})
  const app = boot({ files: { [AGENTS]: "# a" }, agents: [first, second], tools })
  try {
    const res = await app.call(ROUTES.refresh, { method: "POST", body: { path: AGENTS, agentId: "session-b" } })
    assert.equal(res.status, 200, res.body)
    assert.equal(tools.__calls[0].agent, second)
  } finally {
    app.restore()
  }
})

/* ── 与浏览器半的契约锁定 ──────────────────────────────── */

test("契约锁定：三条 POST/GET 响应的顶层字段名固定（防前后端漂移）", async () => {
  const app = boot({ files: { [AGENTS]: "# hello" } })
  try {
    const state = json(await app.call(ROUTES.state))
    for (const field of ["ok", "home", "authoritativePath", "files", "selected", "budget", "refreshLimits", "writing"]) {
      assert.ok(field in state, `state 响应缺少 ${field}`)
    }
    for (const field of ["path", "exists", "content", "version", "bytes", "budget", "remaining", "overBudget"]) {
      assert.ok(field in state.selected, `state.selected 缺少 ${field}`)
    }

    const files = json(await app.call(ROUTES.files))
    for (const field of ["ok", "files", "authoritativePath"]) assert.ok(field in files, `files 响应缺少 ${field}`)

    const saved = json(await app.call(ROUTES.save, {
      method: "POST",
      body: { path: AGENTS, content: "x", version: state.selected.version },
    }))
    for (const field of ["ok", "saved", "files"]) assert.ok(field in saved, `save 响应缺少 ${field}`)
    for (const field of ["path", "version", "bytes", "created"]) assert.ok(field in saved.saved, `save.saved 缺少 ${field}`)

    const refreshed = json(await app.call(ROUTES.refresh, { method: "POST", body: { path: AGENTS } }))
    for (const field of ["ok", "refreshed"]) assert.ok(field in refreshed, `refresh 响应缺少 ${field}`)
  } finally {
    app.restore()
  }
})
