# dsh-tool-runseal

[English](README.md) | 中文

一个独立的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用 [RunSeal](https://github.com/runseal-labs/runseal) 替换内置沙箱 —— 一个 OS 原生、策略驱动的执行环境，具备可强制执行的 filesystem / process / resource / network 边界，以及结构化审计事件和环境凭据擦除。

完全独立于仓库（out-of-tree）：只依赖已发布的 dsh 基础包。同时注册 `ctx.sandbox` 和 `ctx.subprocess`。受限调用保留文件策略；普通 subprocess 调用以显式 `danger-full-access` 交给 RunSeal 管理。

## 适配基线

适配未修改的 dsh `master@687f282e8625c6b8d11ff58211a90524be2e4317`（已发布包 `0.2.1-rc.2`）。插件 **0.2.4** 固定 **RunSeal 0.2.2**。插件补丁版本独立递增，无需修改 dsh 源码。

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

通过 `dsh plugin --profile web add dsh-tool-runseal@0.2.4` 安装 bundle，重启 dsh 后打开「插件 → RunSeal」。插件 0.2.4 在 npm `postinstall` 阶段自动下载固定的 **RunSeal 0.2.2**，选择当前系统与架构，校验发布压缩包的 SHA-256，并把可执行文件和 Windows 辅助程序一起安装到包目录内。

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
pnpm add /absolute/path/dsh-tool-runseal-0.2.4.tgz
```

bundle 自动禁用原版 dsh 的 sandbox、subprocess 两个 provider，并注册 sandbox-runseal。默认使用自动下载的二进制。需要覆盖时，在 profile 的 cordis.patch.yml 中添加：

```yaml
- id: sandbox-runseal
  config:
    command: 'C:/path/to/runseal.exe'
```

正常启动 dsh web，然后打开「插件 → RunSeal」编辑可执行文件、网络模式、超时、输入上限、额外参数和 wrapper 自动 setup。保存使用 dsh 原生配置服务，写回 profile；新命令使用最新配置快照，正在执行的命令保留启动时的配置。不要再使用同名组件的手工 insert 或 --patch overlay，否则可能重复挂载或阻止页面保存。

## 安装排查

插件页提示“这个包没有声明组合包”时，先看**安装日志实际装入的版本**，不要只看预览卡片。已有 macOS desktop 安装反馈：卡片显示 0.2.3，但 `pnpm add dsh-tool-runseal` 实际选择了 `^0.1.1`；旧版没有 bundle 声明。安装目标应明确填写 `dsh-tool-runseal@0.2.3`。若 pnpm 拦截刚发布的版本，在对应 profile 的 `pnpm-workspace.yaml` 现有 `minimumReleaseAgeExclude` 列表中只追加 `dsh-tool-runseal@0.2.3`，保留全局发布时间保护。桌面端通常使用 `~/.dsh/profiles/desktop`，Web 使用 `~/.dsh/profiles/web`；保留已有配置，并允许本包 postinstall 脚本。这能解释旧包与声明不匹配，尚不能确定该 Mac 选中旧版的原因，安装问题本身不能证明沙箱可用；后续 mba 原生验收结果见独立验收文档。

## 配置

沙箱策略由 dsh 会话的访问模式选择：只读、工作区内修改或完全权限。插件继承该策略，无需另开沙箱开关。

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

- **原生交互 I/O** —— PTY 启动、输入、resize 和 interrupt 通过 RunSeal RPC 接入。控制数据使用子进程 fd 7 上的原生字节管道；关闭输入只封闭后续写入，不发送对端 EOF，子进程通过消息边界完成通信后关闭通道。终端提供真实子进程 PID；Windows interrupt 等待原生 Ctrl-C 写入确认并返回控制台根进程 PID；macOS 则确认 SIGINT 已投递到实际观测到的前台进程组，raw ETX 仍作为终端输入。没有实时原生观测时前台身份保持未知，shell 活动也保持未知。Windows SIGTERM 通过协议取消并等待控制台进程范围清空；拒绝对终端 shell 执行 SIGKILL，不支持 SIGTSTP 和 SIGHUP。终端终止会等待清理及在途操作完成。
- **覆盖范围** —— 管理经过 `ctx.subprocess` 的命令；直接使用 `node:child_process` 的代码不受此 provider 管理。
- **Windows 已有遗留门禁** —— 正常取消路径不再杀死 RPC owner，但不会自动重置之前崩溃或强杀留下的门禁。需要在管理员终端运行 `runseal repair execution-gates --json`，由官方命令验证释放后修复。Windows RPC owner 独立于宿主控制台，宿主意外退出后通过管道断连完成清理。强杀 owner 或机器断电仍可能留下保护记录。
- **平台验证范围** —— Windows 与 macOS arm64 已完成原生集成验收。macOS 在 mba 上验证了受限文件写入边界、取消后重试、dsh 宿主被强杀后的自动清理及重启执行，这些链路已实测可用。macOS 后端仍自报 experimental；这是后端支持等级，不影响本轮验收通过的事实。未做 Linux 实测、macOS 页面交互或 Windows UAC setup 验收。
- **Setup** —— 挂载 subprocess provider 前完成 Windows setup；provider 不自动提权。
- **每个服务只能挂载一个 provider** —— bundle 自动禁用 `sandbox` 和 `subprocess`。
- **无回退链** —— 与 `sandbox-local`（bwrap→Landlock→Seatbelt→ACL）不同，本 provider 不链接其他 runner；runseal 不可用时调用直接 fail closed。

## 验证

RunSeal 0.2.2 新增 macOS PTY/控制通道及持久化 owner 恢复，插件 0.2.4 固定下载该版本。macOS 15.7.8 arm64 源码验收已覆盖取消重启、宿主退出清理及 RPC owner 强杀恢复；mba 上 npm 0.2.4 全新安装也已通过受限 PTY/PTC 取消重试、宿主退出清理和重启执行，详见发布包验收记录。

原生测试、Web profile 验收、审计证据和平台边界见[验收记录](https://github.com/runseal-labs/dsh-tool-runseal/blob/main/docs/acceptance.zh.md)。

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
