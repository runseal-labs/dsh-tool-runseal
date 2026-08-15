# dsh-tool-runseal

一个独立的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：用 [RunSeal](https://github.com/runseal-labs/runseal) 替换内置沙箱 —— 一个 OS 原生、策略驱动的执行环境，具备可强制执行的 filesystem / process / resource / network 边界，以及结构化审计事件和环境凭据擦除。

完全独立于仓库（out-of-tree）：只依赖已发布的 dsh 基础包。注册为 `ctx.sandbox`，因此所有现有沙箱消费者（bash、jobs、fs）都会自动通过 RunSeal 执行受限命令。

## 功能

| 项 | 说明 |
|---|---|
| `ctx.sandbox` provider | 继承 `SandboxProvider`；`confine()` 通过一个薄 Node wrapper 把 argv 包到 `runseal rpc` 下执行 |
| 策略映射 | dsh 的 `read-only` / `workspace-write` / `danger-full-access` → 同名的 RunSeal sandbox 级别 |
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

RunSeal 接管 `ctx.sandbox`。把 base bundle 的 `sandbox-local` 行禁用，插入本插件：

```yaml
# cordis.patch.yml —— 用 RunSeal 替换内置本地沙箱
- id: sandbox-local
  disabled: true

- insert:
    - id: sandbox-runseal
      name: 'dsh-tool-runseal'
      inject: [sandbox]
      config:
        # runseal 可执行文件：绝对路径，或 PATH 上的名称
        command: 'runseal'
        # 网络模式：unmanaged（默认）、disabled 或 proxy
        networkMode: 'unmanaged'
        # 单次执行默认超时（毫秒）
        timeoutMs: 600000
```

> 注意：`ctx.sandbox` 是单服务键。必须禁用 base bundle 的 `sandbox-local` 行（或替换），RunSeal provider 才能注册。切换前请备份 patch。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `command` | —（必填） | runseal 可执行文件：绝对路径或 PATH 上的名称。 |
| `args` | `[]` | `rpc` 子命令前的额外参数（不走 shell）。 |
| `networkMode` | `unmanaged` | 网络策略：`unmanaged`、`disabled` 或 `proxy`。 |
| `maxStdinBytes` | `65536` | `bytes` 模式的 stdin 上限（runseal 限制）。 |
| `timeoutMs` | `600000` | 单次执行默认超时（毫秒）。 |

## 工作原理

`confine()` 按契约是同步的，因此立即返回 wrapper argv：

```text
[node, wrapper.cjs, {"argv": [...], "cwd": ..., "policy": ..., "network": ..., "timeoutMs": ...}]
```

消费者 spawn 它时，wrapper 启动 `runseal rpc --stdio`，发一个 `execute` 请求，把 `execution.stdout` / `execution.stderr` 事件负载转发到自己的 stdio，并以命令的退出码退出。消费者看到的是普通子进程生命周期 —— 无需改动 dsh 核心。

## 已知限制与待办

- **stdin 不流式** —— RunSeal 的 `execute` 接受 `stdin: { mode: 'bytes' | 'file' }`，不支持交互式流。wrapper 会排空消费者 stdin；长期交互命令（REPL）暂不支持。
- **Windows 受限模式需要 setup** —— `read-only` / `workspace-write` 需要执行一次 `runseal setup windows-sandbox`；在此之前这些模式会 fail closed。
- **同一时刻一个 provider** —— `ctx.sandbox` 只接受一个 provider；从 `sandbox-local` 切换需要禁用它的行（上面的 patch 已做）。
- **无回退链** —— 与 `sandbox-local`（bwrap→Landlock→Seatbelt→ACL）不同，本 provider 不链接其他 runner；runseal 不可用时调用直接 fail closed。

## 开发

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（协议 + confine 单元测试）
pnpm lint        # oxlint
pnpm build       # tsc + 复制 wrapper.cjs 到 lib/
```

## License

MIT
