# Upstream Integration and Sync Policy

## Objective

CodeScrim remains a thin, explicit fork of VS Code. Normal upstream synchronization should take hours or days, not weeks of rediscovering product changes.

## Rules

1. Prefer new files under `src/vs/workbench/contrib/codeScrim`.
2. Consume existing service interfaces before changing their implementations.
3. Add a missing capability to the component that owns it through the narrowest typed API.
4. Never access another component through its private storage keys or `IInstantiationService` service lookup.
5. Keep upstream hooks in isolated commits with `codescrim-api-hook` in the subject.
6. Do not edit generated files.
7. Do not copy upstream implementations into the CodeScrim directory.
8. Record every modified upstream-owned file in the ledger below.
9. Add or update a focused test for every new upstream API.
10. Merge `upstream/main` at least weekly while active development continues.

## Current integration ledger

| Upstream-owned file | Change | Reason | Expected conflict risk |
|---|---|---|---|
| `src/vs/workbench/workbench.desktop.main.ts` | One contribution import | Load native CodeScrim desktop workbench code | Low |

All other initial files are new CodeScrim-owned files.

Milestone 1 added only CodeScrim-owned files and did not widen the upstream integration surface.

## Planned integration points

These are possibilities, not authorization to modify them:

| Area | Existing API first | Modification threshold |
|---|---|---|
| Editor/model | `IModelService`, `IEditorService`, `ITextFileService` | Only if replay-origin metadata cannot be carried safely |
| Files | `IFileService` | Only if atomic overlay materialization requires a missing operation |
| Terminal | `ITerminalService`, `ITerminalInstance` events | Only if output causation or snapshot state is unavailable |
| Debug | `IDebugService` and debug model events | Only if a required state transition is not observable |
| Browser | `IBrowserViewWorkbenchService`, `IBrowserViewCDPService` | Only if lesson-scoped context or required CDP state is inaccessible |
| Layout | `IEditorGroupsService`, `IWorkbenchLayoutService` | Modify `EditorPart` only after an approved architecture decision |
| Audio | Existing Electron/media capabilities | Add a platform service only for reliable cross-platform capture |

## Sync procedure

The repository already has `upstream` pointing to `microsoft/vscode`.

1. Ensure CodeScrim changes are committed and the worktree is clean.
2. Fetch `upstream`.
3. Merge `upstream/main` into the long-lived CodeScrim branch.
4. Resolve the explicit integration ledger first.
5. Review upstream changes to every internal service CodeScrim consumes.
6. Run format/state tests, targeted workbench tests, layer validation when applicable, and the native smoke flow.
7. Update this ledger if any upstream-owned file changed.
8. Commit the merge without mixing unrelated product work.

Enable Git's recorded conflict resolution for recurring import conflicts:

```powershell
git config rerere.enabled true
```

## Upstream review checklist

- Did an imported service interface change?
- Did an event's ordering or lifetime change?
- Did browser-view IPC or CDP behavior change?
- Did editor serialization or group restoration change?
- Did terminal process/input ownership change?
- Did debug-session lifecycle change?
- Did security, workspace trust, or permission behavior change?
- Does the CodeScrim contribution still satisfy layer rules?
- Is a previously necessary fork hook now available upstream and removable?
