@{
  SchemaVersion = 1

  # Exact CPython patch requested for the workstation. The bootstrap uses the
  # official Python Install Manager rather than the legacy standalone installer.
  PythonVersion = '3.14.6'

  # Created below the current user's profile during setup.
  WorkspaceDirectory = 'code'

  Profiles = @{
    core = @(
      'core'
      'cli'
    )
    default = @(
      'core'
      'cli'
      'languages'
      'build'
      'native'
    )
    full = @(
      'core'
      'cli'
      'languages'
      'build'
      'native'
      'containers'
      'devops'
      'dev-apps'
    )
  }

  Groups = @{
    core = @(
      @{
        Id = 'Microsoft.PowerShell'
        Name = 'PowerShell 7'
        Command = 'pwsh'
      }
      @{
        Id = 'Microsoft.WindowsTerminal'
        Name = 'Windows Terminal'
        Command = 'wt'
      }
      @{
        Id = 'Git.Git'
        Name = 'Git for Windows'
        Command = 'git'
      }
      @{
        Id = 'GitHub.cli'
        Name = 'GitHub CLI'
        Command = 'gh'
      }
      @{
        Id = 'Microsoft.VisualStudioCode'
        Name = 'Visual Studio Code'
        Command = 'code'
      }
      @{
        Id = 'M2Team.NanaZip'
        Name = 'NanaZip'
      }
    )

    cli = @(
      @{
        Id = 'BurntSushi.ripgrep.MSVC'
        Name = 'ripgrep'
        Command = 'rg'
      }
      @{
        Id = 'sharkdp.fd'
        Name = 'fd'
        Command = 'fd'
      }
      @{
        Id = 'junegunn.fzf'
        Name = 'fzf'
        Command = 'fzf'
      }
      @{
        Id = 'jqlang.jq'
        Name = 'jq'
        Command = 'jq'
      }
      @{
        Id = 'MikeFarah.yq'
        Name = 'yq'
        Command = 'yq'
      }
      @{
        Id = 'sharkdp.bat'
        Name = 'bat'
        Command = 'bat'
      }
      @{
        Id = 'eza-community.eza'
        Name = 'eza'
        Command = 'eza'
      }
      @{
        Id = 'ajeetdsouza.zoxide'
        Name = 'zoxide'
        Command = 'zoxide'
      }
      @{
        Id = 'Starship.Starship'
        Name = 'Starship prompt'
        Command = 'starship'
      }
      @{
        Id = 'JesseDuffield.lazygit'
        Name = 'lazygit'
        Command = 'lazygit'
      }
      @{
        Id = 'dandavison.delta'
        Name = 'delta'
        Command = 'delta'
      }
    )

    languages = @(
      @{
        Id = '9NQ7512CXL7T'
        Name = 'Python Install Manager'
        Source = 'msstore'
        Command = 'py'
      }
      @{
        Id = 'astral-sh.uv'
        Name = 'uv Python project manager'
        Command = 'uv'
      }
      @{
        Id = 'EclipseAdoptium.Temurin.25.JDK'
        Name = 'Eclipse Temurin JDK 25 LTS'
        Command = 'java'
      }
      @{
        Id = 'Schniz.fnm'
        Name = 'Fast Node Manager'
        Command = 'fnm'
      }
      @{
        Id = 'GoLang.Go'
        Name = 'Go'
        Command = 'go'
      }
      @{
        Id = 'Rustlang.Rustup'
        Name = 'Rustup'
        Command = 'rustup'
      }
      @{
        Id = 'Microsoft.DotNet.SDK.10'
        Name = '.NET 10 SDK (LTS)'
        Command = 'dotnet'
      }
    )

    build = @(
      @{
        Id = 'Kitware.CMake'
        Name = 'CMake'
        Command = 'cmake'
      }
      @{
        Id = 'Ninja-build.Ninja'
        Name = 'Ninja'
        Command = 'ninja'
      }
    )

    native = @(
      @{
        Id = 'Microsoft.VisualStudio.2022.BuildTools'
        Name = 'Visual Studio 2022 C++ Build Tools'
        WingetArguments = @(
          '--override'
          '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        )
      }
      @{
        Id = 'LLVM.LLVM'
        Name = 'LLVM and Clang'
        Command = 'clang'
      }
    )

    containers = @(
      @{
        Id = 'Docker.DockerDesktop'
        Name = 'Docker Desktop'
        Command = 'docker'
      }
    )

    devops = @(
      @{
        Id = 'Kubernetes.kubectl'
        Name = 'kubectl'
        Command = 'kubectl'
      }
      @{
        Id = 'Helm.Helm'
        Name = 'Helm'
        Command = 'helm'
      }
      @{
        Id = 'Hashicorp.Terraform'
        Name = 'Terraform'
        Command = 'terraform'
      }
    )

    'dev-apps' = @(
      @{
        Id = 'Bruno.Bruno'
        Name = 'Bruno API client'
      }
      @{
        Id = 'DBeaver.DBeaver.Community'
        Name = 'DBeaver Community'
      }
      @{
        Id = 'JetBrains.Toolbox'
        Name = 'JetBrains Toolbox'
      }
    )
  }
}
