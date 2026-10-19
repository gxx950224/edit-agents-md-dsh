# Edit Agents MD DSH

在 DSH 的「设置 → 系统指令」中编辑 DSH 全局加载的 `$DSH_HOME/AGENTS.md`，支持 Markdown 预览、版本冲突保护和保存后的立即刷新。

[![npm](https://img.shields.io/npm/v/@gxx-labs/edit-agents-md-dsh)](https://www.npmjs.com/package/@gxx-labs/edit-agents-md-dsh) [GitHub](https://github.com/gxx950224/edit-agents-md-dsh)

## 安装

在 DSH 的插件管理器中安装：

```text
@gxx-labs/edit-agents-md-dsh
```

也可以安装到 desktop profile：

```powershell
npm install @gxx-labs/edit-agents-md-dsh --prefix "$env:USERPROFILE\.dsh\profiles\desktop"
```

安装或升级后，从托盘完全退出并重新启动 DSH。不要同时启用未作用域的旧包和本包。

## 使用

1. 打开「设置 → 系统指令」。
2. 编辑指令，或切换到预览查看 Markdown 效果。
3. 选择「保存」写入磁盘。
4. 选择「重新读取」丢弃未保存内容并载入磁盘版本。
5. 保存后选择「立即刷新」，让 DSH 尝试在当前会话中重新读取指令。

插件编辑的是 `$DSH_HOME/AGENTS.md`，默认路径为 `~/.dsh/AGENTS.md`。文件名必须是复数 `AGENTS.md`；单数 `AGENT.md` 不会作为全局指令加载。项目目录中的指令文件不在本插件的编辑范围内。

## 保存权限与安全边界

保存操作由用户在设置页直接发起，插件使用自身的最高权限写入全局指令文件，因此不需要先切换当前会话的权限模式。写入范围仍限制在宿主提供的候选 `AGENTS.md` 文件，覆盖写入要求版本一致，文件大小上限为 1 MiB，写入服务只接受本机 loopback 请求。

请保持 DSH Web 服务只监听本机，不要把端口暴露给不可信网络。全局指令会影响后续 Agent 行为，保存前请检查内容和目标文件。

## 版本冲突与刷新

如果文件在编辑期间被其他程序修改，保存会提示版本冲突并拒绝覆盖；选择「重新读取」后再确认磁盘内容。立即刷新可能因当前没有可用会话而无法完成，但已保存的文件会在下一次读取或新会话中生效。

## 开发

```bash
npm install
npm run build
npm run verify
npm test
npm run scan:css
```

## 许可

MIT © guoxiaoxi
