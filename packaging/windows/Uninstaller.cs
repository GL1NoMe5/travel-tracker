using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TravelTracker.Uninstall
{
    internal static class Uninstaller
    {
        private const string Identity = "travel-tracker-local-app-v1";
        private const string DisplayName = "Карта путешествий";
        private const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\TravelTracker";

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = args.Length == 1 && args[0] == "--silent";
            Mutex operation = null;
            bool acquired = false;
            try
            {
                if (args.Length != 0 && !silent) throw new ArgumentException("Допустимый параметр: --silent.");
                operation = new Mutex(false, @"Local\TravelTracker.Install." + WindowsIdentity.GetCurrent().User.Value);
                try { acquired = operation.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new IOException("Установка или удаление уже выполняется. Дождитесь завершения и попробуйте ещё раз.");
                string expected = ReadRegisteredDirectory();
                string executable = Assembly.GetExecutingAssembly().Location;
                string actual = CanonicalDirectory(Path.GetDirectoryName(executable));
                if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(Path.GetFullPath(executable), Path.Combine(expected, "Uninstall.exe"), StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Запустите удаление из установленной папки приложения или через параметры Windows.");
                ValidateInstallation(expected);
                if (!silent)
                {
                    Application.EnableVisualStyles();
                    if (MessageBox.Show("Удалить «Карту путешествий» с компьютера?\n\nСохранённые в браузере страны и места останутся.", DisplayName,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return 0;
                }
                EnsureLauncherClosed(expected);
                List<ShortcutSnapshot> shortcuts = CaptureOwnedShortcuts(expected);
                StartCleanup(expected, silent, shortcuts);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                if (!silent) MessageBox.Show(error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                if (operation != null) { if (acquired) operation.ReleaseMutex(); operation.Dispose(); }
            }
        }

        private static string CanonicalDirectory(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length < 4 ||
                !((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) ||
                value[1] != ':' || (value[2] != '\\' && value[2] != '/') || value.Any(Char.IsControl))
                throw new IOException("В записи установки указан недопустимый путь. Файлы оставлены без изменений.");
            string normalized = value.Replace('/', '\\').TrimEnd('\\');
            if (normalized.Length <= 3) throw new IOException("Удаление из корня диска не поддерживается.");
            string[] segments = normalized.Substring(3).Split('\\');
            if (segments.Any(part => part.Length == 0 || part == "." || part == ".." ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal)))
                throw new IOException("В записи установки указан недопустимый путь. Файлы оставлены без изменений.");
            string full = Path.GetFullPath(normalized).TrimEnd(Path.DirectorySeparatorChar);
            string root = Path.GetPathRoot(full);
            if (String.Equals(full, root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) || new DriveInfo(root).DriveType == DriveType.Network)
                throw new IOException("Удаление из корня диска или сетевой папки не поддерживается.");
            return full;
        }

        private static string ReadRegisteredDirectory()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath))
            {
                if (key == null) throw new IOException("Запись установки не найдена. Файлы оставлены без изменений.");
                string directory = CanonicalDirectory(key.GetValue("InstallLocation", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string);
                string command = key.GetValue("UninstallString", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                if (!String.Equals(command, "\"" + Path.Combine(directory, "Uninstall.exe") + "\"", StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Запись удаления не соответствует папке приложения. Файлы оставлены без изменений.");
                return directory;
            }
        }

        private static void ValidateInstallation(string directory)
        {
            EnsureNoReparseAncestors(directory);
            EnsureNoReparseTree(directory);
            string marker = Path.Combine(directory, "app.identity");
            if (!File.Exists(marker) || File.ReadAllText(marker).Trim() != Identity)
                throw new IOException("Не удалось подтвердить папку приложения. Файлы оставлены без изменений.");
            string manifest = Path.Combine(directory, "install.files");
            if (!File.Exists(manifest)) throw new IOException("Список установленных файлов отсутствует. Файлы оставлены без изменений.");
            HashSet<string> files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string prefix = directory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            foreach (string entry in File.ReadAllLines(manifest, Encoding.UTF8))
            {
                string relative = ValidateRelativePath(entry);
                string path = Path.GetFullPath(Path.Combine(directory, relative));
                if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || Directory.Exists(path))
                    throw new IOException("Список установленных файлов повреждён. Файлы оставлены без изменений.");
                files.Add(relative);
            }
            if (!files.Contains("TravelTracker.exe") || !files.Contains("Uninstall.exe") || !files.Contains("app.identity") || !files.Contains("install.files"))
                throw new IOException("Список установленных файлов повреждён. Файлы оставлены без изменений.");
        }

        private static string ValidateRelativePath(string name)
        {
            if (String.IsNullOrWhiteSpace(name) || Path.IsPathRooted(name) || name.IndexOf(':') >= 0 || name.Any(Char.IsControl)) throw new IOException("Недопустимый путь в списке файлов.");
            string[] parts = name.Replace('\\', '/').Split('/');
            if (parts.Any(part => part.Length == 0 || part == "." || part == ".." || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal)))
                throw new IOException("Недопустимый путь в списке файлов.");
            return String.Join(Path.DirectorySeparatorChar.ToString(), parts);
        }

        private static void EnsureNoReparseAncestors(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Папка приложения содержит перенаправление. Файлы оставлены без изменений.");
                string parent = Path.GetDirectoryName(current);
                if (parent == current) break;
                current = parent;
            }
        }

        private static void EnsureNoReparseTree(string directory)
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
            {
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("В папке приложения найдена ссылка. Файлы оставлены без изменений.");
                if ((attributes & FileAttributes.Directory) != 0) EnsureNoReparseTree(entry);
            }
        }

        private static void EnsureLauncherClosed(string directory)
        {
            string executable = Path.Combine(directory, "TravelTracker.exe");
            if (!File.Exists(executable)) return;
            try { using (FileStream probe = new FileStream(executable, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } }
            catch (IOException) { throw new IOException("Закройте «Карту путешествий» через значок рядом с часами и повторите удаление."); }
            catch (UnauthorizedAccessException) { throw new IOException("Не удалось удалить приложение. Закройте его через значок рядом с часами и проверьте доступ к папке установки."); }
        }

        private static string QuotePowerShell(string value) { return "'" + value.Replace("'", "''") + "'"; }

        private sealed class ShortcutSnapshot
        {
            internal string Path;
            internal string Hash;
        }

        private static List<ShortcutSnapshot> CaptureOwnedShortcuts(string directory)
        {
            List<ShortcutSnapshot> snapshots = new List<ShortcutSnapshot>();
            string launcher = Path.Combine(directory, "TravelTracker.exe");
            foreach (Environment.SpecialFolder folder in new Environment.SpecialFolder[] {
                Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.Programs })
            {
                string parent = Environment.GetFolderPath(folder);
                if (String.IsNullOrEmpty(parent)) continue;
                string path = Path.GetFullPath(Path.Combine(parent, DisplayName + ".lnk"));
                ShortcutSnapshot snapshot = ReadOwnedShortcutSnapshot(path, launcher);
                if (snapshot != null) snapshots.Add(snapshot);
            }
            return snapshots;
        }

        private static ShortcutSnapshot ReadOwnedShortcutSnapshot(string path, string launcher)
        {
            try
            {
                if (!File.Exists(path)) return null;
                EnsureNoReparseAncestors(path);
                // Deny modification and deletion while target ownership and bytes are read.
                using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    string target = TravelTracker.Windows.ShellLinks.ReadTarget(path);
                    if (String.IsNullOrEmpty(target) || !Path.IsPathRooted(target) ||
                        !String.Equals(Path.GetFullPath(target), launcher, StringComparison.OrdinalIgnoreCase)) return null;
                    using (SHA256 hash = SHA256.Create())
                        return new ShortcutSnapshot { Path = path, Hash = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "") };
                }
            }
            // An unreadable, changed or foreign shortcut does not belong to this cleanup.
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
            catch (ArgumentException) { return null; }
            catch (COMException) { return null; }
        }

        private static void StartCleanup(string directory, bool silent, IEnumerable<ShortcutSnapshot> shortcuts)
        {
            // A hidden, in-memory helper waits for this executable to exit before deleting it.
            // It repeats the identity, canonical path and reparse checks immediately before removal.
            StringBuilder shortcutData = new StringBuilder("$ownedShortcuts = @(\r\n");
            foreach (ShortcutSnapshot shortcut in shortcuts)
                shortcutData.Append("@{ Path = ").Append(QuotePowerShell(shortcut.Path)).Append("; Hash = ").Append(QuotePowerShell(shortcut.Hash)).Append(" }\r\n");
            shortcutData.Append(")\r\n");
            string script = "$ErrorActionPreference = 'Stop'\r\n" +
                "$requested = " + QuotePowerShell(directory) + "\r\n" +
                "$ownerProcessId = " + Process.GetCurrentProcess().Id + "\r\n" +
                "$quiet = " + (silent ? "$true" : "$false") + "\r\n" + shortcutData + CleanupScript;
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetTempPath()
            };
            using (Process helper = Process.Start(start))
            {
                if (helper == null) throw new IOException("Не удалось запустить удаление приложения.");
            }
        }

        // Only manifest-listed files are removed; additional user files keep their containing folder.
        // All destructive filesystem operations use native PowerShell -LiteralPath without cmd.exe.
        private const string CleanupScript = @"
$operationMutex = $null
$operationAcquired = $false
try {
    $owner = Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue
    if ($null -ne $owner) {
        if (-not $owner.WaitForExit(30000)) { throw 'Не удалось дождаться закрытия программы удаления.' }
    }
    $operationName = 'Local\TravelTracker.Install.' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $operationMutex = New-Object Threading.Mutex($false, $operationName)
    try { $operationAcquired = $operationMutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $operationAcquired = $true }
    if (-not $operationAcquired) { throw 'Установка или удаление уже выполняется. Повторите попытку после завершения.' }
    $registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\TravelTracker'
    function Get-CanonicalDirectory([string] $value) {
        if ([String]::IsNullOrWhiteSpace($value) -or $value -notmatch '^[A-Za-z]:[\\/].+' -or $value -match '\p{Cc}') { throw 'Недопустимый путь установки.' }
        $normalized = $value.Replace('/', '\').TrimEnd('\')
        if ($normalized.Length -le 3) { throw 'Удаление из корня диска не поддерживается.' }
        foreach ($part in $normalized.Substring(3).Split('\')) {
            if ($part.Length -eq 0 -or $part -eq '.' -or $part -eq '..' -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'Недопустимый путь установки.' }
        }
        $full = [IO.Path]::GetFullPath($normalized).TrimEnd('\')
        $root = [IO.Path]::GetPathRoot($full)
        $drive = New-Object IO.DriveInfo($root)
        if ($full -eq $root.TrimEnd('\') -or $drive.DriveType -eq [IO.DriveType]::Network) { throw 'Недопустимая папка установки.' }
        return $full
    }
    function Get-RegisteredDirectory {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
        if ($null -eq $key) { throw 'Запись установки не найдена.' }
        try {
            $location = Get-CanonicalDirectory ([string] $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
            $command = [string] $key.GetValue('UninstallString', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $expectedCommand = [string][char]34 + [IO.Path]::Combine($location, 'Uninstall.exe') + [char]34
            if (-not [String]::Equals($command, $expectedCommand, [StringComparison]::OrdinalIgnoreCase)) { throw 'Запись удаления не соответствует папке приложения.' }
            return $location
        } finally { $key.Dispose() }
    }
    $expected = Get-RegisteredDirectory
    if (-not [String]::Equals((Get-CanonicalDirectory $requested), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Недопустимая папка приложения.' }
    $prefix = $expected.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    function Assert-NoRedirect([string] $candidate) {
        $current = [IO.Path]::GetFullPath($candidate)
        while (-not [String]::IsNullOrEmpty($current)) {
            if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
                if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Обнаружено перенаправление папки. Удаление отменено.' }
            }
            $parentPath = [IO.Path]::GetDirectoryName($current)
            if ($parentPath -eq $current) { break }
            $current = $parentPath
        }
    }
    function Get-CheckedEntries([string] $folder) {
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($folder)) {
            $full = [IO.Path]::GetFullPath($child)
            if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Недопустимый путь приложения.' }
            $attributes = [IO.File]::GetAttributes($full)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'В папке обнаружена ссылка. Удаление отменено.' }
            $full
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { Get-CheckedEntries $full }
        }
    }
    Assert-NoRedirect $expected
    $marker = [IO.Path]::Combine($expected, 'app.identity')
    if (-not [IO.File]::Exists($marker) -or [IO.File]::ReadAllText($marker).Trim() -cne 'travel-tracker-local-app-v1') { throw 'Не удалось подтвердить папку приложения.' }
    $entries = @(Get-CheckedEntries $expected)
    $manifest = [IO.Path]::Combine($expected, 'install.files')
    $files = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in [IO.File]::ReadAllLines($manifest, [Text.Encoding]::UTF8)) {
        if ([String]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or $relative -match '[\x00-\x1f]') { throw 'Повреждён список файлов приложения.' }
        foreach ($part in ($relative.Replace('\', '/').Split('/'))) {
            if ($part.Length -eq 0 -or $part -eq '.' -or $part -eq '..' -or $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'Повреждён путь файла приложения.' }
        }
        $full = [IO.Path]::GetFullPath([IO.Path]::Combine($expected, $relative))
        if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Directory]::Exists($full)) { throw 'Недопустимый путь файла приложения.' }
        Assert-NoRedirect $full
        [void] $files.Add($full)
    }
    foreach ($required in @('TravelTracker.exe', 'Uninstall.exe', 'app.identity', 'install.files')) {
        if (-not $files.Contains([IO.Path]::Combine($expected, $required))) { throw 'Список файлов приложения неполон.' }
    }
    $launcher = [IO.Path]::Combine($expected, 'TravelTracker.exe')
    if ([IO.File]::Exists($launcher)) {
        try {
            $probe = [IO.File]::Open($launcher, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $probe.Dispose()
        } catch { throw 'Закройте Карту путешествий через значок рядом с часами и повторите удаление.' }
    }
    foreach ($file in $files) {
        if ([IO.File]::Exists($file)) {
            try {
                $probe = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
                $probe.Dispose()
            } catch { throw ('Файл приложения используется. Закройте связанные программы и повторите удаление: ' + [IO.Path]::GetFileName($file)) }
        }
    }
    if (-not [String]::Equals((Get-RegisteredDirectory), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Запись установки изменилась. Удаление отменено.' }
    $lastFiles = @([IO.Path]::Combine($expected, 'Uninstall.exe'), $marker, $manifest)
    foreach ($file in ($files | Where-Object { $lastFiles -notcontains $_ })) {
        if ([IO.File]::Exists($file)) {
            Assert-NoRedirect $file
            if (-not ([IO.Path]::GetFullPath($file)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Недопустимый путь удаления.' }
            Remove-Item -LiteralPath $file -Force
        }
    }
    foreach ($folder in ($entries | Sort-Object Length -Descending)) {
        if ([IO.Directory]::Exists($folder)) {
            Assert-NoRedirect $folder
            if (-not ([IO.Path]::GetFullPath($folder)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Недопустимая папка удаления.' }
            if (@([IO.Directory]::EnumerateFileSystemEntries($folder)).Count -eq 0) { Remove-Item -LiteralPath $folder -Force }
        }
    }
    foreach ($snapshot in $ownedShortcuts) {
        $shortcutPath = [string] $snapshot.Path
        if (-not [IO.File]::Exists($shortcutPath)) { continue }
        try {
            Assert-NoRedirect $shortcutPath
            $hash = [Security.Cryptography.SHA256]::Create()
            try {
                $stream = [IO.File]::Open($shortcutPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                try { $actualHash = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
                finally { $stream.Dispose() }
            } finally { $hash.Dispose() }
            if ($actualHash -cne [string] $snapshot.Hash) { continue }
            Assert-NoRedirect $shortcutPath
        } catch { continue }
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    if (-not [String]::Equals((Get-RegisteredDirectory), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Запись установки изменилась. Удаление отменено.' }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath, $false)
    foreach ($file in $lastFiles) {
        Assert-NoRedirect $file
        if (-not ([IO.Path]::GetFullPath($file)).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Недопустимый путь удаления.' }
        if ([IO.File]::Exists($file)) { Remove-Item -LiteralPath $file -Force }
    }
    Assert-NoRedirect $expected
    if ([IO.Directory]::Exists($expected) -and @([IO.Directory]::EnumerateFileSystemEntries($expected)).Count -eq 0) { Remove-Item -LiteralPath $expected -Force }
} catch {
    if (-not $quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [void] [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Карта путешествий — удаление', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
    }
    exit 1
} finally {
    if ($null -ne $operationMutex) {
        if ($operationAcquired) { $operationMutex.ReleaseMutex() }
        $operationMutex.Dispose()
    }
}
";
    }
}
