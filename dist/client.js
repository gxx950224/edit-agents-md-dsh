/* @gxx-labs/edit-agents-md-dsh client bundle (esbuild) */
window.__ModuleLoader__.load({
  id: "@gxx-labs/edit-agents-md-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  NS: () => NS,
  SECTION_ID: () => SECTION_ID,
  SECTION_ORDER: () => SECTION_ORDER,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// client/Eam.module.css
var Eam_default = {
  Eam_page: "Eam_9d0ae281_page",
  Eam_heading: "Eam_9d0ae281_heading",
  Eam_intro: "Eam_9d0ae281_intro",
  Eam_notice: "Eam_9d0ae281_notice",
  Eam_grow: "Eam_9d0ae281_grow",
  Eam_hint: "Eam_9d0ae281_hint",
  Eam_toolbar: "Eam_9d0ae281_toolbar",
  Eam_error: "Eam_9d0ae281_error",
  Eam_warn: "Eam_9d0ae281_warn",
  Eam_warnActions: "Eam_9d0ae281_warnActions",
  Eam_inlineError: "Eam_9d0ae281_inlineError",
  Eam_main: "Eam_9d0ae281_main",
  Eam_editorHead: "Eam_9d0ae281_editorHead",
  Eam_path: "Eam_9d0ae281_path",
  Eam_viewSwitch: "Eam_9d0ae281_viewSwitch",
  Eam_editor: "Eam_9d0ae281_editor",
  Eam_editorReadonly: "Eam_9d0ae281_editorReadonly",
  Eam_preview: "Eam_9d0ae281_preview",
  Eam_meta: "Eam_9d0ae281_meta",
  Eam_overBudget: "Eam_9d0ae281_overBudget"
};

// client/index.jsx
var NS = "edit-agents-md";
var SECTION_ID = "agents-md";
var SECTION_ORDER = 27;
var API = {
  state: "/api/edit-agents/state",
  save: "/api/edit-agents/save",
  refresh: "/api/edit-agents/refresh"
};
function cx(...names) {
  return names.filter(Boolean).join(" ");
}
function format(template, values) {
  return String(template).replace(
    /\{(\w+)\}/g,
    (whole, key) => Object.hasOwn(values, key) ? String(values[key]) : whole
  );
}
function utf8Bytes(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}
function clockText(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
async function requestRaw(url, init) {
  const res = await fetch(url, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}
async function postJson(url, body) {
  const { status, data } = await requestRaw(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  if (data?.ok === false) throw Object.assign(new Error(data.error ?? "\u64CD\u4F5C\u5931\u8D25"), { status, data });
  if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status}`), { status, data });
  return { status, data };
}
function toBudget(data) {
  const b = data?.budget ?? {};
  return {
    bytes: typeof b.bytes === "number" ? b.bytes : 0,
    limit: typeof b.budget === "number" ? b.budget : 0,
    remaining: typeof b.remaining === "number" ? b.remaining : 0,
    overBudget: b.overBudget === true
  };
}
function toWriting(data) {
  const w = data?.writing ?? {};
  return {
    allowed: w.allowed !== false,
    reason: typeof w.reason === "string" ? w.reason : "",
    sandboxMode: typeof w.sandboxMode === "string" ? w.sandboxMode : "",
    workspaceRoot: typeof w.workspaceRoot === "string" ? w.workspaceRoot : ""
  };
}
var zh = {
  nav: "\u7CFB\u7EDF\u6307\u4EE4",
  title: "\u7CFB\u7EDF\u6307\u4EE4",
  intro: "\u5728\u7EBF\u7F16\u8F91 DSH \u52A0\u8F7D\u7684\u6307\u4EE4\u6587\u4EF6\uFF08\u9ED8\u8BA4 $DSH_HOME/AGENTS.md\uFF09\u3002\u4FDD\u5B58\u540E\u70B9\u300C\u7ACB\u5373\u5237\u65B0\u300D\u4F1A\u53D1\u8D77\u4E00\u6B21\u771F\u5B9E\u7684\u7B2C\u4E00\u65B9 read \u8C03\u7528\uFF0C\u8BA9\u65B0\u6307\u4EE4\u91CD\u65B0\u6CE8\u5165\u4F1A\u8BDD\u3002",
  viewEdit: "\u7F16\u8F91",
  viewPreview: "\u9884\u89C8",
  previewEmpty: "\u6587\u4EF6\u662F\u7A7A\u7684\uFF0C\u6CA1\u6709\u53EF\u9884\u89C8\u7684\u5185\u5BB9\u3002",
  loading: "\u6B63\u5728\u8BFB\u53D6\u6307\u4EE4\u6587\u4EF6\u2026",
  loadFailed: "\u8BFB\u53D6\u5931\u8D25",
  save: "\u4FDD\u5B58",
  saving: "\u6B63\u5728\u4FDD\u5B58\u2026",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25",
  refresh: "\u7ACB\u5373\u5237\u65B0",
  refreshing: "\u6B63\u5728\u5237\u65B0\u2026",
  refreshFailed: "\u5237\u65B0\u8BF7\u6C42\u5931\u8D25",
  reload: "\u91CD\u65B0\u8BFB\u53D6",
  dirty: "\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539",
  clean: "\u5DF2\u4E0E\u78C1\u76D8\u4E00\u81F4",
  readonly: "\u53EA\u8BFB",
  saved: "\u5DF2\u4FDD\u5B58",
  savedBytes: "\u5DF2\u4FDD\u5B58 {n} \u5B57\u8282",
  savedCreated: "\u5DF2\u65B0\u5EFA\u5E76\u4FDD\u5B58 {n} \u5B57\u8282",
  savedAt: "\u4FDD\u5B58\u4E8E {time}",
  copy: "\u590D\u5236\u8DEF\u5F84",
  copied: "\u5DF2\u590D\u5236\u8DEF\u5F84",
  copyFailed: "\u590D\u5236\u5931\u8D25",
  emptyFile: "\u8FD9\u4E2A\u6587\u4EF6\u8FD8\u662F\u7A7A\u7684\uFF0C\u5199\u70B9\u6307\u4EE4\u5427\u3002",
  createdBySave: "\u4FDD\u5B58\u540E\u4F1A\u65B0\u5EFA\u6B64\u6587\u4EF6",
  tooLarge: "\u5185\u5BB9\u8D85\u51FA\u4E0A\u9650\uFF1A{n} / {max} \u5B57\u8282",
  bytes: "{n} \u5B57\u8282",
  bytesBudget: "{n} / {max} \u5B57\u8282",
  chars: "{n} \u5B57\u7B26",
  remaining: "\u5269\u4F59 {n} \u5B57\u8282",
  version: "\u7248\u672C",
  writableNo: "\u6B64\u6587\u4EF6\u5F53\u524D\u4E0D\u53EF\u5199\uFF1A{reason}",
  conflictTitle: "\u6587\u4EF6\u5DF2\u88AB\u5916\u90E8\u4FEE\u6539\uFF0C\u65E0\u6CD5\u4FDD\u5B58",
  conflictDesc: "\u78C1\u76D8\u4E0A\u7684\u5185\u5BB9\u5728\u4F60\u7F16\u8F91\u671F\u95F4\u88AB\u6539\u8FC7\uFF08\u4E5F\u53EF\u80FD\u662F\u53E6\u4E00\u4E2A\u7A97\u53E3\u4FDD\u5B58\u7684\uFF09\u3002\u4E3A\u907F\u514D\u8986\u76D6\u522B\u4EBA\u7684\u4FEE\u6539\uFF0C\u672C\u6B21\u4FDD\u5B58\u5DF2\u4E2D\u6B62\u3002",
  conflictReload: "\u91CD\u65B0\u52A0\u8F7D\uFF08\u4E22\u5F03\u6211\u7684\u4FEE\u6539\uFF09",
  conflictDismiss: "\u7A0D\u540E\u5904\u7406\uFF08\u4FDD\u7559\u6211\u7684\u4FEE\u6539\uFF09",
  conflictCurrent: "\u78C1\u76D8\u5F53\u524D\u7248\u672C\u4EE4\u724C\uFF1A{v}",
  discardTitle: "\u91CD\u65B0\u52A0\u8F7D\u5E76\u4E22\u5F03\u4FEE\u6539\uFF1F",
  discardDesc: "\u7F16\u8F91\u5668\u91CC\u672A\u4FDD\u5B58\u7684\u5185\u5BB9\u4F1A\u4E22\u5931\uFF0C\u78C1\u76D8\u4E0A\u7684\u6700\u65B0\u5185\u5BB9\u5C06\u88AB\u8F7D\u5165\u3002",
  discardCancel: "\u53D6\u6D88",
  discardGo: "\u91CD\u65B0\u52A0\u8F7D",
  refreshOk: "\u5DF2\u5237\u65B0\uFF1A\u5DF2\u53D1\u8D77\u4E00\u6B21\u771F\u5B9E\u7684\u7B2C\u4E00\u65B9 read \u8C03\u7528\uFF0CDSH \u4F1A\u636E\u6B64\u628A\u65B0\u6307\u4EE4\u6295\u5F71\u5230\u4F1A\u8BDD\u3002",
  refreshTargetLabel: "\u6295\u5F71\u5230\u4F1A\u8BDD",
  refreshDegraded: "\u5DF2\u4FDD\u5B58\uFF1B\u65B0\u6307\u4EE4\u5C06\u5728\u4E0B\u6B21\u5DE5\u5177\u89E6\u78B0\u8BE5\u8DEF\u5F84\u6216\u65B0\u4F1A\u8BDD\u65F6\u751F\u6548\u3002",
  refreshReasonLabel: "\u5BBF\u4E3B\u8FD4\u56DE\u7684\u539F\u56E0",
  refreshFallbackLabel: "\u751F\u6548\u6761\u4EF6",
  refreshNote: "\u5237\u65B0\u4F1A\u53D1\u8D77\u4E00\u6B21\u771F\u5B9E\u7684\u7B2C\u4E00\u65B9 read \u8C03\u7528\uFF1BDSH \u53EA\u5728 read/write/edit \u5DE5\u5177\u7684\u7ED3\u679C\u4E0A\u6536\u96C6\u300C\u89E6\u78B0\u300D\u3002",
  reloadNote: "\u4ECE\u78C1\u76D8\u91CD\u65B0\u8F7D\u5165\u6587\u4EF6\u5230\u7F16\u8F91\u5668\uFF1B\u82E5\u7F16\u8F91\u5668\u91CC\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF0C\u4F1A\u5148\u8BA9\u4F60\u786E\u8BA4\u3002",
  noPath: "\u672A\u9009\u62E9\u6587\u4EF6"
};
var en = {
  nav: "System instructions",
  title: "System instructions",
  intro: "Edit the instruction file DSH loads (default $DSH_HOME/AGENTS.md). \u201CRefresh now\u201D issues one real first-party read call so DSH re-injects the instructions into a session.",
  viewEdit: "Edit",
  viewPreview: "Preview",
  previewEmpty: "The file is empty \u2014 nothing to preview.",
  loading: "Reading the instruction file\u2026",
  loadFailed: "Failed to load",
  save: "Save",
  saving: "Saving\u2026",
  saveFailed: "Save failed",
  refresh: "Refresh now",
  refreshing: "Refreshing\u2026",
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
  emptyFile: "This file is still empty \u2014 write some instructions.",
  createdBySave: "Saving creates this file",
  tooLarge: "Over the limit: {n} / {max} bytes",
  bytes: "{n} bytes",
  bytesBudget: "{n} / {max} bytes",
  chars: "{n} characters",
  remaining: "{n} bytes left",
  version: "Version",
  writableNo: "This file is not writable right now: {reason}",
  conflictTitle: "The file changed on disk \u2014 cannot save",
  conflictDesc: "Its content changed while you were editing (another window may have saved it). This save was aborted so your edit cannot clobber that change.",
  conflictReload: "Reload (discard my changes)",
  conflictDismiss: "Later (keep my changes)",
  conflictCurrent: "Current on-disk version token: {v}",
  discardTitle: "Reload and discard changes?",
  discardDesc: "Unsaved editor content is lost and the latest on-disk content is loaded.",
  discardCancel: "Cancel",
  discardGo: "Reload",
  refreshOk: "Refreshed: a real first-party read call was issued; DSH projects the new instructions from it.",
  refreshTargetLabel: "Projected to session",
  refreshDegraded: "Saved; the new instructions take effect on the next tool touch of this path or in a new session.",
  refreshReasonLabel: "Reason from the host",
  refreshFallbackLabel: "Takes effect",
  refreshNote: "Refresh issues one real first-party read call; DSH only collects a \u201Ctouch\u201D from read/write/edit results.",
  reloadNote: "Reload the file from disk into the editor; if the editor has unsaved changes you are asked first.",
  noPath: "No file selected"
};
function AgentMdSection(props) {
  const { t } = props;
  const [phase, setPhase] = (0, import_react.useState)("loading");
  const [path, setPath] = (0, import_react.useState)("");
  const [content, setContent] = (0, import_react.useState)("");
  const [saved, setSaved] = (0, import_react.useState)("");
  const [version, setVersion] = (0, import_react.useState)("");
  const [budget, setBudget] = (0, import_react.useState)(() => toBudget({}));
  const [writing, setWriting] = (0, import_react.useState)(() => toWriting({}));
  const [exists, setExists] = (0, import_react.useState)(true);
  const [selectedMeta, setSelectedMeta] = (0, import_react.useState)(null);
  const [savedAt, setSavedAt] = (0, import_react.useState)(0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [refreshing, setRefreshing] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [conflict, setConflict] = (0, import_react.useState)(null);
  const [toast, setToast] = (0, import_react.useState)(null);
  const [confirmDiscard, setConfirmDiscard] = (0, import_react.useState)(false);
  const [view, setView] = (0, import_react.useState)("edit");
  const seq = (0, import_react.useRef)(0);
  const notify = (0, import_react.useCallback)((next) => {
    seq.current += 1;
    setToast({ ...next, seq: seq.current });
  }, []);
  const dirty = content !== saved;
  const liveBytes = utf8Bytes(content);
  const overBudget = budget.limit > 0 && liveBytes > budget.limit;
  const canEdit = writing.allowed !== false;
  const adopt = (0, import_react.useCallback)((data) => {
    setBudget(toBudget(data));
    setWriting(toWriting(data));
    const sel = data?.selected ?? {};
    const selPath = typeof sel.path === "string" && sel.path !== "" ? sel.path : data?.path ?? "";
    setPath(selPath);
    const text = typeof sel.content === "string" ? sel.content : typeof data?.content === "string" ? data.content : "";
    setContent(text);
    setSaved(text);
    setVersion(typeof sel.version === "string" ? sel.version : typeof data?.version === "string" ? data.version : "");
    setExists(sel.exists !== false);
    setSelectedMeta({
      readable: sel.readable !== false,
      error: typeof sel.error === "string" ? sel.error : "",
      isDirectory: sel.isDirectory === true
    });
    setError(null);
  }, []);
  const load = (0, import_react.useCallback)(async () => {
    setPhase("loading");
    setError(null);
    try {
      const { data } = await requestRaw(API.state);
      if (data?.ok === false) throw new Error(data.error ?? t("loadFailed"));
      adopt(data);
      setSavedAt(Date.now());
      setPhase("ready");
    } catch (e) {
      setError(`${t("loadFailed")}\uFF1A${e instanceof Error ? e.message : String(e)}`);
      setPhase("failed");
    }
  }, [adopt, t]);
  (0, import_react.useEffect)(() => {
    load();
  }, [load]);
  const doSave = (0, import_react.useCallback)(async () => {
    if (path === "") return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const { data } = await postJson(API.save, {
        path,
        content,
        version,
        /* 文件不存在时允许新建（宿主据此走 createIfAbsent 语义）。 */
        create: exists !== true
      });
      const out = data?.saved ?? {};
      const nextVersion = typeof out.version === "string" ? out.version : version;
      setSaved(content);
      setVersion(nextVersion);
      setExists(true);
      setBudget((prev) => ({
        bytes: typeof out.bytes === "number" ? out.bytes : prev.bytes,
        limit: typeof out.budget === "number" ? out.budget : prev.limit,
        remaining: typeof out.remaining === "number" ? out.remaining : prev.remaining,
        overBudget: out.overBudget === true
      }));
      setSavedAt(Date.now());
      setWriting(toWriting(data));
      notify({
        text: out.created === true ? format(t("savedCreated"), { n: out.bytes ?? liveBytes }) : format(t("savedBytes"), { n: out.bytes ?? liveBytes }),
        tone: "success",
        icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconCheckOutlineMedium, { size: 16 }),
        holdMs: 3e3
      });
    } catch (e) {
      const status = e?.status;
      const data = e?.data;
      const code = data?.code ?? "";
      if (status === 409 || code === "FS_STALE_VERSION" || code === "path/already-exists") {
        setConflict({
          message: data?.error ?? (e instanceof Error ? e.message : t("saveFailed")),
          current: typeof data?.current === "string" ? data.current : ""
        });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setError(`${t("saveFailed")}\uFF1A${message}`);
      notify({
        text: `${t("saveFailed")}\uFF1A${message}`,
        tone: "error",
        icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconWarningOutlineMedium, { size: 16 }),
        holdMs: 9e3
      });
    } finally {
      setBusy(false);
    }
  }, [path, content, version, exists, liveBytes, notify, t]);
  const doRefresh = (0, import_react.useCallback)(async () => {
    if (path === "") return;
    setRefreshing(true);
    try {
      const { data } = await requestRaw(API.refresh, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      const reason = typeof data?.reason === "string" ? data.reason.trim() : "";
      const fallback = typeof data?.fallback === "string" ? data.fallback.trim() : "";
      if (data?.ok === true && data?.refreshed === true) {
        const target = typeof data?.agentId === "string" && data.agentId !== "" ? data.agentId : "";
        const source = typeof data?.agentSource === "string" && data.agentSource !== "" ? data.agentSource : "";
        const where = target === "" ? "" : `${t("refreshTargetLabel")}\uFF1A${target}${source === "" ? "" : `\uFF08${source}\uFF09`}`;
        notify({
          text: where === "" ? t("refreshOk") : `${t("refreshOk")}
${where}`,
          tone: "success",
          icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconCheckOutlineMedium, { size: 16 }),
          holdMs: 6e3
        });
      } else {
        const head = fallback === "" ? t("refreshDegraded") : `${t("refreshDegraded")}
${t("refreshFallbackLabel")}\uFF1A${fallback}`;
        notify({
          text: reason === "" ? head : `${head}
${t("refreshReasonLabel")}\uFF1A${reason}`,
          tone: "warn",
          icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconInfoOutlineMedium, { size: 16 }),
          holdMs: reason === "" ? 9e3 : 13e3
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`${t("refreshFailed")}\uFF1A${message}`);
      notify({
        text: `${t("refreshFailed")}\uFF1A${message}`,
        tone: "warn",
        icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconWarningOutlineMedium, { size: 16 }),
        holdMs: 9e3
      });
    } finally {
      setRefreshing(false);
    }
  }, [path, notify, t]);
  const copyPath = (0, import_react.useCallback)(async () => {
    try {
      const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : void 0;
      if (clipboard === void 0 || clipboard.writeText === void 0) throw new Error("no clipboard");
      await clipboard.writeText(path);
      notify({ text: t("copied"), tone: "success", holdMs: 2500 });
    } catch {
      notify({ text: t("copyFailed"), tone: "error", holdMs: 4e3 });
    }
  }, [path, notify, t]);
  if (phase === "loading") {
    return import_react.default.createElement(
      "div",
      { className: Eam_default.Eam_page },
      import_react.default.createElement("p", { className: Eam_default.Eam_notice, role: "status" }, t("loading"))
    );
  }
  return import_react.default.createElement(
    "div",
    { className: Eam_default.Eam_page },
    import_react.default.createElement("h1", { className: Eam_default.Eam_heading }, t("title")),
    import_react.default.createElement("p", { className: Eam_default.Eam_intro }, t("intro")),
    /* ---- 冲突条：优先于普通错误条展示，动作只有一个出口 ---- */
    conflict !== null && import_react.default.createElement(
      "div",
      { className: Eam_default.Eam_warn, role: "alert" },
      import_react.default.createElement(
        "div",
        null,
        import_react.default.createElement("strong", null, t("conflictTitle")),
        import_react.default.createElement("div", null, t("conflictDesc")),
        import_react.default.createElement("div", { className: Eam_default.Eam_hint }, conflict.message),
        conflict.current !== "" && import_react.default.createElement(
          "div",
          { className: Eam_default.Eam_hint },
          format(t("conflictCurrent"), { v: conflict.current })
        )
      ),
      import_react.default.createElement(
        "div",
        { className: Eam_default.Eam_warnActions },
        import_react.default.createElement(import_dsh_client_ui_primitives.Button, { size: "sm", onClick: () => setConflict(null) }, t("conflictDismiss")),
        import_react.default.createElement(
          import_dsh_client_ui_primitives.Button,
          { size: "sm", variant: "primary", onClick: () => setConfirmDiscard(true) },
          t("conflictReload")
        )
      )
    ),
    error !== null && import_react.default.createElement(
      "div",
      { className: Eam_default.Eam_error, role: "alert" },
      import_react.default.createElement("span", null, error),
      import_react.default.createElement(import_dsh_client_ui_primitives.Button, { size: "sm", onClick: () => setError(null) }, t("conflictDismiss"))
    ),
    /* ---- 工具条 ---- */
    import_react.default.createElement(
      "div",
      { className: Eam_default.Eam_toolbar },
      import_react.default.createElement(
        import_dsh_client_ui_primitives.Button,
        {
          size: "sm",
          variant: "primary",
          disabled: busy || !dirty || overBudget || !canEdit || path === "",
          icon: busy ? import_react.default.createElement(import_dsh_client_ui_primitives.IconLoadingOutlineMedium, { size: 16 }) : void 0,
          onClick: doSave
        },
        busy ? t("saving") : t("save")
      ),
      import_react.default.createElement(
        import_dsh_client_ui_primitives.Button,
        {
          size: "sm",
          disabled: refreshing || dirty || busy || path === "",
          icon: refreshing ? import_react.default.createElement(import_dsh_client_ui_primitives.IconLoadingOutlineMedium, { size: 16 }) : import_react.default.createElement(import_dsh_client_ui_primitives.IconSendOutlineMedium, { size: 16 }),
          onClick: doRefresh,
          title: t("refreshNote")
        },
        refreshing ? t("refreshing") : t("refresh")
      ),
      import_react.default.createElement(
        import_dsh_client_ui_primitives.Button,
        {
          size: "sm",
          disabled: busy,
          /* 「从磁盘拉回」：用循环箭头图标 */
          icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconRefreshOutlineMedium, { size: 16 }),
          onClick: () => {
            if (dirty) setConfirmDiscard(true);
            else load();
          },
          title: t("reloadNote")
        },
        t("reload")
      ),
      import_react.default.createElement("span", { className: Eam_default.Eam_grow }),
      dirty ? import_react.default.createElement(import_dsh_client_ui_primitives.Tag, { tone: "outline" }, t("dirty")) : savedAt > 0 && import_react.default.createElement(import_dsh_client_ui_primitives.Tag, { tone: "outline" }, format(t("savedAt"), { time: clockText(savedAt) })),
      canEdit ? null : import_react.default.createElement(import_dsh_client_ui_primitives.Tag, { tone: "outline", title: writing.reason }, t("readonly"))
    ),
    /* 不可写时把宿主的 reason 摊开说 —— 用户得知道是"为什么"存不了。 */
    !canEdit && import_react.default.createElement(
      "p",
      { className: Eam_default.Eam_warn, role: "status" },
      format(t("writableNo"), { reason: writing.reason === "" ? t("readonly") : writing.reason })
    ),
    /* ---- 主体：只有一个文件，所以没有左侧列表，编辑区直接占满 ---- */
    import_react.default.createElement(
      "div",
      { className: Eam_default.Eam_main },
      import_react.default.createElement(
        "div",
        { className: Eam_default.Eam_editorHead },
        /*
         * 路径 + 复制按钮**紧挨着**：复制按钮是路径的附属动作，之前把它放在
         * 中间（路径 flex 撑开 + 前面又插了 spacer）会飘到行中央，看着像无主按钮。
         * 现在：路径（可截断）→ 复制 → 弹性空隙 → 编辑/预览。
         */
        import_react.default.createElement("span", { className: Eam_default.Eam_path, title: path }, path === "" ? t("noPath") : path),
        path !== "" && import_react.default.createElement(import_dsh_client_ui_primitives.Button, {
          size: "sm",
          "aria-label": t("copy"),
          title: t("copy"),
          icon: import_react.default.createElement(import_dsh_client_ui_primitives.IconCopyOutlineMedium, { size: 16 }),
          onClick: copyPath
        }),
        import_react.default.createElement("span", { className: Eam_default.Eam_grow }),
        import_react.default.createElement(
          "div",
          { className: Eam_default.Eam_viewSwitch, role: "group", "aria-label": t("viewEdit") },
          import_react.default.createElement(
            import_dsh_client_ui_primitives.Button,
            { size: "sm", variant: view === "edit" ? "primary" : void 0, onClick: () => setView("edit") },
            t("viewEdit")
          ),
          import_react.default.createElement(
            import_dsh_client_ui_primitives.Button,
            { size: "sm", variant: view === "preview" ? "primary" : void 0, onClick: () => setView("preview") },
            t("viewPreview")
          )
        )
      ),
      view === "preview" ? import_react.default.createElement(
        "div",
        { className: Eam_default.Eam_preview, "aria-label": t("viewPreview") },
        content.trim() === "" ? import_react.default.createElement("p", { className: Eam_default.Eam_hint }, t("previewEmpty")) : import_react.default.createElement(import_dsh_client_ui_primitives.MarkdownText, { text: content })
      ) : import_react.default.createElement("textarea", {
        className: canEdit ? Eam_default.Eam_editor : cx(Eam_default.Eam_editor, Eam_default.Eam_editorReadonly),
        value: content,
        spellCheck: false,
        readOnly: !canEdit,
        disabled: busy,
        "aria-label": t("title"),
        placeholder: t("emptyFile"),
        onChange: (e) => {
          setContent(e.target.value);
          setConflict(null);
        }
      }),
      /* 字节数 / 上限 / 剩余 / 脏标记。上限字段来自 budget.budget。 */
      import_react.default.createElement(
        "div",
        { className: Eam_default.Eam_meta },
        import_react.default.createElement(
          "span",
          { className: overBudget ? Eam_default.Eam_overBudget : void 0 },
          budget.limit > 0 ? format(t("bytesBudget"), { n: liveBytes, max: budget.limit }) : format(t("bytes"), { n: liveBytes })
        ),
        budget.limit > 0 && !overBudget && import_react.default.createElement("span", null, format(t("remaining"), { n: Math.max(0, budget.limit - liveBytes) })),
        import_react.default.createElement("span", null, format(t("chars"), { n: content.length })),
        import_react.default.createElement("span", null, dirty ? t("dirty") : t("clean")),
        version !== "" && import_react.default.createElement("span", { className: Eam_default.Eam_hint }, `${t("version")}: ${version}`),
        selectedMeta?.isDirectory === true && import_react.default.createElement("span", { className: Eam_default.Eam_hint }, "isDirectory")
      ),
      overBudget && import_react.default.createElement(
        "p",
        { className: Eam_default.Eam_inlineError, role: "alert" },
        format(t("tooLarge"), { n: liveBytes, max: budget.limit })
      ),
      /* 宿主读了但读不了（权限/沙箱）：把原始 error 亮出来，别让编辑器空白地骗人。 */
      selectedMeta?.readable === false && import_react.default.createElement(
        "p",
        { className: Eam_default.Eam_warn, role: "alert" },
        selectedMeta.error === "" ? t("loadFailed") : selectedMeta.error
      ),
      exists === false && import_react.default.createElement("span", { className: Eam_default.Eam_hint }, t("createdBySave"))
    ),
    /* ---- 丢弃修改确认（破坏性操作走 Modal，不弹原生对话框） ---- */
    import_react.default.createElement(import_dsh_client_ui_primitives.Modal, {
      open: confirmDiscard,
      onClose: () => setConfirmDiscard(false),
      title: t("discardTitle"),
      closeLabel: t("discardCancel"),
      description: t("discardDesc"),
      footer: [
        import_react.default.createElement(
          import_dsh_client_ui_primitives.Button,
          { key: "cancel", size: "sm", onClick: () => setConfirmDiscard(false) },
          t("discardCancel")
        ),
        import_react.default.createElement(
          import_dsh_client_ui_primitives.Button,
          {
            key: "go",
            variant: "danger",
            size: "sm",
            onClick: () => {
              setConfirmDiscard(false);
              setConflict(null);
              load();
            }
          },
          t("discardGo")
        )
      ],
      children: null
    }),
    toast !== null && import_react.default.createElement(import_dsh_client_ui_primitives.Toast, {
      text: toast.text,
      tone: toast.tone,
      icon: toast.icon,
      holdMs: toast.holdMs,
      onDone: () => setToast(null),
      key: `agents-md-toast-${String(toast.seq)}`
    })
  );
}
var inject = ["slots", "locale"];
function apply(ctx) {
  const locale = ctx.locale ?? ctx.get?.("locale");
  if (locale !== void 0 && locale.register !== void 0) {
    ctx.effect(() => locale.register(NS, { zh, en }), "@gxx-labs/edit-agents-md-dsh: dictionaries");
  }
  const t = (key) => {
    if (locale === void 0 || locale.bind === void 0) return zh[key] ?? key;
    try {
      return locale.bind(NS)(key);
    } catch {
      return zh[key] ?? key;
    }
  };
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: SECTION_ID,
        order: SECTION_ORDER,
        /* label 必须是 thunk：导航每次投影时重读，切语言才会跟随。 */
        label: () => t("nav"),
        locale: NS,
        inject: () => ({})
      },
      AgentMdSection
    )
  );
}
var __cssTagId = "@gxx-labs/edit-agents-md-dsh/Eam.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(__cssTagId) + "]") === null) {
  var __styleTag = document.createElement("style");
  __styleTag.dataset.plugin = "@gxx-labs/edit-agents-md-dsh";
  __styleTag.dataset.pluginCss = __cssTagId;
  __styleTag.textContent = "/* client/Eam.module.css */\n.Eam_9d0ae281_page {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  padding: 4px 2px 24px;\n  max-width: none;\n  min-height: 0;\n}\n.Eam_9d0ae281_heading {\n  margin: 0;\n  font-size: 18px;\n  font-weight: 600;\n  line-height: 1.4;\n  color: var(--dsw-alias-label-primary);\n}\n.Eam_9d0ae281_intro {\n  margin: 0;\n  font-size: 13px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-secondary);\n}\n.Eam_9d0ae281_notice {\n  margin: 0;\n  font-size: 13px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-secondary);\n}\n.Eam_9d0ae281_grow {\n  flex: 1 1 auto;\n  min-width: 0;\n}\n.Eam_9d0ae281_hint {\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n.Eam_9d0ae281_toolbar {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 10px;\n}\n.Eam_9d0ae281_error {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n  gap: 12px;\n  margin: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-state-error-primary);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n  font-size: 13px;\n  line-height: 1.6;\n  color: var(--dsw-alias-state-error-primary);\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n.Eam_9d0ae281_warn {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n  gap: 12px;\n  margin: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--dsw-alias-state-warn-primary);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n  font-size: 13px;\n  line-height: 1.6;\n  color: var(--dsw-alias-label-primary);\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n.Eam_9d0ae281_warnActions {\n  display: flex;\n  flex: 0 0 auto;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n}\n.Eam_9d0ae281_inlineError {\n  margin: 0;\n  font-size: 12px;\n  line-height: 1.6;\n  color: var(--dsw-alias-state-error-primary);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n.Eam_9d0ae281_main {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  flex: 1 1 auto;\n  min-height: min(74vh, 820px);\n  min-width: 0;\n}\n.Eam_9d0ae281_editorHead {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n}\n.Eam_9d0ae281_path {\n  flex: 0 1 auto;\n  min-width: 0;\n  max-width: 62%;\n  font-family:\n    ui-monospace,\n    \"Cascadia Mono\",\n    Consolas,\n    monospace;\n  font-size: 11px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.Eam_9d0ae281_viewSwitch {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  flex: 0 0 auto;\n}\n.Eam_9d0ae281_editor {\n  width: 100%;\n  flex: 1 1 auto;\n  min-height: 480px;\n  box-sizing: border-box;\n  padding: 12px 14px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font-family:\n    ui-monospace,\n    \"Cascadia Mono\",\n    Consolas,\n    monospace;\n  font-size: 13px;\n  line-height: 1.7;\n  resize: vertical;\n  tab-size: 2;\n}\n.Eam_9d0ae281_editor:focus {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: -1px;\n}\n.Eam_9d0ae281_editorReadonly {\n  border-color: var(--dsw-alias-border-l1);\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-secondary);\n}\n.Eam_9d0ae281_preview {\n  flex: 1 1 auto;\n  min-height: 480px;\n  box-sizing: border-box;\n  padding: 12px 16px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  overflow-y: auto;\n}\n.Eam_9d0ae281_meta {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n  font-size: 12px;\n  line-height: 1.5;\n  color: var(--dsw-alias-label-tertiary);\n}\n.Eam_9d0ae281_overBudget {\n  font-weight: 600;\n  color: var(--dsw-alias-state-error-primary);\n}\n@media (max-width: 760px) {\n  .Eam_9d0ae281_editor,\n  .Eam_9d0ae281_preview {\n    min-height: 360px;\n  }\n}\n\n/* .build-tmp/entry.css */\n";
  document.head.appendChild(__styleTag);
}

    return module.exports;
  }
});
