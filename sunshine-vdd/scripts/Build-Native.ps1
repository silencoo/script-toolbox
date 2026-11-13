[CmdletBinding()]
param([string]$OutputDirectory,[switch]$Test)
$ErrorActionPreference='Stop'
if(!$OutputDirectory){$OutputDirectory=Join-Path $PSScriptRoot '../native/bin'}
$root=Split-Path $PSScriptRoot
$framework=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
$compiler=Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio/2022/Community/MSBuild/Current/Bin/Roslyn/csc.exe'
if(!(Test-Path -LiteralPath $compiler)){$compiler=Join-Path $framework 'csc.exe'}
if(!(Test-Path -LiteralPath $compiler)){throw 'Install Visual Studio C# build tools or the .NET Framework compiler.'}
$out=[IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Path $out -Force)
# Compile the SAME native structs and topology implementation used by PowerShell.
$module=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'DisplayTopology.psm1') -Raw
$match=[regex]::Match($module,"(?s)\`$source = @'\r?\n(.*?)\r?\n'@")
if(!$match.Success){throw 'Could not extract the shared native display implementation.'}
$generated=Join-Path $out 'DisplayTopology.generated.cs'
[IO.File]::WriteAllText($generated,$match.Groups[1].Value,[Text.UTF8Encoding]::new($false))
function Compile([string]$Name,[string]$Target,[string[]]$Sources,[string[]]$References) {
    $options=@('/nologo','/optimize+','/platform:x64','/warn:4',('/target:'+$Target),('/out:'+(Join-Path $out $Name)))
    foreach($reference in $References){$options+=('/reference:'+$reference)}
    & $compiler @options @Sources
    if($LASTEXITCODE -ne 0){throw "Compilation failed: $Name"}
}
Compile 'SunshineDisplay.Native.dll' library @($generated,(Join-Path $PSScriptRoot 'DisplayRecovery.cs')) @((Join-Path $framework 'System.Core.dll'))
Compile 'SunshineDisplay.Core.dll' library @((Join-Path $root 'native/Common.cs'),(Join-Path $root 'native/BootEpoch.cs'),(Join-Path $root 'native/RecoveryEngine.cs'),(Join-Path $root 'boot-recovery/ConsoleSession.cs')) @((Join-Path $framework 'System.Web.Extensions.dll'),(Join-Path $framework 'System.Core.dll'),(Join-Path $framework 'System.Management.dll'))
$common=@((Join-Path $out 'SunshineDisplay.Core.dll'),(Join-Path $out 'SunshineDisplay.Native.dll'),(Join-Path $framework 'System.Web.Extensions.dll'),(Join-Path $framework 'System.Core.dll'))
Compile 'SunshineDisplay.Recovery.exe' exe @((Join-Path $root 'boot-recovery/Recovery.cs')) ($common+@((Join-Path $framework 'System.ServiceProcess.dll')))
Compile 'SunshineDisplay.Tray.exe' winexe @((Join-Path $root 'tray/Tray.cs')) ($common+@((Join-Path $framework 'System.Windows.Forms.dll'),(Join-Path $framework 'System.Drawing.dll')))
if($Test){
    Compile 'SunshineDisplay.Tests.exe' exe @((Join-Path $root 'tests/Native.Tests.cs')) $common
    & (Join-Path $out 'SunshineDisplay.Tests.exe')
    if($LASTEXITCODE -ne 0){throw 'Native fixture tests failed'}
}
Get-ChildItem -LiteralPath $out -File | Where-Object Extension -in @('.exe','.dll') | Get-FileHash -Algorithm SHA256
