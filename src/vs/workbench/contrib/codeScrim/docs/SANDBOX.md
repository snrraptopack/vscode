# CodeScrim Sandbox Foundation

Status: design draft. Sandbox implementation is deferred.

This document records the native VS Code sandbox facilities available to CodeScrim and the initial learner-execution contract. It intentionally does not define course publishing UI or a final course configuration format.

## Product boundary

Passive replay is always available and never executes recorded commands, tasks, debug sessions, servers, or project scripts.

Learner activity has three independent levels:

1. **Watch** replays immutable instructor state without permissions or execution.
2. **Explore** permits edits and learner checkpoints in the disposable CodeScrim workspace. Missing dependencies may reduce project-aware tooling, but editing remains available.
3. **Execute** starts terminals, tasks, debug adapters, servers, or setup commands only inside a prepared sandbox and only after an explicit learner action.

Declining or being unable to prepare a sandbox must never block Watch or Explore. CodeScrim must never silently replace an unavailable sandbox with ordinary host execution.

## Existing VS Code facilities

The fork already contains a cross-platform command sandbox under `src/vs/platform/sandbox`. CodeScrim should adapt this implementation instead of creating OS isolation from scratch.

### Common engine

`TerminalSandboxEngine` in `src/vs/platform/sandbox/common/terminalSandboxEngine.ts` provides:

- runtime discovery and prerequisite checks;
- sandbox configuration generation;
- filesystem read/write/deny lists;
- network policy resolution;
- platform-specific command wrapping;
- temporary policy-file management and cleanup;
- command-aware runtime configuration; and
- file-access checks.

`ITerminalSandboxEngineHost` supplies environment-specific information to that engine:

- effective operating system;
- application and runtime executable paths;
- user home and sandbox temporary storage;
- readable and writable roots;
- sandbox settings;
- Windows MXC filesystem and environment data; and
- dependency detection.

This host seam is the preferred CodeScrim integration point. A CodeScrim host can expose only the disposable learner roots instead of the normal workbench folders.

`ITerminalSandboxService` in `src/vs/platform/sandbox/common/terminalSandboxService.ts` exposes prerequisite checks, command wrapping, resolved network domains, file-access checks, dependency installation, and cleanup-related state.

The existing workbench `TerminalSandboxService` is designed for chat-agent commands. It must not be injected directly into CodeScrim because its policies and writable roots are derived from chat settings and the normal workbench workspace, which may be the instructor project.

### Windows

Windows support uses Microsoft MXC through:

- `WindowsMxcTerminalSandboxRuntime` in `terminalSandboxMxcRuntime.ts`;
- `ISandboxHelperService` and its main-process IPC adapter;
- `@microsoft/mxc-sdk`; and
- the packaged `wxc-exec.exe` launcher.

The existing policy types support:

- read-only, read/write, and denied filesystem paths;
- process or stronger containment modes supported by MXC;
- explicit process command line, working directory, environment, and timeout;
- outbound and local-network policy;
- UI, clipboard, and input-injection restrictions; and
- destroy-on-exit lifecycle configuration.

The current `WindowsMxcTerminalSandboxRuntime` uses process containment, disables clipboard access and input injection, and currently treats outbound network as an all-or-nothing option. CodeScrim must report these actual capabilities rather than claiming per-domain enforcement when the selected Windows provider cannot provide it.

### Linux

Linux support uses `@vscode/sandbox-runtime` with Bubblewrap. VS Code already probes for `bwrap` and `socat`, reports unusable user namespaces, and contains AppArmor remediation handling.

The runtime configuration supports filesystem allow/deny roots and network filtering. Packaged Linux dependencies already list Bubblewrap and socat for agent command sandboxing.

### macOS

macOS uses `@vscode/sandbox-runtime` with the platform Seatbelt/sandbox-exec implementation. The existing engine emits filesystem and network policy and enables PTY use for terminal-oriented execution.

### Terminal integration

CodeScrim already owns a scoped native terminal launch resolver through `ITerminalService.registerShellLaunchConfigResolver`. Today it points learner terminals at disposable storage. A future sandbox integration should replace the learner shell launch configuration with a sandbox-provider launch configuration while leaving recorded replay PTYs read-only.

New, Split, and explicitly opened learner terminals must resolve to the same sandbox session. Existing author terminals remain quarantined from the learner surface and are restored after CodeScrim exits.

## Initial CodeScrim model

### Provider contract

CodeScrim should depend on a provider abstraction rather than MXC, Bubblewrap, or a container directly:

```ts
interface ICodeScrimSandboxProvider {
	probe(request: ICodeScrimSandboxRequest): Promise<ICodeScrimSandboxCapabilities>;
	prepare(request: ICodeScrimSandboxRequest, grants: ICodeScrimSandboxGrants): Promise<ICodeScrimSandboxSession>;
	disposeSession(sessionId: string): Promise<void>;
}
```

This leaves room for local OS isolation, containers, remote runners, and organization-managed environments.

### Capability reporting

A provider must report what it can enforce, including:

- filesystem isolation;
- network isolation and whether it is all-or-nothing or domain-aware;
- process-tree ownership;
- PTY support;
- port isolation or forwarding;
- resource limits; and
- cleanup guarantees.

If a required capability is unavailable, Execute remains disabled. There is no implicit host-terminal fallback.

### Filesystem

- The materialized learner workspace is writable inside the sandbox.
- Course-owned project roots can be materialized as siblings beneath one disposable execution root, allowing navigation between them without exposing unrelated host folders.
- Immutable instructor checkpoints remain outside writable learner state.
- External host folders are unavailable by default.
- Any future external-folder grant is learner-selected, scoped, revocable, and assigned a logical mount name rather than an instructor absolute path.
- Dependencies and writable caches should live in CodeScrim-owned session or course storage instead of global package-manager caches.

### Network and ports

Network and port behavior cannot be reliably inferred from arbitrary command text.

- The selected provider enforces the active network policy.
- Actual blocked outbound attempts should produce runtime facts rather than guessed opening prompts.
- Actual listening sockets should be detected at runtime and connected to VS Code's native port/browser facilities.
- A provider with a private network namespace may map an internal port to any available host port.
- A provider that shares the host network must report that limitation and surface real bind failures; CodeScrim must not assume every CLI supports automatic port rewriting.

### Commands and dependencies

- Recorded instructor terminal activity remains presentation data and is never automatically executed.
- Static files such as lockfiles may provide preparation hints, but inferred commands must not run automatically.
- Learner-entered commands execute inside the prepared sandbox and all descendants remain owned by that session.
- Future setup commands follow the same sandbox, consent, observation, and cleanup rules as manually entered commands.
- Host secrets and arbitrary environment variables are not inherited automatically.

### Runtime events

The sandbox should report observed facts such as process start/exit, blocked filesystem access, blocked network access, opened ports, port conflicts, missing executables, and resource-limit termination. UI should respond to those facts instead of predicting command behavior.

### Lifecycle

The initial lifecycle is:

```text
replay/explore available
    -> learner requests execution
    -> provider capability check
    -> required grants, if any
    -> preparing
    -> ready
    -> terminal/task/debug/server execution
    -> terminate complete process tree
    -> remove disposable execution state
```

Learner checkpoints are separate from process state and may remain available after the sandbox is destroyed.

## Deferred questions

- Final course execution/configuration schema and UI.
- Trusted or remembered grants.
- Dependency-cache sharing and invalidation.
- Exact external-folder consent flow.
- Port presentation and browser integration.
- CPU, memory, disk, process-count, and wall-time defaults.
- Container and remote-runner selection.
- Secret injection and organization policy.
- Sandboxed tasks and debug adapters.

These questions should be resolved when sandbox implementation resumes. Until then, the current learner terminal remains explicitly documented as an ordinary local execution bridge rather than a security boundary.
