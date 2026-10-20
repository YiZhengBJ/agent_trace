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

| 产物 | 桌面安装程序 | 无桌面 CLI（自带 Node.js） |
|---|---|---|
| `trace-gateway-ubuntu-x64` | `.deb`、`.AppImage` | `.tar.gz` |
| `trace-gateway-macos-arm64` | `.dmg`（Apple Silicon） | `.tar.gz` |
| `trace-gateway-windows-x64` | `.msi`、`-setup.exe` | `.zip` |

每份产物附带 `SHA256SUMS.txt`。缺失任一预期安装程序会导致构建失败；此流程仅上传 Actions Artifacts，不自动发布 GitHub Release。CLI 包解压后运行 `trace`（Windows 为 `trace.exe`），保留同目录下的 `runtime` 文件夹。

本地 macOS 包使用 ad-hoc 签名，仅供预览与内部分发，不等于 Apple Developer ID 签名和公证。公开分发前需要配置开发者证书/公证；Windows 代码签名同理。Ubuntu 和 Windows 包必须在对应 runner 构建并验证，不将源码或 CI 配置冒充已生成的安装包。
