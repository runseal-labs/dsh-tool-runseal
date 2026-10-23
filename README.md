# dsh-tool-runseal

English | [中文](README.zh.md)

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: replaces the built-in sandbox with [RunSeal](https://github.com/runseal-labs/runseal) for filesystem policies, process cleanup, structured audit events and environment-credential scrubbing. Optional network controls depend on the selected mode and platform backend. Execution timeout and output caps are available; this plugin does not provide CPU or memory quotas.

Fully out-of-tree: depends only on published dsh base packages. Registers both `ctx.sandbox` and `ctx.subprocess`. Confined calls retain their file policy; ordinary subprocess calls run through RunSeal with explicit `danger-full-access`.

## Compatibility

Adapted against unmodified dsh `master@687f282e8625c6b8d11ff58211a90524be2e4317` (published packages `0.2.1-rc.2`). Plugin **0.2.5** pins **RunSeal 0.2.2**. Plugin patch releases are versioned independently; no dsh source changes are required.

## What it provides

| Item | Description |
|---|---|
| `ctx.sandbox` provider | Subclasses `SandboxProvider`; `confine()` wraps argv through a thin Node wrapper that runs the command under `runseal rpc` |
| `ctx.subprocess` provider | Owns RPC execution, streaming input, collected output/spill files, cancellation and cleanup completion |
| Policy mapping | dsh `read-only` / `workspace-write` → corresponding RunSeal sandbox levels; preserve the caller cwd separately from writable workspace roots |
| Network modes | `unmanaged` (default: no network isolation), `disabled`, `proxy` (authenticated managed proxy; not an implemented per-route enterprise allowlist) |
| Streaming output | `execution.stdout` / `execution.stderr` RPC events forwarded to the consumer's stdio; exit code propagates |
| Fail closed | Missing setup or an unavailable backend rejects; confined subprocess failures expose `SANDBOX_UNAVAILABLE`, while the standalone wrapper prints `runseal: <reason>` and exits nonzero. No silent passthrough. |
| Audit | Execution lifecycle events and a JSONL record, ending in `execution.finished` or `execution.failed` |

## Install

Install the bundle with `dsh plugin --profile web add dsh-tool-runseal@0.2.5`, then restart dsh and open Plugins → RunSeal. Plugin 0.2.5 downloads **RunSeal 0.2.2** during npm's `postinstall`, selects the current OS and architecture, verifies the release archive's SHA-256 checksum, and installs the executable and Windows helpers together inside the package.

Supported downloads: Windows, macOS and Linux on x64 or arm64. Downloads use a fixed release URL, never `latest`. Binary availability does not imply that every OS supports restricted policies. Network access to GitHub releases and enabled npm lifecycle scripts are required; installation fails with a diagnostic on download/checksum errors. For package managers that block scripts, allow this package's install script or run `npm rebuild dsh-tool-runseal` with scripts enabled. No runtime download or silent unrestricted fallback occurs.

Leave `command` empty to use the downloaded executable. A configured `command` takes precedence over `RUNSEAL_BINARY`, which takes precedence over the downloaded binary. To install offline or use a custom executable, set `RUNSEAL_SKIP_DOWNLOAD=1` during installation and configure `command`; alternatively set `RUNSEAL_BINARY` to the custom executable during installation and at runtime. An explicit PATH name such as `runseal` is preserved. Old profile overrides remain in effect until cleared. Prebuilt artifacts are published on the [RunSeal releases](https://github.com/runseal-labs/runseal/releases) page.

On Windows, confined modes (`read-only`, `workspace-write`) require the sandbox setup once:

```sh
runseal setup windows-sandbox --cwd <workspace> --elevate
```

Install the built package into the Web profile and add dsh-tool-runseal to dsh.profile.bundles in the profile package.json:

```sh
pnpm build
pnpm pack
cd ~/.dsh/profiles/web
pnpm add /absolute/path/dsh-tool-runseal-0.2.5.tgz
```

The bundle disables the upstream sandbox and subprocess providers and registers sandbox-runseal. It uses the automatically downloaded binary by default. To override it, add this to the profile cordis.patch.yml:

```yaml
- id: sandbox-runseal
  config:
    command: 'C:/path/to/runseal.exe'
```

Start dsh web normally and open Plugins → RunSeal to edit the executable, network mode, timeout, input limit, extra arguments and wrapper auto-setup. Saving uses dsh's native configuration service to persist the profile. New commands take a configuration snapshot; running commands keep their original settings. Remove any manual insertion or command-line overlay for the same component to avoid duplicate mounting or blocked UI writes.

## Installation troubleshooting

If the plugin page says “This package declares no bundle”, check the version in the **installation log**, not just the preview card. A reported macOS desktop installation previewed 0.2.3 but `pnpm add dsh-tool-runseal` actually selected `^0.1.1`, which has no bundle declaration. Enter `dsh-tool-runseal@0.2.3` as the install target. If pnpm blocks the recent release, add only `dsh-tool-runseal@0.2.3` to the existing `minimumReleaseAgeExclude` list in that profile's `pnpm-workspace.yaml`; keep the general age policy enabled. Desktop profiles usually live at `~/.dsh/profiles/desktop`, Web profiles at `~/.dsh/profiles/web`. Preserve existing settings and allow this package's postinstall script. This identifies the old-package mismatch; it does not establish why that Mac selected the old version or by itself validate macOS sandbox execution; the subsequent mba native results are recorded separately.

## Configuration

Choose read-only, workspace-write or full access in dsh’s session access mode selector. The plugin inherits that policy; there is no separate sandbox enable switch.

| Field | Default | Meaning |
|---|---|---|
| `command` | empty (automatic) | Custom executable: absolute path or PATH name. Empty uses `RUNSEAL_BINARY` or the downloaded pinned binary. |
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

Child executable names are resolved against the execution's effective PATH and working directory before admission; arguments are preserved without shell expansion. The standalone wrapper uses the same resolver. Shell built-ins still require an explicit shell. Confined runner/configuration/admission failures use dsh's `SANDBOX_UNAVAILABLE`; a missing child retains `SubprocessExecutableNotFoundError`, and cancellation, deadlines and unverified cleanup are not converted into permission denials. Child stderr denial signatures are a diagnostic heuristic, not independent proof of a policy violation.

`enforcement: full` describes dsh's promised file effects for an admitted execution, including backend-defined temporary writes. It does not mean network isolation, read containment, a stable backend support label, or protection against every sandbox escape. RunSeal must reject unsupported enforcement rather than downgrade it; macOS `experimental` is a separate maturity label. The claim is conditional on successful admission, not a capability probe performed by `confine()`.

The subprocess provider reuses RPC connections for its lifetime, separated by executable, arguments and transport environment. Executions retain independent IDs, streams, cancellation and terminal cleanup proof. `done` and `waitForExit()` require `cleanup_complete: true`, without waiting for the shared owner to exit. Transport loss fails affected executions without replay; later calls can create a new connection. Connections with missing cleanup proof stop accepting new executions and close after their remaining executions finish. Provider disposal cancels and joins all executions, then closes connections and joins owners. Windows source builds reuse a non-elevated ACL refresh worker while preparing transient execution roots independently; protocol shutdown joins that worker. These source changes require rebuilding the plugin and native binaries; published 0.2.5 / 0.2.2 packages retain their previous behavior.

Collected output uses dsh's public bounded-tail/spill collector. Explicit environment entries are forwarded subject to RunSeal's environment policy; keys denied by its scrub policy fail explicitly. With `subprocess: false`, other consumers still launch the standalone wrapper, retaining its existing limitations.

## Known Limitations and Deferred Work

- **Native interactive I/O** — PTY startup, input, resize and interrupt use RunSeal RPC. Control traffic uses a native byte pipe at child fd 7. Input close seals writes without peer EOF; children use message framing and close after their final response. The terminal exposes the actual child PID. On Windows, interrupt waits for native Ctrl-C input delivery and returns the console root PID. On macOS it confirms native SIGINT delivery to the observed foreground process group; raw ETX remains terminal input. Foreground inspection without a current native observation and shell activity remain unknown. Windows SIGTERM cancels and joins the owned console range. SIGKILL of the terminal shell is refused; SIGTSTP and SIGHUP are unsupported. Terminal termination waits for cleanup and outstanding operations.
- **Coverage** — only commands routed through `ctx.subprocess` are managed. Direct `node:child_process` users bypass the provider.
- **Existing abandoned Windows gates** — this change prevents the normal cancellation path from killing the owner. It does not silently reset a gate left by a previous crash or force-kill. Use `runseal repair execution-gates --json` in an elevated Windows shell; repair must prove release. On Windows, the RPC owner survives ordinary host termination and cleans up on pipe disconnection. Killing the owner itself or power loss can still leave protected records.
- **Platform verification** — native integration has passed on Windows and macOS arm64. On mba, restricted file-write boundaries, cancellation and retry, automatic cleanup after killing the dsh host, and execution after restart were verified working. The macOS backend still reports experimental status; that support label is distinct from these passing acceptance results. Linux execution, macOS UI interaction and Windows UAC setup have not been validated.
- **Setup** — complete Windows setup before mounting the subprocess provider. It never performs automatic elevation.
- **Desktop PTC startup** — Electron Node workers retain the host's `ELECTRON_RUN_AS_NODE=1` startup selector on the control-channel path unless the caller explicitly removes it. Windows setup can deny the sandbox identity access to a user-profile-installed desktop executable. This plugin does not loosen those ACLs or silently replace that executable; configure dsh's existing PTC `launch` option with an accessible standalone Node runtime and bootstrap assets. Passing Web/Node acceptance does not establish that a desktop Electron worker can launch under the same policy.
- **Single provider per service** — the bundle disables both `sandbox` and `subprocess`.
- **No fallback chain** — unlike `sandbox-local` (bwrap→Landlock→Seatbelt→ACL), this provider does not chain to other runners; runseal must be usable or the call fails closed.

## Verification

For this Windows desktop deployment, an accessible standalone Node and an unchanged copy of the installed PTC bootstrap resolve that startup restriction. Run `scripts/prepare-desktop-ptc.mjs` using the installed desktop executable in Electron Node mode (`ELECTRON_RUN_AS_NODE=1`), passing the absolute standalone Node path and optionally an output directory. The script validates the Node version, copies both official bootstrap variants from the installed ASAR, verifies SHA-256 and emits a manifest plus a separate `cordis.patch.yml` snippet. It does not install Node, edit profiles or change ACLs. Merge the generated `ptc-runtime` override into the desktop profile and restart dsh. The generated configuration uses `per-call`; persistent mode must select the matching persistent bootstrap. Regenerate assets after upgrading dsh to keep the host and bootstrap aligned.

Source acceptance for 0.2.5 with the original desktop host passed restricted PTC bindings, a 294,912-byte UTF-8 round trip, cancellation/retry and host-loss cleanup including a descendant process, followed by execution after restart. `INPUT_BACKPRESSURE` is retried only for a chunk the protocol guarantees was not accepted; acknowledged chunks are not replayed. These fixes are included in plugin 0.2.5; the recorded source acceptance used a local preview, not npm 0.2.4.

RunSeal 0.2.2 adds macOS PTY/control interaction and durable owner recovery; plugin 0.2.4 pins that release. Source acceptance on macOS 15.7.8 arm64 covered cancellation and restart, host-loss cleanup and RPC-owner hard-kill recovery. Fresh npm 0.2.4 installation on mba also passed restricted PTY/PTC cancellation and restart, host-loss cleanup and execution after host restart; see the published-package acceptance record.

Windows Web page acceptance also passed with npm 0.2.4 and automatically downloaded RunSeal 0.2.2: restricted PTY/PTC interaction, page cancellation and retry, cleanup after hard-killing only the dsh host, and execution after restart. An outside-workspace write was denied. This round did not validate keyboard Ctrl-C or first-time UAC setup.

The 0.2.5 adapter changes additionally passed native PowerShell on Windows and bash on mba: execution, ordinary failure classification, read-only denial, cancellation and retry. The opt-in Cordis driver is `tests/native-shell-driver.mjs`; mount it with the base bundle and built plugin in an isolated profile, and set `SHELL_TEST_ROOT` to its acceptance workspace. These source results do not imply that npm 0.2.4 contains the fixes.

See [acceptance records](https://github.com/runseal-labs/dsh-tool-runseal/blob/main/docs/acceptance.md) for native tests, Web profile checks, audit evidence and platform limits.

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
