#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
    iExA-WIN 一键提交并推送：构建 → 敏感信息扫描 → 提交 → 推送 → 校验。

.DESCRIPTION
    默认流程：
      1. 校验仓库、分支、远端（origin 走 SSH 别名 github-iexa-win）
      2. npm run build（-SkipBuild 可跳过）
      3. 扫描待提交内容里的高置信度密钥模式，命中即中止
      4. 有改动则提交（-Message 必填；-Body 支持多行正文）
      5. 推送到远端并校验本地/远端 SHA 一致

.PARAMETER Message
    提交标题，Conventional Commits 风格。工作区有改动时必填。

.PARAMETER Body
    提交正文。可写多行，内部落临时 UTF-8 文件后 git commit -F，
    避免 PowerShell 下 heredoc / 编码问题。

.PARAMETER SkipBuild
    跳过 npm run build（仅改文档/配置时可用）。

.PARAMETER DryRun
    只做检查与清单输出：不构建、不提交、不推送。

.PARAMETER Force
    敏感信息扫描命中时仍然继续（确认是测试夹具后再用）。

.PARAMETER Remote
    远端名，默认 origin。

.PARAMETER Branch
    分支名，默认当前分支。

.EXAMPLE
    pwsh scripts/push.ps1 -Message "fix: 修正缓存百分比取整" -Body "分母改用 输入+缓存，避免除零。"

.EXAMPLE
    pwsh scripts/push.ps1 -Message "docs: 补充 Token 用量说明" -SkipBuild

.EXAMPLE
    pwsh scripts/push.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Message,
    [string]$Body,
    [string]$BodyFile,
    [switch]$SkipBuild,
    [switch]$DryRun,
    [switch]$Force,
    [string]$Remote = 'origin',
    [string]$Branch
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

# Multi-line bodies are unreliable as command-line arguments under `pwsh -File`;
# read them from a file instead when -BodyFile is supplied.
if ($BodyFile) {
    $resolvedBody = if (Test-Path -LiteralPath $BodyFile) { $BodyFile } else { Join-Path $repo $BodyFile }
    if (-not (Test-Path -LiteralPath $resolvedBody)) { Write-Host "  XX   正文文件不存在：$BodyFile" -ForegroundColor Red; exit 1 }
    $Body = Get-Content -LiteralPath $resolvedBody -Raw
}

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  OK   $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !!   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  XX   $text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. 仓库校验
Step '校验仓库与分支'

if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { Fail "不是 git 仓库：$repo" }
$inside = (& git rev-parse --is-inside-work-tree 2>$null)
if ($LASTEXITCODE -ne 0 -or "$inside".Trim() -ne 'true') { Fail '当前目录不在 git 工作树内。' }

if (-not $Branch) {
    $Branch = ("$(& git rev-parse --abbrev-ref HEAD 2>$null)").Trim()
}
if (-not $Branch -or $Branch -eq 'HEAD') { Fail '当前处于 detached HEAD，请先切换到分支。' }
Ok "分支：$Branch"

$remoteUrl = (& git remote get-url $Remote 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $remoteUrl) { Fail "远端 '$Remote' 不存在。" }
Ok "远端：$Remote → $($remoteUrl.Trim())"

# ---------------------------------------------------------------- 2. 变更清单
Step '检查工作区变更'

$status = @(& git status --porcelain=v1 | Where-Object { $_ })
$trackedChanges = @($status | Where-Object { $_ -notmatch '^\?\?' })
$untrackedAll   = @($status | Where-Object { $_ -match '^\?\?' })

if ($status.Count -gt 0) {
    Ok ("待提交变更 {0} 项（已跟踪 {1} / 未跟踪 {2}）" -f $status.Count, $trackedChanges.Count, $untrackedAll.Count)
    $status | Select-Object -First 40 | ForEach-Object { Write-Host "       $_" }
    if ($status.Count -gt 40) { Write-Host ("       ... 其余 {0} 项省略" -f ($status.Count - 40)) }
} else {
    Ok '工作区干净'
}

# ---------------------------------------------------------------- 3. 构建
if ($DryRun) {
    Warn 'DryRun：跳过 npm run build'
} elseif ($SkipBuild) {
    Warn '已跳过构建（-SkipBuild）'
} else {
    Step '构建（npm run build）'
    & npm run build
    if ($LASTEXITCODE -ne 0) { Fail '构建失败，已中止（未提交、未推送）。' }
    Ok '构建通过'
}

# ------------------------------------------------------------ 4. 敏感信息扫描
Step '扫描待提交内容中的密钥模式'

$scriptFile = 'scripts/push.ps1'
$secretPatterns = @(
    @{ Name = 'OpenAI/Anthropic key';  Regex = 'sk-(?:ant-)?[A-Za-z0-9_\-]{20,}' }
    @{ Name = 'GitHub token';          Regex = 'gh[pousr]_[A-Za-z0-9]{20,}' }
    @{ Name = 'GitHub fine-grained';   Regex = 'github_pat_[A-Za-z0-9_]{20,}' }
    @{ Name = 'AWS access key id';     Regex = 'AKIA[0-9A-Z]{16}' }
    @{ Name = 'Slack token';           Regex = 'xox[baprs]-[A-Za-z0-9\-]{10,}' }
    @{ Name = 'Google API key';        Regex = 'AIza[0-9A-Za-z_\-]{35}' }
    @{ Name = 'Private key block';     Regex = '-----BEGIN [A-Z ]*PRIVATE KEY-----' }
)

$scanTargets = New-Object System.Collections.Generic.List[string]

# 已跟踪文件的新增行（相对 HEAD，含 staged 与 unstaged）
$diff = & git diff HEAD -U0 -- . ":(exclude)$scriptFile" 2>$null
if ($LASTEXITCODE -eq 0 -and $diff) {
    foreach ($line in $diff) {
        if ($line -match '^\+' -and $line -notmatch '^\+\+\+') { $scanTargets.Add($line) }
    }
}

# 未跟踪的文本文件内容
$untrackedFiles = @(& git ls-files --others --exclude-standard -- . ":(exclude)$scriptFile")
$textExt = @('.js','.cjs','.mjs','.ts','.tsx','.jsx','.json','.md','.txt','.ps1','.bat','.cmd','.py','.cs','.css','.html','.yml','.yaml','.env','.sh','.xml','.config')
foreach ($f in $untrackedFiles) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $f
    if ($item.Length -gt 1MB) { continue }
    if ($textExt -notcontains $item.Extension.ToLower() -and $item.Extension -ne '') { continue }
    $content = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
    if ($content) { foreach ($line in ($content -split "`n")) { $scanTargets.Add($line) } }
}

$hits = @()
foreach ($line in $scanTargets) {
    foreach ($p in $secretPatterns) {
        if ($line -match $p.Regex) {
            $sample = $line.Trim()
            if ($sample.Length -gt 60) { $sample = $sample.Substring(0, 60) + '…' }
            $hits += ("[{0}] {1}" -f $p.Name, $sample)
        }
    }
}

if ($hits.Count -gt 0) {
    Write-Host ''
    Write-Host '  潜在密钥命中：' -ForegroundColor Red
    $hits | Select-Object -Unique | Select-Object -First 20 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
    if ($Force) {
        Warn '已指定 -Force，继续执行。'
    } else {
        Fail '检测到疑似密钥，已中止。确认是测试夹具后可用 -Force 继续。'
    }
} else {
    Ok ("已扫描 {0} 行，未命中密钥模式" -f $scanTargets.Count)
}

# ---------------------------------------------------------------- 5. 提交
$hasChanges = $status.Count -gt 0
$commitMade = $false

if ($DryRun) {
    Warn 'DryRun：跳过提交'
} elseif (-not $hasChanges) {
    Warn '无工作区改动，跳过提交'
} else {
    if (-not $Message) { Fail '工作区有改动，必须提供 -Message。' }

    Step '暂存并提交'
    & git add -A
    if ($LASTEXITCODE -ne 0) { Fail 'git add 失败。' }

    $stagedNames = @(& git diff --cached --name-only)
    if ($stagedNames.Count -eq 0) {
        Warn '暂存区为空（改动可能都被 .gitignore 忽略），跳过提交'
    } else {
        Ok ("已暂存 {0} 个文件" -f $stagedNames.Count)

        $msgFile = Join-Path ([IO.Path]::GetTempPath()) ("iexa-commit-{0}.txt" -f [guid]::NewGuid().ToString('N'))
        $content = if ($Body) { "$Message`n`n$Body`n" } else { "$Message`n" }
        [IO.File]::WriteAllText($msgFile, $content, [System.Text.UTF8Encoding]::new($false))

        try {
            & git commit -F $msgFile
            if ($LASTEXITCODE -ne 0) { Fail 'git commit 失败。' }
            $commitMade = $true
            $sha = ("$(& git rev-parse --short HEAD)").Trim()
            Ok "提交完成：$sha"
        } finally {
            Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------- 6. 推送
$unpushed = @(& git log --oneline "@{u}..HEAD" 2>$null)
if ($LASTEXITCODE -ne 0) { $unpushed = @() }   # 无 upstream 时忽略

if ($DryRun) {
    Warn ("DryRun：将推送 {0} 个提交到 {1}/{2}" -f [Math]::Max($unpushed.Count, $(if ($commitMade) { 1 } else { 0 })), $Remote, $Branch)
    Write-Host ''
    Write-Host 'DryRun 完成，未做任何写操作。' -ForegroundColor Cyan
    exit 0
}

Step "推送 $Remote/$Branch"
$hasUpstream = $true
& git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { $hasUpstream = $false }

if ($hasUpstream) {
    & git push $Remote $Branch
} else {
    & git push -u $Remote $Branch
}
if ($LASTEXITCODE -ne 0) { Fail '推送失败（检查 SSH 别名与 deploy key 权限）。' }
Ok '推送完成'

# ---------------------------------------------------------------- 7. 校验
Step '校验本地与远端一致'
& git fetch $Remote --quiet
if ($LASTEXITCODE -ne 0) { Fail 'fetch 失败，无法校验远端状态。' }

$localSha  = ("$(& git rev-parse HEAD)").Trim()
$remoteSha = ("$(& git rev-parse "$Remote/$Branch" 2>$null)").Trim()

if ($localSha -eq $remoteSha) {
    $short = $localSha.Substring(0, 7)
    Ok "本地与远端一致：$short"
} else {
    Fail "SHA 不一致（local=$localSha remote=$remoteSha），请检查推送结果。"
}

Write-Host ''
Write-Host ("完成：{0} → {1}/{2} @ {3}" -f $Branch, $Remote, $Branch, $localSha.Substring(0, 7)) -ForegroundColor Green
