// Built with the Windows .NET Framework compiler; no Node.js is needed at runtime.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace TravelTracker.Desktop
{
    internal static class Program
    {
        internal const int Port = 5173;
        internal const string Address = "http://127.0.0.1:5173/";
        internal const string HealthPath = "/__travel_tracker/health";
        internal const string HealthBody = "{\"app\":\"travel-tracker\",\"protocol\":1}";

        [STAThread]
        public static int Main(string[] args)
        {
            bool headless = false;
            bool openBrowser = true;
            string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot");
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--headless") headless = true;
                    else if (args[i] == "--no-browser") openBrowser = false;
                    else if (args[i] == "--root" && i + 1 < args.Length) root = args[++i];
                    else throw new ArgumentException("Неизвестный или неполный параметр: " + args[i]);
                }

                // A second shortcut activation reuses the first copy and its stable origin.
                if (IsExistingInstance())
                {
                    if (openBrowser) OpenBrowser();
                    return 0;
                }

                using (StaticServer server = new StaticServer(root))
                {
                    try { server.Start(); }
                    catch (SocketException)
                    {
                        // Another instance may have won the bind between the probe and Start.
                        if (IsExistingInstance())
                        {
                            if (openBrowser) OpenBrowser();
                            return 0;
                        }
                        throw new InvalidOperationException(
                            "Не удалось открыть карту: порт 5173 занят другим приложением. " +
                            "Закройте приложение, использующее этот порт, и запустите карту снова.");
                    }

                    if (openBrowser)
                    {
                        try { OpenBrowser(); }
                        catch (Exception error)
                        {
                            if (headless) throw;
                            // Keep the local server alive so the suggested manual URL works.
                            MessageBox.Show(error.Message, "Карта путешествий", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                    }
                    if (headless)
                    {
                        using (ManualResetEvent stop = new ManualResetEvent(false))
                        {
                            ConsoleCancelEventHandler cancel = delegate(object sender, ConsoleCancelEventArgs e)
                            {
                                e.Cancel = true;
                                stop.Set();
                            };
                            Console.CancelKeyPress += cancel;
                            try { stop.WaitOne(); }
                            finally { Console.CancelKeyPress -= cancel; }
                        }
                    }
                    else
                    {
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        using (TrayContext context = new TrayContext()) Application.Run(context);
                    }
                }
                return 0;
            }
            catch (Exception error)
            {
                if (headless) Console.Error.WriteLine(error.Message);
                else MessageBox.Show(error.Message, "Карта путешествий", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static bool IsExistingInstance()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Address.TrimEnd('/') + HealthPath);
                request.Proxy = null;
                request.Timeout = 750;
                request.ReadWriteTimeout = 750;
                request.AllowAutoRedirect = false;
                request.KeepAlive = false;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK || response.Headers["X-Travel-Tracker"] != "1") return false;
                    if (response.ContentLength != Encoding.UTF8.GetByteCount(HealthBody)) return false;
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    {
                        char[] body = new char[HealthBody.Length + 1];
                        int count = reader.ReadBlock(body, 0, body.Length);
                        return count == HealthBody.Length && new string(body, 0, count) == HealthBody;
                    }
                }
            }
            catch (WebException) { return false; }
            catch (IOException) { return false; }
        }

        internal static void OpenBrowser()
        {
            try { Process.Start(new ProcessStartInfo(Address) { UseShellExecute = true }); }
            catch (Exception error)
            {
                throw new InvalidOperationException("Не удалось открыть браузер. Откройте " + Address + " вручную.\n" + error.Message);
            }
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu;
        private readonly Icon appIcon;

        public TrayContext()
        {
            menu = new ContextMenuStrip();
            menu.Items.Add("Открыть карту", null, delegate { OpenMap(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Выйти", null, delegate { ExitThread(); });
            appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon = new NotifyIcon();
            icon.Icon = appIcon ?? SystemIcons.Application;
            icon.Text = "Карта путешествий";
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenMap(); };
            icon.Visible = true;
        }

        private static void OpenMap()
        {
            try { Program.OpenBrowser(); }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Карта путешествий", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                icon.Visible = false;
                icon.Dispose();
                menu.Dispose();
                if (appIcon != null) appIcon.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class StaticServer : IDisposable
    {
        private const int MaximumHeaderBytes = 16384;
        private const int MaximumConnections = 16;
        private readonly string root;
        private readonly string rootPrefix;
        private readonly TcpListener listener;
        private readonly SemaphoreSlim slots = new SemaphoreSlim(MaximumConnections, MaximumConnections);
        private readonly ConcurrentDictionary<TcpClient, byte> clients = new ConcurrentDictionary<TcpClient, byte>();
        private Thread acceptThread;
        private int stopped;

        internal StaticServer(string directory)
        {
            root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            rootPrefix = root + Path.DirectorySeparatorChar;
            if (!Directory.Exists(root) || HasUnsafeAttributes(root) || !File.Exists(Path.Combine(root, "index.html")))
                throw new InvalidOperationException("Файлы карты не найдены. Установите приложение заново.");
            if (HasUnsafeAttributes(Path.Combine(root, "index.html")))
                throw new InvalidOperationException("Файлы карты недоступны. Установите приложение заново.");
            listener = new TcpListener(IPAddress.Loopback, Program.Port);
            listener.Server.ExclusiveAddressUse = true;
        }

        internal void Start()
        {
            listener.Start(32);
            acceptThread = new Thread(AcceptLoop);
            acceptThread.IsBackground = true;
            acceptThread.Name = "Travel Tracker local web server";
            acceptThread.Start();
        }

        private void AcceptLoop()
        {
            while (Volatile.Read(ref stopped) == 0)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch (SocketException) { return; }
                catch (ObjectDisposedException) { return; }
                if (!slots.Wait(0)) { client.Close(); continue; }
                client.NoDelay = true;
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 5000;
                clients.TryAdd(client, 0);
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try { Handle(client); }
                    catch (IOException) { }
                    catch (SocketException) { }
                    catch (ObjectDisposedException) { }
                    catch (Exception) { /* A malformed local request must not stop the application. */ }
                    finally
                    {
                        byte ignored;
                        clients.TryRemove(client, out ignored);
                        client.Close();
                        slots.Release();
                    }
                });
            }
        }

        private void Handle(TcpClient client)
        {
            using (NetworkStream stream = client.GetStream())
            {
                bool head = false;
                try
                {
                    string header = ReadHeader(stream);
                    string[] lines = header.Split(new string[] { "\r\n" }, StringSplitOptions.None);
                    string[] request = lines[0].Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (request.Length != 3 || (request[2] != "HTTP/1.1" && request[2] != "HTTP/1.0"))
                        throw new RequestFailure(400, "Bad Request");
                    head = request[0] == "HEAD";
                    if (request[0] != "GET" && !head) throw new RequestFailure(405, "Method Not Allowed");
                    ValidateHeaders(lines);
                    string path = ResolvePath(request[1]);
                    if (path == Program.HealthPath)
                    {
                        SendBytes(stream, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(Program.HealthBody), head);
                        return;
                    }
                    string mime = MimeType(Path.GetExtension(path));
                    if (mime == null || !File.Exists(path) || HasUnsafePath(path)) throw new RequestFailure(404, "Not Found");
                    using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        SendHeader(stream, 200, "OK", mime, file.Length);
                        if (!head) file.CopyTo(stream, 65536);
                    }
                }
                catch (RequestFailure error)
                {
                    SendBytes(stream, error.Status, error.Reason, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(error.Reason), head);
                }
                catch (UnauthorizedAccessException)
                {
                    SendBytes(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found"), head);
                }
                catch (FileNotFoundException)
                {
                    SendBytes(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found"), head);
                }
                catch (DirectoryNotFoundException)
                {
                    SendBytes(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found"), head);
                }
            }
        }

        private static string ReadHeader(NetworkStream stream)
        {
            byte[] bytes = new byte[MaximumHeaderBytes];
            int used = 0;
            while (used < bytes.Length)
            {
                int count = stream.Read(bytes, used, Math.Min(2048, bytes.Length - used));
                if (count == 0) throw new RequestFailure(400, "Bad Request");
                int scanFrom = Math.Max(0, used - 3);
                used += count;
                for (int i = scanFrom; i + 3 < used; i++)
                {
                    if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10)
                    {
                        for (int j = 0; j < i; j++)
                            if (bytes[j] > 126 || (bytes[j] < 32 && bytes[j] != 9 && bytes[j] != 10 && bytes[j] != 13))
                                throw new RequestFailure(400, "Bad Request");
                        return Encoding.ASCII.GetString(bytes, 0, i);
                    }
                }
            }
            throw new RequestFailure(431, "Request Header Fields Too Large");
        }

        private static void ValidateHeaders(string[] lines)
        {
            string host = null;
            string origin = null;
            for (int i = 1; i < lines.Length; i++)
            {
                string line = lines[i];
                int separator = line.IndexOf(':');
                if (separator <= 0 || Char.IsWhiteSpace(line[0])) throw new RequestFailure(400, "Bad Request");
                string name = line.Substring(0, separator);
                for (int j = 0; j < name.Length; j++)
                    if (!(Char.IsLetterOrDigit(name[j]) || name[j] == '-')) throw new RequestFailure(400, "Bad Request");
                string value = line.Substring(separator + 1).Trim();
                if (value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) throw new RequestFailure(400, "Bad Request");
                if (name.Equals("Host", StringComparison.OrdinalIgnoreCase))
                {
                    if (host != null) throw new RequestFailure(400, "Bad Request");
                    host = value;
                }
                else if (name.Equals("Origin", StringComparison.OrdinalIgnoreCase))
                {
                    if (origin != null) throw new RequestFailure(400, "Bad Request");
                    origin = value;
                }
                else if (name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) throw new RequestFailure(400, "Bad Request");
                else if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) && value != "0") throw new RequestFailure(400, "Bad Request");
            }
            if (host != "127.0.0.1:5173" && !String.Equals(host, "localhost:5173", StringComparison.OrdinalIgnoreCase))
                throw new RequestFailure(403, "Forbidden");
            if (origin != null && origin != "http://127.0.0.1:5173" && !String.Equals(origin, "http://localhost:5173", StringComparison.OrdinalIgnoreCase))
                throw new RequestFailure(403, "Forbidden");
        }

        private string ResolvePath(string target)
        {
            if (!target.StartsWith("/", StringComparison.Ordinal) || target.StartsWith("//", StringComparison.Ordinal))
                throw new RequestFailure(400, "Bad Request");
            int query = target.IndexOf('?');
            string encoded = query < 0 ? target : target.Substring(0, query);
            for (int i = 0; i < encoded.Length; i++)
            {
                if (encoded[i] != '%') continue;
                if (i + 2 >= encoded.Length || !Uri.IsHexDigit(encoded[i + 1]) || !Uri.IsHexDigit(encoded[i + 2]))
                    throw new RequestFailure(400, "Bad Request");
                i += 2;
            }
            string path;
            try { path = Uri.UnescapeDataString(encoded); }
            catch (UriFormatException) { throw new RequestFailure(400, "Bad Request"); }
            if (path == Program.HealthPath) return path;
            if (path == "/") path = "/index.html";
            if (path.IndexOf('\\') >= 0 || path.IndexOf('\0') >= 0 || path.IndexOf('#') >= 0)
                throw new RequestFailure(400, "Bad Request");
            string[] segments = path.Substring(1).Split('/');
            foreach (string segment in segments)
            {
                if (segment.Length == 0 || segment[0] == '.' || segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal))
                    throw new RequestFailure(400, "Bad Request");
                if (segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new RequestFailure(400, "Bad Request");
            }
            string full;
            try { full = Path.GetFullPath(Path.Combine(root, String.Join(Path.DirectorySeparatorChar.ToString(), segments))); }
            catch (ArgumentException) { throw new RequestFailure(400, "Bad Request"); }
            catch (NotSupportedException) { throw new RequestFailure(400, "Bad Request"); }
            catch (PathTooLongException) { throw new RequestFailure(400, "Bad Request"); }
            if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)) throw new RequestFailure(403, "Forbidden");
            return full;
        }

        private bool HasUnsafePath(string path)
        {
            string relative = path.Substring(rootPrefix.Length);
            string current = root;
            if (HasUnsafeAttributes(current)) return true;
            foreach (string segment in relative.Split(Path.DirectorySeparatorChar))
            {
                current = Path.Combine(current, segment);
                if (HasUnsafeAttributes(current)) return true;
            }
            return false;
        }

        private static bool HasUnsafeAttributes(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            return (attributes & (FileAttributes.ReparsePoint | FileAttributes.Hidden | FileAttributes.System)) != 0;
        }

        private static string MimeType(string extension)
        {
            switch (extension.ToLowerInvariant())
            {
                case ".html": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".geojson": return "application/geo+json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".gif": return "image/gif";
                case ".ico": return "image/x-icon";
                case ".ttf": return "font/ttf";
                case ".otf": return "font/otf";
                case ".woff": return "font/woff";
                case ".woff2": return "font/woff2";
                case ".wasm": return "application/wasm";
                case ".txt": return "text/plain; charset=utf-8";
                default: return null;
            }
        }

        private static void SendHeader(NetworkStream stream, int status, string reason, string mime, long length)
        {
            StringBuilder header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
            header.Append("Content-Type: ").Append(mime).Append("\r\n");
            header.Append("Content-Length: ").Append(length).Append("\r\n");
            header.Append("Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n");
            header.Append("X-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors 'none'\r\n");
            header.Append("Cross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: strict-origin-when-cross-origin\r\n");
            header.Append("X-Travel-Tracker: 1\r\n");
            if (status == 405) header.Append("Allow: GET, HEAD\r\n");
            header.Append("\r\n");
            byte[] bytes = Encoding.ASCII.GetBytes(header.ToString());
            stream.Write(bytes, 0, bytes.Length);
        }

        private static void SendBytes(NetworkStream stream, int status, string reason, string mime, byte[] body, bool head)
        {
            SendHeader(stream, status, reason, mime, body.LongLength);
            if (!head) stream.Write(body, 0, body.Length);
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref stopped, 1) != 0) return;
            listener.Stop();
            foreach (TcpClient client in clients.Keys) client.Close();
            if (acceptThread != null && acceptThread != Thread.CurrentThread) acceptThread.Join(1000);
        }
    }

    internal sealed class RequestFailure : Exception
    {
        internal readonly int Status;
        internal readonly string Reason;
        internal RequestFailure(int status, string reason) { Status = status; Reason = reason; }
    }
}
