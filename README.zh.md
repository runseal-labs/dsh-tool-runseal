# dsh-tool-runseal

[English](README.md) | 中文

一个独立的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用 [RunSeal](https://github.com/runseal-labs/runseal) 替换内置沙箱 —— 一个 OS 原生、策略驱动的执行环境，具备可强制执行的 filesystem / process / resource / network 边界，以及结构化审计事件和环境凭据擦除。

完全独立于仓库（out-of-tree）：只依赖已发布的 dsh 基础包。同时注册 `ctx.sandbox` 和 `ctx.subprocess`。受限调用保留文件策略；普通 subprocess 调用以显式 `danger-full-access` 交给 RunSeal 管理。

## 适配基线

适配未修改的 dsh `master@687f282e8625c6b8d11ff58211a90524be2e4317`（已发布包 `0.2.1-rc.2`）。自动安装要求 RunSeal **0.2.1**，包含 `ee871b0` 的 RFC-0022 控制传输与终端身份改动。此前本机验收使用该提交，但当时二进制仍报告 `0.2.0`；实际 `v0.2.0` release tag 指向 `8c18b10`，不含这些改动。RunSeal 使用 `main` 分支，没有 `master`。

## 功能

| 项 | 说明 |
|---|---|
| `ctx.sandbox` provider | 继承 `SandboxProvider`；`confine()` 通过一个薄 Node wrapper 把 argv 包到 `runseal rpc` 下执行 |
| `ctx.subprocess` provider | 管理 RPC 执行、流式输入、输出收集及溢出文件、取消和清理完成 |
| 策略映射 | dsh 的 `read-only` / `workspace-write` → 对应的 RunSeal sandbox 级别；实际 cwd 与可写工作区根目录分别保留 |
| 网络模式 | `unmanaged`（默认）、`disabled`、`proxy`（企业路由 + 凭据编辑） |
| 流式输出 | `execution.stdout` / `execution.stderr` RPC 事件转发到消费者的 stdio；退出码正确传播 |
| Fail closed | setup 缺失或后端不可用时，stderr 输出 `runseal: <原因>` 并以非零码退出，绝不静默无沙箱透传 |
| 审计 | 每次执行产生 `execution.requested` → `policy.resolved` → `execution.finished` 事件和 JSONL 审计记录 |

## 安装

通过 `dsh plugin --profile web add dsh-tool-runseal` 安装 bundle，重启 dsh 后打开「插件 → RunSeal」。下一版插件在 npm `postinstall` 阶段自动下载固定的 **RunSeal 0.2.1**，选择当前系统与架构，校验发布压缩包的 SHA-256，并把可执行文件和 Windows 辅助程序一起安装到包目录内。已发布的插件 0.2.0 仍需单独安装二进制。RunSeal 0.2.0 尚未包含完整原生终端/控制契约，不能作为下载目标。

支持下载 Windows、macOS、Linux 的 x64 / arm64 版本；固定版本 URL，不跟随 `latest`。提供二进制不代表各系统都支持受限策略。需要可访问 GitHub releases，并允许 npm 安装脚本；下载或校验失败会明确报错。若包管理器默认禁用脚本，需允许本包安装脚本，或启用脚本后执行 `npm rebuild dsh-tool-runseal`。运行时不自动下载，也不会静默降级为无沙箱执行。

`command` 留空即可使用自动下载版本。优先级为：显式 `command` → 环境变量 `RUNSEAL_BINARY` → 包内固定版本。离线或自定义安装时设置 `RUNSEAL_SKIP_DOWNLOAD=1`，然后配置 `command`；也可在安装和运行时都设置 `RUNSEAL_BINARY`。显式填入 `runseal` 仍按 PATH 解析。已有 profile 的自定义路径会保留，清空才切换到自动版本。预构建产物见 [RunSeal releases](https://github.com/runseal-labs/runseal/releases)。

Windows 上受限模式（`read-only`、`workspace-write`）需要先执行一次沙箱 setup：

```sh
runseal setup windows-sandbox --cwd <workspace> --elevate
```

将构建好的包安装到 Web profile，并在 profile 的 package.json 的 dsh.profile.bundles 中加入 dsh-tool-runseal：

```sh
pnpm build
pnpm pack
cd ~/.dsh/profiles/web
pnpm add /absolute/path/dsh-tool-runseal-0.2.1.tgz
```

bundle 自动禁用原版 dsh 的 sandbox、subprocess 两个 provider，并注册 sandbox-runseal。默认使用自动下载的二进制。需要覆盖时，在 profile 的 cordis.patch.yml 中添加：

```yaml
- id: sandbox-runseal
  config:
    command: 'C:/path/to/runseal.exe'
```

正常启动 dsh web，然后打开「插件 → RunSeal」编辑可执行文件、网络模式、超时、输入上限、额外参数和 wrapper 自动 setup。保存使用 dsh 原生配置服务，写回 profile；新命令使用最新配置快照，正在执行的命令保留启动时的配置。不要再使用同名组件的手工 insert 或 --patch overlay，否则可能重复挂载或阻止页面保存。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `command` | 留空（自动） | 自定义绝对路径或 PATH 名称；留空使用 `RUNSEAL_BINARY` 或下载的固定版本。 |
| `subprocess` | `true` | 注册由 RPC 管理的 subprocess provider。设为 false 仅提供 sandbox；此时旧 Windows 强杀问题仍然存在。 |
| `args` | `[]` | `rpc` 子命令前的额外参数（不走 shell）。 |
| `networkMode` | `unmanaged` | 网络策略：`unmanaged`、`disabled` 或 `proxy`。 |
| `maxStdinBytes` | `65536` | 导出的 `RunsealEngine.execute()` 缓冲 stdin 上限；不限制 wrapper 的流式输入。 |
| `timeoutMs` | `600000` | 受限调用的执行超时；普通 subprocess 调用由调用方管理截止时间与取消。 |
| `autoSetup` | `true` | 仅用于独立 wrapper：准入因缺少 setup 被拒绝时请求安装并重试一次。subprocess provider 要求预先完成 setup，不触发 UAC。 |

## 工作原理

`confine(argv, policy, signal)` 返回 `Promise<ConfinedArgv>`，已取消的请求直接拒绝：

```text
[node, wrapper.cjs, {"command": ..., "args": [...], "argv": [...], "cwd": ..., "policy": ..., "network": ..., "timeoutMs": ...}]
```

subprocess provider 识别本插件生成的 wrapper argv，直接向 RunSeal 发送原始命令，不再启动 wrapper。工作区可写根与实际 cwd 分开处理；普通 argv 使用显式 `danger-full-access`，保留原有非受限 subprocess 的语义。

每个 handle 持有自己的 RPC 连接。`execute` 先返回准入回执，输出通过事件传递，输入使用 `writeExecutionInput` / `closeExecutionInput`。`terminate()` 和 AbortSignal 通过同一连接发送 `cancelExecution`；回执前收到的取消会排队等待 execution ID，不杀 RPC owner。取消确认不代表清理完成：`done` 和 `waitForExit()` 等待终态 `cleanup_complete: true`，再等待 RPC owner 退出。连接丢失或缺少清理证明会明确拒绝，不能声称进程范围已清空。插件卸载时取消全部活跃执行并等待清理。

输出收集复用 dsh 公开的有限尾部缓存与溢出文件工具。显式环境变量仍受 RunSeal 策略约束，被擦除策略禁止的键会明确报错。设为 `subprocess: false` 时，其他消费者仍启动独立 wrapper，其已有生命周期限制继续存在。

## 已知限制与待办

- **原生交互 I/O** —— PTY 启动、输入、resize 和 interrupt 通过 RunSeal RPC 接入。控制数据使用子进程 fd 7 上的原生字节管道；关闭输入只封闭后续写入，不发送对端 EOF，子进程通过消息边界完成通信后关闭通道。终端提供真实子进程 PID；interrupt 等待原生 Ctrl-C 写入确认，返回 Windows 控制台根进程 PID。shell 活动保持未知。Windows SIGTERM 通过协议取消并等待控制台进程范围清空；拒绝对终端 shell 执行 SIGKILL，不支持 SIGTSTP 和 SIGHUP。终端终止会等待清理及在途操作完成。
- **覆盖范围** —— 管理经过 `ctx.subprocess` 的命令；直接使用 `node:child_process` 的代码不受此 provider 管理。
- **已有遗留门禁** —— 正常取消路径不再杀死 RPC owner，但不会自动重置之前崩溃或强杀留下的门禁。需要在管理员终端运行 `runseal repair execution-gates --json`，由官方命令验证释放后修复。宿主被强制结束仍无法保证优雅清理。
- **平台验证范围** —— 本次在 Windows 做了原生集成验证；未运行 macOS/Linux 实测和 UAC setup。
- **Setup** —— 挂载 subprocess provider 前完成 Windows setup；provider 不自动提权。
- **每个服务只能挂载一个 provider** —— bundle 自动禁用 `sandbox` 和 `subprocess`。
- **无回退链** —— 与 `sandbox-local`（bwrap→Landlock→Seatbelt→ACL）不同，本 provider 不链接其他 runner；runseal 不可用时调用直接 fail closed。

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

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # 协议、wrapper 子进程、Cordis 挂载和 dsh subprocess 测试
pnpm lint        # oxlint
pnpm build       # tsc + 复制 wrapper.cjs 到 lib/
```

原生集成测试需要将 `RUNSEAL_TEST_BINARY` 设为二进制绝对路径，再运行 `pnpm test`。测试使用临时工作区并关闭 `autoSetup`，覆盖 cwd、流式 stdin、只读拒写、工作区写入边界、协议取消、AbortSignal、插件卸载及其后的再次执行。未设置该变量时跳过原生测试。

原生集成以未修改的 dsh master 和 0.2.1-rc.2 接口为准。构建支持 RFC-0022 的 RunSeal，设置 `RUNSEAL_TEST_BINARY` 指向原生二进制，设置 `DSH_SOURCE_ROOT` 指向未修改的 dsh 源码，即可直接验证上游控制通道 helper。不需要修改 dsh，也不做协议降级。

## License

MIT
