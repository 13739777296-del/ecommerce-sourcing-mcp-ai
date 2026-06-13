# 电商选品 MCP 本机 worker 安装脚本（Windows / PowerShell）
# 与 install-worker.sh 对应：检查 Node/Chrome → 克隆或更新项目 → npm ci →
# 注册开机自启（计划任务）→ 启动 worker。
# 用法（在 PowerShell 里）：
#   $env:ECOMMERCE_SOURCING_WORKER_KEY="你的worker密钥"; .\install-worker.ps1
# 尚未在真实 Windows 上验证，待实测后再调。

$ErrorActionPreference = "Stop"

function Get-EnvOrDefault($name, $default) {
  $val = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($val)) { return $default }
  return $val
}

$ProjectDir = Get-EnvOrDefault "ECOMMERCE_SOURCING_PROJECT_DIR" (Join-Path $HOME ".ecommerce-sourcing-mcp\runtime")
$RepoUrl    = Get-EnvOrDefault "ECOMMERCE_SOURCING_REPO_URL" "https://github.com/13739777296-del/ecommerce-sourcing-mcp-ai.git"
$ServerUrl  = Get-EnvOrDefault "ECOMMERCE_SOURCING_MCP_SERVER_URL" "http://111.228.45.180/ecommerce-sourcing-mcp/mcp"
$WorkerKey  = Get-EnvOrDefault "ECOMMERCE_SOURCING_WORKER_KEY" ""
$DataDir    = Get-EnvOrDefault "ECOMMERCE_SOURCING_DATA_DIR" (Join-Path $HOME ".ecommerce-sourcing-agent")
$TaskName   = "EcommerceSourcingMcpWorker"

# 1) 检查 Node.js 22+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "没有找到 Node.js。请先安装 Node.js 22.12 或更高版本：https://nodejs.org/"
  exit 1
}
$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 22) {
  Write-Host "Node.js 版本过低：$(& node -v)。需要 22.12 或更高版本。"
  exit 1
}
$NodeBin = $node.Source

# 2) 检查 Google Chrome（注册表 App Paths + 常见安装路径）
function Find-Chrome {
  $regPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
  )
  foreach ($rp in $regPaths) {
    try {
      $p = (Get-ItemProperty -Path $rp -ErrorAction Stop)."(default)"
      if ($p -and (Test-Path $p)) { return $p }
    } catch {}
  }
  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
if (-not (Find-Chrome)) {
  Write-Host "没有找到 Google Chrome。请先安装正式版 Chrome：https://www.google.cn/chrome/"
  exit 1
}

# 3) worker 密钥
if ([string]::IsNullOrWhiteSpace($WorkerKey)) {
  $secure = Read-Host -AsSecureString "请输入电商选品 MCP worker 密钥"
  $WorkerKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ([string]::IsNullOrWhiteSpace($WorkerKey)) {
  Write-Host "worker 密钥不能为空。"
  exit 1
}

# 4) 克隆或更新项目
New-Item -ItemType Directory -Force -Path (Split-Path $ProjectDir -Parent) | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
if (Test-Path (Join-Path $ProjectDir ".git")) {
  Write-Host "更新项目：$ProjectDir"
  git -C $ProjectDir pull --ff-only
} else {
  Write-Host "克隆项目：$RepoUrl -> $ProjectDir"
  if (Test-Path $ProjectDir) { Remove-Item -Recurse -Force $ProjectDir }
  git clone $RepoUrl $ProjectDir
}

Set-Location $ProjectDir
npm ci

# 5) 注册开机自启的计划任务（用户登录时启动，崩溃后由任务计划重启）
$workerScript = Join-Path $ProjectDir "mcp\local-worker.mjs"
$envSetup = "`$env:ECOMMERCE_SOURCING_MCP_SERVER_URL='$ServerUrl'; " +
            "`$env:ECOMMERCE_SOURCING_WORKER_KEY='$WorkerKey'; " +
            "`$env:ECOMMERCE_SOURCING_DATA_DIR='$DataDir'; " +
            "Set-Location '$ProjectDir'; & '$NodeBin' '$workerScript'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($envSetup))
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "本机 worker 已启动（计划任务：$TaskName）。"
Write-Host "项目目录：$ProjectDir"
Write-Host "数据目录：$DataDir"
$healthUrl = $ServerUrl -replace "/mcp$", "/health"
Write-Host "状态检查：curl $healthUrl"
