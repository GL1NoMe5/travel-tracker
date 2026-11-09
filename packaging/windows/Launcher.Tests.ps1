param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath
)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testDirectory = Join-Path $workspaceRoot '.cache/launcher-test'
$webRoot = Join-Path $testDirectory 'wwwroot'
$executable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$serverProcess = $null
$foreignListener = $null
$junction = Join-Path $webRoot 'linked'
$checks = 0

function Send-RawRequest([string]$Request) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.ReceiveTimeout = 7000
        $client.SendTimeout = 7000
        $client.Connect([Net.IPAddress]::Loopback, 5173)
        $stream = $client.GetStream()
        $bytes = [Text.Encoding]::ASCII.GetBytes($Request)
        $stream.Write($bytes, 0, $bytes.Length)
        $buffer = New-Object byte[] 4096
        $memory = New-Object IO.MemoryStream
        try {
            while (($length = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $memory.Write($buffer, 0, $length) }
        } catch [IO.IOException] {
            if ($memory.Length -eq 0) { throw }
        }
        $raw = [Text.Encoding]::UTF8.GetString($memory.ToArray())
        $end = $raw.IndexOf("`r`n`r`n")
        if ($end -lt 0) { throw 'Response has no HTTP headers.' }
        return @{ Header = $raw.Substring(0, $end); Body = $raw.Substring($end + 4) }
    } finally { $client.Close() }
}

function Check-Response([string]$Name, [string]$Request, [int]$Status, [string]$ContentType = '') {
    try { $response = Send-RawRequest $Request }
    catch { throw "$Name failed: $($_.Exception.Message)" }
    if (!$response.Header.StartsWith("HTTP/1.1 $Status ")) { throw "$Name returned unexpected status: $($response.Header)" }
    if ($ContentType -and !$response.Header.Contains("Content-Type: $ContentType")) { throw "$Name has an incorrect content type." }
    if (!$response.Header.Contains('X-Content-Type-Options: nosniff')) { throw "$Name is missing nosniff." }
    $script:checks++
    Write-Host "PASS $Name"
    return $response
}

function New-LauncherProcess {
    $arguments = '--headless --no-browser --root "' + $webRoot + '"'
    # Retain the native process handle for reliable ExitCode on fast WinExe exits
    # in Windows PowerShell 5 (duplicate activation and occupied-port cases).
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $executable
    $start.Arguments = $arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    if (!$process.Start()) { throw 'Could not start launcher.' }
    return $process
}

function Stop-OwnedLauncher($Process) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if (!$Process.HasExited) {
        if ($Process.Path -ne $executable) { throw 'Refusing to stop an unexpected process.' }
        Stop-Process -Id $Process.Id -ErrorAction Stop
        $Process.WaitForExit(5000) | Out-Null
    }
}

try {
    $portCheck = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 5173)
    try { $portCheck.Start() } finally { $portCheck.Stop() }
    New-Item -ItemType Directory -Path (Join-Path $webRoot 'assets') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $testDirectory 'outside') -Force | Out-Null
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $webRoot 'index.html'), '<html>travel-tracker-test</html>', $utf8)
    [IO.File]::WriteAllText((Join-Path $webRoot 'assets/app.js'), 'window.travelTrackerTest = true;', $utf8)
    [IO.File]::WriteAllText((Join-Path $webRoot 'assets/app.css'), 'body { color: black; }', $utf8)
    [IO.File]::WriteAllText((Join-Path $webRoot 'config.json'), '{"test":true}', $utf8)
    [IO.File]::WriteAllText((Join-Path $webRoot 'countries.geojson'), '{"type":"FeatureCollection","features":[]}', $utf8)
    [IO.File]::WriteAllText((Join-Path $webRoot 'private.ps1'), 'do not serve', $utf8)
    [IO.File]::WriteAllText((Join-Path $testDirectory 'outside/secret.txt'), 'outside-root-secret', $utf8)
    $serverProcess = New-LauncherProcess
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $response = Send-RawRequest "GET /__travel_tracker/health HTTP/1.1`r`nHost: 127.0.0.1:5173`r`n`r`n"
            if ($response.Body -eq '{"app":"travel-tracker","protocol":1}') { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 100 }
    }
    if (!$ready) { throw 'Launcher did not become ready.' }

    $suffix = " HTTP/1.1`r`nHost: 127.0.0.1:5173`r`n`r`n"
    $response = Check-Response 'index' ('GET /' + $suffix) 200 'text/html'
    if ($response.Body -ne '<html>travel-tracker-test</html>') { throw 'Incorrect index body.' }
    Check-Response 'JavaScript MIME' ('GET /assets/app.js' + $suffix) 200 'text/javascript' | Out-Null
    Check-Response 'CSS MIME' ('GET /assets/app.css' + $suffix) 200 'text/css' | Out-Null
    Check-Response 'JSON MIME' ('GET /config.json' + $suffix) 200 'application/json' | Out-Null
    Check-Response 'GeoJSON MIME' ('GET /countries.geojson' + $suffix) 200 'application/geo+json' | Out-Null
    $response = Check-Response 'HEAD' ('HEAD /' + $suffix) 200
    if ($response.Body.Length -ne 0) { throw 'HEAD must not return a body.' }
    $response = Check-Response 'HEAD missing file' ('HEAD /missing.js' + $suffix) 404
    if ($response.Body.Length -ne 0) { throw 'HEAD error must not return a body.' }
    Check-Response 'missing file' ('GET /missing.js' + $suffix) 404 | Out-Null
    Check-Response 'unapproved extension' ('GET /private.ps1' + $suffix) 404 | Out-Null
    Check-Response 'dot path' ('GET /../outside/secret.txt' + $suffix) 400 | Out-Null
    Check-Response 'encoded traversal' ('GET /%2e%2e/outside/secret.txt' + $suffix) 400 | Out-Null
    Check-Response 'encoded backslash' ('GET /assets%5capp.js' + $suffix) 400 | Out-Null
    Check-Response 'encoded NUL' ('GET /config.json%00' + $suffix) 400 | Out-Null
    Check-Response 'dotfile' ('GET /.env' + $suffix) 400 | Out-Null
    Check-Response 'Windows alternate stream' ('GET /config.json:secret' + $suffix) 400 | Out-Null
    Check-Response 'malformed escaping' ('GET /bad%GG' + $suffix) 400 | Out-Null
    Check-Response 'directory listing' ('GET /assets/' + $suffix) 400 | Out-Null
    Check-Response 'unsupported method' ('POST /' + $suffix) 405 | Out-Null
    Check-Response 'foreign host' "GET / HTTP/1.1`r`nHost: evil.example:5173`r`n`r`n" 403 | Out-Null
    Check-Response 'foreign origin' "GET / HTTP/1.1`r`nHost: 127.0.0.1:5173`r`nOrigin: https://evil.example`r`n`r`n" 403 | Out-Null
    Check-Response 'same origin' "GET / HTTP/1.1`r`nHost: 127.0.0.1:5173`r`nOrigin: http://127.0.0.1:5173`r`n`r`n" 200 | Out-Null
    Check-Response 'duplicate host' "GET / HTTP/1.1`r`nHost: 127.0.0.1:5173`r`nHost: evil.example`r`n`r`n" 400 | Out-Null
    Check-Response 'transfer encoding' "GET / HTTP/1.1`r`nHost: 127.0.0.1:5173`r`nTransfer-Encoding: chunked`r`n`r`n" 400 | Out-Null
    # Windows may reset a socket with unread oversized input instead of delivering
    # the 431 response. Either form of bounded rejection is correct.
    $oversizedRejected = $false
    try {
        $response = Send-RawRequest ("GET / HTTP/1.1`r`nHost: 127.0.0.1:5173`r`nX-Large: " + ('a' * 17000) + "`r`n`r`n")
        $oversizedRejected = $response.Header.StartsWith('HTTP/1.1 431 ')
    } catch [IO.IOException] { $oversizedRejected = $true }
    if (!$oversizedRejected) { throw 'Oversized header was not rejected.' }
    $checks++
    Write-Host 'PASS oversized header rejected'
    Check-Response 'healthy after malformed requests' ('GET /__travel_tracker/health' + $suffix) 200 | Out-Null

    New-Item -ItemType Junction -Path $junction -Target (Join-Path $testDirectory 'outside') | Out-Null
    Check-Response 'junction outside webroot' ('GET /linked/secret.txt' + $suffix) 404 | Out-Null
    $duplicate = New-LauncherProcess
    if (!$duplicate.WaitForExit(5000) -or $duplicate.ExitCode -ne 0) { throw 'Second activation did not reuse the running launcher.' }
    $checks++
    Write-Output 'PASS second activation reuses existing server'
    Stop-OwnedLauncher $serverProcess
    $serverProcess = $null

    $foreignListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 5173)
    $foreignListener.Start()
    $busy = New-LauncherProcess
    try {
        if (!$busy.WaitForExit(6000) -or $busy.ExitCode -eq 0) { throw 'Busy foreign port was not rejected.' }
    } finally { Stop-OwnedLauncher $busy }
    $checks++
    Write-Output 'PASS foreign listener is preserved and reported busy'
    Write-Output "Launcher checks passed: $checks"
} finally {
    Stop-OwnedLauncher $serverProcess
    if ($null -ne $foreignListener) { $foreignListener.Stop() }
    # Delete only the junction itself, never recurse into its target.
    if (Test-Path -LiteralPath $junction) {
        $resolved = [IO.Path]::GetFullPath($junction)
        if (!$resolved.StartsWith($testDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test junction path.' }
        $entry = Get-Item -LiteralPath $resolved -Force
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Unexpected ordinary directory at test junction path.' }
        # Windows PowerShell 5's Remove-Item can throw for directory junctions.
        # Directory.Delete(path, false) removes this verified junction only.
        [IO.Directory]::Delete($resolved, $false)
    }
}
