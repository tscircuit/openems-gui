# openEMS GUI installer for Windows.
#
#   irm https://raw.githubusercontent.com/tscircuit/openems-gui/main/install.ps1 | iex
#
# Downloads the latest installer and runs it for the current user. There is no
# prebuilt openEMS engine for Windows yet: the app uses an openEMS you installed
# yourself (a Python that can `import openEMS`) or Docker Desktop.
$ErrorActionPreference = "Stop"
$repo = "tscircuit/openems-gui"
$version = if ($env:OPENEMS_GUI_VERSION) { $env:OPENEMS_GUI_VERSION } else { "latest" }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$asset = "openEMS-GUI-win-$arch-setup.exe"
$url = if ($version -eq "latest") { "https://github.com/$repo/releases/latest/download/$asset" } else { "https://github.com/$repo/releases/download/$version/$asset" }
$installer = Join-Path $env:TEMP $asset

Write-Host "==> Downloading openEMS GUI ($version, Windows $arch)"
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
Write-Host "==> Installing"
Start-Process -FilePath $installer -ArgumentList "/S" -Wait
Remove-Item $installer -ErrorAction SilentlyContinue
Write-Host "==> openEMS GUI is installed. Start it from the Start menu."
Write-Host "    Simulations need openEMS: install it with Python bindings (https://docs.openems.de) or start Docker Desktop,"
Write-Host "    then pick the engine from the engine menu in the app's top-right corner."
