using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TravelTracker.Setup
{
    internal static class Installer
    {
        internal const string Identity = "travel-tracker-local-app-v1";
        internal const string DisplayName = "Карта путешествий";
        private const string ManifestName = "install.files";
        private const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\TravelTracker";

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length == 2 && args[0] == "--extract")
                {
                    ExtractForInspection(args[1]);
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--silent")
                {
                    Install();
                    return 0;
                }
                if (args.Length != 0) throw new ArgumentException("Допустимые параметры: --silent или --extract <папка>.");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (SetupForm form = new SetupForm()) Application.Run(form);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                if (args.Length == 0) MessageBox.Show(error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        internal static string InstallDirectory
        {
            get
            {
                string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (String.IsNullOrWhiteSpace(local)) throw new IOException("Не удалось найти папку приложений пользователя.");
                return Path.GetFullPath(Path.Combine(local, "Programs", "TravelTracker"));
            }
        }

        private static void ExtractForInspection(string requestedDirectory)
        {
            string target = Path.GetFullPath(requestedDirectory);
            if (Path.GetPathRoot(target).TrimEnd(Path.DirectorySeparatorChar) == target.TrimEnd(Path.DirectorySeparatorChar))
                throw new IOException("Для распаковки нужна отдельная пустая папка.");
            EnsureNoReparseAncestors(target);
            if (File.Exists(target) || (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any()))
                throw new IOException("Папка распаковки должна быть пустой. Существующие файлы не изменены.");
            Directory.CreateDirectory(target);
            ExtractPayload(target);
        }

        internal static void Install()
        {
            using (Mutex operation = new Mutex(false, @"Local\TravelTracker.Install." + WindowsIdentity.GetCurrent().User.Value))
            {
                bool acquired;
                try { acquired = operation.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new IOException("Установка или удаление уже выполняется. Дождитесь завершения и попробуйте ещё раз.");
                try { InstallUnderLock(); }
                finally { operation.ReleaseMutex(); }
            }
        }

        private static void InstallUnderLock()
        {
            string target = InstallDirectory;
            string parent = Path.GetDirectoryName(target);
            EnsureNoReparseAncestors(target);
            Directory.CreateDirectory(parent);
            if (File.Exists(target)) throw new IOException("Путь установки занят файлом.");
            bool hadPrevious = Directory.Exists(target);
            if (hadPrevious)
            {
                ValidateInstalledDirectory(target);
                EnsureLauncherClosed(target);
            }

            string stage = Path.Combine(parent, ".TravelTracker-install-" + Guid.NewGuid().ToString("N"));
            string backup = Path.Combine(parent, ".TravelTracker-backup-" + Guid.NewGuid().ToString("N"));
            bool movedPrevious = false;
            bool installedNew = false;
            List<ShortcutBackup> shortcuts = new List<ShortcutBackup>();
            RegistryBackup registry = RegistryBackup.Capture(target);
            Directory.CreateDirectory(stage);
            try
            {
                ExtractPayload(stage);
                if (hadPrevious) PreserveUntrackedFiles(target, stage);
                foreach (string shortcut in ShortcutPaths()) shortcuts.Add(ShortcutBackup.Capture(shortcut, target));
                if (hadPrevious)
                {
                    EnsureLauncherClosed(target);
                    Directory.Move(target, backup);
                    movedPrevious = true;
                }
                Directory.Move(stage, target);
                installedNew = true;
                foreach (ShortcutBackup shortcut in shortcuts) WriteShortcut(shortcut.Path, target);
                WriteRegistry(target);
            }
            catch
            {
                foreach (ShortcutBackup shortcut in shortcuts)
                {
                    try { shortcut.Restore(); } catch { }
                }
                try { registry.Restore(); } catch { }
                if (installedNew && Directory.Exists(target)) DeleteVerifiedDirectory(target, target);
                if (movedPrevious && Directory.Exists(backup)) Directory.Move(backup, target);
                throw;
            }
            finally
            {
                if (Directory.Exists(stage)) DeleteTemporaryDirectory(stage, parent, ".TravelTracker-install-");
            }
            // The updated installation already contains copies of any untracked files.
            if (movedPrevious && Directory.Exists(backup))
            {
                try { DeleteTemporaryDirectory(backup, parent, ".TravelTracker-backup-"); }
                catch { /* A locked backup is harmless and must not roll back a working install. */ }
            }
        }

        private static void ExtractPayload(string destination)
        {
            EnsureNoReparseAncestors(destination);
            string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            List<string> files = new List<string>();
            HashSet<string> destinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("TravelTracker.Payload.zip"))
            {
                if (resource == null) throw new InvalidDataException("Установщик повреждён: отсутствуют файлы приложения.");
                using (ZipArchive zip = new ZipArchive(resource, ZipArchiveMode.Read, false))
                {
                    if (zip.Entries.Count > 10000) throw new InvalidDataException("Слишком много файлов в установщике.");
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        string relative = ValidateRelativePath(entry.FullName);
                        if (String.Equals(relative, ManifestName, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Установщик содержит зарезервированный файл.");
                        int unixType = (entry.ExternalAttributes >> 16) & 0xF000;
                        if (unixType == 0xA000 || (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                            throw new InvalidDataException("Ссылки внутри установщика не поддерживаются.");
                        string path = Path.GetFullPath(Path.Combine(root, relative));
                        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Недопустимый путь в установщике.");
                        EnsureNoReparseAncestors(path);
                        if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                        {
                            Directory.CreateDirectory(path);
                            continue;
                        }
                        if (!destinations.Add(path)) throw new InvalidDataException("Повторяющийся файл в установщике.");
                        total = checked(total + entry.Length);
                        if (total > 256L * 1024 * 1024) throw new InvalidDataException("Размер файлов установщика превышает допустимый.");
                        Directory.CreateDirectory(Path.GetDirectoryName(path));
                        using (Stream input = entry.Open())
                        using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                        files.Add(relative.Replace(Path.DirectorySeparatorChar, '/'));
                    }
                }
            }
            string baseDirectory = root.TrimEnd(Path.DirectorySeparatorChar);
            if (!File.Exists(Path.Combine(baseDirectory, "TravelTracker.exe")) ||
                !File.Exists(Path.Combine(baseDirectory, "Uninstall.exe")) ||
                !File.Exists(Path.Combine(baseDirectory, "wwwroot", "index.html")) ||
                !File.Exists(Path.Combine(baseDirectory, "app.identity")) ||
                File.ReadAllText(Path.Combine(baseDirectory, "app.identity")).Trim() != Identity)
                throw new InvalidDataException("Установщик повреждён: набор файлов приложения неполон.");
            files.Add(ManifestName);
            File.WriteAllLines(Path.Combine(baseDirectory, ManifestName), files.OrderBy(value => value, StringComparer.OrdinalIgnoreCase), new UTF8Encoding(false));
        }

        private static string ValidateRelativePath(string name)
        {
            if (String.IsNullOrWhiteSpace(name) || Path.IsPathRooted(name) || name.IndexOf(':') >= 0 || name.Any(Char.IsControl))
                throw new InvalidDataException("Недопустимое имя файла в установщике.");
            string[] parts = name.Replace('\\', '/').TrimEnd('/').Split('/');
            if (parts.Any(part => part.Length == 0 || part == "." || part == ".." || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || IsDeviceName(part)))
                throw new InvalidDataException("Недопустимый путь в установщике.");
            return String.Join(Path.DirectorySeparatorChar.ToString(), parts);
        }

        private static bool IsDeviceName(string part)
        {
            string stem = part.Split('.')[0].ToUpperInvariant();
            return stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
                (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) && stem[3] >= '1' && stem[3] <= '9');
        }

        private static HashSet<string> ReadInstalledFiles(string directory)
        {
            string manifest = Path.Combine(directory, ManifestName);
            if (!File.Exists(manifest)) throw new IOException("Список установленных файлов отсутствует. Сначала переместите прежнюю папку приложения.");
            HashSet<string> files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string line in File.ReadAllLines(manifest, Encoding.UTF8)) files.Add(ValidateRelativePath(line));
            if (!files.Contains("TravelTracker.exe") || !files.Contains("Uninstall.exe") || !files.Contains("app.identity") || !files.Contains(ManifestName))
                throw new IOException("Список установленных файлов повреждён. Прежние файлы не изменены.");
            return files;
        }

        private static void PreserveUntrackedFiles(string oldDirectory, string newDirectory)
        {
            HashSet<string> oldFiles = ReadInstalledFiles(oldDirectory);
            string prefix = oldDirectory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            foreach (string oldFile in Directory.EnumerateFiles(oldDirectory, "*", SearchOption.AllDirectories))
            {
                string relative = oldFile.Substring(prefix.Length);
                if (oldFiles.Contains(relative)) continue;
                string newFile = Path.Combine(newDirectory, relative);
                if (File.Exists(newFile) || Directory.Exists(newFile)) throw new IOException("В папке приложения найден собственный файл, совпадающий с новой версией. Переместите его перед обновлением: " + relative);
                Directory.CreateDirectory(Path.GetDirectoryName(newFile));
                File.Copy(oldFile, newFile, false);
            }
        }

        private static void ValidateInstalledDirectory(string directory)
        {
            EnsureNoReparseTree(directory);
            string marker = Path.Combine(directory, "app.identity");
            if (!File.Exists(marker) || File.ReadAllText(marker).Trim() != Identity)
                throw new IOException("Папка установки содержит другие файлы. Они не будут изменены: " + directory);
            ReadInstalledFiles(directory);
        }

        internal static void EnsureLauncherClosed(string directory)
        {
            string executable = Path.Combine(directory, "TravelTracker.exe");
            if (!File.Exists(executable)) return;
            try { using (FileStream probe = new FileStream(executable, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } }
            catch (IOException) { throw new IOException("Закройте «Карту путешествий» через значок рядом с часами и повторите установку."); }
            catch (UnauthorizedAccessException) { throw new IOException("Не удалось обновить приложение. Закройте его через значок рядом с часами и проверьте доступ к папке установки."); }
        }

        private static void EnsureNoReparseAncestors(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Папка установки не должна содержать символические ссылки или перенаправления.");
                string parent = Path.GetDirectoryName(current);
                if (parent == current) break;
                current = parent;
            }
        }

        private static void EnsureNoReparseTree(string directory)
        {
            EnsureNoReparseAncestors(directory);
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
            {
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("В папке приложения найдена ссылка. Файлы оставлены без изменений.");
                if ((attributes & FileAttributes.Directory) != 0) EnsureNoReparseTree(entry);
            }
        }

        private static void DeleteTemporaryDirectory(string directory, string parent, string prefix)
        {
            string full = Path.GetFullPath(directory);
            if (!String.Equals(Path.GetDirectoryName(full), Path.GetFullPath(parent), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(full).StartsWith(prefix, StringComparison.Ordinal))
                throw new IOException("Недопустимая временная папка.");
            EnsureNoReparseTree(full);
            Directory.Delete(full, true);
        }

        private static void DeleteVerifiedDirectory(string directory, string expected)
        {
            if (!String.Equals(Path.GetFullPath(directory), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new IOException("Недопустимая папка отката.");
            ValidateInstalledDirectory(directory);
            Directory.Delete(directory, true);
        }

        private static IEnumerable<string> ShortcutPaths()
        {
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DisplayName + ".lnk");
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), DisplayName + ".lnk");
        }

        private static object CreateShell() { return Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true)); }
        private static object GetShortcut(object shell, string path) { return shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path }); }
        private static void SetProperty(object value, string name, object property) { value.GetType().InvokeMember(name, BindingFlags.SetProperty, null, value, new object[] { property }); }

        private static string ShortcutTarget(string path)
        {
            object shell = null, shortcut = null;
            try
            {
                shell = CreateShell(); shortcut = GetShortcut(shell, path);
                return Convert.ToString(shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null));
            }
            finally { if (shortcut != null) Marshal.FinalReleaseComObject(shortcut); if (shell != null) Marshal.FinalReleaseComObject(shell); }
        }

        private static void WriteShortcut(string path, string directory)
        {
            object shell = null, shortcut = null;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                shell = CreateShell(); shortcut = GetShortcut(shell, path);
                string executable = Path.Combine(directory, "TravelTracker.exe");
                SetProperty(shortcut, "TargetPath", executable);
                SetProperty(shortcut, "WorkingDirectory", directory);
                SetProperty(shortcut, "Arguments", "");
                SetProperty(shortcut, "IconLocation", executable + ",0");
                SetProperty(shortcut, "Description", DisplayName);
                shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally { if (shortcut != null) Marshal.FinalReleaseComObject(shortcut); if (shell != null) Marshal.FinalReleaseComObject(shell); }
        }

        private sealed class ShortcutBackup
        {
            internal string Path;
            private byte[] bytes;
            internal static ShortcutBackup Capture(string path, string directory)
            {
                ShortcutBackup result = new ShortcutBackup { Path = path };
                if (File.Exists(path))
                {
                    if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || !String.Equals(System.IO.Path.GetFullPath(ShortcutTarget(path)), System.IO.Path.Combine(directory, "TravelTracker.exe"), StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Ярлык с таким именем уже используется другим приложением: " + path);
                    result.bytes = File.ReadAllBytes(path);
                }
                return result;
            }
            internal void Restore() { if (bytes == null) { if (File.Exists(Path)) File.Delete(Path); } else File.WriteAllBytes(Path, bytes); }
        }

        private static void WriteRegistry(string directory)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryPath))
            {
                key.SetValue("DisplayName", DisplayName);
                key.SetValue("DisplayVersion", Assembly.GetExecutingAssembly().GetName().Version.ToString(3));
                key.SetValue("Publisher", "GL1NoMe5");
                key.SetValue("InstallLocation", directory);
                key.SetValue("DisplayIcon", Path.Combine(directory, "TravelTracker.exe"));
                key.SetValue("UninstallString", "\"" + Path.Combine(directory, "Uninstall.exe") + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        private sealed class RegistryBackup
        {
            private bool existed;
            private Dictionary<string, object> values = new Dictionary<string, object>();
            private Dictionary<string, RegistryValueKind> kinds = new Dictionary<string, RegistryValueKind>();
            internal static RegistryBackup Capture(string directory)
            {
                RegistryBackup result = new RegistryBackup();
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath))
                {
                    if (key == null) return result;
                    result.existed = true;
                    if (!String.Equals(Convert.ToString(key.GetValue("InstallLocation")), directory, StringComparison.OrdinalIgnoreCase)) throw new IOException("Запись установки принадлежит другой папке. Приложение не изменено.");
                    foreach (string name in key.GetValueNames()) { result.values.Add(name, key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames)); result.kinds.Add(name, key.GetValueKind(name)); }
                }
                return result;
            }
            internal void Restore()
            {
                if (!existed) { Registry.CurrentUser.DeleteSubKeyTree(RegistryPath, false); return; }
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryPath))
                {
                    foreach (string name in key.GetValueNames()) if (!values.ContainsKey(name)) key.DeleteValue(name, false);
                    foreach (KeyValuePair<string, object> item in values) key.SetValue(item.Key, item.Value, kinds[item.Key]);
                }
            }
        }

        private sealed class SetupForm : Form
        {
            private readonly Button installButton = new Button();
            private readonly CheckBox launch = new CheckBox();
            private readonly Label status = new Label();
            private bool working;
            internal SetupForm()
            {
                Text = DisplayName + " — установка";
                ClientSize = new Size(520, 300);
                Font = new Font("Segoe UI", 10F);
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
                BackColor = Color.FromArgb(245, 245, 242);
                try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
                Label title = new Label { Text = DisplayName, Font = new Font("Segoe UI", 21F, FontStyle.Regular), AutoSize = false, Location = new Point(28, 22), Size = new Size(464, 44) };
                Label description = new Label { Text = "Ваши страны, места и воспоминания — на одной карте.\nПриложение откроется в вашем браузере.", Location = new Point(28, 80), Size = new Size(464, 48) };
                Label folder = new Label { Text = "Папка установки", Location = new Point(28, 144), Size = new Size(464, 22) };
                TextBox location = new TextBox { Text = InstallDirectory, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = BackColor, Location = new Point(28, 170), Size = new Size(464, 24) };
                launch.Text = "Открыть приложение после установки"; launch.Checked = true; launch.Location = new Point(28, 212); launch.Size = new Size(300, 28);
                installButton.Text = "Установить"; installButton.Location = new Point(356, 214); installButton.Size = new Size(136, 42); installButton.BackColor = Color.FromArgb(185, 73, 47); installButton.ForeColor = Color.White; installButton.FlatStyle = FlatStyle.Flat; installButton.FlatAppearance.BorderSize = 0;
                installButton.Click += InstallClick;
                status.Location = new Point(28, 264); status.Size = new Size(464, 24); status.ForeColor = Color.FromArgb(97, 107, 107);
                Controls.AddRange(new Control[] { title, description, folder, location, launch, installButton, status });
                AcceptButton = installButton;
                FormClosing += delegate(object sender, FormClosingEventArgs e) { if (working) e.Cancel = true; };
            }
            private void InstallClick(object sender, EventArgs e)
            {
                working = true; installButton.Enabled = false; launch.Enabled = false; status.Text = "Устанавливаем приложение…"; Cursor = Cursors.WaitCursor;
                Refresh();
                bool success = false;
                try
                {
                    Install();
                    success = true;
                    if (launch.Checked) Process.Start(new ProcessStartInfo(Path.Combine(InstallDirectory, "TravelTracker.exe")) { UseShellExecute = true, WorkingDirectory = InstallDirectory });
                }
                catch (Exception error)
                {
                    status.Text = success ? "Установлено. Откройте приложение с рабочего стола." : "Установка не завершена";
                    MessageBox.Show(this, error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally { working = false; installButton.Enabled = true; launch.Enabled = true; Cursor = Cursors.Default; }
                if (success) Close();
            }
        }
    }
}
