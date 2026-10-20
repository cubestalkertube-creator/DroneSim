# DroneSim: локальный веб-сервер на встроенном PowerShell (ничего ставить не нужно).
# Отдаёт папку с этим скриптом на http://localhost:<порт>/ и открывает браузер. Закрыть окно = остановить.
param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.wasm' = 'application/wasm'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'
  '.glb' = 'model/gltf-binary'; '.gltf' = 'model/gltf+json'; '.bin' = 'application/octet-stream'; '.hdr' = 'application/octet-stream'
  '.ogg' = 'audio/ogg'; '.mp3' = 'audio/mpeg'; '.wav' = 'audio/wav'; '.woff2' = 'font/woff2'; '.woff' = 'font/woff'; '.ico' = 'image/x-icon'
}

$listener = $null
foreach ($p in $Port..($Port + 20)) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start(); $listener = $l; $Port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host 'Не удалось открыть порт. Используй онлайн-версию (ссылка в README).' -ForegroundColor Red; Read-Host 'Enter - выход'; exit 1 }

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  DroneSim запущен: $url" -ForegroundColor Green
Write-Host '  Браузер откроется сам. Не закрывай это окно, пока играешь.' -ForegroundColor Gray
Write-Host ''
Start-Process $url

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
      $res.StatusCode = 404; $b = [Text.Encoding]::UTF8.GetBytes('404'); $res.OutputStream.Write($b, 0, $b.Length)
    } else {
      $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $fs = [IO.File]::OpenRead($path)
      try { $res.ContentLength64 = $fs.Length; $fs.CopyTo($res.OutputStream) } finally { $fs.Dispose() }
    }
  } catch { } finally { try { $res.OutputStream.Close() } catch { } }
}
