<#
.SYNOPSIS
  Opens the local RAS board to the home network (owner ras07 #11). Run once, as administrator.
.DESCRIPTION
  1. Sets the active network to Private if it is Public (explains and asks first; the Allow rule only works on Private).
     A change is remembered in %USERPROFILE%\.ras\lan-setup-state.json so -Remove can offer to undo it.
  2. Adds or updates ONE inbound Allow rule "RAS board <port>": TCP <port>, profile Private only, local subnet only,
     program = this node.exe. Warns about inbound Block rules for node.exe (they win over Allow).
  3. Adds or updates ONE inbound Block rule "RAS board <port> (block Public)": TCP <port>, profile Public, any program.
     Block wins over every Allow rule, also the broad "Node.js JavaScript Runtime" ones, so the port stays closed on
     café/hotel networks. serve-local.cjs --lan refuses to start without this rule (ras07 WO-03 audit H1).
  4. Prints the key to type once on the other computer (node tools/serve-local.cjs --show-key). The key is never put in a link.
  -Autostart  also registers a logon task "RAS board LAN" that runs "node tools/serve-local.cjs --lan" hidden.
  -Remove     removes both rules and the logon task, stops a running "serve-local.cjs --lan", and offers to set a network
              this script made Private back to Public. The key is left as it is.
  Idempotent: running it again changes nothing that is already right. Windows PowerShell 5.1.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\lan-setup.ps1
  powershell -ExecutionPolicy Bypass -File tools\lan-setup.ps1 -Autostart
  powershell -ExecutionPolicy Bypass -File tools\lan-setup.ps1 -Remove
#>
param(
  [switch]$Remove,
  [switch]$Autostart,
  [int]$Port = 5199
)
$ErrorActionPreference = 'Stop'

$ruleName = "RAS board $Port"
$blockName = "RAS board $Port (block Public)"
$taskName = 'RAS board LAN'
$repo = Split-Path -Parent $PSScriptRoot
$serve = Join-Path $repo 'tools\serve-local.cjs'
$stateFile = Join-Path $env:USERPROFILE '.ras\lan-setup-state.json'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Kör skriptet som administratör (högerklicka PowerShell -> Kör som administratör).' -ForegroundColor Red
  exit 1
}

function Test-Yes([string]$answer) { return $answer -match '^(j|ja|y|yes)$' }
# Networks this script changed from Public to Private: @{ name; alias; from }.
function Read-State {
  if (-not (Test-Path $stateFile)) { return @() }
  try { return @((Get-Content -Raw -Encoding UTF8 $stateFile | ConvertFrom-Json).changed | Where-Object { $_ }) } catch { return @() }
}
function Write-State($changed) {
  $list = @($changed)
  if ($list.Count -eq 0) { Remove-Item $stateFile -ErrorAction SilentlyContinue; return }
  New-Item -ItemType Directory -Force (Split-Path -Parent $stateFile) | Out-Null
  ConvertTo-Json -InputObject @{ changed = $list } -Depth 3 | Set-Content -Encoding UTF8 $stateFile
}

if ($Remove) {
  foreach ($name in @($ruleName, $blockName)) {
    $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($rule) { $rule | Remove-NetFirewallRule; Write-Host "Brandväggsregeln '$name' är borttagen." }
    else { Write-Host "Ingen brandväggsregel '$name' fanns." }
  }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Uppgiften '$taskName' är borttagen."
  }
  # Stop only the board started in home-network mode (--lan); the normal 127.0.0.1 board keeps running.
  $lanServers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'serve-local\.cjs' -and $_.CommandLine -match '(^|\s)--lan(\s|$)' })
  foreach ($proc in $lanServers) {
    Stop-Process -Id $proc.ProcessId -Force
    Write-Host "Tavlans hemnätverksserver (process $($proc.ProcessId)) är stoppad."
  }
  if ($lanServers.Count -eq 0) { Write-Host 'Ingen tavla i hemnätverksläge (--lan) körde. (En tavla startad med RAS_BOARD_LAN=1 stoppar du själv.)' }
  # Offer to undo the network profile change this script made.
  $left = @()
  foreach ($c in Read-State) {
    $p = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $c.name -and $_.InterfaceAlias -eq $c.alias })[0]
    if (-not $p) {
      Write-Host "Nätverket '$($c.name)' är inte anslutet nu. Det står kvar som Privat; kör -Remove igen när du är ansluten till det." -ForegroundColor Yellow
      $left += $c
      continue
    }
    if ($p.NetworkCategory -ne 'Private') { continue }
    $answer = Read-Host "Skriptet satte nätverket '$($c.name)' till Privat. Sätta tillbaka det till Offentligt (Windows litar då inte på andra enheter där)? (j/n)"
    if (Test-Yes $answer) {
      Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Public
      Write-Host "'$($c.name)' är Offentligt igen."
    } else {
      Write-Host "'$($c.name)' lämnas Privat."
    }
  }
  Write-State $left
  Write-Host 'Nyckeln är oförändrad (ny nyckel, alla enheter utloggade: node tools\serve-local.cjs --rotate-key).'
  exit 0
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Host 'node.exe hittades inte i PATH.' -ForegroundColor Red; exit 1 }
$node = $nodeCmd.Source

# 1. Network profile: the Allow rule is Private only. Explain what Private means and ask before changing it.
$changed = @(Read-State)
$profiles = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' })
foreach ($p in $profiles) {
  if ($p.NetworkCategory -eq 'Public') {
    Write-Host ''
    Write-Host "Nätverket '$($p.Name)' ($($p.InterfaceAlias)) är Offentligt. Då når andra datorer inte tavlan."
    Write-Host 'Privat betyder att Windows litar på enheterna i nätverket: utöver tavlan blir även fil- och skrivardelning,'
    Write-Host 'nätverksidentifiering och andra program som har regler för Privat nåbara därifrån.'
    Write-Host 'Gör det bara på ditt eget hemnätverk, aldrig på kafé, hotell eller jobb. -Remove kan ändra tillbaka.'
    $answer = Read-Host "Sätta '$($p.Name)' till Privat? (j/n)"
    if (Test-Yes $answer) {
      Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
      $changed = @($changed | Where-Object { -not ($_.name -eq $p.Name -and $_.alias -eq $p.InterfaceAlias) }) +
        @([pscustomobject]@{ name = $p.Name; alias = $p.InterfaceAlias; from = 'Public' })
      Write-State $changed
      Write-Host "'$($p.Name)' är nu Privat."
    } else {
      Write-Host "'$($p.Name)' lämnas Offentligt – tavlan nås inte från andra datorer på det nätverket." -ForegroundColor Yellow
    }
  } else {
    Write-Host "Nätverket '$($p.Name)' är $($p.NetworkCategory)."
  }
}

# 2. One inbound Allow rule, Private profile and local subnet only, for this node.exe.
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
  $rule | Set-NetFirewallRule -Direction Inbound -Action Allow -Profile Private -Enabled True
  $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
  $rule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $node
  $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet
  Write-Host "Brandväggsregeln '$ruleName' är uppdaterad (tillåt TCP $Port, Privat, lokalt nät, $node)."
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -Profile Private -RemoteAddress LocalSubnet -Program $node -Description 'RAS board on the home network (ras07 #11)' | Out-Null
  Write-Host "Brandväggsregeln '$ruleName' är skapad (tillåt TCP $Port, Privat, lokalt nät, $node)."
}
$blocks = @(Get-NetFirewallApplicationFilter -Program $node -ErrorAction SilentlyContinue | Get-NetFirewallRule |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' })
foreach ($b in $blocks) {
  Write-Host "Varning: regeln '$($b.DisplayName)' blockerar node.exe inkommande ($($b.Profile)) och vinner över tillåt-regeln. Ta bort den i Windows-brandväggen om tavlan inte nås." -ForegroundColor Yellow
}

# 3. One inbound Block rule on the Public profile, any program: Block wins over every Allow rule for this port.
$block = Get-NetFirewallRule -DisplayName $blockName -ErrorAction SilentlyContinue
if ($block) {
  $block | Set-NetFirewallRule -Direction Inbound -Action Block -Profile Public -Enabled True
  $block | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
  $block | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program Any
  $block | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress Any
  Write-Host "Brandväggsregeln '$blockName' är uppdaterad (blockera TCP $Port på offentliga nätverk)."
} else {
  New-NetFirewallRule -DisplayName $blockName -Direction Inbound -Action Block -Protocol TCP -LocalPort $Port `
    -Profile Public -Description 'RAS board: never reachable on a Public network (ras07 WO-03 audit H1)' | Out-Null
  Write-Host "Brandväggsregeln '$blockName' är skapad (blockera TCP $Port på offentliga nätverk)."
}

# Optional: start the LAN server at logon, hidden, output to %USERPROFILE%\.ras\board-lan.log. Only with -Autostart.
if ($Autostart) {
  $log = Join-Path $env:USERPROFILE '.ras\board-lan.log'
  $cmd = "& '$($node -replace "'", "''")' '$($serve -replace "'", "''")' --lan --port $Port *>> '$($log -replace "'", "''")'"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $repo `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null
  Write-Host "Uppgiften '$taskName' startar tavlan i hemnätverksläge vid inloggning ($env:USERNAME). Logg: $log"
  Write-Host 'Stäng RAS-tavla-knappens server i T3 först, annars är porten upptagen.' -ForegroundColor Yellow
}

# 4. The key to type once on the other computer (never in a link).
Write-Host ''
Write-Host 'Skriv in nyckeln EN gång på den andra datorn, på sidan "Nyckel krävs". Dela den inte:'
& $node $serve --show-key --port $Port
Write-Host ''
Write-Host "Starta tavlan i hemnätverksläge: node tools\serve-local.cjs --lan   (eller sätt RAS_BOARD_LAN=1)"
