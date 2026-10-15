param([string]$OutputName = 'IsaacWikiDownloader.exe', [switch]$ReuseDependencies)
$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $PSScriptRoot
$sdkDirectory = Join-Path $PSScriptRoot 'packages\webview2'
$frameworkDirectory = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
if (-not $ReuseDependencies) {
    Copy-Item -LiteralPath (Join-Path $sdkDirectory 'lib\net462\Microsoft.Web.WebView2.Core.dll') -Destination $appDirectory -Force
    Copy-Item -LiteralPath (Join-Path $sdkDirectory 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') -Destination $appDirectory -Force
    Copy-Item -LiteralPath (Join-Path $sdkDirectory 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $appDirectory -Force
}
Copy-Item -LiteralPath (Join-Path $sdkDirectory 'LICENSE.txt') -Destination (Join-Path $appDirectory 'desktop\WebView2-LICENSE.txt') -Force
$compilerArguments = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output',
    ('/out:' + (Join-Path $appDirectory $OutputName)),
    ('/reference:' + (Join-Path $appDirectory 'Microsoft.Web.WebView2.Core.dll')),
    ('/reference:' + (Join-Path $appDirectory 'Microsoft.Web.WebView2.WinForms.dll')),
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Net.Http.dll', '/reference:System.Web.Extensions.dll',
    (Join-Path $PSScriptRoot 'Downloader.cs')
)
& (Join-Path $frameworkDirectory 'csc.exe') @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'C# compilation failed.' }
Get-Item -LiteralPath (Join-Path $appDirectory $OutputName) | Select-Object FullName,Length
