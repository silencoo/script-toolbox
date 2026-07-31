# Opinionated Windows developer setup

`setup.ps1` bootstraps a repeatable development workstation on Windows 10 or
Windows 11. It uses WinGet for applications, the official Python Install
Manager for CPython, `fnm` for Node.js, and `rustup` for Rust. The companion
`wsl.ps1` owns WSL 2 initialization, inspection, distribution management, and
maintenance.

The script is intentionally rerunnable: an installed WinGet package is skipped,
managed PowerShell profile blocks are replaced in place, and exact runtime
checks happen before installation.

## What the profiles install

| Profile | Contents |
| --- | --- |
| `core` | PowerShell 7, Windows Terminal, Git, GitHub CLI, VS Code, NanaZip, and modern command-line tools |
| `default` | Everything in `core`, plus Python 3.14.6, uv, Temurin JDK 25 LTS, Node.js LTS, Go, Rust, .NET 10 LTS, CMake, Ninja, Visual Studio C++ Build Tools, and LLVM |
| `full` | Everything in `default`, plus Docker Desktop, kubectl, Helm, Terraform, Bruno, DBeaver, and JetBrains Toolbox |

The default profile deliberately pins Python to `3.14.6`. Java follows the
Temurin `25` LTS package line so rerunning WinGet upgrades can receive security
patches without changing the Java feature version. Node follows the latest LTS
release through `fnm`; Rust follows the stable toolchain.

The native toolchain is deliberately part of `default` because Rust's standard
Windows MSVC target and many Python extension builds require it. Choose `core`
when a smaller editor-and-CLI-only machine is preferred.

Java projects should commit and use Maven Wrapper (`mvnw`) or Gradle Wrapper
(`gradlew`) instead of relying on a workstation-wide build-tool version.

The package catalog and profiles are plain PowerShell data in
[`packages.psd1`](packages.psd1). Edit that file to add, remove, or regroup
packages without changing the installer logic.

Everyday applications—including PowerToys, media utilities, backup tools, and
system inspection software—belong to
[`workstation-utils`](../workstation-utils/). NanaZip is the deliberate shared
exception: a graphical archive handler is useful in both a general workstation
and this GUI-oriented Windows development environment. Both installers skip it
when already installed. The utility catalog's alternative `power-archive`
profile still requires manually removing NanaZip first.

## Quick start

Open PowerShell and inspect the plan before applying it:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1 plan -Profile default
.\setup.ps1 setup -Profile default
```

The setup shows the full package list and asks once before it starts. WSL may
ask separately before enabling Windows features or converting an existing WSL
1 distribution. For unattended setup:

```powershell
.\setup.ps1 setup -Profile default -Yes
```

With `-IncludeWSL`, `-Yes` also accepts the WSL feature-enable and WSL 1
conversion prompts. Back up important distribution data before using that
combination on a machine with WSL 1.

Preview every command without changing the machine:

```powershell
.\setup.ps1 setup -Profile full -DryRun
```

Run the health check from a new PowerShell 7 terminal:

```powershell
.\setup.ps1 doctor -Profile default
```

## Optional Windows features

WSL and the Win32 long-path registry setting are explicit because their first
setup can require an Administrator terminal, and WSL can require a reboot:

```powershell
.\setup.ps1 setup -Profile full -IncludeWSL -EnableLongPaths
```

`-IncludeWSL` runs the bundled WSL lifecycle manager and installs
`Ubuntu-24.04` without launching it. Select another distribution, use the
direct web download path, or skip the WSL update:

```powershell
.\setup.ps1 setup -IncludeWSL -WSLDistro Debian
.\setup.ps1 setup -IncludeWSL -WSLWebDownload
.\setup.ps1 setup -IncludeWSL -WSLSkipUpdate
```

WSL requires Windows 11 or Windows 10 version 2004/build 19041 or newer, a
64-bit Intel, AMD, or Arm system, and CPU virtualization enabled in BIOS/UEFI.
The initial platform installation enables `VirtualMachinePlatform` and
`Microsoft-Windows-Subsystem-Linux`, which normally requires elevation and may
require a reboot. Rerun the same command after restarting.

After installation, launch the distribution once to create its Linux user:

```powershell
wsl.exe --distribution Ubuntu-24.04
```

Docker Desktop is included only in the `full` profile.

### WSL inspection and maintenance

The merged `wsl.ps1` command handles operations that are independent of a full
workstation setup:

```powershell
.\wsl.ps1 info
.\wsl.ps1 doctor
.\wsl.ps1 distros --online
.\wsl.ps1 update
.\wsl.ps1 install-distro Debian
.\wsl.ps1 set-default Debian
.\wsl.ps1 shutdown
```

Initialize only WSL, select a different distribution, omit distribution
installation, or bypass Microsoft Store:

```powershell
.\wsl.ps1 setup
.\wsl.ps1 --distro Debian setup
.\wsl.ps1 --no-distro setup
.\wsl.ps1 --web-download setup
```

The WSL setup is idempotent: an installed distribution is preserved, and an
existing WSL 2 distribution is not converted or reinstalled. Converting WSL 1
is an explicit operation because it can take time and important data should be
backed up first:

```powershell
.\wsl.ps1 convert Ubuntu
```

Use `--yes` for intentional non-interactive feature enable or conversion:

```powershell
.\wsl.ps1 --yes setup
```

## Configuration performed after package installation

Unless disabled, setup:

- creates `%USERPROFILE%\code`;
- installs exact CPython 3.14.6 through `py install`;
- installs the latest Node.js LTS through `fnm`, makes it the default, and
  enables Corepack;
- selects Rust stable and installs `rustfmt` and `clippy`;
- initializes WSL 2 and the selected distribution when `-IncludeWSL` is used;
- configures Git for `main`, fast-forward-only pulls, pruning, LF commits,
  Windows long Git paths, Git Credential Manager, and `delta`;
- adds a clearly marked block to both Windows PowerShell and PowerShell 7
  profiles for `fnm`, `zoxide`, Starship, PSReadLine predictions, `ll`, and
  `lt`.

The script never changes Git `user.name` or `user.email`. Existing PowerShell
profiles are preserved, and the first edit creates a sibling
`.windows-dev-setup.bak` backup.

Disable either opinionated configuration layer when desired:

```powershell
.\setup.ps1 setup -NoGitConfig -NoShellConfig
```

## Commands and switches

```text
setup.ps1 [setup|plan|list|doctor] [options]

  -Profile core|default|full
  -ConfigFile PATH
  -Yes
  -DryRun
  -IncludeWSL
  -WSLDistro NAME
  -WSLWebDownload
  -WSLSkipUpdate
  -EnableLongPaths
  -NoGitConfig
  -NoShellConfig
  -FailFast
```

By default, invoking `setup.ps1` with no command only prints the `default`
plan. The bootstrap does not uninstall software. To update installed WinGet
packages later, use:

```powershell
winget upgrade --all --accept-package-agreements --accept-source-agreements
.\setup.ps1 setup -Profile default -Yes
```

The second command refreshes the Node.js LTS and Rust stable toolchains while
preserving the exact Python pin. Change `PythonVersion` in `packages.psd1` when
the workstation's CPython pin should advance.

Python environments should be project-local:

```powershell
cd ~\code
uv init example
cd example
uv python pin 3.14
uv sync
```

For Node projects, commit `.node-version` or `.nvmrc`; the managed PowerShell
profile configures `fnm --use-on-cd` to switch automatically.

## Future roadmap

The existing profiles cover most of the machine-wide foundation for a
general-purpose Windows development workstation. Future work should focus on
editor integration, code quality, security, and reproducible project
environments rather than adding every available runtime or application to the
host.

These are ideas for future releases; they are not installed by the current
script.

### VS Code profiles and extensions

Add an `extensions.psd1` catalog and install small, purpose-specific VS Code
profiles instead of enabling every extension in one environment:

- `base`: PowerShell, YAML, TOML, Docker, and EditorConfig;
- `python`: Python, Ruff, and Pylance;
- `java`: the Java Extension Pack;
- `web`: ESLint and Prettier;
- `go`: the Go extension;
- `rust`: rust-analyzer;
- `native`: clangd and CMake Tools;
- `remote`: WSL and Dev Containers.

VS Code supports creating profiles and installing extensions into a selected
profile through its command-line interface. Keep the base profile lean and let
users select only the language profiles they need.

Reference: [VS Code command-line interface](https://code.visualstudio.com/docs/configure/command-line)

### Baseline quality and security tools

Consider adding the following tools to `default`, after validating their
WinGet packages and unattended installation behavior:

- `pre-commit` for consistent repository hooks;
- Gitleaks for committed-secret detection;
- Trivy for dependency, container, and infrastructure-as-code scanning;
- ShellCheck for shell-script analysis;
- actionlint for GitHub Actions workflow validation;
- SOPS with age for encrypted configuration and secrets;
- `just` as a small cross-language task runner.

Project configuration must still pin rules and tool versions where
reproducibility matters. Installing a command globally should not replace
declaring it in the repository.

### Opt-in language stacks

Add stack selection independently of the broad `core`, `default`, and `full`
machine profiles. Possible stack groups are:

- Python: Ruff, pytest, and basedpyright;
- Node.js: pnpm through Corepack, with ESLint, Prettier, and TypeScript kept
  project-local;
- Java: editor support only, continuing to use Maven or Gradle wrappers from
  each repository;
- Go: `gopls`, Delve, and staticcheck;
- Rust: cargo-nextest, cargo-audit, cargo-edit, and optionally sccache;
- C/C++: clangd and CMake Tools, with either vcpkg or Conan selected per
  project;
- Kubernetes: kind and k9s;
- cloud providers: AWS CLI, Azure CLI, or Google Cloud CLI only when explicitly
  selected.

Avoid globally installing all cloud CLIs, databases, Java build systems, npm
utilities, or both C/C++ package managers. Local databases are generally better
run through containers, while a client such as DBeaver can remain a workstation
tool.

### Reproducible project environments

Encourage repositories to include `.devcontainer/devcontainer.json` when a
containerized environment is appropriate. Dev Containers can pin the project's
runtime and tooling without continually expanding the host installation.

Reference: [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)

Possible future templates could cover Python, Node.js, Java, Go, Rust, and
polyglot Docker Compose projects. Prebuilt images should pin important
toolchain versions and be updated through CI.

### Windows-specific improvements

- Prefer Windows 11 for new workstations. General Windows 10 version 22H2
  support ended on October 14, 2025; retain Windows 10 compatibility for
  Extended Security Updates, LTSC, and legacy environments.
- Offer Dev Drive as a documented or guided opt-in operation, never as an
  automatic formatting step. Creating one requires supported Windows 11,
  administrator access, and at least 50 GB of free space.
- Keep WSL-hosted repositories inside the Linux filesystem for best
  performance. Use Dev Drive for Windows-native source trees, package caches,
  and build output.
- Offer a Nerd Font such as Cascadia Code NF for Starship prompts and terminal
  icons.
- Detect SSH or GPG signing configuration and provide guidance, but never
  generate or replace a developer identity automatically.

References:

- [Windows 10 end of support](https://learn.microsoft.com/en-gb/lifecycle/announcements/windows-10-end-of-support)
- [Set up a Dev Drive on Windows 11](https://learn.microsoft.com/en-us/windows/dev-drive/)
- [Developing in WSL with VS Code](https://code.visualstudio.com/docs/remote/wsl)

### Installer evolution

A future layout could separate the machine catalog from editor and stack
configuration:

```text
windows-dev-setup/
├── setup.ps1
├── wsl.ps1
├── packages.psd1
├── extensions.psd1
└── stacks/
    ├── python.psd1
    ├── web.psd1
    ├── java.psd1
    ├── go.psd1
    ├── rust.psd1
    └── native.psd1
```

Potential command-line improvements:

```powershell
.\setup.ps1 install -Profile default -Stacks python,web
.\setup.ps1 install -Profile full -Stacks java,containers
.\setup.ps1 doctor -AsJson
.\setup.ps1 update
.\setup.ps1 export-lock
```

The stack list, update command, machine-readable doctor output, and catalog
snapshot are proposed interfaces only. Their eventual implementation should
remain rerunnable, preserve user configuration, support `-DryRun`, and avoid
destructive changes by default.

## Validation

Parse and exercise the non-mutating plan commands on Windows:

```powershell
.\tests\windows-dev-setup-test.ps1
.\tests\wsl-test.ps1
```

The WSL regression test uses a simulated `wsl.exe`; it does not enable Windows
features, install a distribution, reboot, or modify the real WSL
configuration.

Official WSL references:

- [Install WSL](https://learn.microsoft.com/windows/wsl/install)
- [Basic WSL commands](https://learn.microsoft.com/windows/wsl/basic-commands)
- [WSL troubleshooting](https://learn.microsoft.com/windows/wsl/troubleshooting)
