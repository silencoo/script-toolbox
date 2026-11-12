Set-StrictMode -Version Latest
function Write-DiagnosticJson {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Value)
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try {
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20))
        $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        if([IO.File]::Exists($Path)){[IO.File]::Replace($temporary,$Path,[NullString]::Value)}else{[IO.File]::Move($temporary,$Path)}
    } finally {if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}
Export-ModuleMember -Function Write-DiagnosticJson
