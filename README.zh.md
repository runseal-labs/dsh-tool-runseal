# dsh-tool-runseal

[English](README.md) | 中文

一个独立的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用 [RunSeal](https://github.com/runseal-labs/runseal) 替换内置沙箱 —— 一个 OS 原生、策略驱动的执行环境，具备可强制执行的 filesystem / process / resource / network 边界，以及结构化审计事件和环境凭据擦除。

完全独立于仓库（out-of-tree）：只依赖已发布的 dsh 基础包。同时注册 `ctx.sandbox` 和 `ctx.subprocess`。受限调用保留文件策略；普通 subprocess 调用以显式 `danger-full-access` 交给 RunSeal 管理。

## 适配基线

以本地上游源码为准：dsh `master@687f282e8625c6b8d11ff58211a90524be2e4317`，对应已发布包 `0.2.1-rc.2`；RunSeal `main@8c18b10034be51c15d9fd02efded8d8594a3be9a`，版本 `0.2.0`、协议 v2。RunSeal 没有 `master` 分支。本机原生测试二进制报告 `0.2.0`，包含 RFC-0022 的控制传输与终端身份改动。旧协议不属于本次验证基线。

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

前置：PATH 上有 `runseal` 二进制（或在 `command` 配置里给绝对路径）。Windows / macOS / Linux 的预构建二进制发布在 [runseal releases](https://github.com/runseal-labs/runseal/releases) 页面。

Windows 上受限模式（`read-only`、`workspace-write`）需要先执行一次沙箱 setup：

```sh
runseal setup windows-sandbox --cwd <workspace> --elevate
```

然后把插件装进 dsh profile：

```sh
cd ~/.dsh/profiles/web && pnpm add dsh-tool-runseal
# 或从源码：
#   git clone https://github.com/runseal-labs/dsh-tool-runseal && cd dsh-tool-runseal && pnpm install && pnpm build
```

## 挂载到 dsh

RunSeal 接管 `ctx.sandbox` 和 `ctx.subprocess`。禁用两个本地 provider，再加载插件：

```yaml
# cordis.patch.yml —— 用 RunSeal 替换内置本地沙箱
- id: sandbox
  disabled: true

- id: subprocess
  disabled: true

- insert:
    - id: sandbox-runseal
      name: 'dsh-tool-runseal'
      config:
        # runseal 可执行文件：绝对路径，或 PATH 上的名称
        command: 'runseal'
        # 网络模式：unmanaged（默认）、disabled 或 proxy
        networkMode: 'unmanaged'
        # 单次执行默认超时（毫秒）
        timeoutMs: 600000
```

> 两个服务都只能挂载一个 provider。仍依赖 `dsh-subprocess-local` 包的公开输出收集工具，但不挂载它的进程执行服务。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `command` | —（必填） | runseal 可执行文件：绝对路径或 PATH 上的名称。 |
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
- **每个服务只能挂载一个 provider** —— 按上面的配置同时禁用 `sandbox` 和 `subprocess`。
- **无回退链** —— 与 `sandbox-local`（bwrap→Landlock→Seatbelt→ACL）不同，本 provider 不链接其他 runner；runseal 不可用时调用直接 fail closed。

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
