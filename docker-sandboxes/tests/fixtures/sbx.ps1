Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $env:SBX_TEST_LOG) {
  [Console]::Error.WriteLine('SBX_TEST_LOG is required')
  exit 90
}
if (-not $env:SBX_TEST_POLICY_STATE) {
  [Console]::Error.WriteLine('SBX_TEST_POLICY_STATE is required')
  exit 90
}
if (-not $env:SBX_TEST_AUTH_STATE) {
  [Console]::Error.WriteLine('SBX_TEST_AUTH_STATE is required')
  exit 90
}

Add-Content -LiteralPath $env:SBX_TEST_LOG -Value ($args -join ' ')
$command = if ($args.Count -gt 0) { $args[0] } else { '' }

function Assert-KitLineEndings {
  param([string] $KitPath)

  foreach ($file in @(
    Get-ChildItem -LiteralPath $KitPath -File -Recurse -Force
  )) {
    if ([IO.File]::ReadAllBytes($file.FullName) -contains [byte] 13) {
      Write-Error -ErrorAction Continue (
        "kit contains a carriage return: $($file.FullName)"
      )
      exit 93
    }
  }
  Add-Content -LiteralPath $env:SBX_TEST_LOG -Value 'kit-line-endings lf'
  $filesPath = Join-Path $KitPath 'files'
  $filesState = if (Test-Path -LiteralPath $filesPath -PathType Container) {
    'present'
  } else {
    'absent'
  }
  Add-Content -LiteralPath $env:SBX_TEST_LOG -Value (
    "kit-static-files $filesState"
  )
}

switch ($command) {
  'version' {
    Write-Output 'sbx version: test'
  }
  'policy' {
    $subcommand = if ($args.Count -gt 1) { $args[1] } else { '' }
    switch ($subcommand) {
      'init' {
        if (Test-Path -LiteralPath $env:SBX_TEST_POLICY_STATE) {
          Write-Error -ErrorAction Continue (
            'ERROR: global network policy is already initialized; use "sbx policy reset" first to change it'
          )
          exit 1
        }
        Set-Content -LiteralPath $env:SBX_TEST_POLICY_STATE -Value $args[2]
        Write-Output "Network policy set to `"$($args[2])`"."
      }
      'reset' {
        Remove-Item -LiteralPath $env:SBX_TEST_POLICY_STATE `
          -Force -ErrorAction SilentlyContinue
      }
      'inspect' {
        Write-Error -ErrorAction Continue 'unexpected interactive policy probe'
        exit 97
      }
      'check' {
        $target = if ($args.Count -gt 3) { $args[3] } else { 'unknown' }
        Write-Output "Allowed: $target"
      }
      'ls' {
        if ($args -contains '--json') {
          $preset = (
            Get-Content -LiteralPath $env:SBX_TEST_POLICY_STATE -Raw
          ).Trim()
          $ruleId = switch ($preset) {
            'allow-all' { 'default-allow-all' }
            'deny-all' { 'default-deny-all' }
            'balanced' { 'balanced-registry-allow' }
            default { 'custom-rule' }
          }
          Write-Output (
            '{"rules":[{"id":"' + $ruleId + '","origin":"local"}]}'
          )
        } else {
          Write-Output 'local all test-policy'
        }
      }
      default {
        Write-Error -ErrorAction Continue (
          "unsupported policy command: $subcommand"
        )
        exit 98
      }
    }
  }
  'diagnose' {
    if (Test-Path -LiteralPath $env:SBX_TEST_AUTH_STATE) {
      $authMessage = 'authenticated'
      $authStatus = 'pass'
    } else {
      $authMessage = 'not authenticated'
      $authStatus = 'warn'
    }
    Write-Output @"
{
  "checks": [
    {
      "name": "Authentication",
      "status": "$authStatus",
      "message": "$authMessage"
    }
  ]
}
"@
  }
  'login' {
    New-Item -ItemType File -Path $env:SBX_TEST_AUTH_STATE -Force | Out-Null
    Write-Output 'Login complete.'
  }
  'daemon' {
    $subcommand = if ($args.Count -gt 1) { $args[1] } else { '' }
    switch ($subcommand) {
      'status' { Write-Output 'Status: running' }
      'start' { Write-Output 'daemon started' }
      'stop' { Write-Output 'daemon stopped' }
      default {
        Write-Error -ErrorAction Continue (
          "unsupported daemon command: $subcommand"
        )
        exit 96
      }
    }
  }
  'template' {
    Write-Output 'no cached templates'
  }
  'ls' {
    if ($args.Count -gt 1 -and $args[1] -eq '-q') {
      if ($env:SBX_TEST_SANDBOX_NAMES) {
        Write-Output $env:SBX_TEST_SANDBOX_NAMES
      }
    } else {
      Write-Output 'no sandboxes'
    }
  }
  'exec' {
    if ($args.Count -gt 1 -and $args[1] -eq '-u') {
      exit 0
    }
    if ($env:SBX_TEST_SHELL_KIT_CURRENT -eq '0') {
      exit 1
    }
  }
  'cp' {
    Write-Output 'files copied'
  }
  'kit' {
    $subcommand = if ($args.Count -gt 1) { $args[1] } else { '' }
    if ($subcommand -ne 'add' -or $args.Count -lt 4) {
      Write-Error -ErrorAction Continue "unsupported kit command: $subcommand"
      exit 95
    }
    Assert-KitLineEndings $args[3]
    Write-Output 'kit added'
  }
  'run' {
    $kitIndex = [Array]::IndexOf([object[]] $args, '--kit')
    if ($kitIndex -ge 0) {
      if ($kitIndex + 1 -ge $args.Count) {
        Write-Error -ErrorAction Continue '--kit is missing its path'
        exit 94
      }
      $kitPath = $args[$kitIndex + 1]
      Assert-KitLineEndings $kitPath
    }
    Write-Output 'sandbox started'
  }
  default {
    Write-Error -ErrorAction Continue "unsupported sbx command: $command"
    exit 99
  }
}
