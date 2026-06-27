param(
    [ValidateSet("create", "list", "remove")]
    [string]$Action,
    [string]$Name = "",
    [string]$BaseBranch = "master"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Get-Location).Path
$worktreeRoot = Join-Path $repoRoot ".worktrees"

if (-not (Test-Path $worktreeRoot)) {
    New-Item -ItemType Directory -Path $worktreeRoot -Force | Out-Null
}

function Require-Name {
    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "Name is required. Example: -Name l2-fix-logging"
    }
}

switch ($Action) {
    "create" {
        Require-Name
        $branchName = "loop/$Name"
        $path = Join-Path $worktreeRoot $Name

        if (Test-Path $path) {
            throw "Worktree path already exists: $path"
        }

        git fetch origin | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "git fetch origin failed; branching from possibly stale local refs."
        }

        # Branch from the freshly fetched remote ref when it exists so a
        # stale local base branch does not seed the worktree.
        $baseRef = "origin/$BaseBranch"
        git rev-parse --verify --quiet $baseRef | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $baseRef = $BaseBranch
        }

        git worktree add "$path" -b "$branchName" "$baseRef"

        Write-Host "Created worktree: $path"
        Write-Host "Branch: $branchName"
        Write-Host "Tip: cd $path"
    }

    "list" {
        git worktree list
    }

    "remove" {
        Require-Name
        $path = Join-Path $worktreeRoot $Name
        if (-not (Test-Path $path)) {
            throw "Worktree path not found: $path"
        }

        git worktree remove "$path"
        Write-Host "Removed worktree: $path"
    }
}
