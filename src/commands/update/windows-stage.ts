import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { psQuote, runUpdateCommand, throwIfCancelled, type RunOptions, type UpdateCommand } from "./process.js";

export type WindowsUpdateTask =
  | { readonly kind: "binary"; readonly source: string; readonly destination: string; readonly digest: string; readonly previousDigest: string; readonly version: string }
  | { readonly kind: "commands"; readonly commands: readonly UpdateCommand[]; readonly verification: UpdateCommand; readonly version: string; readonly allowNewer: boolean; readonly cleanup?: UpdateCommand };

export function windowsUpdateScript(encoded: string): string {
  return String.raw`$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$task = $data.task
$stage = $data.stage
$status = $data.status
$pending = $null
$backup = $null
$verified = $false
function Save-Status($state, $message) {
  @{ state=$state; version=$task.version; message=$message; time=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $status -Encoding UTF8
}
function Quote-Argument($value) {
  if ($value -notmatch '[\s"]' -and $value.Length -gt 0) { return $value }
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  return '"' + [regex]::Replace($escaped, '(\\+)$', '$1$1') + '"'
}
function Invoke-CommandSpec($spec) {
  if ($spec.env) { foreach ($property in $spec.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') } }
  $arguments = (@($spec.args | ForEach-Object { Quote-Argument ([string]$_) }) -join ' ')
  $outFile = Join-Path $stage 'stdout.txt'
  $errFile = Join-Path $stage 'stderr.txt'
  $parameters = @{ FilePath=$spec.file; ArgumentList=$arguments; RedirectStandardOutput=$outFile; RedirectStandardError=$errFile; PassThru=$true; NoNewWindow=$true }
  if ($spec.cwd) { $parameters.WorkingDirectory = $spec.cwd }
  $child = Start-Process @parameters
  $null = $child.Handle
  $limit = 600000
  if ($spec.args -contains '--version') { $limit = 15000 }
  if (-not $child.WaitForExit($limit)) {
    & taskkill.exe /PID $child.Id /T /F *> $null
    throw "Update command timed out: $($spec.file)"
  }
  $output = (Get-Content -LiteralPath $outFile -Tail 64) -join [Environment]::NewLine
  $exitCode = $child.ExitCode
  if ($null -eq $exitCode) { throw "Cannot read update command exit status: $($spec.file)" }
  if ($exitCode -ne 0) { throw "Update command exited with status $($exitCode): $($spec.file) $((Get-Content -LiteralPath $errFile -Tail 4) -join ' ') $output" }
  return $output.Trim()
}
function Compare-Version($left, $right) {
  $a = ($left -split '\+')[0] -split '-', 2
  $b = ($right -split '\+')[0] -split '-', 2
  $numbersA = $a[0].Split('.')
  $numbersB = $b[0].Split('.')
  for ($index = 0; $index -lt 3; $index++) {
    $difference = ([long]$numbersA[$index]).CompareTo([long]$numbersB[$index])
    if ($difference -ne 0) { return $difference }
  }
  if ($a.Count -eq 1 -or $b.Count -eq 1) { return [int]($b.Count -gt 1) - [int]($a.Count -gt 1) }
  $preA = $a[1].Split('.')
  $preB = $b[1].Split('.')
  for ($index = 0; $index -lt [Math]::Min($preA.Count, $preB.Count); $index++) {
    if ($preA[$index] -ceq $preB[$index]) { continue }
    $numericA = $preA[$index] -match '^\d+$'
    $numericB = $preB[$index] -match '^\d+$'
    if ($numericA -ne $numericB) { return [int]$numericB - [int]$numericA }
    if ($numericA -and $preA[$index].Length -ne $preB[$index].Length) { return $preA[$index].Length - $preB[$index].Length }
    return [StringComparer]::Ordinal.Compare($preA[$index], $preB[$index])
  }
  return $preA.Count - $preB.Count
}
function Verify-Version($spec, $allowNewer) {
  $value = (Invoke-CommandSpec $spec) -replace '^clai\s+', ''
  if ($value -cnotmatch '^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$') { throw "Cannot verify installed version: $value" }
  $actual = $Matches[1]
  $parts = ($actual -split '\+')[0] -split '-', 2
  if ($parts.Count -eq 2) { foreach ($part in $parts[1].Split('.')) { if ($part -match '^0\d+$') { throw "Invalid installed version: $value" } } }
  if ($allowNewer) {
    if ((Compare-Version $actual $task.version) -lt 0) { throw "Installer did not reach version $($task.version): $value" }
  } elseif ($actual -cne $task.version) { throw "Installed version mismatch: $value" }
}
try {
  Save-Status 'waiting' 'Close this clai installation to apply the staged update.'
  if (-not (Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath (Join-Path $stage 'cancel'))) { throw 'Update cancelled before staging.' }
  if ($data.lockFile) {
    $owner = Get-Content -LiteralPath $data.lockFile -Raw | ConvertFrom-Json
    if ($owner.token -ne $data.lockToken) { throw 'Update lock changed before staging; existing installation was kept.' }
    @{ pid=$PID; token=$data.lockToken } | ConvertTo-Json -Compress | Set-Content -LiteralPath $data.lockFile
  }
  Set-Content -LiteralPath (Join-Path $stage 'ready') -Value 'ready'
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ($true) {
    if (-not (Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath (Join-Path $stage 'cancel'))) { throw 'Update cancelled before installation.' }
    $owner = Get-Process -Id $data.pid -ErrorAction SilentlyContinue
    $holders = @()
    if ($task.kind -eq 'binary') { $holders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $task.destination }) }
    if (-not $owner -and $holders.Count -eq 0) { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for clai to close; the previous installation was kept. Close all instances and retry.' }
    Start-Sleep -Milliseconds 250
  }
  Save-Status 'installing' 'Applying staged update.'
  if ($task.kind -eq 'binary') {
    if ((Get-FileHash -LiteralPath $task.source -Algorithm SHA256).Hash.ToLower() -ne $task.digest) { throw 'Staged binary checksum mismatch.' }
    Verify-Version @{ file=$task.source; args=@('--version') } $false
    $pending = "$($task.destination).update-$([Guid]::NewGuid().ToString('N'))"
    $backup = "$($task.destination).rollback-$([Guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $task.source -Destination $pending
    if ((Get-FileHash -LiteralPath $task.destination -Algorithm SHA256).Hash.ToLower() -ne $task.previousDigest) { throw 'Installation changed while the update was staged; existing executable was kept.' }
    [IO.File]::Replace($pending, $task.destination, $backup, $true)
    try { Verify-Version @{ file=$task.destination; args=@('--version') } $false }
    catch { [IO.File]::Replace($backup, $task.destination, $null, $true); throw }
  } else {
    foreach ($command in $task.commands) { $null = Invoke-CommandSpec $command }
    Verify-Version $task.verification $task.allowNewer
  }
  $verified = $true
  Save-Status 'applied' 'Update applied and verified.'
} catch {
  $message = $_.Exception.Message
  if ($backup -and (Test-Path -LiteralPath $backup)) { $message += "; recovery executable: $backup" }
  Save-Status 'failed' $message
} finally {
  if ($task.kind -eq 'commands' -and $task.cleanup) {
    try { $null = [IO.Directory]::CreateDirectory($stage); $null = Invoke-CommandSpec $task.cleanup }
    catch { Save-Status $(if ($verified) { 'applied' } else { 'failed' }) ("$message; staged source cleanup failed: " + $_.Exception.Message) }
  }
  if ($pending) { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
  if ($verified -and $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  if ($data.lockFile -and (Test-Path -LiteralPath $data.lockFile)) {
    try { if ((Get-Content -LiteralPath $data.lockFile -Raw | ConvertFrom-Json).token -eq $data.lockToken) { Remove-Item -LiteralPath $data.lockFile -Force } } catch {}
  }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

export async function stageWindowsUpdate(task: WindowsUpdateTask, options: RunOptions & { readonly lockFile?: string; readonly lockToken?: string | undefined } = {}, elevated = false): Promise<string> {
  throwIfCancelled(options.signal);
  if (options.lockFile && !options.lockToken) throw new Error("cannot stage an update without its installation lock token");
  const stage = mkdtempSync(join(tmpdir(), "clai-update-stage-"));
  const identity = task.kind === "binary" ? task.destination : task.verification.file + task.verification.args.join("|");
  const status = join(tmpdir(), `clai-update-status-${createHash("sha256").update(identity).update(stage).digest("hex").slice(0, 20)}.json`);
  let accepted = false;
  try {
    const stagedTask = task.kind === "binary" ? { ...task, source: join(stage, "clai.exe") } : task;
    if (task.kind === "binary" && stagedTask.kind === "binary") copyFileSync(task.source, stagedTask.source);
    const encoded = Buffer.from(JSON.stringify({ task: stagedTask, stage, status, pid: process.pid, lockFile: options.lockFile, lockToken: options.lockToken })).toString("base64");
    const script = join(stage, "apply-update.ps1");
    writeFileSync(script, windowsUpdateScript(encoded));
    if (elevated) {
      const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
      await runUpdateCommand({ file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -Verb RunAs -WindowStyle Hidden -FilePath powershell.exe -ArgumentList ${psQuote(argumentsText)}`] }, { ...options, timeoutMs: 120_000 });
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
    }
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(stage, "ready"))) {
      throwIfCancelled(options.signal);
      if (Date.now() >= deadline || !existsSync(stage)) {
        const failure = existsSync(status) ? readFileSync(status, "utf8") : "worker did not acknowledge the staged update";
        throw new Error(`could not stage Windows update: ${failure.slice(0, 500)}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throwIfCancelled(options.signal);
    accepted = true;
    return status;
  } finally {
    if (!accepted) {
      if (existsSync(stage)) writeFileSync(join(stage, "cancel"), "cancel");
      rmSync(stage, { recursive: true, force: true });
    }
  }
}
