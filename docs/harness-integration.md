# DeepSeek 的 Harness 集成说明

## 运行方式

本项目的 Harness 编程模式载入官方 DeepSeek Harness Web UI。项目、会话、工具调用、审批、插件和模型设置由 Harness 自己处理。

Electron 主进程通过 `electron/harness-manager.cjs` 管理后端：

```js
const manager = createHarnessManager({
  runtimeRoot,
  nodePath,
  expectedVersion,
  dataDir,
  onStatus,
});
const { url } = await manager.start({ workspace });
await manager.stop();
```

- `nodePath` 指向随桌面应用提供的独立官方 Node.js；引擎更新继续使用它。
- `runtimeRoot/node_modules/@deepseek-ai/dsh/lib/bin.js` 是本次选择的官方 CLI，可以来自随包引擎或已验证的更新目录。
- 管理器检查实际 CLI 版本与 `expectedVersion` 相符，防止运行混合或不完整的目录。
- 启动参数为 `web --host 127.0.0.1 --port 0 --no-open`，由操作系统分配可用端口。
- 正式使用时，`DSH_HOME` 为 `dataDir/harness-home`，保存 Harness 自己的配置、凭据和会话。
- 等待 stdout 中的 `dsh web:` 就绪行后，再载入完整 URL。URL 中的进程认证参数换取 Cookie，并跳转到干净的根页面。
- `onStatus` 和 `getStatus()` 仅包含状态、消息、项目路径、无认证参数的 origin 和运行时版本。完整启动 URL 仅提供给主进程的浏览器视图，诊断输出会移除认证参数。
- 同一个项目重复连接会复用进程；更换项目先停止旧进程。
- 已添加桌面平台时，Harness 自动载入共享连接，首次进入只需选择工作区与模型。

## Chat 与 Harness 的共享平台

`electron/harness-connections.cjs` 在每次启动时读取桌面 `Storage` 中的连接快照，把官方、OpenCode Go、OpenCode Zen 及绑定平台的自定义模型转换为上游 `llm-pi-ai` 配置。Chat Completions、Responses、Messages 分别使用上游 `openai-completions`、`openai-responses`、`anthropic-messages` 适配器，保留 Harness 的流式工具调用、工具结果与多轮历史。官方 Flash 使用 `deepseek-flash`，Go / Zen 使用 `deepseek-v4.1-flash`；默认平台优先级与 Chat 一致，Harness 选择器也可显式选择其他已添加平台。

启动时生成 `harness-home/desktop-connections.patch.json`，作为 CLI 的 `--patch` 覆盖层。该文件只包含地址、模型和凭据引用；密钥仍由桌面安全存储加密保存，只在主进程解密后通过专属环境变量传给 Harness 子进程。主进程的公开设置与状态不包含密钥，启动日志同时过滤共享密钥。

共享连接启用时，覆盖模型适配器和新会话默认选择，默认采用 Chat 当前模型。原有 Harness 用户补丁、独立凭据和会话文件不改写；没有共享平台时使用空覆盖层，原有 Harness 模型配置仍可使用。修改连接或自定义模型后，结束当前任务、停止引擎并重新打开工作区，新配置才会生效；不会自动停止正在运行的任务。

Claude 的 Messages 地址按上游 Anthropic SDK 的 `/v1/messages` 拼接规则规范化，避免 OpenCode 已含 `/v1` 的地址产生重复路径。模型能力未显式配置时采用上游适配器默认值；实际权限、上下文限制和思考参数支持由平台决定。

## Chat 与 Harness 的会话隔离

Chat 只读写用户数据目录下的 `history.json`，Harness 使用独立的 `harness-home`，其浏览器视图还使用单独的 `persist:deepseek-harness` 分区。现有数据无需迁移。

顶部的模式切换始终可用。Chat 模式显示桌面会话侧栏；Harness 模式隐藏整个桌面侧栏，让官方工作区占满标题栏下方的区域。新建、搜索、选择和删除 Chat 会话及相应快捷键只在 Chat 模式工作。模式切换只隐藏或显示视图，不重建 Harness 的 WebContents，也不清空 Chat 当前会话或草稿；键盘焦点随可见工作区切换。

## 引擎更新来源

以下是构建与兼容性所需的技术信息；应用界面和安装包名称不展示版本号。

`electron/harness-updater.cjs` 查询固定的官方仓库 `deepseek-ai/deepseek-harness` 的 GitHub Releases，接受 `dsh-v` 开头的发布标签，包括预发布，忽略草稿。选择最近发布的有效 Release，并从标签解析 CLI 的精确版本。若该版本不比当前引擎新，则不自动降级。更新不跟踪 `master` 或其他未发布提交。

官方发布与 npm 的 `latest` 标签可能不同。例如 2026-09-18 查询时，GitHub 最新发布为 `dsh-v0.1.6-alpha.2`，npm 的 `latest` 仍为 `0.1.5-rc.2`。因此更新器安装与 Release 一致的精确 `@deepseek-ai/dsh` 版本，而不是运行 `npm install @deepseek-ai/dsh@latest`。

安装前会核对 npm 包名、版本、官方仓库来源和 SHA512 完整性字段。下载仅使用官方 npm registry；安装后再次核对锁文件中的 CLI 版本与完整性值。若 npm 元数据提供 `gitHead`，还会核对官方发布标签所指向的提交；没有 `gitHead` 时不声称已验证 npm 包与 Git 提交的密码学对应关系。

GitHub 发布尚未同步到 npm 时，本次更新失败并保留当前引擎，不擅自安装其他渠道或另一版本。

## 更新与清理流程

1. 「检查更新」只读取官方发布信息，可以在引擎运行时使用。「更新 Harness」要求先停止引擎，不会自动终止正在执行的任务。
2. 安装版使用安装目录 `resources/runtime/harness-updates` 保存候选引擎与当前记录。每个安装位置只允许一个应用实例操作或使用该引擎，避免不同配置目录之间删除仍在使用的程序。Chat 与 Harness 会话仍留在各自用户数据目录。
3. 下载、npm 配置与缓存为每次操作隔离。先禁用安装脚本，再仅重建白名单中的原生依赖；不读取用户的 npm 认证配置。
4. 通过临时配置验证原生组件、启动、认证和 HTML 页面。验证不会打开用户项目或发起模型请求。
5. 验证通过后原子写入新的当前引擎记录，这是切换完成的时刻。在此之前取消或失败，保持原引擎，并在安装进程停止后清理本次候选与下载缓存。
6. 切换完成后继续清理旧引擎，包括安装包初始 `runtime/node_modules`、已过期的更新目录，以及旧桌面版当前配置目录中遗留的引擎和 npm 缓存。保留共享 Node、npm、许可证与当前引擎。成功后没有回退入口。
7. 清理失败不会把已生效的新引擎误报为更新失败；状态会说明尚有文件待清理，并在之后重试。无法确认安装进程终止时暂不删除它可能正在写入的目录，明确提示重启电脑后再清理。
8. 兼容旧版用户目录的更新记录。即使官方发布没有变化，点击「更新 Harness」也会将旧版引擎复制到安装存储、重新验证后再切换和清理；复制或验证失败时仍保留旧版选择。开发模式不删除源码的初始依赖。
9. 安装新版桌面包后，如果新内置引擎比旧更新记录更新，启动时原子提交内置引擎选择，再清理旧更新；不会把新内置引擎当作旧副本删除。比安装包更新的已安装引擎仍优先使用，不自动降级。

安装目录必须允许当前使用者写入；无法写入时更新失败并保留原引擎。初始引擎删除后不再是故障回退来源；如果当前引擎或记录受到外部破坏，需要重新安装桌面应用修复。普通退出会取消未完成的更新并等待清理。

更新器不迁移 Chat 历史、API Key 或 Harness 会话。启动验证证明基本运行协议兼容；新版正式启动后仍使用原有 `harness-home`，上游可能调整数据格式。

## 构建与 Node 约束

随安装包提供的初始引擎为 `@deepseek-ai/dsh@0.2.0-rc.2`，于 2026-09-30 核实 GitHub 最新发布及对应 npm 包，搭配独立 Node.js `24.19.0`。完整组合由 `runtime/package-lock.json` 锁定。这份引擎供初次运行使用，安装版在首次成功更新后将其清理。

准备初始运行时后，执行 `npm run setup:updater`。脚本下载并校验固定的 npm `12.0.2`，将 npm 本体、依赖和许可证放入 `runtime/npm`。打包配置分别包含该目录和其中的 `node_modules`，防止 electron-builder 默认过滤导致工具缺失；验证脚本以额外资源形式随包提供，供独立 Node 运行。

更新安装启用 npm 的 `--engine-strict`。新依赖要求的 Node 版本不受支持时，安装失败并保留当前引擎，需要更新桌面安装包里的 Node 后再尝试。应用内更新不会更换 Node，不会通过自动降级 Harness 来掩盖兼容性问题。

Harness 依赖包含 `node-pty`、`koffi`、`sharp` 和 DeepSeek 的原生系统模块。因此引擎始终使用独立的上游 Node，不使用 Electron 内嵌 Node 或 `ELECTRON_RUN_AS_NODE`。

## Chat 与整个应用的更新

Chat 由桌面代码直接调用模型 API；Harness 启动时复用桌面平台连接，其运行目录、会话和更新状态仍独立。只更新 Harness 不会更换 Chat 代码、模型选项、API 参数处理或 Electron。

模型服务保持接口兼容时，Chat 通常无需随 Harness 更新。API 协议或模型名称变化、新增 Chat 功能、修复界面问题以及升级 Electron 等桌面依赖，仍需要发布新的 DeepSeek 安装包。当前没有整款桌面应用的自动更新、自动安装或重启流程。

## 进程生命周期与其他限制

官方仓库已经包含 `apps/desktop` Electron 桌面工程，采用配套的后端与客户端版本、独立 Node.js 和私有进程管道。本项目是按照 Chat / Harness 切换需求制作的个人桌面外壳，使用官方 Web 启动方式。

Windows 停止流程通过 `taskkill.exe /PID <本应用创建的子进程> /T /F` 结束后端及其子进程。正在执行的任务会被终止；应等待任务完成后再停止引擎或关闭应用。这里未实现官方桌面私有 Host 的优雅 IPC 关闭机制。macOS/Linux 开发模式向独立进程组发送 SIGTERM，等待最多六秒后升级为 SIGKILL；交付目标仍为 Windows x64。

Harness 官方将项目标记为开发者预览，后续发布可能存在兼容性变化。实际验证范围见 [验证记录](../VALIDATION.md)。

## 官方来源

- [官方 README：Web 启动与开发者预览](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)
- [官方发布列表](https://github.com/deepseek-ai/deepseek-harness/releases)
- [CLI 行为参考：参数、工作目录与停止语义](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
- [Web 启动参数源码：临时端口与 no-open](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/src/startup.ts)
- [Web 集成说明：就绪行及启动认证](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/README.md)
- [官方桌面工程：运行时及打包架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)
