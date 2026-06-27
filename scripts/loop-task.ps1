param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("reject")]
    [string]$Action,
    [string]$Title,
    [string]$StatePath = "STATE.md"
)

$ErrorActionPreference = 'Stop'

# [IO.File] resolves relative paths against the process directory, which can
# differ from the PowerShell location; anchor explicitly.
if (-not [IO.Path]::IsPathRooted($StatePath)) {
    $StatePath = Join-Path (Get-Location).Path $StatePath
}
if (-not (Test-Path $StatePath)) {
    throw "State file not found: $StatePath"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = Get-Content -Path $StatePath -Raw -Encoding UTF8
$eol = if ($content -match "`r`n") { "`r`n" } else { "`n" }

$sectionMatch = [regex]::Match($content, "(?ms)^## Approved Tasks.*?(?=^## |\z)")
if (-not $sectionMatch.Success) {
    throw "No '## Approved Tasks' section found in $StatePath"
}

# A task block is the '- [ ] title' line plus its indented 'key: value' lines.
# The '(queue is empty ...)' placeholder does not match the checkbox prefix.
$allBlocks = [regex]::Matches($sectionMatch.Value, "(?m)^- \[[ xX]\][^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*")

# The section's format documentation lives in an HTML comment and contains an
# example task block; matches inside comments are not real queue entries.
$commentRanges = [regex]::Matches($sectionMatch.Value, '(?s)<!--.*?-->')
$blocks = @()
foreach ($candidate in $allBlocks) {
    $inComment = $false
    foreach ($comment in $commentRanges) {
        if ($candidate.Index -ge $comment.Index -and $candidate.Index -lt ($comment.Index + $comment.Length)) {
            $inComment = $true
            break
        }
    }
    if (-not $inComment) {
        $blocks += $candidate
    }
}
if ($blocks.Count -eq 0) {
    throw "Approved Tasks queue is empty; nothing to record a rejection against."
}

function Get-BlockField {
    param([string]$Block, [string]$Name)
    $match = [regex]::Match($Block, ('(?m)^[ \t]+' + $Name + ':\s*(.*)$'))
    if ($match.Success) {
        return $match.Groups[1].Value.Trim()
    }
    return $null
}

$target = $null
if ($Title) {
    foreach ($block in $blocks) {
        $titleLine = [regex]::Match($block.Value, '^[^\r\n]*').Value
        if ($titleLine -match [regex]::Escape($Title)) {
            $target = $block
            break
        }
    }
    if (-not $target) {
        throw "No Approved Tasks entry title matches '$Title'."
    }
}
else {
    # Prefer the task being worked on; fall back to the top queued task.
    foreach ($block in $blocks) {
        $status = Get-BlockField -Block $block.Value -Name 'status'
        if ($status -and $status -match '^in-progress') {
            $target = $block
            break
        }
    }
    if (-not $target) {
        foreach ($block in $blocks) {
            $status = Get-BlockField -Block $block.Value -Name 'status'
            if ($status -and $status -match '^queued') {
                $target = $block
                break
            }
        }
    }
    if (-not $target) {
        throw "No in-progress or queued task found; pass -Title to pick one explicitly."
    }
}

$taskTitle = [regex]::Match($target.Value, '^- \[[ xX]\]\s*(.+)').Groups[1].Value.Trim()
$currentStatus = Get-BlockField -Block $target.Value -Name 'status'
if ($currentStatus -and $currentStatus -match '^escalated') {
    throw "Task '$taskTitle' is already escalated; a human decision is required before more loop work."
}

$newBlock = $target.Value
$rejections = 1
$rejectionsMatch = [regex]::Match($newBlock, '(?m)^[ \t]+rejections:\s*(\d+)')
if ($rejectionsMatch.Success) {
    $rejections = [int]$rejectionsMatch.Groups[1].Value + 1
    $newBlock = ([regex]'(?m)^([ \t]+)rejections:[^\r\n]*').Replace($newBlock, ('${1}rejections: ' + $rejections), 1)
}
else {
    # Insert after the status line when present, else after the title line.
    $statusLine = [regex]::Match($newBlock, '(?m)^[ \t]+status:[^\r\n]*')
    $insertAt = if ($statusLine.Success) {
        $statusLine.Index + $statusLine.Length
    }
    else {
        [regex]::Match($newBlock, '^[^\r\n]*').Length
    }
    $newBlock = $newBlock.Insert($insertAt, "$eol  rejections: $rejections")
}

$escalated = $false
if ($rejections -ge 2) {
    $escalated = $true
    if ($newBlock -match '(?m)^[ \t]+status:') {
        $newBlock = ([regex]'(?m)^([ \t]+status:)[^\r\n]*').Replace($newBlock, '${1} escalated', 1)
    }
    else {
        $rejectionsLine = [regex]::Match($newBlock, '(?m)^[ \t]+rejections:[^\r\n]*')
        $newBlock = $newBlock.Insert($rejectionsLine.Index + $rejectionsLine.Length, "$eol  status: escalated")
    }
}

$absoluteStart = $sectionMatch.Index + $target.Index
$content = $content.Remove($absoluteStart, $target.Length).Insert($absoluteStart, $newBlock)
[IO.File]::WriteAllText($StatePath, ($content.TrimEnd() + "`n"), $utf8NoBom)

Write-Host "Recorded verifier rejection: '$taskTitle' now has $rejections rejection(s)."
if ($escalated) {
    Write-Host "Rejection cap reached (2): task marked escalated. Stop the loop and hand off to the human gate."
}
