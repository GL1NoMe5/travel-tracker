using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace TravelTracker.Windows
{
    // Explicit Unicode interfaces keep names and targets independent of the Windows ANSI code page.
    internal static class ShellLinks
    {
        private const int StringCapacity = 32768;
        private const int StgmReadShareDenyWrite = 0x20;
        private const uint SlgpRawPath = 0x4;

        internal static void Write(string path, string target, string workingDirectory, string description)
        {
            object native = new ShellLinkObject();
            try
            {
                IShellLinkW link = (IShellLinkW)native;
                string executable = Path.GetFullPath(target);
                link.SetPath(executable);
                link.SetWorkingDirectory(Path.GetFullPath(workingDirectory));
                link.SetArguments(String.Empty);
                link.SetDescription(description ?? String.Empty);
                link.SetIconLocation(executable, 0);
                link.SetShowCmd(1);
                ((IPersistFile)native).Save(Path.GetFullPath(path), true);
            }
            finally { Marshal.FinalReleaseComObject(native); }
        }

        internal static string ReadTarget(string path) { return ReadString(path, false); }
        internal static string ReadWorkingDirectory(string path) { return ReadString(path, true); }

        private static string ReadString(string path, bool workingDirectory)
        {
            object native = new ShellLinkObject();
            try
            {
                // Read-only loading also works while the caller holds a shared read handle.
                ((IPersistFile)native).Load(Path.GetFullPath(path), StgmReadShareDenyWrite);
                IShellLinkW link = (IShellLinkW)native;
                StringBuilder value = new StringBuilder(StringCapacity);
                if (workingDirectory) link.GetWorkingDirectory(value, value.Capacity);
                else link.GetPath(value, value.Capacity, IntPtr.Zero, SlgpRawPath);
                return value.ToString();
            }
            finally { Marshal.FinalReleaseComObject(native); }
        }

        [ComImport]
        [Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLinkObject { }

        // Preserve the complete native vtable order from the Windows SDK's IShellLinkW.
        // The runtime translates failing HRESULT values into COMException instances.
        [ComImport]
        [Guid("000214F9-0000-0000-C000-000000000046")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr findData, uint flags);
            void GetIDList(out IntPtr itemIdList);
            void SetIDList(IntPtr itemIdList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int capacity);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int capacity);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int capacity);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out ushort hotkey);
            void SetHotkey(ushort hotkey);
            void GetShowCmd(out int command);
            void SetShowCmd(int command);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
        }
    }
}
