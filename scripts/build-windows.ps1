param([switch]$SkipWebBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$originalLocation = Get-Location
$buildRoot = Join-Path $projectRoot ('.cache/windows-build/' + [Guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $projectRoot 'release'
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
if (!(Test-Path -LiteralPath (Join-Path $frameworkRoot 'csc.exe'))) { $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319' }
$compiler = Join-Path $frameworkRoot 'csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows with .NET Framework 4.5 or later is required to build Setup.exe.' }

function New-ApplicationIcon([string]$Path) {
  Add-Type -AssemblyName System.Drawing
  $images = @()
  foreach ($size in @(16, 32, 48, 256)) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#b9492f'))
    $pen = [Drawing.Pen]::new([Drawing.Color]::White, [single]($size * 0.065))
    try {
      $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $graphics.Clear([Drawing.Color]::Transparent)
      $graphics.FillEllipse($brush, [single]1, [single]1, [single]($size-2), [single]($size-2))
      $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
      $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
      $graphics.DrawBezier($pen, [single]($size*.25), [single]($size*.70), [single]($size*.25), [single]($size*.47), [single]($size*.72), [single]($size*.64), [single]($size*.72), [single]($size*.34))
      $graphics.DrawEllipse($pen, [single]($size*.61), [single]($size*.20), [single]($size*.21), [single]($size*.21))
      $graphics.DrawLine($pen, [single]($size*.25), [single]($size*.70), [single]($size*.15), [single]($size*.61))
      $graphics.DrawLine($pen, [single]($size*.25), [single]($size*.70), [single]($size*.38), [single]($size*.65))
      $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
      $images += ,@{ Size=$size; Bytes=$stream.ToArray() }
    } finally { $pen.Dispose(); $brush.Dispose(); $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
  $file = [IO.File]::Create($Path)
  $writer = [IO.BinaryWriter]::new($file)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16*$images.Count
    foreach ($entry in $images) {
      $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
      $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
      $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([uint16]1); $writer.Write([uint16]32)
      $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
      $offset += $entry.Bytes.Length
    }
    foreach ($entry in $images) { $writer.Write([byte[]]$entry.Bytes) }
  } finally { $writer.Dispose(); $file.Dispose() }
}

function Invoke-Compiler([string]$Source, [string]$Output, [string[]]$Extra = @()) {
  $compilerArguments = @('/nologo','/target:winexe','/optimize+','/platform:anycpu','/codepage:65001',
    ('/out:' + $Output), ('/win32manifest:' + (Join-Path $projectRoot 'packaging/windows/app.manifest')),
    ('/win32icon:' + (Join-Path $buildRoot 'app.ico')), '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll')
  & $compiler @compilerArguments @Extra (Join-Path $projectRoot $Source) (Join-Path $buildRoot 'VersionInfo.cs')
  if ($LASTEXITCODE -ne 0) { throw "Compiler failed for $Source (exit $LASTEXITCODE)." }
}

try {
  Set-Location -LiteralPath $projectRoot
  if (!$SkipWebBuild) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
  }
  $distRoot = Join-Path $projectRoot 'dist'
  if (!(Test-Path -LiteralPath (Join-Path $distRoot 'index.html'))) { throw 'dist/index.html is missing. Run npm run build.' }
  if (@(Get-ChildItem -LiteralPath $distRoot -Recurse -Force -Attributes ReparsePoint).Count -gt 0) { throw 'Refusing linked files in the web build.' }
  New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  $payloadRoot = Join-Path $buildRoot 'payload'
  New-Item -ItemType Directory -Path $payloadRoot | Out-Null
  Copy-Item -LiteralPath $distRoot -Destination (Join-Path $payloadRoot 'wwwroot') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/third-party') -Destination (Join-Path $payloadRoot 'licenses') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/data-sources.md') -Destination (Join-Path $payloadRoot 'licenses/country-data.md')
  & node (Join-Path $projectRoot 'scripts/generate-third-party-notices.mjs') (Join-Path $payloadRoot 'licenses/dependencies.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Dependency license collection failed.' }
  [IO.File]::WriteAllText((Join-Path $payloadRoot 'app.identity'), 'travel-tracker-local-app-v1', [Text.Encoding]::ASCII)
  $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a numeric x.y.z package version for the Windows build.' }
  $versionSource = 'using System.Reflection;' + [Environment]::NewLine +
    '[assembly: AssemblyTitle("Travel Tracker")]' + [Environment]::NewLine +
    '[assembly: AssemblyProduct("Travel Tracker")]' + [Environment]::NewLine +
    '[assembly: AssemblyCompany("GL1NoMe5")]' + [Environment]::NewLine +
    '[assembly: AssemblyVersion("' + $version + '.0")]' + [Environment]::NewLine +
    '[assembly: AssemblyFileVersion("' + $version + '.0")]'
  [IO.File]::WriteAllText((Join-Path $buildRoot 'VersionInfo.cs'), $versionSource, [Text.Encoding]::UTF8)
  New-ApplicationIcon (Join-Path $buildRoot 'app.ico')
  Invoke-Compiler 'packaging/windows/Launcher.cs' (Join-Path $payloadRoot 'TravelTracker.exe')
  Invoke-Compiler 'packaging/windows/Uninstaller.cs' (Join-Path $payloadRoot 'Uninstall.exe')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $payloadZip = Join-Path $buildRoot 'payload.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot, $payloadZip, [IO.Compression.CompressionLevel]::Optimal, $false)
  $installerPath = Join-Path $releaseRoot 'Setup.exe'
  Invoke-Compiler 'packaging/windows/Installer.cs' $installerPath @(('/resource:' + $payloadZip + ',TravelTracker.Payload.zip'))
  $hasher = [Security.Cryptography.SHA256]::Create()
  $installerStream = [IO.File]::OpenRead($installerPath)
  try { $digest = [BitConverter]::ToString($hasher.ComputeHash($installerStream)).Replace('-', '').ToLowerInvariant() }
  finally { $installerStream.Dispose(); $hasher.Dispose() }
  [IO.File]::WriteAllText((Join-Path $releaseRoot 'Setup.exe.sha256'), ($digest + '  Setup.exe' + [Environment]::NewLine), [Text.Encoding]::ASCII)
  Write-Output ('Built: ' + $installerPath)
  Write-Output ('SHA256: ' + $digest)
} finally {
  Set-Location -LiteralPath $originalLocation.Path
  if (Test-Path -LiteralPath $buildRoot) {
    $resolvedBuild = (Resolve-Path -LiteralPath $buildRoot).Path
    $allowedBuildParent = [IO.Path]::GetFullPath((Join-Path $projectRoot '.cache/windows-build')) + [IO.Path]::DirectorySeparatorChar
    if (!$resolvedBuild.StartsWith($allowedBuildParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove an unexpected build path.' }
    if (@(Get-ChildItem -LiteralPath $resolvedBuild -Recurse -Force -Attributes ReparsePoint).Count -gt 0) { throw 'Refusing to remove linked build output.' }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
  }
}
