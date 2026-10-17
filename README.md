# @gxx-labs/edit-agents-md-dsh

在 DSH 的**设置 → 系统指令**中编辑全局 `AGENTS.md`。支持 Markdown 预览、保存冲突保护，并可尝试让 DSH 立即重新读取已保存的指令。

## 安装

在 DSH 的插件页搜索并安装 `@gxx-labs/edit-agents-md-dsh`，然后完整重启 DSH。

手动安装到 desktop profile：

```powershell
npm install @gxx-labs/edit-agents-md-dsh --prefix "$env:USERPROFILE\.dsh\profiles\desktop"
```

手动安装后，还需将 `@gxx-labs/edit-agents-md-dsh` 加入该 profile 的 `package.json` 中 `dsh.profile.bundles` 数组，再完整重启 DSH（从托盘退出后重新打开）。

如果已安装未作用域的 `edit-agents-md-dsh`，请先卸载旧包，再安装 scoped 包；不要同时启用两个版本。

## 使用

1. 打开 **设置 → 系统指令**。
2. 编辑内容，或切换到预览查看 Markdown 效果。
3. 选择**保存**写入文件；选择**重新读取**可丢弃未保存内容并载入磁盘版本。
4. 保存后可选择**立即刷新**，让 DSH 尝试通过一次真实的指令文件读取更新会话中的指令。

插件编辑的是 DSH 全局指令文件 `$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）。文件名是复数 `AGENTS.md`；单数 `AGENT.md` 不会作为该全局文件加载。界面候选只来自 `$DSH_HOME`，项目目录中的指令文件不会出现在这里（宿主 API 的白名单为兼容旧版客户端仍接受项目根的 `AGENTS.md` 族，见下文安全边界）。

## 保存权限：最高权限写入（必读）

**保存不依赖当前会话的权限模式。** 插件在宿主进程内固定以 `danger-full-access`
策略调用文件服务，直接把内容写入 `$DSH_HOME/AGENTS.md`：

- 会话是「仅可查看」「工作区内修改」还是「完全权限」，都能保存；
- **不需要**先把会话切到「完全权限」，也不需要在输入框执行 `/permission danger-full-access`；
- 目标在工作区之外（`~/.dsh` 通常在会话 workspace 之外）也能写入。

### 为什么允许这样

「设置 → 系统指令」的保存是**用户直接操作**，不是模型发起的工具调用。DSH 的文件
沙箱（`@deepseek-ai/dsh-fs-sandbox`）对显式传入的 `danger-full-access` 策略不做
围栏，因此插件可以自行使用该策略。这是有意的权限提升（用户需求：编辑全局指令
不应该先切换会话权限）。

### 权限提升后的安全边界

写入绕过会话沙箱后，以下四道边界就是插件**唯一**的约束，请不要删除或放宽：

1. **请求边界**：只接受本机 loopback 请求；Host 必须是回环字面量（`127.0.0.1`
   / `localhost` / `[::1]`，或 DSH webServer 公布的 host，用来挡 DNS-rebinding）、
   Content-Type 必须是 `application/json`、有 `Origin` 时其 host 必须等于 Host，
   且拒绝 `sec-fetch-site: cross-site/same-site` —— 挡住恶意网页经浏览器发起的
   跨站写入（CSRF）。
2. **路径白名单**：只允许写候选指令文件（`$DSH_HOME` 下的 `AGENTS.md` 族 +
   会话项目根目录的 `AGENTS.md` 族），并且每次写入前重新规划白名单，不信任浏览器
   传来的清单。
3. **版本守卫**：覆盖写入必须回传读取时的 `version`，文件被外部修改时返回 409，
   绝不静默覆盖。
4. **大小预算**：服务端强制单文件 1 MiB 上限（DSH 渲染指令的默认上限），超限
   直接 413，不会「保存成功但不生效」。

### 残余风险（务必知悉）

- **本机进程视为可信**：HTTP 头无法区分本机进程；`curl`/脚本可以伪造 Host/Origin
  直接调用这些写路由，没有 `Origin` 的本机非浏览器客户端也按设计放行。因此请确保
  本机运行的代码可信。
- **DSH 端口要保持本机可达性最小化**：不要将 DSH Web 服务暴露到不可信网络。
- **同机沙箱化进程的提权路径**：与 DSH 同机的沙箱化 shell / 插件进程理论上也能
  通过 `127.0.0.1` 调用该写入通道（这是「保存不再受会话权限模式限制」的固有代价）。
  如需更强的隔离，请用独立的 DSH profile / 独立操作系统账户运行不同信任级别的任务。

⚠️ 请保持 DSH Web 服务只监听本机（默认即如此），不要把端口暴露到不可信网络；
也不要在浏览器里对不可信页面开放对该端口的访问。

## 版本冲突

如果文件在编辑期间被其他程序修改，保存会提示版本冲突，不会覆盖外部改动。选择**重新读取**后确认磁盘内容，再进行编辑和保存。

## 立即刷新

立即刷新会请求 DSH 对 `AGENTS.md` 发起一次真实读取，并显示读取结果。它可能因没有可用会话而无法完成；此时已保存的文件仍会在之后读取该文件或新会话开始时使用。

## License

MIT © guoxiaoxi
