# Testserver til tests/mutation.html. Lægger én fejl ind i en fil i hukommelsen,
# så man kan se, om testene opdager den. Filerne på disken røres ikke.
param([int]$Port = 8124)

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png' = 'image/png'
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$mutation = $null

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Fejltest paa http://localhost:$Port/tests/mutation.html"

function Send-Json($response, $text) {
  $bytes = $utf8.GetBytes($text)
  $response.ContentType = 'application/json'
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $response = $context.Response
  try {
    $urlPath = $context.Request.Url.AbsolutePath
    if ($urlPath -eq '/__mutate') {
      $reader = New-Object System.IO.StreamReader($context.Request.InputStream, $utf8)
      $mutation = $reader.ReadToEnd() | ConvertFrom-Json
      $target = Join-Path $root $mutation.file
      $found = ([System.IO.File]::ReadAllText($target, $utf8)).Contains($mutation.from)
      Send-Json $response (@{ found = $found } | ConvertTo-Json)
    } elseif ($urlPath -eq '/__reset') {
      $mutation = $null
      Send-Json $response '{}'
    } else {
      $relative = [Uri]::UnescapeDataString($urlPath).TrimStart('/').Replace('/', '\')
      $path = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
      if ((Test-Path $path -PathType Container)) { $path = Join-Path $path 'index.html' }
      if ($path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $path -PathType Leaf)) {
        if ($mutation -and $relative -eq $mutation.file.Replace('/', '\')) {
          $bytes = $utf8.GetBytes(([System.IO.File]::ReadAllText($path, $utf8)).Replace($mutation.from, $mutation.to))
        } else {
          $bytes = [System.IO.File]::ReadAllBytes($path)
        }
        $type = $types[[System.IO.Path]::GetExtension($path).ToLower()]
        $response.ContentType = if ($type) { $type } else { 'application/octet-stream' }
        $response.Headers.Add('Cache-Control', 'no-store')
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $response.StatusCode = 404
      }
    }
  } catch {
    $response.StatusCode = 500
    Write-Output $_.Exception.Message
  } finally {
    $response.Close()
  }
}
