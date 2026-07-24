# Windows WSL 2 Setup

`setup.ps1` installs, initializes, inspects, and maintains WSL 2 from
PowerShell. It follows Microsoft's modern `wsl.exe --install` flow and keeps
Linux distribution initialization separate so the script never tries to invent
Linux credentials.

This tool is independent of `docker-sandboxes/sbx-manager.ps1`. Docker
Sandboxes runs directly on the Windows Hypervisor Platform and does not require
WSL 2.

## Requirements

- Windows 11, or Windows 10 version 2004/build 19041 or newer
- A 64-bit Intel, AMD, or Arm system
- CPU virtualization enabled in BIOS/UEFI
- Administrator PowerShell for the initial platform installation

WSL 2 relies on the `VirtualMachinePlatform` and
`Microsoft-Windows-Subsystem-Linux` Windows features. Enabling them normally
requires a reboot.

## Quick start

Open PowerShell as Administrator and run:

```powershell
.\setup.ps1 setup
```

The default distribution is `Ubuntu-24.04`. The script installs it without
launching it, sets WSL 2 as the default architecture, and makes the selected
distribution the default. Launch the distribution once afterward to create its
Linux user:

```powershell
wsl.exe --distribution Ubuntu-24.04
```

Use another distribution, omit the distribution, or bypass Microsoft Store:

```powershell
.\setup.ps1 --distro Debian setup
.\setup.ps1 --no-distro setup
.\setup.ps1 --web-download setup
```

If Windows features are enabled during setup, restart Windows and run the same
command again. Setup is idempotent: an installed distribution is preserved, and
an existing WSL 2 distribution is not converted or reinstalled.

## Inspection and maintenance

```powershell
.\setup.ps1 info
.\setup.ps1 doctor
.\setup.ps1 distros --online
.\setup.ps1 update
.\setup.ps1 install-distro Debian
.\setup.ps1 set-default Debian
.\setup.ps1 shutdown
```

Convert an existing WSL 1 distribution only after backing up important data.
Microsoft notes that conversion can take time and may fail for distributions
with large projects:

```powershell
.\setup.ps1 convert Ubuntu
```

Use `--yes` for an intentional non-interactive feature enable or conversion:

```powershell
.\setup.ps1 --yes setup
```

## Validation

The regression test uses a simulated `wsl.exe`; it does not enable Windows
features, install a distribution, reboot, or modify the real WSL configuration:

```powershell
.\tests\setup-test.ps1
```

Official references:

- [Install WSL](https://learn.microsoft.com/windows/wsl/install)
- [Basic WSL commands](https://learn.microsoft.com/windows/wsl/basic-commands)
- [WSL troubleshooting](https://learn.microsoft.com/windows/wsl/troubleshooting)
