# DeepSeek

一个个人开发的 Windows x64 桌面应用：顶部切换 **Chat** 和 **Harness**。Chat 显示自己的会话侧栏；Harness 仅保留官方工作区自带的侧栏，并支持深浅色主题和本地项目。

本项目没有 DeepSeek 或 OpenAI 的官方背书。**Harness 编程模式运行 DeepSeek Harness**。

## 直接使用

前往 [Releases 下载页面](https://github.com/Irisuko/DeepSeek-Harness-Desktop/releases/latest)，下载 **DeepSeek.exe**。安装包已包含 Harness、独立 Node.js 和引擎更新工具，无需另外安装开发工具。

双击安装程序，按提示选择安装位置。分享给其他人时，可以直接发送安装包或上述下载链接；每位使用者需填写自己的 API Key。

自行打包后，也可双击 `release/win-unpacked/DeepSeek.exe` 直接运行。请保留整个 `win-unpacked` 文件夹，其中包含应用资源及运行环境。

### Chat

1. 打开「设置」，添加 DeepSeek 官方、OpenCode Go 或 OpenCode Zen，分别填写该平台的 API Key。可同时添加三个平台，各自保存独立密钥。
2. 点击「保存设置」。模型列表根据已添加的平台生成；OpenAI 和 Anthropic 不再作为单独的平台入口。
3. 在**对话输入栏**选择模型，旁边显示本次使用的平台。
4. 输入消息即可发送。可停止生成、查看平台返回的思考内容、搜索历史、复制回复及导出 Markdown。

#### 模型列表与路由

| 已添加的平台 | 列表中加入的模型 |
| --- | --- |
| OpenCode Zen | GPT 6 Astra、GPT 6.1 Sol、GPT 6 Luna；Claude Fable 5.1、Opus 5.5、Sonnet 5.5、Haiku 4.5，以及平台模型目录中的其他 GPT / Claude 文本模型 |
| DeepSeek 官方或 OpenCode Go | DeepSeek V4.1 Flash、DeepSeek V4 Pro |

启动和保存 Zen 连接后会自动获取该平台的 GPT / Claude 文本模型目录，也可以在设置中点击「刷新 GPT / Claude 模型」。后续平台发布的新模型无需手动填写 ID；获取失败时保留上次缓存，无缓存时使用上述七款预设。原有选择和明确配置的模型会保留，实际访问权限和费用由平台账户决定。模型目录不包含图片生成、音频或 Gemini 等尚未接入的协议。

添加多个平台后，模型合并显示且不重复。官方或 Go 加入两款 DeepSeek。移除平台会隐藏失去对应连接的模型，并自动选择剩余可用项。未添加任何平台时，需先添加平台才能发送消息。

DeepSeek 模型按已添加的平台优先选择：**DeepSeek 官方 → OpenCode Go → OpenCode Zen**；GPT 和 Claude 使用 **OpenCode Zen**。优先级在发送前确定，请求失败会显示错误，不会自动向其他平台重复发送。按上述列表规则，仅添加 Zen 时不展示 DeepSeek 模型。

| 平台 | 默认 API 地址 |
| --- | --- |
| DeepSeek 官方 | https://api.deepseek.com |
| OpenCode Go | https://opencode.ai/zen/go/v1 |
| OpenCode Zen | https://opencode.ai/zen/v1 |

Flash 在 DeepSeek 官方请求中使用 **deepseek-flash**，在 Go 中使用 **deepseek-v4.1-flash**；Pro 使用 **deepseek-v4-pro**。Zen 的 GPT 模型使用 Responses，Claude 使用 Messages，DeepSeek 使用 Chat Completions。模型的实际权限和费用由平台账户决定。

「＋ 添加模型…」仍支持自定义模型 ID，必须绑定已添加的平台；移除该平台后，这些模型也会隐藏。模型配置可单独指定接口和思考参数，预置模型的平台按上述路由规则自动确定。旧版未绑定平台的自定义模型不会自动混入新列表，需要重新添加并绑定平台。

#### 密钥与旧设置

- 各平台密钥使用系统安全存储分别加密，界面不会回显。留空保持已有密钥，移除平台会移除其当前连接密钥。
- 更改 API 地址的源（协议、域名或端口）时需重新填写密钥。同源接口路径调整可继续使用原密钥。
- 旧版 DeepSeek / OpenCode 单平台连接会迁移为一个已添加的平台；原设置备份为 **settings.before-platforms.json**。备份可能保留历史加密密钥，且不会用于请求。OpenAI / Anthropic 密钥不会转用到 Zen，需要添加 Zen 自己的密钥。

#### 思考与兼容性

- DeepSeek 官方继续使用深度思考开关。其他平台默认不发送专属参数，由服务决定思考行为。
- 支持思考的模型可配置 DeepSeek thinking、Responses reasoning（medium）、Claude adaptive 或 budget（2048），然后在输入栏开关。Responses / Claude 关闭开关时恢复平台默认，不强制关闭模型自身推理。需要按平台文档选择支持的格式。
- 当前支持文本多轮对话与流式回复；Claude 回复上限为 8192 tokens。支持添加不超过 128 KB 的文本或代码附件，附件内容随消息发送给对应平台。

对话历史保存在本机。Chat 与 Harness 共享连接和密钥，会话分别管理。

### Harness

1. 通过顶部模式切换进入 Harness，选择本地项目文件夹。
2. 点击「打开编程工作区」。首次加载官方插件可能需要几分钟。
3. Harness 自动载入桌面设置中添加的官方、OpenCode Go 和 Zen 平台及自定义模型；无需重复填写 API Key。在 Harness 工作区选择模型，然后开始任务。

**Chat 与 Harness 共享平台连接、API Key、API 地址和自定义模型。** Harness 新会话默认采用 Chat 当前模型，工作区内也可选择各平台模型。修改密钥、地址或模型后，请结束任务、停止引擎并重新打开工作区，新连接才会生效。密钥只在桌面设置中加密保存，启动时传给 Harness 进程，不写入 Harness 的共享配置文件。未添加共享平台时仍可使用原有 Harness 配置。 Harness 页面嵌入官方 Harness Web UI；项目文件访问、命令执行、会话和审批由 Harness 处理。关闭应用或停止引擎会终止正在运行的 Harness 任务。

**会话分开管理：** Chat 的会话、新建和搜索入口只在 Chat 模式使用；Harness 会话由其工作区侧栏管理。切换模式会保留各自当前页面和 Chat 输入草稿，不会停止正在运行的 Harness。Harness 模式下可通过顶部切回 Chat，也可打开桌面设置和检查引擎更新。

### 更新 Harness

1. 打开桌面应用顶部「设置」，找到「Harness 编程引擎 → 引擎更新」。
2. 可以先点击「检查更新」，也可以直接点击「更新 Harness」。如果引擎正在运行，先等待任务结束，再点击「停止引擎」。
3. 应用会查询 [官方 Harness 发布](https://github.com/deepseek-ai/deepseek-harness/releases)，下载最新发布对应的官方 npm 包及依赖，并自动验证原生组件、启动、认证和页面响应。首次更新可能需要几分钟。
4. 更新完成后，重新打开编程工作区即可使用新引擎，无需重新安装整个 DeepSeek。

更新包含官方预发布版本（alpha、rc 等），以 GitHub 已发布的 Release 为准，不跟随尚未发布的分支提交。对应 npm 包尚未发布、网络失败或兼容性检查失败时，会保留当前引擎。应用不会自动降级，也不会自动升级内置 Node.js；遇到 Node 要求不兼容时，需要安装配备新运行环境的 DeepSeek 安装包。

更新过程中可以点击「取消更新」。取消或失败时会清理本次下载、缓存和未完成的引擎，继续使用原引擎；安装与启动验证通过后才切换。成功后会清理所有旧引擎，包括安装包自带的初始引擎，只保留当前引擎，不再提供「恢复上一引擎」。共享的 Node 和 npm 更新工具继续保留。

如果旧文件被占用、暂时无法删除，应用会明确提示清理待完成，并在之后启动或更新时重试。无法确认安装进程已停止时，会先保留可能仍在写入的目录，避免边写边删；提示中的重试条件满足后再清理。取消只作用于切换前的阶段，切换成功后的清理会继续完成。

下载和检查使用独立目录、临时测试配置；不会用你的 API Key 发起测试对话。现有项目、Chat 历史以及 Harness 的配置和会话保留在原位置。新引擎第一次正式启动后仍使用原有 Harness 数据，数据格式兼容性由上游决定。

### Chat 是否需要随 Harness 更新？

通常不需要。Chat 直接调用模型服务 API，与 Harness 引擎分开运行；这项更新功能只更新 Harness。模型服务在保持 API 和模型标识兼容时，服务端升级通常不需要更新桌面端。

Zen 新增 GPT / Claude 文本模型时，刷新模型目录即可同步到 Chat 和下一次启动的 Harness。如果 API 格式发生变化，或需要新的 Chat 功能、界面修复和桌面依赖安全更新，则仍需发布并安装新版 DeepSeek。**当前没有整款桌面应用的自动下载、安装或重启更新功能**。

## 当前范围

- 已实现：模式切换、桌面窗口、本地 Chat 历史与搜索、流式回答、深度思考、文本附件、导出、主题切换，以及管理并嵌入本地 Harness。
- 支持从设置中检查并更新官方 Harness 引擎、取消更新，并自动清理下载残留与旧引擎。
- 编程区域保留 Harness 原有界面，尚未将其全部页面改为 ChatGPT 的布局。
- 尚未实现账号云同步、语音、图片生成、通用图片/PDF 附件、商店，以及整个桌面应用的自动更新。
- 验证范围与尚未完成的检查见 [验证记录](VALIDATION.md)。没有使用真实 DeepSeek API Key 验证模型回复。

## 开发与打包

开发与打包需要 Windows x64、Git，以及官方 Node.js 24.19.0（含 npm）。源码仓库保留依赖锁文件和许可证；安装包、依赖目录、更新工具与 Node 二进制由构建时准备。

克隆仓库后，在 PowerShell 中执行：

```powershell
git clone https://github.com/Irisuko/DeepSeek-Harness-Desktop.git
cd DeepSeek-Harness-Desktop

node -e "if(process.platform!=='win32'||process.arch!=='x64'||process.versions.node!=='24.19.0')process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw '需要 Windows x64 Node.js 24.19.0' }
npm ci
if ($LASTEXITCODE -ne 0) { throw '桌面依赖安装失败' }

$deepseekNode = node -p "process.execPath"
Copy-Item -LiteralPath $deepseekNode -Destination .\runtime\node.exe
npm ci --prefix runtime
if ($LASTEXITCODE -ne 0) { throw 'Harness 依赖安装失败' }
.\runtime\node.exe .\scripts\verify-runtime.cjs
if ($LASTEXITCODE -ne 0) { throw 'Harness 运行时验证失败' }

npm run setup:updater
if ($LASTEXITCODE -ne 0) { throw 'Harness 更新工具准备失败' }

npm test
npm run test:harness-integration
npm start
```

`runtime/package.json` 包含 npm 12 所需的原生依赖安装脚本白名单。不要跳过这些安装脚本；验证脚本会检查本地子进程及终端是否可用。

`npm run setup:updater` 从官方 npm registry 下载固定的 npm 12.0.2，核对 SHA512 后解包到 `runtime/npm`。完整 npm 依赖与许可证随应用打包，使普通使用者无需在电脑上安装 npm。该工具目录不提交到源码仓库。

生成安装包：

```powershell
npm run dist
```

`npm run pack` 仅生成 `release/win-unpacked`；`npm run dist` 生成 `release/DeepSeek.exe` Windows 安装程序。应用界面和安装包名称不显示版本号；构建所需的内部版本及依赖锁定信息仍保留。当前构建未配置代码签名。

随安装包提供的初始引擎为 `@deepseek-ai/dsh@0.2.0-rc.2`（2026-09-30 核实的官方最新发布），完整组合记录于 `runtime/package-lock.json`。独立 Node.js 为 `24.19.0`。已安装应用将更新保存在安装目录的 `resources/runtime/harness-updates`，以安装级记录选择当前引擎；成功后删除初始引擎的 `runtime/node_modules` 与历次旧引擎，不改写源码依赖锁文件。旧桌面版的用户目录引擎会在点击更新时迁移并验证，再清理原副本。开发模式仍在测试配置目录更新，保留源码的初始依赖以便重新打包。不要仅替换单个包或改用 Electron 内嵌 Node 执行 Harness。

检查随包运行时，不需要 API Key：

```powershell
.\runtime\node.exe .\scripts\verify-runtime.cjs
```

更多技术细节见 [Harness 集成说明](docs/harness-integration.md)。

## 来源与许可证

本项目原创代码采用 [MIT 许可证](LICENSE)。第三方组件分别遵循各自许可证，原有许可证文件随运行时及依赖保留：

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)，含 [官方桌面工程](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop)。
- [Node.js](https://nodejs.org/)：完整上游许可证见 `runtime/NODE-LICENSE.txt`。
- [npm CLI](https://github.com/npm/cli)：更新工具的许可证见准备完成后的 `runtime/npm/LICENSE`；其依赖许可证保留在 `runtime/npm/node_modules`。
- [Electron](https://www.electronjs.org/)：发布目录包含 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`；开发依赖中的原文位于 `node_modules/electron/dist`。
- 其他依赖的许可证见相应 `node_modules` 包内文件。项目的 MIT 许可证不替代这些上游许可。
