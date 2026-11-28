# Pin the LAN adapter to 192.168.1.5 so the phone URL never changes.
# Run elevated:  powershell -ExecutionPolicy Bypass -File scripts\lan-static-ip.ps1
# Revert with:   powershell -ExecutionPolicy Bypass -File scripts\lan-static-ip.ps1 -RestoreDhcp
param([switch]$RestoreDhcp)

$ErrorActionPreference = 'Stop'
$Alias   = 'LAN'
$Address = '192.168.1.5'
$Prefix  = 24
$Gateway = '192.168.1.1'
$Dns     = @('192.168.1.1', '223.5.5.5')

if ($RestoreDhcp) {
  Set-NetIPInterface -InterfaceAlias $Alias -Dhcp Enabled
  Remove-NetIPAddress -InterfaceAlias $Alias -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetRoute -InterfaceAlias $Alias -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
  Set-DnsClientServerAddress -InterfaceAlias $Alias -ResetServerAddresses
  Write-Host "已恢复 DHCP"
  exit 0
}

# Remove competing IPv4 leases/routes first so the static address sticks cleanly
Remove-NetIPAddress -InterfaceAlias $Alias -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetRoute -InterfaceAlias $Alias -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue

New-NetIPAddress -InterfaceAlias $Alias -IPAddress $Address -PrefixLength $Prefix -DefaultGateway $Gateway | Out-Null
Set-DnsClientServerAddress -InterfaceAlias $Alias -ServerAddresses $Dns
Set-NetIPInterface -InterfaceAlias $Alias -Dhcp Disabled

Write-Host "固定 IP 已生效："
Get-NetIPAddress -InterfaceAlias $Alias -AddressFamily IPv4 | Select-Object IPAddress, PrefixLength, PrefixOrigin | Format-Table -AutoSize
