param(
    [switch]$RunChecks,
    [switch]$UpdateState
)

$ErrorActionPreference = 'Stop'
$runStartedAt = Get-Date

$repoRoot = (Get-Location).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$isoDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$loopDir = Join-Path $repoRoot ".loop"
$triageDir = Join-Path $loopDir "triage"
if (-not (Test-Path $triageDir)) {
    New-Item -ItemType Directory -Path $triageDir -Force | Out-Null
}

$reportPath = Join-Path $triageDir "triage-$timestamp.md"
$statePath = Join-Path $repoRoot "STATE.md"
$attemptLedgerPath = Join-Path $loopDir "attempt-ledger.json"
$runLogPath = Join-Path $loopDir "run-log.jsonl"

function Run-CommandOutput {
    param([string]$Command)
    try {
        $global:LASTEXITCODE = 0
        $output = (Invoke-Expression $Command | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return "[command failed] $Command (exit $LASTEXITCODE)`n$output"
        }
        return $output
    }
    catch {
        return "[command failed] $Command`n$($_.Exception.Message)"
    }
}

# ConvertFrom-Json -AsHashtable needs PowerShell 6+; the npm scripts run
# Windows PowerShell 5.1, so convert PSObjects to hashtables manually.
function Convert-PSObjectToHashtable {
    param($InputObject)

    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $table = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $table[$property.Name] = Convert-PSObjectToHashtable $property.Value
        }
        return $table
    }

    return $InputObject
}

# Shared BOM-less UTF-8: PS 5.1 Set-Content -Encoding UTF8 writes a BOM,
# pwsh 7 does not; mixing them produces permanent diff churn on loop files.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText($Path, $Content, $script:utf8NoBom)
}

function Set-StateLine {
    param(
        [string]$Content,
        [string]$Pattern,
        [string]$Replacement
    )

    # Instance Replace has a real count parameter. The static
    # [regex]::Replace(input, pattern, replacement, 1) binds the 1 to
    # RegexOptions (1 = IgnoreCase) and replaces ALL matches.
    return ([regex]$Pattern).Replace($Content, $Replacement, 1)
}

function Get-HighPriorityItems {
    param([string]$StateContent)

    $items = @()
    $sectionMatch = [regex]::Match($StateContent, "(?ms)^## High Priority\s*(?<body>.*?)(^\s*## |\z)")
    if (-not $sectionMatch.Success) {
        return $items
    }

    # The format documentation lives in an HTML comment with an example task;
    # strip comments first so that example is not counted as a real item.
    $body = [regex]::Replace($sectionMatch.Groups["body"].Value, '(?s)<!--.*?-->', '')
    # Only unchecked items count as open; a checked-off [x] item must stop
    # accruing consecutive runs toward the recurrence escalation cap.
    $lines = $body -split "`r?`n"
    foreach ($line in $lines) {
        if ($line -match '^\s*-\s*\[ \]\s*(.+?)\s*$') {
            $title = $matches[1].Trim()
            $slug = (($title.ToLowerInvariant() -replace '[^a-z0-9]+', '-') -replace '(^-+|-+$)', '')
            if (-not [string]::IsNullOrWhiteSpace($slug)) {
                $items += [pscustomobject]@{
                    Title = $title
                    Slug = $slug
                }
            }
        }
    }

    return $items
}

function Get-AttemptLedger {
    param([string]$Path)

    if (Test-Path $Path) {
        $parsed = Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        return Convert-PSObjectToHashtable $parsed
    }

    return @{
        last_run = $null
        items = @{}
    }
}

function Update-AttemptLedger {
    param(
        [hashtable]$Ledger,
        [array]$Items,
        [string]$IsoDate
    )

    if (-not $Ledger.ContainsKey("items")) {
        $Ledger["items"] = @{}
    }

    $today = $IsoDate.Substring(0, 10)
    $currentSlugs = @()
    foreach ($item in $Items) {
        $currentSlugs += $item.Slug
        if ($Ledger["items"].ContainsKey($item.Slug)) {
            $entry = $Ledger["items"][$item.Slug]
            # The recurrence cap means "3 consecutive DAYS", so several runs
            # on the same calendar day count once, not once per invocation.
            $lastSeen = [string]$entry["last_seen"]
            $lastSeenDay = $lastSeen.Substring(0, [Math]::Min(10, $lastSeen.Length))
            if ($lastSeenDay -ne $today) {
                $entry["consecutive_runs"] = [int]$entry["consecutive_runs"] + 1
            }
            else {
                $entry["consecutive_runs"] = [Math]::Max(1, [int]$entry["consecutive_runs"])
            }
            $entry["title"] = $item.Title
            $entry["last_seen"] = $IsoDate
        }
        else {
            $Ledger["items"][$item.Slug] = @{
                title = $item.Title
                first_seen = $IsoDate
                last_seen = $IsoDate
                consecutive_runs = 1
                status = "active"
            }
        }
    }

    foreach ($slug in @($Ledger["items"].Keys)) {
        if ($currentSlugs -notcontains $slug) {
            $Ledger["items"][$slug]["status"] = "inactive"
            $Ledger["items"][$slug]["consecutive_runs"] = 0
        }
        else {
            $Ledger["items"][$slug]["status"] = "active"
        }
    }

    $Ledger["last_run"] = $IsoDate
    return $Ledger
}

$gitBranch = Run-CommandOutput "git branch --show-current"
$gitStatus = Run-CommandOutput "git status --short"
if ([string]::IsNullOrWhiteSpace($gitStatus)) {
    $gitStatus = "clean"
}

# CDK project roots. docs/ is excluded on purpose: it holds private source
# context (binary), not code, so it should never surface as a triage finding.
$searchRoots = @("lib", "bin", "lambda", "specs") | Where-Object { Test-Path $_ }
$excludeGlob = "docs/loop-engineering"

if ((Get-Command rg -ErrorAction SilentlyContinue) -and $searchRoots.Count -gt 0) {
    $rootsArg = $searchRoots -join " "
    $todoScan = Run-CommandOutput "rg -n 'TODO|FIXME|HACK' -g '!$excludeGlob/**' $rootsArg"
    if ($todoScan.StartsWith("[command failed]") -and $todoScan -match '\(exit 1\)') {
        # rg exit 1 means "no matches", not an error.
        $todoScan = "No TODO/FIXME/HACK markers found."
    }
    elseif ($todoScan.StartsWith("[command failed]")) {
        $todoScan = "[scan error] $todoScan"
    }
    elseif ([string]::IsNullOrWhiteSpace($todoScan)) {
        $todoScan = "No TODO/FIXME/HACK markers found."
    }
    else {
        $todoScan = (($todoScan -split "`r?`n") | Select-Object -First 100) -join "`n"
    }
}
else {
    $files = @()
    foreach ($root in $searchRoots) {
        $files += Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notlike "*$([IO.Path]::DirectorySeparatorChar)loop-engineering$([IO.Path]::DirectorySeparatorChar)*" }
    }

    # -CaseSensitive matches ripgrep's default so local and CI runs agree.
    $scanMatches = $files | Select-String -Pattern 'TODO|FIXME|HACK' -CaseSensitive
    if ($scanMatches) {
        $todoScan = ($scanMatches | Select-Object -First 100 | ForEach-Object {
            $relative = $_.Path.Substring($repoRoot.Length).TrimStart('\', '/')
            "{0}:{1}: {2}" -f $relative, $_.LineNumber, $_.Line.Trim()
        }) -join "`n"
    }
    else {
        $todoScan = "No TODO/FIXME/HACK markers found."
    }
}

$todoCount = if ($todoScan -eq "No TODO/FIXME/HACK markers found." -or $todoScan.StartsWith("[scan error]")) { 0 } else { ($todoScan -split "`n").Count }

$checksSummary = @()
$failedChecks = 0
if ($RunChecks) {
    $checks = @(
        @{ Name = "npm run build"; Command = "npm run build" },
        @{ Name = "cdk synth"; Command = "npx cdk synth --quiet" }
    )

    foreach ($check in $checks) {
        Write-Host "Running $($check.Name)..."
        $output = Run-CommandOutput $check.Command
        # Prefix check: build output that merely contains the phrase
        # "command failed" must not mark the check FAILED.
        $result = if ($output.StartsWith("[command failed]")) { "FAILED" } else { "PASSED_OR_NEEDS_REVIEW" }
        if ($result -eq "FAILED") {
            $failedChecks++
        }
        $checksSummary += "- $($check.Name): $result"
    }
}
else {
    $checksSummary += "- Checks not run (use -RunChecks to enable)."
}

$stateContent = if (Test-Path $statePath) { Get-Content -Path $statePath -Raw -Encoding UTF8 } else { "" }
$highPriorityItems = Get-HighPriorityItems -StateContent $stateContent
$attemptLedger = Get-AttemptLedger -Path $attemptLedgerPath
$attemptLedger = Update-AttemptLedger -Ledger $attemptLedger -Items $highPriorityItems -IsoDate $isoDate

# Plan progress for a solo workflow: read spec task lists and surface where
# unfinished work left off. A spec counts as "active" only when its folder is
# referenced from the Approved Tasks queue in STATE.md; everything else is a
# draft and gets reported quietly, never nagged about.
$queueSection = [regex]::Match($stateContent, "(?ms)^## Approved Tasks.*?(?=^## |\z)").Value
$planLines = @()
$resumePointer = $null
if (Test-Path "specs") {
    $taskFiles = Get-ChildItem -Path "specs" -Recurse -Filter "tasks.md" -File | Sort-Object LastWriteTime -Descending
    foreach ($taskFile in $taskFiles) {
        $planContent = Get-Content -Path $taskFile.FullName -Raw -Encoding UTF8
        $openCount = [regex]::Matches($planContent, '(?m)^\s*-\s*\[ \]').Count
        $doneCount = [regex]::Matches($planContent, '(?m)^\s*-\s*\[[xX]\]').Count
        # Full path relative to the repo root, so nested spec folders keep
        # their real name instead of the immediate parent's.
        $specRef = $taskFile.Directory.FullName.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')
        # Boundary after the ref so "specs/001-x" cannot match a queue entry
        # for "specs/001-x-extended".
        $statusLabel = if ($queueSection -match ([regex]::Escape($specRef) + '(/|\s|$)')) { "active" } else { "draft" }
        $planLines += "- ${specRef}: $statusLabel - $doneCount done / $openCount open"
        if ($statusLabel -eq "active" -and $openCount -gt 0 -and -not $resumePointer) {
            $firstOpen = [regex]::Match($planContent, '(?m)^\s*-\s*\[ \]\s*(.+?)\s*$').Groups[1].Value
            $resumePointer = "$specRef -> $firstOpen"
        }
    }
}
if ($planLines.Count -eq 0) {
    $planLines += "- No spec task lists found under specs/."
}
$planResumeLine = if ($resumePointer) {
    "Resume here: $resumePointer"
}
else {
    "No active plan. Approve a spec into the Approved Tasks queue in STATE.md to give the work loop something to resume."
}

$recurringEscalations = @()
foreach ($slug in $attemptLedger["items"].Keys) {
    $entry = $attemptLedger["items"][$slug]
    if ($entry["status"] -eq "active" -and [int]$entry["consecutive_runs"] -ge 3) {
        $recurringEscalations += "$($entry["title"]) (seen $($entry["consecutive_runs"]) consecutive runs)"
    }
}

$healthSignals = @()
if ($gitStatus -ne "clean") {
    $healthSignals += "working tree not clean"
}
if ($todoCount -gt 0) {
    $healthSignals += "$todoCount TODO/FIXME/HACK markers"
}
if ($failedChecks -gt 0) {
    $healthSignals += "$failedChecks failed validation checks"
}
if ($recurringEscalations.Count -gt 0) {
    $healthSignals += "$($recurringEscalations.Count) recurring high-priority items"
}

# Report-only runs may be green when nothing is wrong; an unconditional
# yellow carried no information. "Checks not run" is still stated in the
# Validation Checks section.
$health = "green"
if ($failedChecks -gt 0) {
    $health = "red"
}
elseif ($healthSignals.Count -gt 0) {
    $health = "yellow"
}

$escalationSummary = @()
if ($failedChecks -gt 0) {
    $escalationSummary += "Escalate to the human gate before any L2 work because one or more validation checks failed."
}
if ($todoCount -gt 25) {
    $escalationSummary += "Escalate backlog review if TODO/FIXME/HACK markers continue to rise across repeated runs."
}
foreach ($item in $recurringEscalations) {
    $escalationSummary += "Escalate recurring item: $item"
}
if ($escalationSummary.Count -eq 0) {
    $escalationSummary += "No automatic escalation triggered in this run."
}

$attemptLedgerSummary = if ($highPriorityItems.Count -eq 0) {
    "- No high-priority items tracked in STATE.md."
}
else {
    (($highPriorityItems | ForEach-Object {
        $entry = $attemptLedger["items"][$_.Slug]
        "- $($_.Title): $($entry["consecutive_runs"]) consecutive runs"
    }) -join "`n")
}

$report = @"
# Loop Triage Report

- Run Time: $isoDate
- Branch: $gitBranch
- Health: $health
- Mode: L1 report-only
- Stop Rule: Write report + update STATE.md + stop
- L2 Attempt Cap: 2 maker-checker cycles per approved task
- Recurrence Cap: escalate unchanged high-priority items after 3 consecutive runs

## Git Status

$gitStatus

## TODO/FIXME/HACK Scan

$todoScan

## High-Priority Recurrence Ledger

$attemptLedgerSummary

## Plan Progress

$($planLines -join "`n")

$planResumeLine

## Validation Checks

$($checksSummary -join "`n")

## Escalation Guidance

$($escalationSummary | ForEach-Object { "- $_" } | Out-String)
## Recommended Next Actions

1. Review top risk items from this report.
2. Choose one scoped implementation task for the next session.
3. If you start L2 work, stop after 2 failed verifier cycles and escalate.
4. Re-run loop after completing changes.

## Human Gate Decision Required

- Yes
- Reason: This loop is configured as report-only and does not auto-apply changes.
"@

Write-Utf8NoBom -Path $reportPath -Content ($report.TrimEnd() + "`n")
Write-Host "Wrote triage report: $reportPath"

$runEndedAt = Get-Date
$durationSeconds = [math]::Round(($runEndedAt - $runStartedAt).TotalSeconds, 2)
$escalationCount = $escalationSummary.Count
if ($escalationSummary.Count -eq 1 -and $escalationSummary[0] -eq "No automatic escalation triggered in this run.") {
    $escalationCount = 0
}
$runLogEntry = [ordered]@{
    run_id = "triage-$timestamp"
    timestamp = $isoDate
    pattern = "daily-triage"
    duration_s = $durationSeconds
    branch = $gitBranch
    health = $health
    items_found = $todoCount
    actions_taken = 0
    escalations = $escalationCount
    outcome = if ($failedChecks -gt 0) { "needs-human-review" } else { "success" }
}

if ($UpdateState) {
    if (-not (Test-Path $statePath)) {
        throw "STATE.md not found at $statePath"
    }

    # Durable loop memory (ledger, run log) only changes on real runs;
    # a dry run is report-only.
    Write-Utf8NoBom -Path $attemptLedgerPath -Content (($attemptLedger | ConvertTo-Json -Depth 6) + "`n")
    [IO.File]::AppendAllText($runLogPath, (($runLogEntry | ConvertTo-Json -Compress) + "`n"), $utf8NoBom)

    $runId = "triage-$timestamp"
    $latestRunSummary = "Triage loop completed. See .loop/triage/triage-$timestamp.md"
    $escalationState = if ($escalationCount -gt 0) { "$escalationCount automatic escalation(s)" } else { "none" }
    $runLog = "Run log: $isoDate | health $health | $todoCount findings | 0 actions | $escalationCount escalations"
    $stateAppend = @"

- ${isoDate}: $runId completed, report at .loop/triage/triage-$timestamp.md
"@

    # Patterns are line-anchored and stop before the EOL so CRLF endings
    # survive and a task title mentioning e.g. "Health:" cannot be clobbered.
    $stateContent = Get-Content -Path $statePath -Raw -Encoding UTF8
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^Last run:[^\r\n]*" -Replacement "Last run: $isoDate"
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^- Run ID:[^\r\n]*" -Replacement "- Run ID: $runId"
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^- Date:[^\r\n]*" -Replacement "- Date: $isoDate"
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^- Summary:[^\r\n]*" -Replacement "- Summary: $latestRunSummary"
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^- Health:[^\r\n]*" -Replacement "- Health: $health"
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^- Escalations:[^\r\n]*" -Replacement "- Escalations: $escalationState"
    $nextAction = if ($resumePointer) { "Resume active plan: $resumePointer" } else { "Review the report and select one scoped task" }
    # Escape $ so task titles cannot trigger regex group substitution.
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^- Next Action:[^\r\n]*" -Replacement ("- Next Action: " + $nextAction.Replace('$', '$$'))
    $stateContent = Set-StateLine -Content $stateContent -Pattern "(?m)^Run log:[^\r\n]*" -Replacement $runLog
    $stateContent = $stateContent -replace "(\r?\n---\r?\nRun log:)", "$stateAppend`$1"
    Write-Utf8NoBom -Path $statePath -Content ($stateContent.TrimEnd() + "`n")
    Write-Host "Updated STATE.md run history"
}
