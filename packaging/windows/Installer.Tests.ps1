param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [switch]$InstallLifecycle,
    [switch]$CustomInstallLifecycle,
    [string]$PreviousSetupPath
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$setup = (Resolve-Path -LiteralPath $SetupPath).Path
if ($InstallLifecycle -and $CustomInstallLifecycle) { throw 'Run default and custom installation lifecycles separately.' }
if ($PreviousSetupPath -and (!$InstallLifecycle -or $CustomInstallLifecycle)) { throw '-PreviousSetupPath requires only -InstallLifecycle.' }
$initialSetup = if ($PreviousSetupPath) { (Resolve-Path -LiteralPath $PreviousSetupPath).Path } else { $setup }
$runLifecycle = $InstallLifecycle -or $CustomInstallLifecycle
$testId = [Guid]::NewGuid().ToString('N')
$cacheRoot = Join-Path $workspaceRoot '.cache'
$testRoot = Join-Path $cacheRoot ('installer-test-' + $testId)
$extractRoot = Join-Path $testRoot 'Проверка установки с пробелами'
$dist = Join-Path $workspaceRoot 'dist'
$identity = 'travel-tracker-local-app-v1'
$displayName = 'Карта путешествий'
$defaultInstallRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Programs/TravelTracker'))
$customInstallRoot = Join-Path $testRoot "Карта & путешествия 'тест'"
$installRoot = if ($CustomInstallLifecycle) { $customInstallRoot } else { $defaultInstallRoot }
$launcherPath = Join-Path $installRoot 'TravelTracker.exe'
$uninstallPath = Join-Path $installRoot 'Uninstall.exe'
$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\TravelTracker'
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)) ($displayName + '.lnk')),
    (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) ($displayName + '.lnk'))
)
$sentinelPath = Join-Path $installRoot ('qa-sentinel-' + $testId + '.txt')
$sentinelBody = 'Installer test owned sentinel: ' + $testId
$installedByTest = $false
$launcherProcess = $null
$testJunction = Join-Path $testRoot 'linked-install'
$processCount = 0
$checks = 0
$lastProcessError = ''
$shortcutReadTarget = $null
$shortcutReadWorkingDirectory = $null

function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) {
        if ($script:lastProcessError) { $Message += [Environment]::NewLine + $script:lastProcessError }
        throw $Message
    }
    $script:checks++
    Write-Host "PASS $Message"
}

function Assert-NoReparseAncestors([string]$Path) {
    $candidate = [IO.Path]::GetFullPath($Path)
    while (![string]::IsNullOrEmpty($candidate)) {
        if ([IO.Directory]::Exists($candidate) -or [IO.File]::Exists($candidate)) {
            if (([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse path: $candidate" }
        }
        $next = [IO.Path]::GetDirectoryName($candidate)
        if ($next -eq $candidate) { break }
        $candidate = $next
    }
}

function Assert-NoReparseTree([string]$Directory) {
    Assert-NoReparseAncestors $Directory
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Directory)) {
        $attributes = [IO.File]::GetAttributes($entry)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse entry: $entry" }
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { Assert-NoReparseTree $entry }
    }
}

function Assert-CleanLifecycleState {
    # All checks happen before creating even the workspace test directory.
    foreach ($path in @($defaultInstallRoot, $installRoot) + $shortcutPaths) {
        Assert-NoReparseAncestors $path
        if ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) { throw "Lifecycle test requires absent existing state; untouched: $path" }
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
    if ($null -ne $key) { $key.Dispose(); throw 'Lifecycle test requires an absent HKCU TravelTracker uninstall entry; existing entry is untouched.' }
    $probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 5173)
    try { $probe.Start() } finally { $probe.Stop() }
}

function Invoke-Executable([string]$Path, [string]$Arguments, [int]$Timeout = 30000) {
    $script:processCount++
    $prefix = Join-Path $testRoot ('process-' + $script:processCount)
    # Starting Process directly retains its native handle reliably in Windows
    # PowerShell 5. Start-Process can lose ExitCode when a WinExe exits quickly.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Path
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $workspaceRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (!$process.Start()) { throw "Could not start executable: $Path" }
        $standardOutput = $process.StandardOutput.ReadToEndAsync()
        $standardError = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit($Timeout)) { throw "Process $($process.Id) did not finish within $Timeout ms; it was not forcibly terminated during filesystem work." }
        $process.WaitForExit()
        [IO.File]::WriteAllText(($prefix + '.stdout.log'), $standardOutput.Result)
        [IO.File]::WriteAllText(($prefix + '.stderr.log'), $standardError.Result)
        $script:lastProcessError = $standardError.Result.Trim()
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Assert-Payload([string]$Directory) {
    Assert-NoReparseTree $Directory
    foreach ($relative in @('TravelTracker.exe', 'Uninstall.exe', 'app.identity', 'install.files', 'wwwroot/index.html')) {
        Assert-True ([IO.File]::Exists((Join-Path $Directory $relative))) "Payload includes $relative"
    }
    Assert-True ([IO.File]::ReadAllText((Join-Path $Directory 'app.identity')).Trim() -ceq $identity) 'Payload identity matches'
    Assert-NoReparseTree $dist
    $distPrefix = $dist.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $sourceFiles = @([IO.Directory]::EnumerateFiles($dist, '*', [IO.SearchOption]::AllDirectories))
    Assert-True ($sourceFiles.Count -gt 0) 'Production dist contains files'
    foreach ($source in $sourceFiles) {
        $relative = $source.Substring($distPrefix.Length)
        $installed = Join-Path (Join-Path $Directory 'wwwroot') $relative
        if (![IO.File]::Exists($installed)) { throw "Missing packaged production file: $relative" }
        if ((Get-Sha256 $source) -cne (Get-Sha256 $installed)) { throw "Packaged production file differs: $relative" }
    }
    $packagedCount = @([IO.Directory]::EnumerateFiles((Join-Path $Directory 'wwwroot'), '*', [IO.SearchOption]::AllDirectories)).Count
    Assert-True ($packagedCount -eq $sourceFiles.Count) "All $($sourceFiles.Count) packaged production files match dist hashes exactly"
}

function Read-UnicodeShortcut([string]$Path) {
    if ($null -eq $script:shortcutReadTarget) {
        # Load the production helper from bytes: inspection must not lock Setup,
        # the installed uninstaller, or extracted files needed during cleanup.
        $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($setup))
        $helpers = @($assembly.GetTypes() | Where-Object { $_.Name -ceq 'ShellLinks' })
        Assert-True ($helpers.Count -eq 1) 'Setup contains one shared Unicode shortcut helper'
        $flags = [Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::NonPublic
        $script:shortcutReadTarget = $helpers[0].GetMethod('ReadTarget', $flags)
        $script:shortcutReadWorkingDirectory = $helpers[0].GetMethod('ReadWorkingDirectory', $flags)
        if ($null -eq $script:shortcutReadTarget -or $null -eq $script:shortcutReadWorkingDirectory) {
            throw 'Setup is missing its Unicode shortcut inspection methods.'
        }
    }
    return [pscustomobject]@{
        TargetPath = [string]$script:shortcutReadTarget.Invoke($null, [object[]]@($Path))
        WorkingDirectory = [string]$script:shortcutReadWorkingDirectory.Invoke($null, [object[]]@($Path))
    }
}

function Assert-ShortcutsAndRegistry {
    foreach ($path in $shortcutPaths) {
        Assert-True ([IO.File]::Exists($path)) "Shortcut exists: $path"
        $matchingNames = @([IO.Directory]::EnumerateFiles([IO.Path]::GetDirectoryName($path), '*.lnk') | Where-Object {
            [IO.Path]::GetFileName($_) -ceq ($displayName + '.lnk')
        })
        Assert-True ($matchingNames.Count -eq 1) 'Shortcut retains its exact Russian filename'
        $shortcut = Read-UnicodeShortcut $path
        Assert-True ([string]::Equals([IO.Path]::GetFullPath($shortcut.TargetPath), $launcherPath, [StringComparison]::OrdinalIgnoreCase)) 'Shortcut points to the installed launcher'
        Assert-True ([string]::Equals([IO.Path]::GetFullPath($shortcut.WorkingDirectory), $installRoot, [StringComparison]::OrdinalIgnoreCase)) 'Shortcut working directory matches'
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
    Assert-True ($null -ne $key) 'Windows uninstall registration exists'
    try {
        Assert-True ([string]::Equals([string]$key.GetValue('InstallLocation'), $installRoot, [StringComparison]::OrdinalIgnoreCase)) 'Registered install directory matches'
        Assert-True ([string]$key.GetValue('UninstallString') -ceq ('"' + $uninstallPath + '"')) 'Registered uninstall command matches'
    } finally { $key.Dispose() }
}

function Stop-OwnedLauncher {
    if ($null -eq $script:launcherProcess) { return }
    $script:launcherProcess.Refresh()
    if (!$script:launcherProcess.HasExited) {
        if (![string]::Equals($script:launcherProcess.Path, $launcherPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to stop an unexpected launcher process.' }
        Stop-Process -Id $script:launcherProcess.Id -ErrorAction Stop
        if (!$script:launcherProcess.WaitForExit(5000)) { throw 'Owned launcher did not stop.' }
    }
    $script:launcherProcess.Dispose()
    $script:launcherProcess = $null
}

function Test-Health {
    try {
        $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:5173/__travel_tracker/health')
        $request.Proxy = $null
        $request.Timeout = 800
        $request.ReadWriteTimeout = 800
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try {
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            try { return $response.Headers['X-Travel-Tracker'] -eq '1' -and $reader.ReadToEnd() -ceq '{"app":"travel-tracker","protocol":1}' }
            finally { $reader.Dispose() }
        } finally { $response.Dispose() }
    } catch { return $false }
}

function Test-Unregistered {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
    if ($null -ne $key) { $key.Dispose(); return $false }
    foreach ($path in $shortcutPaths) { if ([IO.File]::Exists($path)) { return $false } }
    return $true
}

function Wait-Uninstall {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if (![IO.File]::Exists($uninstallPath) -and (Test-Unregistered)) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Asynchronous uninstall did not complete within 15 seconds; inspect the installed directory and process logs.'
}

function Remove-OwnedSentinelAndEmptyFolder {
    Assert-NoReparseAncestors $installRoot
    if ([IO.File]::Exists($sentinelPath)) {
        if ([IO.File]::ReadAllText($sentinelPath) -cne $sentinelBody) { throw 'Test sentinel changed; preserved for inspection.' }
        Assert-NoReparseAncestors $sentinelPath
        Remove-Item -LiteralPath $sentinelPath -Force
    }
    if ([IO.Directory]::Exists($installRoot) -and @([IO.Directory]::EnumerateFileSystemEntries($installRoot)).Count -eq 0) {
        Remove-Item -LiteralPath $installRoot -Force
    }
}

function Assert-RejectedCustomDirectories {
    $foreignRoot = Join-Path $testRoot 'foreign-install'
    New-Item -ItemType Directory -Path $foreignRoot | Out-Null
    $foreignFile = Join-Path $foreignRoot 'keep.txt'
    [IO.File]::WriteAllText($foreignFile, $sentinelBody)
    Assert-True ((Invoke-Executable $setup ('--silent --directory "' + $foreignRoot + '"')) -ne 0) 'Installation refuses an occupied unmarked directory'
    Assert-True ([IO.File]::ReadAllText($foreignFile) -ceq $sentinelBody -and @([IO.Directory]::EnumerateFileSystemEntries($foreignRoot)).Count -eq 1) 'Rejected installation preserves foreign files exactly'

    $driveRoot = [IO.Path]::GetPathRoot($workspaceRoot)
    $rootEntries = @([IO.Directory]::EnumerateFileSystemEntries($driveRoot) | Sort-Object)
    Assert-True ((Invoke-Executable $setup ('--silent --directory "' + $driveRoot.TrimEnd('\') + '\\"')) -ne 0) 'Installation refuses a drive root'
    $entriesAfter = @([IO.Directory]::EnumerateFileSystemEntries($driveRoot) | Sort-Object)
    Assert-True (($rootEntries -join "`n") -ceq ($entriesAfter -join "`n")) 'Rejected root selection creates no root entries'

    $relativeTarget = '.cache/installer-test-' + $testId + '/relative-install'
    Assert-True ((Invoke-Executable $setup ('--silent --directory "' + $relativeTarget + '"')) -ne 0) 'Installation refuses a relative directory'
    Assert-True (![IO.Directory]::Exists((Join-Path $workspaceRoot $relativeTarget))) 'Rejected relative path creates no directory'
    New-Item -ItemType Junction -Path $testJunction -Target $foreignRoot | Out-Null
    Assert-True ((Invoke-Executable $setup ('--silent --directory "' + (Join-Path $testJunction 'new-install') + '"')) -ne 0) 'Installation refuses a directory reached through a junction'
    Assert-True ([IO.File]::ReadAllText($foreignFile) -ceq $sentinelBody -and @([IO.Directory]::EnumerateFileSystemEntries($foreignRoot)).Count -eq 1) 'Rejected junction selection leaves its target untouched'
    Assert-True (Test-Unregistered) 'Rejected directory selections create no shortcuts or registration'
    Assert-True (![IO.Directory]::Exists($defaultInstallRoot)) 'Rejected directory selections create no default installation'
}

function Assert-MismatchedUninstallRegistration {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath, $true)
    if ($null -eq $key) { throw 'Test-owned registration is missing.' }
    $expectedCommand = '"' + $uninstallPath + '"'
    try {
        if ([string]$key.GetValue('InstallLocation') -cne $installRoot -or [string]$key.GetValue('UninstallString') -cne $expectedCommand) {
            throw 'Refusing to modify registration not owned by this test.'
        }
        $locationKind = $key.GetValueKind('InstallLocation')
        $commandKind = $key.GetValueKind('UninstallString')
        $wrongDirectory = Join-Path $testRoot 'wrong-registered-directory'
        try {
            $key.SetValue('InstallLocation', $wrongDirectory, $locationKind)
            Assert-True ((Invoke-Executable $uninstallPath '--silent') -ne 0) 'Uninstall refuses a mismatched registered installation directory'
            Assert-True ([string]$key.GetValue('InstallLocation') -ceq $wrongDirectory) 'Rejected uninstall preserves the registration'
        } finally { $key.SetValue('InstallLocation', $installRoot, $locationKind) }
        try {
            $key.SetValue('UninstallString', ('"' + (Join-Path $wrongDirectory 'Uninstall.exe') + '"'), $commandKind)
            Assert-True ((Invoke-Executable $uninstallPath '--silent') -ne 0) 'Uninstall refuses a mismatched registered uninstall command'
        } finally { $key.SetValue('UninstallString', $expectedCommand, $commandKind) }
    } finally { $key.Dispose() }
    Assert-True ((Invoke-Executable (Join-Path $extractRoot 'Uninstall.exe') '--silent') -ne 0) 'Uninstall refuses execution from an unregistered extracted copy'
    Assert-Payload $installRoot
    Assert-ShortcutsAndRegistry
}

if ($runLifecycle) { Assert-CleanLifecycleState }
Assert-NoReparseAncestors $testRoot
if ([IO.Directory]::Exists($testRoot) -or [IO.File]::Exists($testRoot)) { throw 'Unique test directory already exists.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
Write-Host "Test logs: $testRoot"

try {
    Assert-True ((Invoke-Executable $setup ('--extract "' + $extractRoot + '"')) -eq 0) 'Setup extracts to a Unicode path containing spaces'
    Assert-Payload $extractRoot
    $occupiedRoot = Join-Path $testRoot 'nonempty'
    New-Item -ItemType Directory -Path $occupiedRoot | Out-Null
    $occupiedFile = Join-Path $occupiedRoot 'keep.txt'
    [IO.File]::WriteAllText($occupiedFile, $sentinelBody)
    Assert-True ((Invoke-Executable $setup ('--extract "' + $occupiedRoot + '"')) -ne 0) 'Setup rejects a nonempty extraction directory'
    Assert-True ([IO.File]::ReadAllText($occupiedFile) -ceq $sentinelBody -and @([IO.Directory]::EnumerateFileSystemEntries($occupiedRoot)).Count -eq 1) 'Rejected extraction leaves existing files untouched'

    if ($runLifecycle) {
        # Repeat immediately before installation in case another process changed state.
        Assert-CleanLifecycleState
        if ($CustomInstallLifecycle) {
            Assert-RejectedCustomDirectories
            Assert-CleanLifecycleState
            # The default lifecycle covers a missing directory; custom covers an empty one.
            New-Item -ItemType Directory -Path $installRoot | Out-Null
        }
        $firstArguments = if ($CustomInstallLifecycle) { '--silent --directory "' + $installRoot + '"' } else { '--silent' }
        $installExitCode = Invoke-Executable $initialSetup $firstArguments
        $installedByTest = $installExitCode -eq 0
        Assert-True ($installExitCode -eq 0) 'Silent per-user installation succeeds in the selected directory'
        Assert-Payload $installRoot
        Assert-ShortcutsAndRegistry
        if ($CustomInstallLifecycle) {
            Assert-True (![IO.Directory]::Exists($defaultInstallRoot)) 'Custom installation leaves the default location absent'
            $relocationTarget = Join-Path $testRoot 'unrequested-relocation'
            Assert-True ((Invoke-Executable $setup ('--silent --directory "' + $relocationTarget + '"')) -ne 0) 'Existing installation cannot be silently relocated'
            Assert-True (![IO.Directory]::Exists($relocationTarget)) 'Refused relocation creates no target directory'
            Assert-ShortcutsAndRegistry
        }
        $launcherProcess = Start-Process -FilePath $launcherPath -ArgumentList '--headless --no-browser' -WindowStyle Hidden -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($launcherProcess.HasExited) { throw 'Installed launcher exited instead of owning its local server.' }
            if (Test-Health) { $ready = $true; break }
            Start-Sleep -Milliseconds 100
        }
        Assert-True $ready 'Installed launcher serves its local health endpoint'
        Assert-True ((Invoke-Executable $setup '--silent') -ne 0) 'Update is rejected while the launcher runs'
        Assert-True ((Invoke-Executable $uninstallPath '--silent') -ne 0) 'Uninstall is rejected while the launcher runs'
        Assert-True (Test-Health) 'Rejected operations leave the running app healthy'
        Stop-OwnedLauncher
        [IO.File]::WriteAllText($sentinelPath, $sentinelBody)
        Assert-True ((Invoke-Executable $setup '--silent') -eq 0) 'Silent update succeeds after launcher closes'
        foreach ($program in @('TravelTracker.exe', 'Uninstall.exe')) {
            Assert-True ((Get-Sha256 (Join-Path $installRoot $program)) -ceq (Get-Sha256 (Join-Path $extractRoot $program))) "Update installs the current $program exactly"
        }
        if ($CustomInstallLifecycle) { Assert-True (![IO.Directory]::Exists($defaultInstallRoot)) 'Update without --directory reuses the registered custom location' }
        Assert-True ([IO.File]::ReadAllText($sentinelPath) -ceq $sentinelBody) 'Update preserves an untracked user file'
        Assert-Payload $installRoot
        Assert-ShortcutsAndRegistry
        if ($CustomInstallLifecycle) { Assert-MismatchedUninstallRegistration }
        $tracked = [IO.File]::ReadAllLines((Join-Path $installRoot 'install.files'))
        Assert-True ((Invoke-Executable $uninstallPath '--silent') -eq 0) 'Uninstaller starts its cleanup helper'
        Wait-Uninstall
        foreach ($relative in $tracked) {
            if ([IO.File]::Exists((Join-Path $installRoot $relative))) { throw "Uninstall left tracked file: $relative" }
        }
        Assert-True (Test-Unregistered) 'Uninstall removes both shortcuts and its registry entry'
        Assert-True ([IO.File]::ReadAllText($sentinelPath) -ceq $sentinelBody) 'Uninstall preserves the untracked user file'
        Remove-OwnedSentinelAndEmptyFolder
        Assert-True (![IO.Directory]::Exists($installRoot)) 'Only test-owned sentinel and empty install folder are cleaned up'
        $installedByTest = $false
    }
    Write-Host "Installer checks passed: $checks"
} finally {
    Stop-OwnedLauncher
    if ($installedByTest -and [IO.File]::Exists($uninstallPath) -and [IO.File]::Exists((Join-Path $installRoot 'app.identity'))) {
        # Recovery uses the application's guarded uninstaller; never recursive deletion.
        if ([IO.File]::ReadAllText((Join-Path $installRoot 'app.identity')).Trim() -ceq $identity) {
            try {
                if ((Invoke-Executable $uninstallPath '--silent') -eq 0) { Wait-Uninstall; Remove-OwnedSentinelAndEmptyFolder }
            } catch { Write-Warning ('Test installation retained after cleanup failure: ' + $_.Exception.Message) }
        }
    }
    # Keep compact logs for review. Remove only our uniquely named extracted fixtures.
    if ([IO.Directory]::Exists($testJunction)) {
        $junctionFull = [IO.Path]::GetFullPath($testJunction)
        if (!$junctionFull.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test junction path.' }
        if (([IO.File]::GetAttributes($junctionFull) -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Unexpected ordinary folder at test junction path.' }
        # Windows PowerShell 5.1 Remove-Item can throw NullReferenceException for
        # directory junctions. Delete the verified link itself without recursion.
        [IO.Directory]::Delete($junctionFull, $false)
    }
    foreach ($fixture in @($extractRoot, (Join-Path $testRoot 'nonempty'), (Join-Path $testRoot 'foreign-install'))) {
        if ([IO.Directory]::Exists($fixture)) {
            $full = [IO.Path]::GetFullPath($fixture)
            if (!$full.StartsWith($testRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
            Assert-NoReparseTree $full
            Remove-Item -LiteralPath $full -Recurse -Force
        }
    }
}
