# dsh-tool-runseal

English | [中文](README.zh.md)

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: replaces the built-in sandbox with [RunSeal](https://github.com/runseal-labs/runseal) — an OS-native, policy-governed execution environment with enforceable filesystem, process, resource, and network boundaries, plus structured audit events and environment-credential scrubbing.

Fully out-of-tree: depends only on published dsh base packages. Registers both `ctx.sandbox` and `ctx.subprocess`. Confined calls retain their file policy; ordinary subprocess calls run through RunSeal with explicit `danger-full-access`.

## Compatibility

Adapted against local upstream checkouts: dsh `master` at `687f282e8625c6b8d11ff58211a90524be2e4317` (published packages `0.2.1-rc.2`), and RunSeal `main` at `8c18b10034be51c15d9fd02efded8d8594a3be9a` (`0.2.0`, protocol v2). RunSeal has no `master` branch. The validated native binary reports `0.2.0` and includes the RFC-0022 transport and terminal identity changes. Older protocols are not the validation baseline.

## What it provides

| Item | Description |
|---|---|
| `ctx.sandbox` provider | Subclasses `SandboxProvider`; `confine()` wraps argv through a thin Node wrapper that runs the command under `runseal rpc` |
| `ctx.subprocess` provider | Owns RPC execution, streaming input, collected output/spill files, cancellation and cleanup completion |
| Policy mapping | dsh `read-only` / `workspace-write` → corresponding RunSeal sandbox levels; preserve the caller cwd separately from writable workspace roots |
| Network modes | `unmanaged` (default), `disabled`, `proxy` (enterprise routing + credential redaction) |
| Streaming output | `execution.stdout` / `execution.stderr` RPC events forwarded to the consumer's stdio; exit code propagates |
| Fail closed | Missing setup or an unavailable backend rejects with `runseal: <reason>` on stderr and a non-zero exit, never silent passthrough |
| Audit | Every execution emits `execution.requested` → `policy.resolved` → `execution.finished` events and a JSONL audit record |

## Install

Prerequisites: a `runseal` binary on PATH (or an absolute `command` path). Prebuilt binaries for Windows / macOS / Linux are published on the [runseal releases](https://github.com/runseal-labs/runseal/releases) page.

On Windows, confined modes (`read-only`, `workspace-write`) require the sandbox setup once:

```sh
runseal setup windows-sandbox --cwd <workspace> --elevate
```

Then install the plugin into your dsh profile:

```sh
cd ~/.dsh/profiles/web && pnpm add dsh-tool-runseal
# or from source:
#   git clone https://github.com/runseal-labs/dsh-tool-runseal && cd dsh-tool-runseal && pnpm install && pnpm build
```

## Mount into dsh

RunSeal takes over `ctx.sandbox` and `ctx.subprocess`. Disable both local providers before loading the plugin:

```yaml
# cordis.patch.yml — replace the built-in local sandbox with RunSeal
- id: sandbox
  disabled: true

- id: subprocess
  disabled: true

- insert:
    - id: sandbox-runseal
      name: 'dsh-tool-runseal'
      config:
        # runseal executable: absolute path, or a name resolved on PATH
        command: 'runseal'
        # network mode: unmanaged (default), disabled, or proxy
        networkMode: 'unmanaged'
        # default per-execution timeout in ms
        timeoutMs: 600000
```

> Both services are single-provider keys. The `dsh-subprocess-local` package remains a dependency only for its public output collector; its process runner is not mounted.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `command` | — (required) | The runseal executable: absolute path or PATH-resolved name. |
| `subprocess` | `true` | Register the RPC-owned subprocess provider. Set false only for sandbox-only integrations; the old Windows kill-range limitation then remains. |
| `args` | `[]` | Extra arguments before the `rpc` subcommand (no shell). |
| `networkMode` | `unmanaged` | Network policy: `unmanaged`, `disabled`, or `proxy`. |
| `maxStdinBytes` | `65536` | Maximum bytes for exported `RunsealEngine.execute()` buffered stdin; wrapper streaming is separate. |
| `timeoutMs` | `600000` | Timeout for confined calls. Ordinary subprocess calls use caller cancellation/deadlines. |
| `autoSetup` | `true` | Wrapper-only legacy integration: request Windows setup and retry a pre-admission refusal once. The subprocess provider requires setup beforehand and does not trigger UAC. |

## How it works

`confine(argv, policy, signal)` returns `Promise<ConfinedArgv>` and rejects pre-aborted requests:

```text
[node, wrapper.cjs, {"command": ..., "args": [...], "argv": [...], "cwd": ..., "policy": ..., "network": ..., "timeoutMs": ...}]
```

The subprocess provider recognizes this plugin's wrapper argv and sends its original command directly to RunSeal, without spawning the wrapper. Workspace write roots are resolved independently of the caller cwd. Plain argv uses `danger-full-access`, preserving the existing unrestricted subprocess semantics.

Each handle owns one RPC connection. `execute` returns an admission receipt; stdout/stderr arrive as events. Input uses `writeExecutionInput` / `closeExecutionInput`. `terminate()` and the caller's abort signal send `cancelExecution` on that same connection, including cancellation queued before receipt. They do not kill the RPC owner. The cancellation acknowledgment is not completion: `done` and `waitForExit()` wait for the terminal `cleanup_complete: true` and RPC owner exit. Missing cleanup proof or transport loss rejects instead of claiming the range is empty. Plugin disposal cancels all live handles and joins their cleanup.

Collected output uses dsh's public bounded-tail/spill collector. Explicit environment entries are forwarded subject to RunSeal's environment policy; keys denied by its scrub policy fail explicitly. With `subprocess: false`, other consumers still launch the standalone wrapper, retaining its existing limitations.

## Known Limitations and Deferred Work

- **Native interactive I/O** — PTY startup, input, resize and interrupt use RunSeal RPC. Control traffic uses a native byte pipe at child fd 7. Input close seals writes without peer EOF; children use message framing and close after their final response. The terminal exposes the actual child PID. Interrupt waits for native Ctrl-C input delivery and returns the Windows console root PID; shell activity remains unknown. Windows SIGTERM cancels and joins the owned console range. SIGKILL of the terminal shell is refused; SIGTSTP and SIGHUP are unsupported. Terminal termination waits for cleanup and outstanding operations.
- **Coverage** — only commands routed through `ctx.subprocess` are managed. Direct `node:child_process` users bypass the provider.
- **Existing abandoned gates** — this change prevents the normal cancellation path from killing the owner. It does not silently reset a gate left by a previous crash or force-kill. Use `runseal repair execution-gates --json` in an elevated Windows shell; repair must prove release. Hard host termination still cannot guarantee graceful cleanup.
- **Platform verification** — native integration was exercised on Windows. macOS/Linux execution and UAC setup have not been exercised by this adaptation.
- **Setup** — complete Windows setup before mounting the subprocess provider. It never performs automatic elevation.
- **Single provider per service** — disable both `sandbox` and `subprocess` as shown above.
- **No fallback chain** — unlike `sandbox-local` (bwrap→Landlock→Seatbelt→ACL), this provider does not chain to other runners; runseal must be usable or the call fails closed.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # protocol, wrapper process, Cordis and dsh subprocess tests
pnpm lint        # oxlint
pnpm build       # tsc + copies wrapper.cjs into lib/
```

For native integration, set `RUNSEAL_TEST_BINARY` to an absolute binary path and run `pnpm test`. The opt-in test uses a temporary workspace and `autoSetup: false`; it checks cwd, streaming stdin, read-only denial, workspace write boundaries, protocol cancellation, AbortSignal, disposal, and successful re-admission afterward. Without this variable, that test is skipped.

Integration targets unmodified dsh master and its 0.2.1-rc.2 interfaces. Build RunSeal with RFC-0022 support. Set `RUNSEAL_TEST_BINARY` to the native binary and `DSH_SOURCE_ROOT` to an unmodified dsh checkout to test the upstream control helper directly. No upstream patches or protocol downgrade are used.

## License

MIT
