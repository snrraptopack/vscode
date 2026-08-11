# Development Setup

CodeScrim uses the VS Code repository toolchain. It does not maintain a second package-manager graph.

## Required Windows toolchain

- Node.js `24.18.0` or a newer `24.x` release, matching the root `.nvmrc` constraint.
- npm `11.x`; the repository preinstall rejects npm `12.x`.
- Python 3 for `node-gyp`.
- Visual Studio Build Tools 2022 with:
  - MSVC v143 x64/x86 tools;
  - a Windows 10 or Windows 11 SDK; and
  - x64/x86 Spectre-mitigated libraries matching the installed v143 toolset.

On this workstation, Node `24.18.0` is installed at:

```text
C:\Users\babyface\AppData\Local\Programs\node-v24.18.0-win-x64
```

The current Visual Studio toolset is `14.43` from Build Tools `17.13`. Its matching Spectre component is installed under this component ID:

```text
Microsoft.VisualStudio.Component.VC.14.43.17.13.x86.x64.Spectre
```

If the native package lifecycle reports missing Spectre libraries on another workstation, install that component from an elevated Visual Studio Installer.

## Install

Run the install from a Developer PowerShell so `node-gyp` sees the existing compiler and Windows SDK:

```powershell
$vsPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
Import-Module (Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'

$nodeDir = Join-Path $env:LOCALAPPDATA 'Programs\node-v24.18.0-win-x64'
$env:Path = "$nodeDir;$env:Path"
npm install
```

Do not run `bun install` at the repository root. The root lockfile, preinstall checks, Electron header setup, native builds, and nested postinstall steps are npm-specific. Bun may be used for isolated utilities that do not modify the dependency graph.

## Compile and run

```powershell
npm run compile
.\scripts\code.bat
```

In the development workbench, open the Command Palette and run `CodeScrim: Open CodeScrim`.

## Validation

```powershell
npm run typecheck-client
npm run eslint -- "src/vs/workbench/contrib/codeScrim/**/*.ts"
npm run stylelint -- --path src/vs/workbench/contrib/codeScrim/browser/media
```

The host-neutral playback tests live at `test/common/codeScrimSession.test.ts`. Run them through the normal VS Code unit runner once client output has been compiled.

## Current workstation state

The complete root and nested dependency lifecycle has been installed with npm. Electron `42.8.0`, its headers, built-in extensions, and the required Windows native bindings are present. A full `npm run compile` succeeds, and the native CodeScrim course and lesson editors have been smoke-tested in an isolated Code OSS development profile.
