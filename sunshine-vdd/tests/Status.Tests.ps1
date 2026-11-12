$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot '../monitor/Status.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot '../boot-recovery/BootRecovery.Core.psm1') -Force
$dir=Join-Path ([IO.Path]::GetTempPath()) ('sunshine-status-tests-'+[guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $dir)
try {
    $path=Join-Path $dir 'status.json'
    foreach($i in 1..20){Write-DiagnosticJson $path @{At=[datetime]::UtcNow.ToString('o');Sequence=$i};$actual=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;if($actual.Sequence -ne $i){throw 'Incomplete atomic status'}}
    if(@(Get-ChildItem -LiteralPath $dir -Filter '*.tmp').Count){throw 'Temporary records leaked'}
    $plan=Get-BootRecoveryInstallPlan
    if(!$plan.Preview -or $plan.ChangesSunshineStartup -or $plan.ChangesLiveTopology -or $plan.StopsSunshine){throw 'Default preview must not promise unapproved startup changes'}
    $coordinated=Get-BootRecoveryInstallPlan -StartupCoordinationApproved $true
    if(!$coordinated.ChangesSunshineStartup -or $coordinated.StartsRecoveryNow){throw 'Approved plan must expose startup change without starting recovery now'}
    $tray=Get-BootRecoveryInstallPlan -Component Tray -StartupCoordinationApproved $true
    if($tray.ChangesSunshineStartup -or $tray.StartsRecoveryNow -or $tray.ChangesLiveTopology){throw 'Tray-only deployment must remain independent even when dependency approval was previously supplied'}
    'PASS atomic PowerShell status and nonmutating deployment plans'
} finally {
    $resolved=[IO.Path]::GetFullPath($dir);$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if(!$resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'sunshine-status-tests-*'){throw 'Unsafe test cleanup target'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
