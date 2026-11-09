using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace TravelTracker.Uninstall
{
    internal static class Uninstaller
    {
        private const string Identity = "travel-tracker-local-app-v1";
        private const string DisplayName = "Карта путешествий";

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
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (String.IsNullOrWhiteSpace(local)) throw new IOException("Не удалось найти папку приложений пользователя.");
                string expected = Path.GetFullPath(Path.Combine(local, "Programs", "TravelTracker"));
                string actual = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                if (!String.Equals(Path.GetFullPath(actual), expected, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Запустите удаление из установленной папки приложения или через параметры Windows.");
                ValidateInstallation(expected);
                if (!silent)
                {
                    Application.EnableVisualStyles();
                    if (MessageBox.Show("Удалить «Карту путешествий» с компьютера?\n\nСохранённые в браузере страны и места останутся.", DisplayName,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return 0;
                }
                EnsureLauncherClosed(expected);
                StartCleanup(expected, silent);
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

        private static void StartCleanup(string directory, bool silent)
        {
            // A hidden, in-memory helper waits for this executable to exit before deleting it.
            // It repeats the identity, canonical path and reparse checks immediately before removal.
            string script = "$ErrorActionPreference = 'Stop'\r\n" +
                "$requested = " + QuotePowerShell(directory) + "\r\n" +
                "$ownerProcessId = " + Process.GetCurrentProcess().Id + "\r\n" +
                "$quiet = " + (silent ? "$true" : "$false") + "\r\n" + CleanupScript;
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
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([String]::IsNullOrWhiteSpace($local)) { throw 'Папка приложений пользователя недоступна.' }
    $expected = [IO.Path]::GetFullPath([IO.Path]::Combine($local, 'Programs', 'TravelTracker'))
    if (-not [String]::Equals([IO.Path]::GetFullPath($requested), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Недопустимая папка приложения.' }
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
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($shortcutFolder in @([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory), [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs))) {
            $shortcutPath = [IO.Path]::Combine($shortcutFolder, 'Карта путешествий.lnk')
            if ([IO.File]::Exists($shortcutPath) -and (([IO.File]::GetAttributes($shortcutPath) -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
                $shortcut = $shell.CreateShortcut($shortcutPath)
                try {
                    if ([String]::Equals($shortcut.TargetPath, $launcher, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $shortcutPath -Force }
                } finally { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
            }
        }
    } finally { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    $registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\TravelTracker'
    $registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
    $ownedRegistry = $false
    if ($null -ne $registry) {
        try { $ownedRegistry = [String]::Equals([string] $registry.GetValue('InstallLocation'), $expected, [StringComparison]::OrdinalIgnoreCase) }
        finally { $registry.Dispose() }
    }
    if ($ownedRegistry) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath, $false) }
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
