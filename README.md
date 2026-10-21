# Trace Gateway 0.2 · desktop + headless

本机 Agent 轨迹网关。一个包包含 Rust CLI/后台管理、可选 Tauri 2 托盘应用，以及现有的网关和前端。不需要用户安装 Node、npm 或 Rust。无 GUI 机器只运行 CLI/daemon，不依赖 GTK、WebKit 或浏览器。

## 架构与范围

- **Rust `trace`**：CLI、配置/数据目录、后台进程、单实例锁、管理鉴权、登录常驻、旧数据导入。
- **Tauri `trace-desktop`**：macOS 菜单栏、Ubuntu AppIndicator、Windows 系统托盘，按需打开 WebView；关闭窗口隐藏到托盘，退出托盘可保持网关运行。
- **随包 Node runtime + gateway engine**：保留已经验证的原始流透传、脱敏、Session 归类、Token 图和完整前端。当前不是纯 Rust 网络代理；Rust 守护进程管理独立 Node 子进程，父进程消失时通过管道 EOF 停止引擎，避免孤儿进程。
- **持久化**：沿用按请求 JSON 文件；所有管理入口只绑定 127.0.0.1，新增关闭服务/切换默认 Provider 等操作要求本机私有控制令牌。

发行目标为 macOS 13.5+、Ubuntu 22.04+、Windows 10/11 x64；本机成品为 macOS Apple Silicon。Node 24 的 macOS 基线参考 [Node 官方构建要求](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)。

## 快速使用（无需桌面）

完整解压 CLI 发行包，保留 `trace`、`trace-background`（Windows 无窗口后台入口）和旁边的 `runtime/`。macOS/Linux：`./trace`；Windows PowerShell：`.\trace.exe`。

```sh
trace start
trace status
trace provider add --name DeepSeek --url https://api.deepseek.com --protocol openai --activate
trace provider list
trace provider current
trace provider url
trace session list --limit 20
trace session list --search hello --since 2026-10-19
trace session show '<session-id>'
trace session export '<session-id>' --output session.json
trace stop
```

API Key 仍填在 Harness 中，只透传给上游；CLI 不接受明文 Key 参数，不会把 Key 写进 Provider 配置。导出经过脱敏。

每个 Provider 的地址固定为 `/p/<provider-id>/v1`（OpenAI）或 `/p/<provider-id>`（Anthropic）。`provider use` 设置 CLI 的默认选择，不会将已经配置到别的 Provider 地址的 Harness 偷偷切换。

```sh
trace provider use DeepSeek
trace provider url DeepSeek
trace provider remove '<provider-id>'   # 保留已录制轨迹
trace open                            # 可选：在浏览器打开控制台
trace serve                           # 前台常驻，适合容器/服务管理器
trace restart
trace --json session list
```

全局选项可以放在子命令前或后：

```sh
trace --home /path/to/trace-data --port 44317 start
trace --home /path/to/trace-data status
```

`start` 保存所选端口。也可以设置 `TRACE_HOME`。多个数据目录可使用不同端口各自运行；不会停止或接管其他进程。默认 4317；CLI 遇到占用会报错，选择另一个端口或先自行停止旧版。桌面应用首次启动且没有已有配置时会在 4317–4327 中选取空闲端口并保存，因此可与旧版预览并存，端口在托盘状态及本地 URL 中显示。

## 数据目录

默认使用系统本地应用数据目录下的 `trace-gateway`：macOS `~/Library/Application Support/trace-gateway`，Ubuntu `~/.local/share/trace-gateway`（遵循 XDG），Windows `%LOCALAPPDATA%\trace-gateway`。

包含 `config.json`、私有 `control.token`、`data/providers.json`、`data/records/`、`gateway.log`。Unix 目录 0700/私有文件 0600；Windows 使用当前用户目录继承的 ACL。

旧版数据需要显式导入，不会随安装包分发：

```sh
trace stop
trace import --from /path/to/old/trace-gateway/data
trace start
```

目标必须为空，避免覆盖。导入保留 Provider ID、本地路径和 Session；启动时对历史记录重新脱敏。

## 可选：工具调用前文件备份

```sh
trace backup enable    # 开启文件备份
trace backup disable   # 关闭，不删除已有快照
trace backup status    # 查看开关、配置路径和网关运行状态
```

与 GUI 共用同一配置，运行中修改立即用于后续请求，无需重启；停止状态也能设置，下次启动生效。
支持全局 `--home`、`--port`、`--json` 和自定义配置文件环境变量 `TRACE_FILE_BACKUP_CONFIG`。


控制台左侧点击 **设置**，设置启用开关和资源上限，修改后自动保存并立即用于后续请求，无需重启。“工具匹配规则”中可编辑 JSON，或一键补充 DSH 的小写 `read` / `write` / `edit` 规则，自动保存。不需要配置工作目录，工具涉及且网关进程有权限读取的文件均可备份。

默认关闭，不需要修改 Harness。网关首次启动会在 `<TRACE_HOME>/data/file-backup.json`
生成配置（macOS 默认是 `~/Library/Application Support/trace-gateway/data/file-backup.json`）。
在该文件中设置 `enabled: true` 即可开启。文件必须位于网关可访问的文件系统中，
不限制项目或 Session。旧配置的 `workspaceRoot` 被忽略，保存设置后移除。
绝对工具路径直接访问；相对路径使用工具参数或当前请求中明确提供的 cwd / Harness
环境上下文解析，无法确定时记录 `relative_path_unresolved`，不猜测网关自身工作目录。

完整默认模板见 [gateway/file-backup.example.json](gateway/file-backup.example.json)。也可在启动网关前设置
`TRACE_FILE_BACKUP_CONFIG=/absolute/path/file-backup.json` 使用另一份配置。Rust CLI/daemon
继承此环境变量；登录服务需在其环境中设置，通常直接编辑默认数据目录中的文件更方便。

```json
{
  "version": 1,
  "enabled": true,
  "maxFileBytes": 8388608,
  "maxFilesPerResponse": 64,
  "maxResponseBytes": 33554432,
  "rules": [
    {
      "id": "read-file",
      "operation": "read",
      "toolNames": ["Read", "read_file"],
      "pathFields": ["file_path", "path"]
    },
    {
      "id": "edit-file",
      "operation": "write",
      "namePattern": "^(Write|Edit|MultiEdit|write_file|edit_file)$",
      "pathFields": ["file_path", "path", "edits.*.path"]
    }
  ]
}
```

`toolNames` 是区分大小写的精确匹配，`namePattern` 是 JavaScript 正则，两者取或；
建议正则使用 `^` / `$` 限定名称。`pathFields` 是参数对象内的点分路径，`*` 遍历一层，
末端数组也会展开。它们只匹配工具名称并提取路径，不执行代码、shell 或任意 JSONPath。
规则 ID 唯一，`operation` 为 `read` / `write`，两者均保存执行前文件。

配置每次请求前按文件元数据检查更新，不需重启；当前响应使用请求开始时固定的配置。
建议先写临时文件再原子替换，避免编辑过程中出现半份 JSON。无效配置在启动时报错，
运行中返回 503，不会静默绕过。未来可由 RSI 写入同一规则文件；本版不包含自动生成规则。

### 捕获、关联与存储

- 支持 OpenAI Chat Completions、Anthropic Messages、Responses 的常见 JSON/SSE
  function/tool-use 结构，包含流式参数拼接；不从普通文本或 shell 命令猜测文件操作。
- 开启后，SSE 普通文本帧继续转发；从首个结构化工具帧起，后续原始字节暂存到磁盘。
  等该响应结束、参数齐全且文件备份及 manifest 完成后，再按原始字节释放，避免
  Harness 在备份前执行工具。非流式响应也在完成备份后放行。开启时工具帧之后的文本
  同样延后，不承诺零延迟；关闭时沿用原始流透传。
- 按文件串行、64 KiB 缓冲区复制，不把文件内容整体读入内存；同一用户 query 下跨多轮工具调用的同一文件
  只在首次出现时备份，后续读写复用首次快照；新文件单独备份，新 query 重新开始。首次
  目标不存在也会复用该状态。重复引用不占额外文件数限制，失败的捕获允许后续重试。工具参数累计上限 2 MiB、未闭合 SSE 帧上限 2 MiB；
  响应暂存上限由 `maxResponseBytes` 限制。非流式 JSON 解析仍有此上限内的内存开销。
- 每条请求记录新增 `fileBackup`，包含配置哈希、文件状态、原工具 ID、规则 ID、
  备份相对路径和耗时，并记录 query ID。复用项带 `reused: true` 和首次请求的
  `sourceRecordId`，指向原备份文件，不再生成副本；重启时从历史记录恢复。对应文件位于
  `<TRACE_HOME>/data/file-backups/<record-id>/*.bin`，`manifest.json` 保存关联。
  备份保存**原始文件内容，不做文本脱敏**；API 的 JSON 导出只含引用，不打包文件。
  Unix 上目录 0700、文件 0600；原文件权限作为元数据记录，源文件不修改。
- 已存在的普通文件记为 `saved`；不存在的目标记为 `absent`（新文件写入前状态）；
  目录、超限、权限不足、无法解析的相对路径、无路径、参数错误、复制失败均有显式状态。符号链接指向的文件有读取权限即可备份；
  备份目录自身不参与备份，避免递归。仅保存文件，不递归备份目录。
- 未匹配的结构化工具名和 ID 写入 `unmatchedTools`，便于后续补充规则；只要存在
  未覆盖工具或文件失败，整体标为 `partial`。文件备份失败会记录原因并继续放行，
  不等于备份成功；响应解析/缓冲超限、断连会终止当前响应并清理临时文件。

本功能记录“模型建议执行工具前”的文件状态，不能确认工具真的执行过，也不防止其他进程
并发修改文件；复制时检测到变化会标记失败。Bash、动态脚本、目录操作和未识别协议
不在首版完整回放保证内，不应把部分采集样本当作完整环境快照。备份目前不自动清理，
清理历史轨迹时需按整个 query 及引用关系处理，不应删除仍被其他轮次引用的首次快照。

## 托盘应用

启动 `Trace Gateway.app` / `trace-desktop` / Windows 安装的 Trace Gateway：默认不弹出窗口，只显示托盘图标，并启动后台网关。

菜单包括：状态、打开控制台、浏览器打开、启动/停止网关、启用/取消登录时启动托盘、退出托盘（保留服务）、停止网关并退出。

macOS 显示在菜单栏右侧；Windows 显示在任务栏通知区域，系统可能默认收纳到隐藏图标中；Ubuntu 使用 AppIndicator，依赖桌面环境启用其支持。Ubuntu Server 没有托盘，使用 CLI 即可。托盘的确切摆放位置由操作系统/桌面环境决定。

关闭窗口只隐藏，不停止网关。普通「退出托盘」保留后台进程；需要完全退出请选择「停止网关并退出」。

## 常驻与登录启动

默认不会修改系统启动项；用户执行以下命令后安装：

```sh
trace service install --dry-run   # 预览实际系统配置，不修改启动项
trace service install            # 无 GUI 后台服务，当前用户
trace service status
trace service uninstall
```

- macOS：用户 LaunchAgent，由 launchd 运行 `trace serve`。
- Ubuntu：systemd user unit。若要求用户登出后/未登录也运行，可由管理员执行 `loginctl enable-linger <user>`；本工具不擅自申请管理员权限。
- Windows：当前用户登录计划任务，无控制台窗口、失败后重启；无桌面会话也可手动运行 `trace serve`。此版不是 Windows SCM 的机器级 Service，不提供登录前以 SYSTEM 运行。

有 GUI 时可用托盘菜单，或 `trace service install --desktop` 安装登录后托盘启动。CLI 与 `trace-desktop` 须位于同一目录（macOS 在 .app/Contents/MacOS 中）。headless 与 desktop 启动模式是二选一；切换前先卸载旧模式。已展开的配置路径绑定当前安装位置，不要移动发行目录后继续使用旧启动项，应重新安装启动项。

## 构建

构建者需要 Rust stable、Python 3、Node.js 22+。终端使用无需 Node；Node 仅在打包阶段拷贝进发行目录。

```sh
cargo test --locked -p trace-gateway-cli
node --test gateway/test/*.test.mjs
python scripts/package.py --node /path/to/node
python tests/cli_smoke.py
```

macOS 可直接生成本机 .app（无需全局 Tauri CLI）：

```sh
python scripts/package.py --node /path/to/node --native-macos-bundle
```

原生安装器（需要 Tauri CLI 2）用 `python scripts/package.py --desktop`，或在准备 sidecar 后 `cd desktop && tauri build`。Ubuntu 构建依赖 WebKitGTK 4.1 / Ayatana AppIndicator；Windows 需要 MSVC Build Tools / WebView2；参考 [Tauri 官方前置要求](https://v2.tauri.app/start/prerequisites/)。

`.github/workflows/build.yml` 在推送代码到 `main`、向 `main` 提交 PR、推送 `v*` 标签时自动构建，也可手动触发。三个任务独立运行，先执行 Rust / 网关测试和 CLI 端到端测试，再打包桌面应用。不会上传用户数据。

在 [GitHub Actions](https://github.com/YiZhengBJ/agent_trace/actions/workflows/build.yml) 选择 **Cross-platform builds → Run workflow → main → Run workflow**。完成后进入该次运行的 **Artifacts** 下载（保留 30 天）：

每个平台只发布一个统一包，包含桌面安装程序、CLI、内置 Node.js 和安装脚本：

| 平台 | 统一包 | 桌面组件 |
|---|---|---|
| Ubuntu x64 | `trace-gateway-ubuntu-x64-unified.tar.gz` | `.deb`、`.AppImage` |
| macOS Apple Silicon | `trace-gateway-macos-arm64-unified.tar.gz` | `.app`、`.dmg` |
| Windows x64 | `trace-gateway-windows-x64-unified.zip` | `.msi`、NSIS 安装程序 |

解压并进入包目录后安装：

```sh
# macOS / Ubuntu：自动选择模式（Linux 无显示环境时仅安装 CLI）
sh install.sh
# 服务器明确指定无桌面安装，不安装图形依赖
sh install.sh --headless
# Linux 桌面安装会通过 sudo apt-get 安装 deb 及其系统依赖
sh install.sh --desktop
```

Windows 在 PowerShell 中运行 `./install.ps1`；仅安装 CLI 用 `./install.ps1 -Headless`。若脚本被本机策略拦截，可使用 `powershell -ExecutionPolicy Bypass -File ./install.ps1`。桌面模式会打开原生安装向导。

安装不需要 Node.js、Rust 或 Python，也不会下载 Node.js。CLI 的 `runtime` 随包安装；桌面程序也携带自己的运行时，允许两种入口独立运行。macOS 应用安装到 `~/Applications`，Unix CLI 安装到 `~/.local/share/trace-gateway-app` 并链接到 `~/.local/bin/trace`（未在 PATH 中时脚本会提示）；Windows CLI 安装到 `%LOCALAPPDATA%/TraceGatewayApp` 并加入用户 PATH，新终端生效。安装不会自动启用开机启动。已有网关请先 `trace stop` 再升级，轨迹数据目录独立于程序安装目录。

### 卸载

统一安装脚本会同时安装卸载命令；无需保留下载包，也不需要 Node.js 或 Python：

```sh
# macOS / Ubuntu：先从托盘退出桌面应用
trace-uninstall
# 可选：同时永久删除当前 TRACE_HOME（未指定时为默认目录）的配置和轨迹
trace-uninstall --purge-data
```

```powershell
# Windows：先从托盘退出桌面应用
trace-uninstall
# 可选：同时永久删除当前数据目录
trace-uninstall -PurgeData
```

若 Unix 的 `~/.local/bin` 未加入 PATH，可直接运行 `~/.local/bin/trace-uninstall`。Windows PATH 尚未刷新时，在 PowerShell 使用 `& "$env:LOCALAPPDATA\TraceGatewayApp\trace-uninstall.cmd"`。

卸载会停止当前数据目录的网关，移除本用户的开机启动项、CLI、内置运行时和安装脚本注册的桌面组件。Ubuntu 移除 deb 需要 sudo，不会自动删除其他系统共享依赖。Windows 桌面组件调用原生卸载向导；也可从系统“已安装的应用”单独卸载桌面部分，再执行 `trace-uninstall` 清理 CLI。默认保留 Provider 配置和轨迹，不删除其他自定义数据目录；使用过多个 `--home` 时应先逐个停止，数据由用户单独处理。卸载脚本遇到仍在运行的托盘或清理失败会报错并保留剩余文件，修正后可重试。仅直接运行 `.dmg`/`.deb`/`.msi` 等原生安装器、未运行统一安装脚本时，使用相应系统卸载方式。

每个包内附带文件校验清单 `SHA256SUMS.txt`。缺失任一预期桌面安装程序会导致构建失败；此流程仅上传 Actions Artifacts，不自动发布 GitHub Release。

本地 macOS 包使用 ad-hoc 签名，仅供预览与内部分发，不等于 Apple Developer ID 签名和公证。公开分发前需要配置开发者证书/公证；Windows 代码签名同理。Ubuntu 和 Windows 包必须在对应 runner 构建并验证，不将源码或 CI 配置冒充已生成的安装包。
