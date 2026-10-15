using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    public static bool ResumeAfterStartup;
    [STAThread]
    private static void Main(string[] args)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        ServicePointManager.DefaultConnectionLimit = 12;
        ResumeAfterStartup = Array.IndexOf(args, "--resume") >= 0;
        if (Array.IndexOf(args, "--self-test") >= 0)
        {
            var report = new Dictionary<string, object>();
            foreach (string file in new string[] { "runtime/node.exe", "server.mjs", "shared.js", "desktop/worker.js", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" })
                report[file] = File.Exists(Path.Combine(Root, file));
            try { report["WebView2Runtime"] = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (Exception error) { report["WebView2RuntimeError"] = error.Message; }
            File.WriteAllText(Path.Combine(Root, "logs/desktop-self-test.json"), new JavaScriptSerializer().Serialize(report));
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool created;
        using (var mutex = new Mutex(true, "Local\\IsaacWikiDownloaderDesktopV1", out created))
        {
            if (!created) { MessageBox.Show("下载器已在运行，请切换到已打开的程序。", "以撒 Wiki"); return; }
            Application.Run(new Downloader());
        }
    }
}

internal sealed class DownloadBlockedException : Exception
{
    public readonly int StatusCode;
    public readonly int RetryAfterMs;
    public DownloadBlockedException(string message, int statusCode = 0, int retryAfterMs = 0) : base(message) { StatusCode = statusCode; RetryAfterMs = retryAfterMs; }
}

internal sealed class Downloader : Form
{
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 100 * 1024 * 1024, RecursionLimit = 256 };
    private readonly HttpClient local = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(120) };
    private readonly Dictionary<string, TaskCompletionSource<Dictionary<string, object>>> messages = new Dictionary<string, TaskCompletionSource<Dictionary<string, object>>>();
    private readonly WebView2 source = new WebView2 { Dock = DockStyle.Fill };
    private readonly WebView2 resources = new WebView2 { Dock = DockStyle.Fill };
    private readonly WebView2 reader = new WebView2 { Dock = DockStyle.Fill };
    private readonly TabControl tabs = new TabControl { Dock = DockStyle.Fill };
    private readonly TabPage progressTab = new TabPage("下载进度");
    private readonly TabPage sourceTab = new TabPage("原站验证");
    private readonly TabPage resourceTab = new TabPage("素材验证");
    private readonly TabPage readerTab = new TabPage("离线阅读");
    private readonly Label status = new Label { AutoSize = false, Dock = DockStyle.Top, Height = 68, Padding = new Padding(22, 18, 15, 5), Text = "正在初始化下载器……", Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold) };
    private readonly Label counters = new Label { AutoSize = false, Dock = DockStyle.Top, Height = 82, Padding = new Padding(22, 12, 12, 12), Font = new Font("Microsoft YaHei UI", 12F) };
    private readonly TextBox log = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font("Microsoft YaHei UI", 10F), BackColor = Color.FromArgb(245, 247, 248), BorderStyle = BorderStyle.None };
    private readonly Button start = MakeButton("开始 / 继续下载");
    private readonly Button pause = MakeButton("暂停");
    private readonly Button verify = MakeButton("连接 / 验证原站");
    private readonly Button read = MakeButton("浏览本地 Wiki");
    private readonly Button retry = MakeButton("重试失败任务");
    private readonly ComboBox speed = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, Margin = new Padding(12, 6, 4, 0) };
    private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 2000 };
    private Process ownedServer;
    private string token;
    private bool initialized, running, closing, closeRequested, refreshing;
    private bool runInProgress;
    private int laneDelayMs = 200;
    private int pageWorkers = 2;
    private long sessionCompleted;
    private readonly Stopwatch sessionTimer = new Stopwatch();
    private Task downloadRun;
    private bool resumePending = Program.ResumeAfterStartup;
    private TaskCompletionSource<Dictionary<string, object>> pendingAsset;
    private string assetUrl;
    private string assetMime;
    private readonly HashSet<string> receivingAssets = new HashSet<string>();

    public Downloader()
    {
        Text = "以撒 Wiki 离线下载器 · 加速版"; Width = 1180; Height = 820; MinimumSize = new Size(1000, 620);
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 10F);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 96, Padding = new Padding(14, 12, 10, 10), BackColor = Color.FromArgb(24, 44, 53) };
        toolbar.Controls.AddRange(new Control[] { start, pause, verify, read, retry });
        speed.Items.AddRange(new object[] { "稳妥：1 路 / 350 ms", "加速：2 路 / 200 ms", "更快：4 路 / 150 ms" });
        speed.SelectedIndex = 1; toolbar.Controls.Add(speed);
        var notes = new Label { Dock = DockStyle.Bottom, Height = 88, Padding = new Padding(20, 12, 12, 8), Text = "保存位置：" + Program.Root + "\\site\r\n下载原站当前公开页面和素材，可暂停续传。验证在程序内部完成，无需打开 Chrome。\r\n历史修订、编辑和复杂网页动画不属于静态离线版。", BackColor = Color.FromArgb(232, 240, 236) };
        progressTab.Controls.Add(log); progressTab.Controls.Add(counters); progressTab.Controls.Add(status);
        sourceTab.Controls.Add(source); resourceTab.Controls.Add(resources); readerTab.Controls.Add(reader);
        tabs.TabPages.AddRange(new TabPage[] { progressTab, sourceTab, resourceTab, readerTab });
        Controls.Add(tabs); Controls.Add(notes); Controls.Add(toolbar);
        start.Enabled = false; pause.Enabled = false;
        start.Click += async delegate { downloadRun = StartDownload(); await downloadRun; };
        pause.Click += async delegate { running = false; await SafePause(); Append("暂停已请求，当前任务处理后停止。"); };
        verify.Click += async delegate { if (!initialized) return; running = false; await SafePause(); if (downloadRun != null) await downloadRun; source.CoreWebView2.Navigate("https://isaac.huijiwiki.com/wiki/"); tabs.SelectedTab = sourceTab; };
        read.Click += delegate { if (!initialized) return; reader.CoreWebView2.Navigate("http://127.0.0.1:8765/"); tabs.SelectedTab = readerTab; };
        retry.Click += async delegate { try { await Api("/api/control", new { action = "retry" }); Append("失败任务已重新排队，请点击开始 / 继续下载。"); } catch (Exception e) { Append(e.Message); } };
        poll.Tick += async delegate { await RefreshStats(); };
        Shown += async delegate { await Initialize(); };
        FormClosing += async delegate(object sender, FormClosingEventArgs e)
        {
            if (closing) return;
            if (closeRequested) { e.Cancel = true; return; }
            closeRequested = true;
            e.Cancel = true; running = false; poll.Stop();
            await SafePause();
            if (downloadRun != null) await downloadRun;
            try { await Api("/api/control", new { action = "checkpoint" }); } catch { }
            closing = true; Close();
        };
        FormClosed += delegate
        {
            foreach (var message in messages.Values) message.TrySetCanceled();
            if (pendingAsset != null) pendingAsset.TrySetCanceled();
            source.Dispose(); resources.Dispose(); reader.Dispose(); local.Dispose();
            try { if (ownedServer != null && !ownedServer.HasExited) ownedServer.Kill(); } catch { }
        };
    }

    private static Button MakeButton(string text)
    {
        return new Button { Text = text, AutoSize = true, Height = 38, Padding = new Padding(8, 4, 8, 4), Margin = new Padding(4, 0, 4, 0), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(168, 218, 191), ForeColor = Color.FromArgb(18, 36, 27) };
    }
    private void Append(string text)
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action<string>(Append), text); return; }
        if (log.TextLength > 120000) log.Text = log.Text.Substring(log.TextLength - 60000);
        log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + text + Environment.NewLine);
    }
    private static string Value(Dictionary<string, object> value, string key)
    {
        object result; return value.TryGetValue(key, out result) && result != null ? Convert.ToString(result) : "";
    }
    private static bool Bool(Dictionary<string, object> value, string key)
    {
        object result; return value.TryGetValue(key, out result) && result is bool && (bool)result;
    }
    private async Task<Dictionary<string, object>> Api(string route, object body = null)
    {
        var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, "http://127.0.0.1:8765" + route);
        request.Headers.Add("X-Mirror-Token", token);
        if (body != null) request.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json");
        using (request)
        using (var response = await local.SendAsync(request))
        {
            string raw = await response.Content.ReadAsStringAsync();
            var result = json.Deserialize<Dictionary<string, object>>(raw);
            if (!response.IsSuccessStatusCode) throw new Exception(result == null ? "本地服务响应无效" : Value(result, "error"));
            return result;
        }
    }
    private async Task EnsureServer()
    {
        string tokenPath = Path.Combine(Program.Root, ".mirror-token");
        Dictionary<string, object> existing = null;
        try { token = File.ReadAllText(tokenPath).Trim(); existing = await Api("/api/status"); } catch { }
        if (existing != null)
        {
            if (Value(existing, "engineVersion") != "2.0.0") throw new Exception("旧版本地服务仍在运行。请先退出旧下载器，再重启本程序；现有下载记录会保留。");
            if (!String.Equals(Value(existing, "dataDirectory").TrimEnd(Path.DirectorySeparatorChar), Program.Root, StringComparison.OrdinalIgnoreCase)) throw new Exception("端口 8765 被另一个目录中的 Wiki 服务占用。请先关闭那个服务，再启动本程序。");
            return;
        }
        var info = new ProcessStartInfo(Path.Combine(Program.Root, "runtime/node.exe"), "server.mjs") { WorkingDirectory = Program.Root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true };
        ownedServer = new Process { StartInfo = info };
        ownedServer.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (!String.IsNullOrEmpty(e.Data)) Append(e.Data); };
        ownedServer.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (!String.IsNullOrEmpty(e.Data)) Append(e.Data); };
        ownedServer.Start(); ownedServer.BeginOutputReadLine(); ownedServer.BeginErrorReadLine();
        for (int i = 0; i < 240; i++)
        {
            await Task.Delay(250);
            try { token = File.ReadAllText(tokenPath).Trim(); await Api("/api/status"); return; } catch { }
            if (ownedServer.HasExited) throw new Exception("本地服务无法启动，请检查端口 8765 是否被其他程序占用。");
        }
        throw new Exception("等待本地服务启动超时。");
    }
    private async Task Initialize()
    {
        try
        {
            await EnsureServer();
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Root, "runtime/webview-profile"));
            await source.EnsureCoreWebView2Async(environment);
            await resources.EnsureCoreWebView2Async(environment);
            await reader.EnsureCoreWebView2Async(environment);
            string scripts = File.ReadAllText(Path.Combine(Program.Root, "shared.js")) + "\n" + File.ReadAllText(Path.Combine(Program.Root, "desktop/worker.js"));
            await source.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(scripts);
            source.CoreWebView2.WebMessageReceived += ReceiveMessage;
            resources.CoreWebView2.WebResourceResponseReceived += ReceiveAsset;
            resources.CoreWebView2.DownloadStarting += ReceiveDownload;
            source.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            resources.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            source.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { Uri target; if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target) || target.Scheme != "https" || (target.Host != "isaac.huijiwiki.com" && target.Host != "challenges.cloudflare.com")) e.Cancel = true; };
            resources.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!AllowedAsset(e.Uri)) e.Cancel = true; };
            reader.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { Uri u; if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out u) || u.Scheme != "http" || u.Host != "127.0.0.1" || u.Port != 8765) e.Cancel = true; };
            source.CoreWebView2.NavigationCompleted += async delegate
            {
                try
                {
                    string ready = await source.CoreWebView2.ExecuteScriptAsync("location.origin==='https://isaac.huijiwiki.com' && !!document.querySelector('#mw-content-text')");
                    if (ready == "true")
                    {
                        status.Text = "原站页面已连接，可开始 / 继续下载"; Append("原站正文已加载。点击开始后将检查公开 API。");
                        if (resumePending && initialized && !runInProgress)
                        {
                            resumePending = false; downloadRun = StartDownload(); await downloadRun;
                        }
                    }
                    else { status.Text = "请在“原站验证”页完成原站要求的验证"; Append("原站正文尚未就绪，如显示验证请由你在程序内完成。"); }
                } catch (Exception e) { Append(e.Message); }
            };
            initialized = true; start.Enabled = true; poll.Start();
            status.Text = "连接原站中；如要求验证，请在程序内完成";
            source.CoreWebView2.Navigate("https://isaac.huijiwiki.com/wiki/");
            reader.CoreWebView2.Navigate("http://127.0.0.1:8765/");
            tabs.SelectedTab = sourceTab;
            await RefreshStats();
            File.WriteAllText(Path.Combine(Program.Root, "logs/desktop-runtime.json"), json.Serialize(new { initialized = true, version = "2.0.0", webview = environment.BrowserVersionString, root = Program.Root, time = DateTime.UtcNow.ToString("o") }));
        }
        catch (Exception error)
        {
            status.Text = "初始化失败"; Append(error.Message);
            Directory.CreateDirectory(Path.Combine(Program.Root, "logs"));
            File.WriteAllText(Path.Combine(Program.Root, "logs/desktop-runtime.json"), json.Serialize(new { initialized = false, error = error.ToString() }));
        }
    }
    private void ReceiveMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith("https://isaac.huijiwiki.com/", StringComparison.Ordinal)) return;
        try
        {
            var message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            if (Value(message, "channel") != "isaac-desktop") return;
            TaskCompletionSource<Dictionary<string, object>> completion;
            if (messages.TryGetValue(Value(message, "id"), out completion)) completion.TrySetResult(message);
        } catch (Exception error) { Append("脚本响应失败：" + error.Message); }
    }
    private async Task<Dictionary<string, object>> Execute(Dictionary<string, object> job, object extra = null)
    {
        string id = Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<Dictionary<string, object>>(); messages[id] = completion;
        try
        {
            await source.CoreWebView2.ExecuteScriptAsync("if(window.IsaacDesktopRun){window.IsaacDesktopRun(" + json.Serialize(id) + "," + json.Serialize(job) + "," + json.Serialize(extra) + ");}else{chrome.webview.postMessage({channel:'isaac-desktop',id:" + json.Serialize(id) + ",ok:false,blocked:true,error:'原站页面尚未就绪，请完成验证后继续。'});}");
            if (await Task.WhenAny(completion.Task, Task.Delay(120000)) != completion.Task) throw new DownloadBlockedException("原站请求超时；请检查程序内的原站验证页。");
            var message = await completion.Task;
                if (!Bool(message, "ok")) { if (Bool(message, "blocked")) throw new DownloadBlockedException(Value(message, "error"), Number(message, "statusCode"), Number(message, "retryAfterMs")); throw new Exception(Value(message, "error")); }
            return (Dictionary<string, object>)message["result"];
        }
        finally { messages.Remove(id); }
    }
    private static bool AllowedAsset(string value)
    {
        Uri url;
        if (!Uri.TryCreate(value, UriKind.Absolute, out url) || url.Scheme != "https" || url.Port != 443 || !String.IsNullOrEmpty(url.UserInfo)) return false;
        return url.Host == "isaac.huijiwiki.com" || url.Host == "huiji-public.huijistatic.com" || url.Host == "huiji-thumb.huijistatic.com" || url.Host == "fs.huijiwiki.com" || url.Host == "av.huijiwiki.com" || url.Host == "challenges.cloudflare.com";
    }
    private async Task<Dictionary<string, object>> GetAsset(string url)
    {
        if (!AllowedAsset(url)) throw new Exception("素材域名不在允许范围。");
        pendingAsset = new TaskCompletionSource<Dictionary<string, object>>(); assetUrl = url; assetMime = null;
        receivingAssets.Clear();
        resources.CoreWebView2.Navigate(url);
        var completion = pendingAsset;
        try
        {
            if (await Task.WhenAny(completion.Task, Task.Delay(90000)) != completion.Task) throw new DownloadBlockedException("素材请求超时；请在“素材验证”页检查原站验证后继续。");
            return await completion.Task;
        }
        finally { if (pendingAsset == completion) pendingAsset = null; }
    }
    private static bool SameUrl(string one, string two)
    {
        try { var a = new UriBuilder(one); var b = new UriBuilder(two); a.Fragment = ""; b.Fragment = ""; return a.Uri == b.Uri; } catch { return false; }
    }
    private async void ReceiveAsset(object sender, CoreWebView2WebResourceResponseReceivedEventArgs e)
    {
        var completion = pendingAsset;
        if (completion == null || !SameUrl(e.Request.Uri, assetUrl)) return;
        try
        {
            int code = e.Response.StatusCode;
            string mime = e.Response.Headers.Contains("Content-Type") ? e.Response.Headers.GetHeader("Content-Type") : "application/octet-stream";
            if (code == 429)
            {
                string retryAfter = e.Response.Headers.Contains("Retry-After") ? e.Response.Headers.GetHeader("Retry-After") : "";
                completion.TrySetException(new DownloadBlockedException("素材 HTTP 429：原站限制下载频率，请稍后继续。", code, RetryAfterMilliseconds(retryAfter))); return;
            }
            if (code == 401 || code == 403)
            {
                completion.TrySetException(new DownloadBlockedException("素材 HTTP " + code + "：请在“素材验证”页正常完成验证后继续。", code)); return;
            }
            if (code != 200) { completion.TrySetException(new Exception("素材 HTTP " + code)); return; }
            if (mime.IndexOf("text/html", StringComparison.OrdinalIgnoreCase) >= 0) { completion.TrySetException(new DownloadBlockedException("素材域名返回验证页；请在“素材验证”页正常完成验证后继续。")); return; }
            assetMime = mime;
            if (receivingAssets.Contains(e.Request.Uri)) return; receivingAssets.Add(e.Request.Uri);
            using (var stream = await e.Response.GetContentAsync())
            using (var buffer = new MemoryStream())
            {
                var bytes = new byte[65536]; int count;
                while ((count = await stream.ReadAsync(bytes, 0, bytes.Length)) > 0) { if (buffer.Length + count > 64L * 1024 * 1024) throw new Exception("单个素材超过 64 MB，需要单独导出。"); await buffer.WriteAsync(bytes, 0, count); }
                if (buffer.Length == 0) return;
                completion.TrySetResult(new Dictionary<string, object> { { "base64", Convert.ToBase64String(buffer.ToArray()) }, { "mime", mime } });
            }
        }
        catch (Exception error) { if (error is System.Runtime.InteropServices.COMException) Append("素材由下载通道继续读取：" + error.Message); else completion.TrySetException(error); }
    }
    private void ReceiveDownload(object sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var completion = pendingAsset;
        if (completion == null || !SameUrl(e.DownloadOperation.Uri, assetUrl)) { e.Cancel = true; return; }
        string tempDir = Path.Combine(Program.Root, "runtime/temporary-downloads"); Directory.CreateDirectory(tempDir);
        string file = Path.Combine(tempDir, Guid.NewGuid().ToString("N") + ".tmp");
        e.ResultFilePath = file; e.Handled = true;
        var operation = e.DownloadOperation;
        operation.BytesReceivedChanged += delegate { if (operation.BytesReceived > 64L * 1024 * 1024) { operation.Cancel(); completion.TrySetException(new Exception("单个素材超过 64 MB。")); } };
        operation.StateChanged += delegate
        {
            if (operation.State == CoreWebView2DownloadState.Completed)
            {
                try { completion.TrySetResult(new Dictionary<string, object> { { "base64", Convert.ToBase64String(File.ReadAllBytes(file)) }, { "mime", assetMime ?? operation.MimeType ?? "application/octet-stream" } }); }
                catch (Exception error) { completion.TrySetException(error); }
                finally { try { File.Delete(file); } catch { } }
            }
            else if (operation.State == CoreWebView2DownloadState.Interrupted) completion.TrySetException(new Exception("素材下载中断：" + operation.InterruptReason));
        };
    }
    private async Task RefreshStats()
    {
        if (refreshing || String.IsNullOrEmpty(token)) return; refreshing = true;
        try
        {
            var state = await Api("/api/status");
            double rate = sessionTimer.Elapsed.TotalSeconds > 0 ? sessionCompleted / sessionTimer.Elapsed.TotalSeconds : 0;
            counters.Text = String.Format("已保存页面  {0}     本地素材  {1}     等待下载  {2}\r\n处理中  {3}     失败  {4}     未支持资源  {5}     素材大小  {6:F1} MB     本轮平均  {7:F2} 项/秒", Value(state, "pages"), Value(state, "assets"), Value(state, "pending"), Value(state, "active"), Value(state, "failed"), Value(state, "rejected"), Convert.ToDouble(state["bytes"]) / 1048576, rate);
            if (Bool(state, "complete")) status.Text = "全站静态下载完成";
        }
        catch (Exception error) { Append("读取进度：" + error.Message); }
        finally { refreshing = false; }
    }
    private async Task SafePause()
    {
        if (String.IsNullOrEmpty(token)) return;
        try { await Api("/api/control", new { action = "pause" }); } catch { }
    }
    private async Task StartDownload()
    {
        if (!initialized || runInProgress || closeRequested) return;
        runInProgress = true; running = true; start.Enabled = false; pause.Enabled = true; speed.Enabled = false;
        pageWorkers = speed.SelectedIndex == 0 ? 1 : speed.SelectedIndex == 2 ? 4 : 2;
        laneDelayMs = speed.SelectedIndex == 0 ? 350 : speed.SelectedIndex == 2 ? 150 : 200;
        sessionCompleted = 0; sessionTimer.Restart();
        Exception downloadFailure = null;
        try
        {
        try
        {
            await Execute(new Dictionary<string, object> { { "kind", "check" } });
            await Api("/api/control", new { action = "start" });
            tabs.SelectedTab = progressTab; status.Text = "正在下载；页面 " + pageWorkers + " 路并发，素材单路"; Append("公开 API 已连接。页面并发：" + pageWorkers + "，任务间隔：" + laneDelayMs + " ms。");
            var workers = new List<Task>();
            for (int i = 0; i < pageWorkers; i++) workers.Add(RunLane("page-or-meta"));
            await Task.WhenAll(workers);
            if (running) await RunLane("asset");
            var state = await Api("/api/status");
            status.Text = Bool(state, "complete") ? "全站静态下载完成" : "已暂停 / 当前队列处理结束；全站尚未完成";
        }
        catch (Exception error) { downloadFailure = error; }
        running = false; sessionTimer.Stop();
        if (downloadFailure != null) { status.Text = downloadFailure is DownloadBlockedException ? "下载已暂停，请按错误提示处理验证或限流" : "下载已暂停，请检查连接或程序日志"; Append(downloadFailure.Message); }
        await SafePause();
        if (!IsDisposed) await RefreshStats();
        }
        finally { running = false; runInProgress = false; sessionTimer.Stop(); if (!IsDisposed) { start.Enabled = !closeRequested; pause.Enabled = false; speed.Enabled = !closeRequested; } }
    }
    private static int RetryAfterMilliseconds(string value)
    {
        double seconds;
        if (!Double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out seconds))
        {
            DateTimeOffset date;
            if (!DateTimeOffset.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out date)) return 0;
            seconds = (date - DateTimeOffset.UtcNow).TotalSeconds;
        }
        if (Double.IsNaN(seconds) || seconds <= 0) return 0;
        return (int)Math.Min(Int32.MaxValue, seconds * 1000);
    }
    private static int Number(Dictionary<string, object> value, string key)
    {
        object result; int number; return value.TryGetValue(key, out result) && Int32.TryParse(Convert.ToString(result), out number) ? number : 0;
    }
    private async Task RunLane(string lane)
    {
        try
        {
        while (running && !IsDisposed)
        {
            var timer = Stopwatch.StartNew();
            var current = await Api("/api/next?kind=" + lane);
            if (current == null)
            {
                var state = await Api("/api/status");
                string pending = lane == "asset" ? "pendingAssets" : "pendingPages";
                string active = lane == "asset" ? "activeAssets" : "activePages";
                if (!Bool(state, "running") || (Number(state, pending) == 0 && Number(state, active) == 0)) break;
                await Task.Delay(500); continue;
            }
            string kind = Value(current, "kind"), id = Value(current, "id"), url = Value(current, "url");
            Append("正在处理：" + (Value(current, "title") == "" ? kind : Value(current, "title")));
            Exception taskFailure = null;
            try
            {
                Dictionary<string, object> result;
                if (kind == "seed") result = await Execute(current, await Api("/api/seed"));
                else if (kind == "asset")
                {
                    var bytes = await GetAsset(url);
                    bool isCss = Value(bytes, "mime").IndexOf("text/css", StringComparison.OrdinalIgnoreCase) >= 0 || new Uri(url).AbsolutePath.EndsWith(".css", StringComparison.OrdinalIgnoreCase);
                    result = isCss ? await Execute(current, bytes) : bytes;
                }
                else result = await Execute(current);
                await Api("/api/result", new { id = id, result = result });
                sessionCompleted++;
            }
            catch (Exception error) { taskFailure = error; }
            if (taskFailure != null)
            {
                bool blocked = taskFailure is DownloadBlockedException;
                if (blocked) running = false;
                await Api("/api/failure", new { id = id, error = taskFailure.Message, blocked = blocked });
                Append("任务未完成：" + taskFailure.Message);
                if (blocked)
                {
                    var blockedError = (DownloadBlockedException)taskFailure;
                    if (blockedError.StatusCode == 429) Append("原站限流。建议等待 " + Math.Max(30, blockedError.RetryAfterMs / 1000) + " 秒，选择稳妥模式后继续。");
                    tabs.SelectedTab = kind == "asset" ? resourceTab : sourceTab;
                    throw taskFailure;
                }
            }
            timer.Stop();
            try { File.AppendAllText(Path.Combine(Program.Root, "logs/download-speed.jsonl"), json.Serialize(new { time = DateTime.UtcNow.ToString("o"), kind = kind, elapsedMs = timer.ElapsedMilliseconds, success = taskFailure == null, workers = pageWorkers }) + Environment.NewLine); } catch { }
            await Task.Delay(laneDelayMs);
        }
        }
        catch { running = false; throw; }
    }
}
