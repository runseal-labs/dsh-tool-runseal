# 验收记录

[README](../README.zh.md) | [English](acceptance.md)

以下为历史验收记录，结论仅适用于各节注明的版本和环境。

## Windows 页面验收（2026-10-23）

使用未修改的 dsh master（`687f282e86`）、RunSeal 0.2.0（`ee871b0`）和已正式安装到 Web profile 的插件（`3630495`），从 dsh 页面完成两轮真实命令验收：

1. 在页面选择访问模式，执行输出开始标记、等待 120 秒、输出结束标记的 PowerShell 命令。
2. 确认命令正在执行后，点击页面“停止生成”中途取消。
3. 在同一会话、同一访问模式中执行一条输出标记的短命令；两轮均未重启 dsh，未手动修复执行门禁，也未提权。

| 页面模式 | RunSeal 策略 | 取消结果 | 再次执行结果 |
|---|---|---|---|
| 完全权限 | `danger-full-access`，`sandbox.enforced: false` | 约 12 秒后取消；`EXECUTION_CANCELLED`，`cleanup_complete: true` | 输出 `RUNSEAL_UI_RETRY_20261023_OK`，退出码 0，清理完成 |
| 工作区内修改 | `workspace-write`，`sandbox.enforced: true` | 约 9 秒后取消；`EXECUTION_CANCELLED`，`cleanup_complete: true` | 输出 `RUNSEAL_RESTRICTED_RETRY_OK`，退出码 0，清理完成 |

完全权限轮核对了真实进程链 `dsh → runseal.exe rpc → pwsh.exe`；工作区内修改轮的审计确认 `restricted-local-process` 边界和 `low-privilege` 身份。两轮取消后，所记录的 RunSeal owner 与命令进程均已退出。再次执行的输出同时在页面原始工具结果与 RunSeal 完成记录中核对（审计记录输出字节数，不保存输出正文）。

本机审计文件位于执行工作区的 `.runseal/audit/`，未随仓库发布。对应记录为：

| 模式 | 取消记录 | 再次执行记录 |
|---|---|---|
| 完全权限 | `sess_1a165f70d4c_4fb0_0.jsonl` | `sess_1a165f762d6_125c_0.jsonl` |
| 工作区内修改 | `sess_1a165f9a3cd_ab54_0.jsonl` | `sess_1a165f9f5da_2ca8_0.jsonl` |

上述结果验证 Windows 页面正常取消后的清理及再次执行；完全权限轮不代表沙箱隔离验证。页面命令没有写入文件，未在这两轮中重复测试文件写入边界、宿主强杀或其他平台。

## npm 0.2.1 自动安装与 Web profile 验收（2026-10-23）

本轮验收开始前，`dsh-tool-runseal@0.2.1` 与 RunSeal `v0.2.1` 均已公开发布。在全新目录执行 `npm install dsh-tool-runseal@latest --registry=https://registry.npmjs.org --foreground-scripts --no-audit --no-fund`，解析到插件 0.2.1。postinstall 从公开 GitHub release 下载 Windows x64 压缩包，校验 SHA-256，安装三个必需的可执行文件。未使用本地 tarball、下载替身、自定义二进制路径或下载覆盖设置；安装后的二进制报告版本 0.2.1。基于实际安装包的冒烟检查在工作区内修改模式下取消命令、等待清理，再次执行输出 `AUTO_BINARY_RETRY_OK`，退出码 0。

随后通过 `dsh plugin --profile web add dsh-tool-runseal@0.2.1 --registry=https://registry.npmjs.org` 安装到本机 Web profile。profile 允许该包的安装脚本，并为这个精确版本配置 pnpm 最低发布时间豁免。bundle 正式登记，`command` 清空为字符串空值，然后重启 dsh。插件页显示版本 0.2.1、可执行文件字段为空、RunSeal 组件运行中。

在原有会话中保持 **工作区内修改** 模式完成页面验收：

1. 从页面执行 `Write-Output "AUTO_NPM_021_BEGIN"; Start-Sleep -Seconds 120; Write-Output "AUTO_NPM_021_END"`。
2. 命令运行期间，核实 dsh 子进程实际使用 `<web-profile>/node_modules/dsh-tool-runseal/.runseal/0.2.1-win32-x64/runseal.exe rpc --stdio`。
3. 点击 **停止生成**，页面显示已停止；进程检查确认 RunSeal owner、command runner 和对应长命令均已退出。
4. 在同一会话、同一模式执行 `Write-Output "AUTO_NPM_021_RETRY_OK"`，页面显示完成并输出预期标记，退出码 0。取消和再次执行之间无需额外重启、修复门禁或提权。

本轮验证了公开 npm 包及其自动下载的发布二进制，运行环境是已完成配置的 Windows 主机；不代表首次 Windows setup、macOS/Linux 运行验证或新增文件隔离边界测试。页面轮核对了页面状态与进程清理，未单独读取协议终态审计记录。截图 `web-0.2.1-config.png` 和 `web-0.2.1-cancel-retry.png` 保存在本机验收输出目录，未纳入仓库。

## 页面终端策略与 PTC 补验（本地修复，2026-10-23）

上游页面终端直接调用 `spawnTerminal()`，未附带 confinement。插件现在对携带 `DSH_SESSION_ID` 和 `shellActivity` 的终端解析当前会话策略，在创建受限终端前封装沙箱；会话或策略服务缺失时拒绝启动。策略在终端创建时确定，切换权限模式后须关闭并重新创建终端。匿名 subprocess 保持原有行为。

PTC 会主动移除子进程的用户配置环境变量。插件单独固定 RPC owner 使用的 Windows 沙箱配置目录，不恢复被移除的子进程用户目录变量或凭据。

本轮 Web profile 使用本地修复 tarball 和自动下载的 RunSeal 0.2.1 二进制；**已发布的 npm 0.2.1 尚不包含这些修复**。未修改 dsh，在“工作区内修改”模式下验证：

- 页面 PTY：`isTTY: true`、输入回显、调整尺寸通过；关闭运行中的终端后，取消审计确认 `cleanup_complete: true`，新建终端输出 `PTY_RESTART_OK`。取消审计为 `sess_1a1662d9a15_8b18_0.jsonl`。
- 页面原生 PTC：停止运行中的 `run_code`，确认取消和清理后再次执行，原始工具输出为 `PTC_CONTROL_RESTART_OK` 与 `{"sum":6}`。控制通道审计为 `sess_1a16630f7c3_7f50_0.jsonl`（取消）及 `sess_1a166329a06_a0e0_0.jsonl`（重试），均确认 enforced workspace-write。代码结果通过控制通道返回，随后 dsh 终止 worker，因此成功重试的进程审计仍记为取消且清理完成，而非退出码 0。

随后用页面真实键盘输入补验 Ctrl-C。浏览器自动化的 Ctrl-C 快捷键没有生成终端输入，临时插件诊断也未记录到 ETX。用户实际按键后，raw-mode 探针输出 `BYTES:03` 和 `RAW_CTRL_C_OK`；普通 Node 进程收到 SIGINT，输出 `PAGE_SIGINT_OK` 并返回同一 shell，之后的新命令输出 `PAGE_CTRL_C_RESTART_OK`。插件记录到两次 ETX，审计 `sess_1a166385259_a450_0.jsonl` 确认 enforced workspace-write，关闭终端后清理完成。无需改写 Ctrl-C 逻辑；补充回归断言，保证 ETX 作为普通 PTY 输入原样传递，保留 raw-mode 程序的语义。

诊断期间曾在测试终端仍运行时重启 dsh，留下执行保护记录。经明确授权，官方管理员修复清除了两条预留记录和一个临时运行目录，报告不可检查进程为 0、无未验证运行目录。最后先正常关闭终端、确认清理，再重启 dsh；临时诊断已移除。这不代表强制终止宿主后可以无需修复自动恢复。不扩展声称文件系统边界或其他平台验证通过。

## npm 0.2.2 普通安装与 Web 验收（2026-10-23）

插件 0.2.2 从 `8c1bf2ef35bad01467e208003eb120424a676753` 发布，固定 RunSeal 0.2.1。公开 npm registry 确认 `latest: 0.2.2`，发布包完整性哈希与本地打包验证的产物一致：

```text
sha512-wLsKIBesiTEmGlZdsWsJY/g423d1t9fbMR8Xz3Jp7vrwujN8Or4sLNNnWSyhJ9U3Kq+ylhU+yRazl8Qp929FVA==
```

在全新目录执行 `npm install dsh-tool-runseal@0.2.2 --registry=https://registry.npmjs.org --foreground-scripts --no-audit --no-fund`，安装公开包并自动下载 RunSeal 0.2.1 及 Windows 辅助程序，未使用本地 tarball 或自定义二进制覆盖。直接运行安装后的包，在 workspace-write 下通过 fd 7 控制通道 98,304 字节往返、取消清理和重试，以及 PTY 输入、调整尺寸、中断、取消和重新启动，结果为 `PUBLIC_NPM_022_ALL_PASS`。

Web profile 通过 `dsh plugin --profile web add dsh-tool-runseal@0.2.2 --registry=https://registry.npmjs.org` 升级，替换本地 tarball 依赖。profile 为这个精确版本豁免最低发布时间限制，并允许安装脚本。重启未修改的 dsh 后，插件页显示 0.2.2、自定义可执行文件字段为空、组件运行中；实际进程使用 profile 包内的 `.runseal/0.2.1-win32-x64/runseal.exe rpc --stdio`。

页面保持“工作区内修改”，验证结果如下：

| 路径 | 交互与取消 | 再次执行 |
|---|---|---|
| PTY | 输出 `NPM_022_PTY_READY:true`、`PTY_ECHO:npm022`；关闭运行中的终端，审计记录 `EXECUTION_CANCELLED` 且清理完成 | 新终端输出 `NPM_022_PTY_RESTART_OK:true`；正常退出 shell 后退出码为 0，清理完成 |
| PTC | 通过“停止生成”取消运行中的原生 `run_code`，审计记录控制通道流量及取消清理完成 | 原始工具输出为 `NPM_022_PTC_RETRY_OK` 和 `42`，worker 结束后清理完成 |

四份审计均确认 `workspace-write`、`sandbox.enforced: true`：

| 路径 | 取消审计 | 重试审计 |
|---|---|---|
| PTY | `sess_1a166439724_8d18_0.jsonl` | `sess_1a1664434c5_83b0_0.jsonl` |
| PTC | `sess_1a166435b69_93c0_0.jsonl` | `sess_1a166439a94_947c_0.jsonl` |

与此前 PTC 验收一致，代码成功输出后 dsh 会取消 worker，因此重试的进程审计仍记录取消，而非退出码 0。取消与重试之间无需重启、修复或提权。最后正常退出测试终端，未留下 RunSeal owner 或 command runner。截图 `web-npm-0.2.2-config.png`、`web-npm-0.2.2-interaction.png`、`web-npm-0.2.2-restart.png` 及原生结果、审计保留在本机仓库外。本轮使用已完成配置的 Windows 主机，未重复页面手动 Ctrl-C、首次 setup、文件系统边界或其他平台验证。

## Windows 宿主退出清理（0.2.3）

RPC owner 现在脱离 Windows 宿主控制台启动，隐藏窗口，并继续连接 stdio 管道；没有调用 unref，正常释放仍会等待 owner 退出。插件宿主退出或被终止时，管道关闭会让 RunSeal 取消执行、完成原生清理并释放保护记录，无需调用 repair。此前的宿主退出探针中，owner 在写入清理终态前就已消失。

针对 RunSeal 0.2.1 的原生故障注入覆盖“不执行释放直接退出宿主”和“强制终止宿主”。两者均确认 enforced workspace-write、`client_disconnected`、`cleanup_complete: true`，并在不 repair 的情况下再次执行受限命令。插件 0.2.3 包含此改动，继续固定 RunSeal 0.2.1。

这项修复避免普通宿主退出打断清理，不会自动解锁已有残留记录。如果连 owner 一起强杀、终止整个 OS job、机器断电，或无法证明清理完成，仍需严格的原生 repair。插件不会删除保护记录、仅凭 PID 消失认定清理成功，也不会自动使用 `--accept-unverified-release`。

## npm 0.2.3 与真实 Web 宿主退出验收（2026-10-23）

发布源提交为 `03240acc31a0ee91240aa0f952ecb5851313b69d`。公开 npm 的 latest 已解析到 0.2.3，完整性哈希与已验证 tarball 一致。全新目录普通 npm 安装自动下载固定的 RunSeal 0.2.1。Web profile 从公开 registry 升级，自定义二进制路径为空；插件页显示 0.2.3、组件运行中。

页面在工作区内修改模式下启动终端，Node 子进程输出 `NPM_023_HOST_LOSS_READY` 后持续运行。仅强制结束 dsh 宿主，审计 `sess_1a166509e64_95fc_0.jsonl` 记录 `client_disconnected`、`sandbox.enforced: true` 和 `cleanup_complete: true`，owner 与 runner 均退出。重启未修改的 dsh 后，新页面终端输出 `NPM_023_AFTER_HOST_RESTART_OK true`；正常退出终端后，审计 `sess_1a16651d62c_b0bc_0.jsonl` 记录 enforced workspace-write、退出码 0 和清理完成。两轮之间未执行 repair、提权或删除保护记录。

类型检查、Lint、构建和 30 项针对性测试通过，包含两项原生宿主退出测试。本轮 Windows 验收只结束宿主，不覆盖 owner 被强杀、整个 OS job 被终止或机器断电。截图 `web-npm-0.2.3-restart.png` 保存在本机仓库外。

## macOS arm64（mba）原生验收（2026-10-23）

环境为 mba（Darwin arm64），已安装的 dsh 桌面发行版 **0.2.1-rc.2**、npm 插件 **0.2.3**，以及插件自动下载的 **RunSeal 0.2.1 darwin-arm64**。通过 SSH 使用发行版自带的 dsh 启动器，启动独立 `runseal-acceptance-023` profile，加载原版 dsh 基础包和 desktop profile 已安装的插件；验收驱动通过 `ctx.sandbox.confine()` 和 `ctx.subprocess` 执行真实命令。未修改 dsh 源码或安装包，未修改 desktop profile，也未终止正在使用的桌面会话。

| 场景 | 实测结果 |
|---|---|
| 工作区内修改 | 工作区内写入成功；向工作区外的测试路径写入被拒绝，目标文件不存在。 |
| 只读模式 | 工作区内写入被拒绝，目标文件不存在。 |
| 取消后重试 | 等待长任务输出就绪后调用 `terminate()`，等待 `done` 和 `waitForExit()`；审计记录 cancelled、清理完成，随后受限命令输出 `MBA_DSH_RETRY_OK`、退出码 0。 |
| dsh 意外退出 | 长任务就绪后，仅向独立验收 profile 的 dsh 宿主发送 SIGKILL。RunSeal 记录 client_disconnected、清理完成。 |
| 重启后执行 | 重新使用同一 dsh 启动器和验收 profile，文件边界、取消及重试检查再次全部通过。 |

关键审计记录：

- 首轮取消：`sess_1a1665562c2_403c_0.jsonl`；重试：`sess_1a166556368_403e_0.jsonl`。
- 宿主强杀：`sess_1a16655a1f2_4054_0.jsonl`，`termination_reason: client_disconnected`。
- 重启后取消：`sess_1a16655a6c5_4060_0.jsonl`；重试：`sess_1a16655a76b_4063_0.jsonl`。

上述审计均记录 `sandbox.enforced: true` 和 `cleanup_complete: true`，策略对应 workspace-write 或 read-only。结束后未发现 RunSeal 残留进程，工作区 `.runseal/runtime` 下无残留执行目录；全程未调用 repair、删除保护记录或提权。结果与脚本保留在 mba 的 `~/.dsh/runseal-acceptance-023/`，汇总另存于 Windows 的 `~/.dsh/runseal-preview/mba-0.2.3/results.json`。

**结论：上述 macOS 原生执行链路已实测可用。** RunSeal 0.2.1 同时仍报告后端 `runseal-macos-experimental`、状态 `experimental`；本次插件验收不更改上游支持等级。不扩展声称 macOS 页面交互、PTY/PTC、其他架构、owner 本身被强杀、整个进程组被杀或机器断电已通过验收。

## macOS PTY、控制通道及 owner 恢复——未发布源码预览版（2026-10-23）

环境为 mba、macOS 15.7.8 arm64，通过未修改的 dsh 0.2.1-rc.2 启动器及独立验收 profile 执行，插件和 RunSeal 均使用本次修改后的源码构建。当前 npm 0.2.3 和固定下载的 RunSeal 0.2.1 二进制尚不包含该实现。未修改 dsh 源码、桌面 profile 或应用安装文件。

- 最终 8 项集成验收全部通过：工作区内修改和完全权限两种模式分别验证 fd 7 控制通道取消重试（98,304 字节往返）、PTY 输入/调整尺寸/raw ETX/取消重启、前台原生 SIGINT，以及仅强杀 dsh 宿主后的清理。受限模式审计 enforced=true，完全权限为 false；宿主退出后记录 client_disconnected 和完整清理。
- 独立强杀两次 RPC owner，两次内核资源 coalition 均为 started=exited=5、active=0。后续执行自动清除了对应注册任务、归属记录和运行目录。两个恢复者并发执行成功，同时存活的另一执行保持原 owner/子进程身份、活跃 cohort、注册任务及记录，未被误杀。
- 注入无效的已准入 cohort 记录后，新执行被拒绝且没有 Started 事件。以 /private/tmp 为宽工作区的受限命令无法覆盖归属标记，也无法伪造同级恢复记录。恢复故意损坏的测试夹具属于故障注入复位，并非生产环境手动 repair。
- Windows 和 macOS 严格 Clippy、格式检查通过；macOS 19 项定向单测、9 项原生一致性测试通过，后者也通过并发运行。插件 typecheck、lint、build 和 18 项 subprocess 定向测试通过。

清理成功要求内核正向空集证明、封闭启动入口、绑定进程出生身份的信号、I/O 收尾及持久化恢复阶段；归属未知仍阻止执行。最终成功验收不需要 sudo、额外系统权限、常驻服务或手动 repair。结论限于本机 CLI/服务集成，未声称覆盖 macOS 页面交互、其他系统版本、断电或全部可信清理助手同时消失。

mba 证据：`~/.dsh/runseal-acceptance-023/dsh-final-two-mode-acceptance.json`、`owner-hard-kill-recovery-result.json`。实现与证明边界见 RunSeal 的 `docs/security/2026-10-macos-owned-process-boundary.md`。

## npm 0.2.4 + RunSeal 0.2.2：macOS 发布包验收（2026-10-23）

先从 `2e097f7bdacd116d0f0a2ab186450719c7359bf9` 发布 [RunSeal v0.2.2](https://github.com/runseal-labs/runseal/releases/tag/v0.2.2)，核验六平台归档、校验和及 SBOM；再从 `9ddfff61b6f31511257ac6c9d7f591722303b30e` 发布 npm `dsh-tool-runseal@0.2.4`。已确认 npm latest=0.2.4，插件明确固定二进制版本为 0.2.2。

mba（macOS 15.7.8 arm64）的全新独立 profile 使用普通 `npm install --save-exact dsh-tool-runseal@0.2.4 --registry=https://registry.npmjs.org --foreground-scripts` 安装，独立 npm 缓存避免读取发布前的旧元数据。postinstall 自动下载到包内 `.runseal/0.2.2-darwin-arm64/`，自定义路径为空，也未设置二进制或跳过下载的环境覆盖。归档 SHA-256 为 `1449ab8a448c6d7f2b30b1604ad1e0f656aff4647d0220be79b200e463218bc8`；安装的二进制与公开归档逐字节匹配，并报告 0.2.2 / 协议 v2。

通过未修改的已安装 dsh 0.2.1-rc.2 启动器及原版控制通道 helper，以下六项全部通过：

- 工作区内修改模式 PTC：子进程 fd 7 精确往返 98,304 字节，取消并等待清理，再次启动和往返成功。
- 同模式 PTY：真实 TTY、输入、80x24 → 100x30 resize、raw ETX、取消及再次交互启动成功。
- 原生 SIGINT：确认投递到有效前台进程组，应用确认收到，再取消并等待清理。
- 仅 SIGKILL 独立 dsh 宿主：审计 `sess_1a1671240f9_9515_0.jsonl` 记录 client_disconnected、受限策略生效及完整清理，目标子进程已不存在。
- 宿主重启后，PTC 取消重试和 PTY 取消重启分别再次通过。

十条执行审计全部报告 RunSeal 0.2.2、sandbox.enforced=true、cleanup_complete=true。结束后无 cohort 注册任务、归属记录或执行运行目录残留。未执行 repair、未提权、未修改 dsh 或活跃桌面 profile。本轮属于原生 CLI/服务验收，不代表 macOS 页面交互验收。mba 结果：`~/.dsh/runseal-acceptance-024/npm-024-acceptance.json`。

验收驱动曾修正 profile 字段为 dsh.profile.bundles，并在审计文件仍写入时只解析换行完整的记录；产品代码、清理断言和超时均未改动。发布时 Linux/macOS CI 和发布工作流通过，独立 Windows prepared-conformance 的工作区写入用例曾触发 30 秒执行超时，清理成功。该历史 CI 失败现已修复，标准矩阵已全部通过，详见下方后续验证。

## Windows 超时修复及标准 CI 全绿（2026-10-23）

RunSeal 提交 [`1d405d1b517d45fe2373d3b19dd9867f47655ce6`](https://github.com/runseal-labs/runseal/commit/1d405d1b517d45fe2373d3b19dd9867f47655ce6) 的[标准 CI 39903936626](https://github.com/runseal-labs/runseal/actions/runs/39903936626) 已完成，**Windows、Linux、macOS 三个平台全部通过**。

Windows 超时已定位到夹具中未限定模块的 PowerShell 命令解析路径。进程能进入脚本，直接原生文件写入也完成，但未限定命令的路径在 runner 的模块环境中阻塞；对照调用同一个 `Microsoft.PowerShell.Management\Set-Content`，原写入校验在 0.95 秒内完成。修复将文件系统夹具绑定到该内置 cmdlet，并对成功的工作区写入新增 cleanup_complete=true 断言。原 30 秒执行上限、文件内容校验、退出码和拒绝越界断言均保留，测试没有新增 sleep 或重试。

验证结果：

- 移除诊断标记后，[独立 Windows 文件系统测试](https://github.com/runseal-labs/runseal/actions/runs/39903086957/attempts/2) 17/17 通过。
- 标准 Windows prepared-conformance 共 **485 项通过、零失败、零 ignored**，包括原超时用例 workspace_write_allows_workspace_write_when_supported_or_fails_closed，以及全部 77 项执行一致性测试。
- Windows 格式检查、严格 Clippy、原生清理检查、第三方示例、空白和脱敏扫描全部通过；Linux、macOS job 也均成功完成。

本次后续修复修改测试夹具并加强清理断言，未修改 dsh、运行时沙箱权限或已发布二进制内容，也不替代前文的发布包验收。

## npm 0.2.4 + RunSeal 0.2.2：Windows 页面验收（2026-10-23）

本机 Windows Web profile 使用公开 npm `dsh-tool-runseal@0.2.4`，自定义 `command` 为空，实际 RPC owner 来自包内 `.runseal/0.2.2-win32-x64/runseal.exe`。profile 锁文件的 npm 完整性哈希与发布包一致，未使用本地 tarball。自动下载的二进制报告 0.2.2 / 协议 v2，其 SHA-256 与官方 Windows 发布归档中提取的可执行文件一致：

```text
029E04EB0AE8FED8F524E0A0EC391D247ABF8617EDA5C46CCA098F2FC4F4E336
```

重启未修改的 dsh 后，在页面“工作区内修改”模式完成以下验收：

| 场景 | 页面及审计结果 |
|---|---|
| PTY 交互与边界 | 真实 TTY、输入回显和 resize 事件正常；向工作区外测试路径写入返回 EPERM，目标文件不存在。 |
| PTY 取消重试 | 关闭运行中的终端，等待取消清理；新建终端成功回显 `NPM_024_PTY_RETRY_OK`。 |
| 原生 PTC 取消重试 | 运行中的 `run_code` 通过“停止生成”取消；下一次原始工具输出 `NPM_024_PTC_RETRY_OK` 和 `{sum:6, answer:42}`，审计包含控制通道流量。 |
| 宿主意外退出 | PTY、PTC 同时运行时，仅强杀 Web 宿主，不强杀 RPC owner 或整个进程树；两条执行均记录 client_disconnected、cleanup_complete=true，对应 owner、子进程及执行运行目录均消失。 |
| 重启后执行 | 原生 PTC 输出 `NPM_024_AFTER_HOST_RESTART_PTC_OK` 和 `{answer:42}`；新 PTY 回显 `NPM_024_AFTER_HOST_RESTART_PTY_OK`，仍拒绝工作区外写入。关闭测试终端后，两条执行均完成清理，进程与运行目录消失。 |

关键审计记录均报告 RunSeal 0.2.2、`sandbox.enforced: true`、`workspace-write` 和 `cleanup_complete: true`：

| 路径 | 页面取消 | 取消后重试／宿主断连 | 宿主重启后 |
|---|---|---|---|
| PTY | `sess_1a1677236e7_8ea8_0.jsonl` | `sess_1a167753f4b_b31c_0.jsonl` | `sess_1a167783a5e_a1d4_0.jsonl` |
| PTC | `sess_1a16770fc9d_5684_0.jsonl` | 重试 `sess_1a16772086d_9048_0.jsonl`；宿主断连 `sess_1a167760242_52e8_0.jsonl` | `sess_1a1677843eb_4608_0.jsonl` |

PTY 重试实例继续用于宿主退出测试。PTC 代码成功返回后，dsh 取消 worker，因此成功返回的进程审计仍可记录 cancelled；成功依据是原始工具结果、控制通道流量和完整清理，而非退出码 0。

全程未调用 repair、删除保护记录或额外提权，未修改 dsh、插件或 RunSeal 源码。验收主机已完成 Windows setup，本轮不覆盖首次 UAC setup、强杀 owner、机器断电或其他平台。浏览器自动化 Ctrl-C 未产生 ETX，不计为本轮通过项；本轮取消通过页面停止生成和关闭终端验证。

本机证据保留在 `~/.dsh/runseal-preview/windows-web-024/`：`acceptance-result.json`、`host-loss-result.json`、`post-restart-result.json`，以及 `pty-ptc-interaction.png`、`pty-retry.png`、`host-loss-ready.png`、`post-restart.png`。原始审计位于验收工作区 `.runseal/audit/`；截图和本机输出未纳入仓库。

## 原生 shell 适配补验——未发布源码（2026-10-23）

本轮验证的是插件工作区构建，版本字段仍为 0.2.4，二进制仍为已发布 RunSeal 0.2.2；修复尚未包含在 npm 0.2.4 中。只修改插件，不改 dsh。Windows 使用本地原版 dsh master 的 CLI；mba 使用已安装的 dsh 0.2.1-rc.2 启动器。独立 `runseal-shell-adapter` profile 加载插件构建产物和 `tests/native-shell-driver.mjs`，不替换日常 Web/desktop profile。

两端分别通过原生 `ctx.shell.resolve()` / `execute()` / `result()` 路径验证 Windows PowerShell 与 macOS bash，不用 PTY 或 PTC 冒充 shell 工具覆盖。macOS 原生执行器传入裸 `bash`，由插件在执行时按有效 PATH 解析；参数不经过额外 shell 展开。

| 场景 | Windows / mba 结果 |
|---|---|
| 工作区内修改执行 | 输出 `NATIVE_SHELL_OK`，退出码 0，denied=false。 |
| 普通命令失败 | 退出码 17，denied=false，不误报为沙箱拒绝。 |
| 只读写入拒绝 | 写入未发生，命令非零退出，原生 shell 结果中 denied=true。 |
| 取消及重试 | 等待 shell 输出 CANCEL_READY 后取消、等待结束；再次执行输出 NATIVE_SHELL_RETRY_OK，退出码 0。 |

两端各 5 份执行审计均确认 sandbox.enforced=true、cleanup_complete=true，临时执行目录已消失。Windows 取消／重试审计为 `sess_1a1679717bd_8150_0.jsonl` / `sess_1a167971eb1_8034_0.jsonl`；mba 为 `sess_1a16796f294_b6b3_0.jsonl` / `sess_1a16796f32f_b6b6_0.jsonl`。Windows 证据保留在 `~/.dsh/runseal-preview/shell-adapter/`；mba 为 `~/.dsh/runseal-shell-preview/`。本轮是原生服务验收，不是新的页面或公开 npm 安装验收。

适配层改用子命令的 OS 拒绝文案进行诊断，runner/RPC 不可用则使用 SANDBOX_UNAVAILABLE，并通过 cause 保留原始错误；子命令找不到仍保留独立的 executable-not-found 类型。测试覆盖 PATH 覆盖、参数保留、独立 wrapper、拒绝准入后的清理证明及错误分类。enforcement 保留 full，其含义仅为成功准入后 dsh 文件效果的完整强制，不能按 macOS experimental 支持标签直接降为 partial；也不表示网络或读隔离。

另行排查 Windows 桌面 PTC 启动失败：受限身份对用户目录安装的 Electron 可执行文件存在显式拒绝读取 ACL；完全权限路径则曾因插件漏传 ELECTRON_RUN_AS_NODE=1 而启动 GUI。修复启动变量传递后，实际桌面可执行文件在完全权限下输出 ELECTRON_NODE_MODE_OK 并以 0 退出。受限 Electron 启动仍被 ACL 阻止，未放宽权限、删除缓存或声称该桌面场景已修复；应另行配置可访问的独立 Node 及 bootstrap。上述 PowerShell/bash 验收不受此桌面部署限制影响。

## Windows 桌面受限 PTC 独立 Node 部署——未发布源码（2026-10-23）

上述桌面限制现已通过显式部署解决，不放宽 ACL、不改 dsh。原版桌面发行版 0.2.1-rc.2 继续作为 Electron 宿主；PTC launch 指向可访问的独立 Node 26.8.1，以及从该安装包 ASAR 原样复制的 per-call bootstrap。原文件 42,917 字节，SHA-256 为 `e25ce53b26bb3e96e62cb7433f74612395f3865b4627a695d3d4fd42c4706790`，副本逐字节哈希一致。persistent bootstrap 同时备份，但本轮执行模式为 per-call。

新增 `scripts/prepare-desktop-ptc.mjs` 生成有哈希的副本、manifest 和独立配置片段，不改安装包、profile 或权限。实际 desktop profile 已安装本地修复 tarball（版本字段仍为 0.2.4、固定自动下载 RunSeal 0.2.2），通过已有 `ptc-runtime.launch` 配置使用独立 Node 和 bootstrap，并重新启动桌面应用。profile 原文件已备份；只为这个精确本地 tarball 允许 postinstall，未关闭一般安装脚本策略。npm 0.2.4 尚不包含这些源码修改。

使用已安装的插件与自动下载二进制、原版桌面 Electron CLI 宿主及原版 PTC runtime，在独立验收 profile 验证：

- 受限 PTC 通过真实主机 binding 往返 `{answer:42}`，并精确往返 294,912 字节 UTF-8 中文字符串；worker 确认为独立 node.exe，非 Electron。
- 通过 binding 确认 worker 就绪，再取消并等待结束；返回 abort，下一次运行成功返回 43。
- 同时保留运行中的 worker 和 Node 后代进程，只强杀验收宿主。审计 `sess_1a167a17d34_738c_0.jsonl` 记录 client_disconnected、sandbox.enforced=true、cleanup_complete=true；RPC owner、worker、后代进程全部退出，执行目录消失。
- 重启后大消息交互、取消、重试再次通过。三份审计 `sess_1a167a1f3b6_a198_0.jsonl`、`sess_1a167a1fa09_9f00_0.jsonl`、`sess_1a167a1ff20_1dbc_0.jsonl` 均确认受限执行、完整清理和无执行目录残留。

大消息曾暴露 INPUT_BACKPRESSURE：RunSeal 有 256 KiB 待写队列，拒绝表示本次块未入队。插件现只重试这一明确拒绝的块，RPC 轮次之间让出 I/O，不增加 sleep、超时或重复已接受的块；持续背压时仍可取消。新增定向测试覆盖精确字节、不重复和背压中的取消清理。准备工具已用真实安装包运行，58 项插件测试通过、4 项需显式启用的测试跳过；桌面原生验收单独执行。

原桌面 EXE 的拒绝读取 ACL 前后 SDDL 一致，未 repair、提权、删除保护记录或放宽断言。此为 Windows 原生桌面服务验收，不是页面操作验收，也不声称覆盖 persistent 模式、机器断电或强杀 RPC owner。证据保留于 `~/.dsh/runseal-preview/desktop-ptc/`，运行时副本与生成配置在 `~/.dsh/runseal-runtime/ptc/`；验收驱动为 `tests/desktop-ptc-driver.mjs`。

## npm 0.2.5 发布与 desktop profile 验收（2026-10-23）

插件从提交 [`536fd9938a14e5ca54f9ce028130d5809b6f1a80`](https://github.com/runseal-labs/dsh-tool-runseal/commit/536fd9938a14e5ca54f9ce028130d5809b6f1a80) 打包，发布为 [npm 0.2.5](https://www.npmjs.com/package/dsh-tool-runseal/v/0.2.5)，仍固定 RunSeal 0.2.2。registry 已确认 latest=0.2.5，公开包完整性与已验证 tarball 一致：

```text
sha512-GtC5YEROUWFT049x6wws0fGOeRdbp4aRDvM95VjrOOoJyqQMewXZNDLzeh02uqMxuZkPuC3dFb457XhexprJNA==
```

发布前 typecheck、lint、构建、原生发布检查通过；58 项测试通过、4 项显式跳过。tarball 在全新目录普通 npm 安装通过，自动下载二进制报告 RunSeal 0.2.2 / 协议 v2。公开版本可读后，desktop profile 改用 registry 的精确依赖 0.2.5，替换本地 file tarball；lockfile 完整性与上述哈希一致。postinstall 自动下载 RunSeal 0.2.2，二进制 SHA-256 仍为 `029e04eb0ae8fed8f524e0a0ec391d247abf8617eda5c46cca098f2fc4f4e336`。本地 tarball 的脚本授权已移除，仅为 0.2.5 添加精确版本的发布时间豁免和安装脚本许可；一般策略保留。独立 Node 和官方 bootstrap 配置保留，桌面已重新启动。

使用实际 desktop profile 的 npm 安装包、自动二进制和原版桌面 Electron 宿主，在独立验收 profile 完成受限 PTC 原生服务验收：

- 真实 host binding 往返 `{answer:42}`、294,912 字节 UTF-8 中文字符串；worker 确认为独立 Node。
- binding 确认就绪后取消，等待 abort 和清理，再次运行返回 43。
- 只强杀独立验收宿主。审计 `sess_1a167a94ce6_3eec_0.jsonl` 记录 client_disconnected、受限策略生效、完整清理；owner、worker、Node 后代进程及执行目录全部消失。
- 重启后交互、取消和重试再次通过。审计为 `sess_1a167a9a96a_1094_0.jsonl`、`sess_1a167a9afdb_a648_0.jsonl`、`sess_1a167a9b528_93d0_0.jsonl`。

七份执行审计全部确认 RunSeal 0.2.2、sandbox.enforced=true、cleanup_complete=true 和运行目录已移除。PTC 正常返回后 dsh 会取消 worker，因此成功调用的进程终态仍可记为 cancelled；成功依据同时包含原始返回值、控制通道流量和清理证明。未改 dsh、未 repair、未提权或放宽 ACL。本轮是原生桌面服务验收，不是页面点击验收；不扩展到 persistent 模式或强杀 owner。证据位于 `~/.dsh/runseal-preview/release-025/`，包括公开 registry 元数据、打包与安装记录、host-loss-result.json、audit-results.json 及重启日志。
