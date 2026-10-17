/**
 * edit-agents-md-dsh 浏览器半：设置 →「系统指令」页签。
 *
 * 设计（按用户要求**大幅简化**）：
 *   只维护**一个**文件 —— `$DSH_HOME/AGENTS.md`，也就是 DSH 真正读取的用户全局指令。
 *   以前这里有个候选列表（AGENTS.md / AGENT.md / CLAUDE.md / *.local.md / 项目级同名
 *   / "保存即新建"的空位，共 15 条），但其中 DSH 真正会加载的只有 AGENTS.md；其余要么
 *   不存在、要么压根不被加载，平铺出来纯属噪声。列表、分组、"显示未创建"开关、
 *   重新扫描按钮、以及页面底部重复一遍的按钮行，**全部删除**。
 *
 * 保留的能力（都有回归测试锁住，改之前先看 test/ 与 scripts/smoke-client.mjs）：
 *   1. **保存失败不得静默**：每次失败都同时给 Toast 和内联错误条；
 *   2. **409 冲突不得覆盖**：明确告知"文件已被外部修改"，让用户自己选
 *      「重新加载（丢弃我的修改）」，绝不替他决定、也绝不自动重试；
 *   3. **刷新要如实呈现**：只有宿主回 `ok && refreshed` 才算真刷新；
 *      其余一律按降级文案渲染（下次工具触碰该路径或新会话时生效）+ 真实原因。
 *      成功文案也**不**断言"已对当前会话生效" —— 宿主挑会话有
 *      `agents.list()[-1]` 兜底，多会话时那未必是用户正看着的会话，
 *      因此改为回显真实投影目标（agentId / agentSource）；
 *   4. **不可写要说清原因**：沙箱策略拒绝时宿主回 403 + 可操作中文，
 *      界面用 writing.reason 摊开讲，并在保存前就能看到。
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  Button,
  IconCheckOutlineMedium,
  IconCopyOutlineMedium,
  IconInfoOutlineMedium,
  IconLoadingOutlineMedium,
  IconRefreshOutlineMedium,
  IconSendOutlineMedium,
  IconWarningOutlineMedium,
  MarkdownText,
  Modal,
  Tag,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives"
/*
 * 必须 import 样式：local-css 给类名加作用域前缀，JS 里读到的是**映射后的**类名
 * （css.Eam_page）。若只 import 而不在 JS 里用，样式标签仍会注入，但类名对不上。
 */
import css from "./Eam.module.css"

/** 字典命名空间。 */
export const NS = "edit-agents-md"

/** 设置导航项 id；须与 settings.section 注册一致。 */
export const SECTION_ID = "agents-md"

/** 页签在设置导航里的排序；26 已被 mcp 占用，故取 27。 */
export const SECTION_ORDER = 27

const API = {
  state: "/api/edit-agents/state",
  save: "/api/edit-agents/save",
  refresh: "/api/edit-agents/refresh",
}

/** 拼接非空类名。 */
function cx(...names) {
  return names.filter(Boolean).join(" ")
}

/** 极简模板替换：`{n}` / `{max}` / `{time}` / `{reason}` / `{v}`。 */
function format(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  )
}

/** 按 UTF-8 计算字节数（与宿主 budget 的口径一致）。 */
function utf8Bytes(text) {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

/** 本地时钟文案（HH:MM:SS）。 */
function clockText(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 发一个请求并解析 JSON，**不把非 2xx 当异常**。
 *
 * 为什么单独有这个函数：`POST /refresh` 在"刷新失败"时仍然返回 **HTTP 200**
 * 并带 `ok:false`（文件保存没失败，刷新是另一件事）。若用会抛错的 postJson，
 * 降级就会被误报成"请求失败"。
 */
async function requestRaw(url, init) {
  const res = await fetch(url, init)
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}

/** 发 POST + JSON，业务失败（ok:false 或非 2xx）抛错并带上响应体。 */
async function postJson(url, body) {
  const { status, data } = await requestRaw(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  if (data?.ok === false) throw Object.assign(new Error(data.error ?? "操作失败"), { status, data })
  if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status}`), { status, data })
  return { status, data }
}

/** 把宿主的 `budget` 收敛成前端模型（上限字段就叫 `budget`）。 */
function toBudget(data) {
  const b = data?.budget ?? {}
  return {
    bytes: typeof b.bytes === "number" ? b.bytes : 0,
    limit: typeof b.budget === "number" ? b.budget : 0,
    remaining: typeof b.remaining === "number" ? b.remaining : 0,
    overBudget: b.overBudget === true,
  }
}

/** 把宿主的 `writing` 收敛成前端模型（可写性 + 沙箱模式）。 */
function toWriting(data) {
  const w = data?.writing ?? {}
  return {
    allowed: w.allowed !== false,
    reason: typeof w.reason === "string" ? w.reason : "",
    sandboxMode: typeof w.sandboxMode === "string" ? w.sandboxMode : "",
    workspaceRoot: typeof w.workspaceRoot === "string" ? w.workspaceRoot : "",
  }
}

const zh = {
  nav: "系统指令",
  title: "系统指令",
  intro:
    "在线编辑 DSH 加载的指令文件（默认 $DSH_HOME/AGENTS.md）。保存后点「立即刷新」会发起一次真实的第一方 read 调用，让新指令重新注入会话。",
  viewEdit: "编辑",
  viewPreview: "预览",
  previewEmpty: "文件是空的，没有可预览的内容。",
  loading: "正在读取指令文件…",
  loadFailed: "读取失败",
  save: "保存",
  saving: "正在保存…",
  saveFailed: "保存失败",
  refresh: "立即刷新",
  refreshing: "正在刷新…",
  refreshFailed: "刷新请求失败",
  reload: "重新读取",
  dirty: "有未保存的修改",
  clean: "已与磁盘一致",
  readonly: "只读",
  saved: "已保存",
  savedBytes: "已保存 {n} 字节",
  savedCreated: "已新建并保存 {n} 字节",
  savedAt: "保存于 {time}",
  copy: "复制路径",
  copied: "已复制路径",
  copyFailed: "复制失败",
  emptyFile: "这个文件还是空的，写点指令吧。",
  createdBySave: "保存后会新建此文件",
  tooLarge: "内容超出上限：{n} / {max} 字节",
  bytes: "{n} 字节",
  bytesBudget: "{n} / {max} 字节",
  chars: "{n} 字符",
  remaining: "剩余 {n} 字节",
  version: "版本",
  writableNo: "此文件当前不可写：{reason}",
  conflictTitle: "文件已被外部修改，无法保存",
  conflictDesc:
    "磁盘上的内容在你编辑期间被改过（也可能是另一个窗口保存的）。为避免覆盖别人的修改，本次保存已中止。",
  conflictReload: "重新加载（丢弃我的修改）",
  conflictDismiss: "稍后处理（保留我的修改）",
  conflictCurrent: "磁盘当前版本令牌：{v}",
  discardTitle: "重新加载并丢弃修改？",
  discardDesc: "编辑器里未保存的内容会丢失，磁盘上的最新内容将被载入。",
  discardCancel: "取消",
  discardGo: "重新加载",
  refreshOk: "已刷新：已发起一次真实的第一方 read 调用，DSH 会据此把新指令投影到会话。",
  refreshTargetLabel: "投影到会话",
  refreshDegraded: "已保存；新指令将在下次工具触碰该路径或新会话时生效。",
  refreshReasonLabel: "宿主返回的原因",
  refreshFallbackLabel: "生效条件",
  refreshNote: "刷新会发起一次真实的第一方 read 调用；DSH 只在 read/write/edit 工具的结果上收集「触碰」。",
  reloadNote: "从磁盘重新载入文件到编辑器；若编辑器里有未保存的修改，会先让你确认。",
  noPath: "未选择文件",
}

const en = {
  nav: "System instructions",
  title: "System instructions",
  intro:
    "Edit the instruction file DSH loads (default $DSH_HOME/AGENTS.md). “Refresh now” issues one real first-party read call so DSH re-injects the instructions into a session.",
  viewEdit: "Edit",
  viewPreview: "Preview",
  previewEmpty: "The file is empty — nothing to preview.",
  loading: "Reading the instruction file…",
  loadFailed: "Failed to load",
  save: "Save",
  saving: "Saving…",
  saveFailed: "Save failed",
  refresh: "Refresh now",
  refreshing: "Refreshing…",
  refreshFailed: "Refresh request failed",
  reload: "Reload",
  dirty: "Unsaved changes",
  clean: "Matches disk",
  readonly: "Read-only",
  saved: "Saved",
  savedBytes: "Saved {n} bytes",
  savedCreated: "Created and saved {n} bytes",
  savedAt: "Saved {time}",
  copy: "Copy path",
  copied: "Path copied",
  copyFailed: "Copy failed",
  emptyFile: "This file is still empty — write some instructions.",
  createdBySave: "Saving creates this file",
  tooLarge: "Over the limit: {n} / {max} bytes",
  bytes: "{n} bytes",
  bytesBudget: "{n} / {max} bytes",
  chars: "{n} characters",
  remaining: "{n} bytes left",
  version: "Version",
  writableNo: "This file is not writable right now: {reason}",
  conflictTitle: "The file changed on disk — cannot save",
  conflictDesc:
    "Its content changed while you were editing (another window may have saved it). This save was aborted so your edit cannot clobber that change.",
  conflictReload: "Reload (discard my changes)",
  conflictDismiss: "Later (keep my changes)",
  conflictCurrent: "Current on-disk version token: {v}",
  discardTitle: "Reload and discard changes?",
  discardDesc: "Unsaved editor content is lost and the latest on-disk content is loaded.",
  discardCancel: "Cancel",
  discardGo: "Reload",
  refreshOk: "Refreshed: a real first-party read call was issued; DSH projects the new instructions from it.",
  refreshTargetLabel: "Projected to session",
  refreshDegraded:
    "Saved; the new instructions take effect on the next tool touch of this path or in a new session.",
  refreshReasonLabel: "Reason from the host",
  refreshFallbackLabel: "Takes effect",
  refreshNote: "Refresh issues one real first-party read call; DSH only collects a “touch” from read/write/edit results.",
  reloadNote: "Reload the file from disk into the editor; if the editor has unsaved changes you are asked first.",
  noPath: "No file selected",
}

/** 设置页签组件。 */
function AgentMdSection(props) {
  const { t } = props

  const [phase, setPhase] = useState("loading")
  const [path, setPath] = useState("")
  const [content, setContent] = useState("")
  const [saved, setSaved] = useState("")
  const [version, setVersion] = useState("")
  const [budget, setBudget] = useState(() => toBudget({}))
  const [writing, setWriting] = useState(() => toWriting({}))
  const [exists, setExists] = useState(true)
  const [selectedMeta, setSelectedMeta] = useState(null)
  const [savedAt, setSavedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null)
  const [toast, setToast] = useState(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /* 编辑器视图：源码编辑 / Markdown 预览。 */
  const [view, setView] = useState("edit")

  const seq = useRef(0)
  const notify = useCallback((next) => {
    seq.current += 1
    setToast({ ...next, seq: seq.current })
  }, [])

  const dirty = content !== saved
  /* 超限判断以**本地输入内容**为准（用户每敲一个字都要看到反馈）。 */
  const liveBytes = utf8Bytes(content)
  const overBudget = budget.limit > 0 && liveBytes > budget.limit
  const canEdit = writing.allowed !== false

  /** 收下一份 state（初次加载 / 保存 / 刷新 / 冲突重载共用同一套字段）。 */
  const adopt = useCallback((data) => {
    setBudget(toBudget(data))
    setWriting(toWriting(data))

    /* 当前文件内容在 **selected** 里（不是顶层扁平字段）。 */
    const sel = data?.selected ?? {}
    const selPath = typeof sel.path === "string" && sel.path !== "" ? sel.path : (data?.path ?? "")
    setPath(selPath)
    const text = typeof sel.content === "string" ? sel.content : (typeof data?.content === "string" ? data.content : "")
    setContent(text)
    setSaved(text)
    setVersion(typeof sel.version === "string" ? sel.version : (typeof data?.version === "string" ? data.version : ""))
    setExists(sel.exists !== false)
    setSelectedMeta({
      readable: sel.readable !== false,
      error: typeof sel.error === "string" ? sel.error : "",
      isDirectory: sel.isDirectory === true,
    })
    setError(null)
  }, [])

  const load = useCallback(async () => {
    setPhase("loading")
    setError(null)
    try {
      const { data } = await requestRaw(API.state)
      if (data?.ok === false) throw new Error(data.error ?? t("loadFailed"))
      adopt(data)
      setSavedAt(Date.now())
      setPhase("ready")
    } catch (e) {
      setError(`${t("loadFailed")}：${e instanceof Error ? e.message : String(e)}`)
      setPhase("failed")
    }
  }, [adopt, t])

  useEffect(() => {
    load()
  }, [load])

  const doSave = useCallback(async () => {
    if (path === "") return
    setBusy(true)
    setError(null)
    setConflict(null)
    try {
      const { data } = await postJson(API.save, {
        path,
        content,
        version,
        /* 文件不存在时允许新建（宿主据此走 createIfAbsent 语义）。 */
        create: exists !== true,
      })
      /*
       * 契约：结果是**嵌套**在 `saved` 下的
       * `{ path, version, bytes, created, budget, remaining, overBudget }`。
       */
      const out = data?.saved ?? {}
      const nextVersion = typeof out.version === "string" ? out.version : version
      setSaved(content)
      setVersion(nextVersion)
      setExists(true)
      setBudget((prev) => ({
        bytes: typeof out.bytes === "number" ? out.bytes : prev.bytes,
        limit: typeof out.budget === "number" ? out.budget : prev.limit,
        remaining: typeof out.remaining === "number" ? out.remaining : prev.remaining,
        overBudget: out.overBudget === true,
      }))
      setSavedAt(Date.now())
      /* 可写性可能随会话沙箱模式变化，顺手用最新响应刷新。 */
      setWriting(toWriting(data))
      notify({
        text:
          out.created === true
            ? format(t("savedCreated"), { n: out.bytes ?? liveBytes })
            : format(t("savedBytes"), { n: out.bytes ?? liveBytes }),
        tone: "success",
        icon: React.createElement(IconCheckOutlineMedium, { size: 16 }),
        holdMs: 3000,
      })
    } catch (e) {
      const status = e?.status
      const data = e?.data
      const code = data?.code ?? ""
      /*
       * 409 = 版本冲突（`FS_STALE_VERSION`，或 create 语义下文件已存在）。
       * 交给冲突条，让用户**自己**决定是否丢弃本地修改 —— 绝不自动重试覆盖。
       */
      if (status === 409 || code === "FS_STALE_VERSION" || code === "path/already-exists") {
        setConflict({
          message: data?.error ?? (e instanceof Error ? e.message : t("saveFailed")),
          current: typeof data?.current === "string" ? data.current : "",
        })
        return
      }
      const message = e instanceof Error ? e.message : String(e)
      setError(`${t("saveFailed")}：${message}`)
      notify({
        text: `${t("saveFailed")}：${message}`,
        tone: "error",
        icon: React.createElement(IconWarningOutlineMedium, { size: 16 }),
        holdMs: 9000,
      })
    } finally {
      setBusy(false)
    }
  }, [path, content, version, exists, liveBytes, notify, t])

  /**
   * 「立即刷新」：让宿主发起一次**真实的**第一方 read 调用，触发 DSH 的指令触碰。
   *
   * 关键：宿主在"刷新失败"时仍返回 **HTTP 200** + `ok:false`，所以这里用
   * requestRaw 并**按 body 判读**；只看状态码会把降级误判成成功。
   * 真正的调用错误（网络故障、400 缺 path）才走 catch。
   */
  const doRefresh = useCallback(async () => {
    if (path === "") return
    setRefreshing(true)
    try {
      const { data } = await requestRaw(API.refresh, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      })
      const reason = typeof data?.reason === "string" ? data.reason.trim() : ""
      const fallback = typeof data?.fallback === "string" ? data.fallback.trim() : ""
      if (data?.ok === true && data?.refreshed === true) {
        /*
         * 诚实性：**不**说"已对当前会话生效"。宿主挑会话的顺序是
         * agentId → currentInitiator() → agents.list()[-1]，多会话或含子 agent 时
         * 最后那个未必是用户正看着的会话。这里只陈述确已发生的事 + 回显真实目标。
         */
        const target = typeof data?.agentId === "string" && data.agentId !== "" ? data.agentId : ""
        const source = typeof data?.agentSource === "string" && data.agentSource !== "" ? data.agentSource : ""
        const where =
          target === "" ? "" : `${t("refreshTargetLabel")}：${target}${source === "" ? "" : `（${source}）`}`
        notify({
          text: where === "" ? t("refreshOk") : `${t("refreshOk")}\n${where}`,
          tone: "success",
          icon: React.createElement(IconCheckOutlineMedium, { size: 16 }),
          holdMs: 6000,
        })
      } else {
        const head =
          fallback === ""
            ? t("refreshDegraded")
            : `${t("refreshDegraded")}\n${t("refreshFallbackLabel")}：${fallback}`
        notify({
          text: reason === "" ? head : `${head}\n${t("refreshReasonLabel")}：${reason}`,
          tone: "warn",
          icon: React.createElement(IconInfoOutlineMedium, { size: 16 }),
          holdMs: reason === "" ? 9000 : 13000,
        })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(`${t("refreshFailed")}：${message}`)
      notify({
        text: `${t("refreshFailed")}：${message}`,
        tone: "warn",
        icon: React.createElement(IconWarningOutlineMedium, { size: 16 }),
        holdMs: 9000,
      })
    } finally {
      setRefreshing(false)
    }
  }, [path, notify, t])

  const copyPath = useCallback(async () => {
    try {
      const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined
      if (clipboard === undefined || clipboard.writeText === undefined) throw new Error("no clipboard")
      await clipboard.writeText(path)
      notify({ text: t("copied"), tone: "success", holdMs: 2500 })
    } catch {
      notify({ text: t("copyFailed"), tone: "error", holdMs: 4000 })
    }
  }, [path, notify, t])

  if (phase === "loading") {
    return React.createElement(
      "div",
      { className: css.Eam_page },
      React.createElement("p", { className: css.Eam_notice, role: "status" }, t("loading")),
    )
  }

  return React.createElement(
    "div",
    { className: css.Eam_page },
    React.createElement("h1", { className: css.Eam_heading }, t("title")),
    React.createElement("p", { className: css.Eam_intro }, t("intro")),

    /* ---- 冲突条：优先于普通错误条展示，动作只有一个出口 ---- */
    conflict !== null &&
      React.createElement(
        "div",
        { className: css.Eam_warn, role: "alert" },
        React.createElement(
          "div",
          null,
          React.createElement("strong", null, t("conflictTitle")),
          React.createElement("div", null, t("conflictDesc")),
          React.createElement("div", { className: css.Eam_hint }, conflict.message),
          conflict.current !== "" &&
            React.createElement(
              "div",
              { className: css.Eam_hint },
              format(t("conflictCurrent"), { v: conflict.current }),
            ),
        ),
        React.createElement(
          "div",
          { className: css.Eam_warnActions },
          React.createElement(Button, { size: "sm", onClick: () => setConflict(null) }, t("conflictDismiss")),
          React.createElement(
            Button,
            { size: "sm", variant: "primary", onClick: () => setConfirmDiscard(true) },
            t("conflictReload"),
          ),
        ),
      ),

    error !== null &&
      React.createElement(
        "div",
        { className: css.Eam_error, role: "alert" },
        React.createElement("span", null, error),
        React.createElement(Button, { size: "sm", onClick: () => setError(null) }, t("conflictDismiss")),
      ),

    /* ---- 工具条 ---- */
    React.createElement(
      "div",
      { className: css.Eam_toolbar },
      React.createElement(
        Button,
        {
          size: "sm",
          variant: "primary",
          disabled: busy || !dirty || overBudget || !canEdit || path === "",
          icon: busy ? React.createElement(IconLoadingOutlineMedium, { size: 16 }) : undefined,
          onClick: doSave,
        },
        busy ? t("saving") : t("save"),
      ),
      React.createElement(
        Button,
        {
          size: "sm",
          disabled: refreshing || dirty || busy || path === "",
          icon: refreshing
            ? React.createElement(IconLoadingOutlineMedium, { size: 16 })
            /* 「推送进会话」：用发送图标，与下面的「从磁盘重载」区分开 */
            : React.createElement(IconSendOutlineMedium, { size: 16 }),
          onClick: doRefresh,
          title: t("refreshNote"),
        },
        refreshing ? t("refreshing") : t("refresh"),
      ),
      React.createElement(
        Button,
        {
          size: "sm",
          disabled: busy,
          /* 「从磁盘拉回」：用循环箭头图标 */
          icon: React.createElement(IconRefreshOutlineMedium, { size: 16 }),
          onClick: () => {
            /*
             * 有未保存修改时**不能**静默丢弃 —— 先让用户确认（复用同一个 Modal）。
             * 以前这里直接 load()，用户会莫名其妙丢掉刚写的内容。
             */
            if (dirty) setConfirmDiscard(true)
            else load()
          },
          title: t("reloadNote"),
        },
        t("reload"),
      ),
      React.createElement("span", { className: css.Eam_grow }),
      dirty
        ? React.createElement(Tag, { tone: "outline" }, t("dirty"))
        : savedAt > 0 &&
          React.createElement(Tag, { tone: "outline" }, format(t("savedAt"), { time: clockText(savedAt) })),
      canEdit ? null : React.createElement(Tag, { tone: "outline", title: writing.reason }, t("readonly")),
    ),

    /* 不可写时把宿主的 reason 摊开说 —— 用户得知道是"为什么"存不了。 */
    !canEdit &&
      React.createElement(
        "p",
        { className: css.Eam_warn, role: "status" },
        format(t("writableNo"), { reason: writing.reason === "" ? t("readonly") : writing.reason }),
      ),

    /* ---- 主体：只有一个文件，所以没有左侧列表，编辑区直接占满 ---- */
    React.createElement(
      "div",
      { className: css.Eam_main },
      React.createElement(
        "div",
        { className: css.Eam_editorHead },
        /*
         * 路径 + 复制按钮**紧挨着**：复制按钮是路径的附属动作，之前把它放在
         * 中间（路径 flex 撑开 + 前面又插了 spacer）会飘到行中央，看着像无主按钮。
         * 现在：路径（可截断）→ 复制 → 弹性空隙 → 编辑/预览。
         */
        React.createElement("span", { className: css.Eam_path, title: path }, path === "" ? t("noPath") : path),
        path !== "" &&
          React.createElement(Button, {
            size: "sm",
            "aria-label": t("copy"),
            title: t("copy"),
            icon: React.createElement(IconCopyOutlineMedium, { size: 16 }),
            onClick: copyPath,
          }),
        React.createElement("span", { className: css.Eam_grow }),
        React.createElement(
          "div",
          { className: css.Eam_viewSwitch, role: "group", "aria-label": t("viewEdit") },
          React.createElement(
            Button,
            { size: "sm", variant: view === "edit" ? "primary" : undefined, onClick: () => setView("edit") },
            t("viewEdit"),
          ),
          React.createElement(
            Button,
            { size: "sm", variant: view === "preview" ? "primary" : undefined, onClick: () => setView("preview") },
            t("viewPreview"),
          ),
        ),
      ),

      view === "preview"
        ? React.createElement(
            "div",
            { className: css.Eam_preview, "aria-label": t("viewPreview") },
            content.trim() === ""
              ? React.createElement("p", { className: css.Eam_hint }, t("previewEmpty"))
              : React.createElement(MarkdownText, { text: content }),
          )
        : React.createElement("textarea", {
            className: canEdit ? css.Eam_editor : cx(css.Eam_editor, css.Eam_editorReadonly),
            value: content,
            spellCheck: false,
            readOnly: !canEdit,
            disabled: busy,
            "aria-label": t("title"),
            placeholder: t("emptyFile"),
            onChange: (e) => {
              setContent(e.target.value)
              setConflict(null)
            },
          }),

      /* 字节数 / 上限 / 剩余 / 脏标记。上限字段来自 budget.budget。 */
      React.createElement(
        "div",
        { className: css.Eam_meta },
        React.createElement(
          "span",
          { className: overBudget ? css.Eam_overBudget : undefined },
          budget.limit > 0
            ? format(t("bytesBudget"), { n: liveBytes, max: budget.limit })
            : format(t("bytes"), { n: liveBytes }),
        ),
        budget.limit > 0 &&
          !overBudget &&
          React.createElement("span", null, format(t("remaining"), { n: Math.max(0, budget.limit - liveBytes) })),
        React.createElement("span", null, format(t("chars"), { n: content.length })),
        React.createElement("span", null, dirty ? t("dirty") : t("clean")),
        version !== "" && React.createElement("span", { className: css.Eam_hint }, `${t("version")}: ${version}`),
        selectedMeta?.isDirectory === true && React.createElement("span", { className: css.Eam_hint }, "isDirectory"),
      ),

      overBudget &&
        React.createElement(
          "p",
          { className: css.Eam_inlineError, role: "alert" },
          format(t("tooLarge"), { n: liveBytes, max: budget.limit }),
        ),

      /* 宿主读了但读不了（权限/沙箱）：把原始 error 亮出来，别让编辑器空白地骗人。 */
      selectedMeta?.readable === false &&
        React.createElement(
          "p",
          { className: css.Eam_warn, role: "alert" },
          selectedMeta.error === "" ? t("loadFailed") : selectedMeta.error,
        ),

      exists === false && React.createElement("span", { className: css.Eam_hint }, t("createdBySave")),
    ),

    /* ---- 丢弃修改确认（破坏性操作走 Modal，不弹原生对话框） ---- */
    React.createElement(Modal, {
      open: confirmDiscard,
      onClose: () => setConfirmDiscard(false),
      title: t("discardTitle"),
      closeLabel: t("discardCancel"),
      description: t("discardDesc"),
      footer: [
        React.createElement(
          Button,
          { key: "cancel", size: "sm", onClick: () => setConfirmDiscard(false) },
          t("discardCancel"),
        ),
        React.createElement(
          Button,
          {
            key: "go",
            variant: "danger",
            size: "sm",
            onClick: () => {
              setConfirmDiscard(false)
              setConflict(null)
              load()
            },
          },
          t("discardGo"),
        ),
      ],
      children: null,
    }),

    toast !== null &&
      React.createElement(Toast, {
        text: toast.text,
        tone: toast.tone,
        icon: toast.icon,
        holdMs: toast.holdMs,
        onDone: () => setToast(null),
        key: `agents-md-toast-${String(toast.seq)}`,
      }),
  )
}

/**
 * 浏览器半入口。注册「设置 → 系统指令」页签。
 *
 * `settings.section` 是 list 槽位（由 ui-settings-general 声明），通过
 * `slots.inject` 等它上账后再注册。id/order 与既有占用错开：
 * account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20) /
 * session-manager(25) / mcp(26) / **agents-md(27)**。
 *
 * locale 用 ctx.get 惰性取（不在这里快照）：Cordis 服务挂在提供方自己的
 * fiber 上，本插件的 apply 早于 provider 注册是可能的排序。
 */
export const inject = ["slots", "locale"]

export function apply(ctx) {
  const locale = ctx.locale ?? ctx.get?.("locale")
  if (locale !== undefined && locale.register !== undefined) {
    ctx.effect(() => locale.register(NS, { zh, en }), "@gxx-labs/edit-agents-md-dsh: dictionaries")
  }
  const t = (key) => {
    if (locale === undefined || locale.bind === undefined) return zh[key] ?? key
    try {
      return locale.bind(NS)(key)
    } catch {
      return zh[key] ?? key
    }
  }

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: SECTION_ID,
        order: SECTION_ORDER,
        /* label 必须是 thunk：导航每次投影时重读，切语言才会跟随。 */
        label: () => t("nav"),
        locale: NS,
        inject: () => ({}),
      },
      AgentMdSection,
    ),
  )
}
