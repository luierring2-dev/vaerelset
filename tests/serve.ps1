# Lille lokal webserver til udvikling og tests. Kræver intet ud over Windows.
param([int]$Port = 8123)

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json'
  '.svg' = 'image/svg+xml'
  '.png' = 'image/png'
  '.jpg' = 'image/jpeg'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Serverer $root paa http://localhost:$Port/"

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $response = $context.Response
  try {
    $relative = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/').Replace('/', '\')
    $path = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    if ((Test-Path $path -PathType Container)) { $path = Join-Path $path 'index.html' }

    $inside = $path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)
    if ($inside -and (Test-Path $path -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $type = $types[[System.IO.Path]::GetExtension($path).ToLower()]
      $response.ContentType = if ($type) { $type } else { 'application/octet-stream' }
      $response.Headers.Add('Cache-Control', 'no-store')
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
    }
  } catch {
    $response.StatusCode = 500
    Write-Output $_.Exception.Message
  } finally {
    $response.Close()
  }
}
