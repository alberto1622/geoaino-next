# desktop/scripts/assemble-pg-portable.ps1
# Assemble un PostgreSQL 16 + PostGIS portable (zips EDB + PostGIS, sans
# installateur) dans desktop/vendor/pg-portable/, pour etre embarque tel
# quel par electron-builder (cf. Task 10, extraResources).
#
# Prerequis : telecharger manuellement (pages avec interaction navigateur) :
#   - PostgreSQL 16.x Windows x86-64 "binaries" zip :
#     https://www.enterprisedb.com/download-postgresql-binaries
#   - PostGIS zip (pas l'installateur .exe) pour PostgreSQL 16, 64-bit :
#     https://download.osgeo.org/postgis/windows/pg16/
#
# Usage :
#   .\assemble-pg-portable.ps1 -PgZip <chemin> -PostgisZip <chemin>

param(
    [Parameter(Mandatory=$true)][string]$PgZip,
    [Parameter(Mandatory=$true)][string]$PostgisZip
)

$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\vendor\pg-portable"

if (Test-Path $dest) {
    Remove-Item $dest -Recurse -Force
}
New-Item -ItemType Directory -Path $dest | Out-Null

Write-Host "Extraction de PostgreSQL..."
Expand-Archive -Path $PgZip -DestinationPath $dest -Force
# L'archive EDB extrait un dossier "pgsql" a la racine : on remonte son contenu.
$pgsql = Join-Path $dest "pgsql"
if (Test-Path $pgsql) {
    Get-ChildItem $pgsql | Move-Item -Destination $dest -Force
    Remove-Item $pgsql -Recurse -Force
}

Write-Host "Extraction de PostGIS..."
$postgisTmp = Join-Path $dest "_postgis_tmp"
Expand-Archive -Path $PostgisZip -DestinationPath $postgisTmp -Force
# Le zip PostGIS a la meme structure bin/lib/share qu'une installation
# PostgreSQL : on fusionne son contenu dans l'arbre deja extrait.
Copy-Item -Path (Join-Path $postgisTmp "*") -Destination $dest -Recurse -Force
Remove-Item $postgisTmp -Recurse -Force

Write-Host "Verification : demarrage d'un cluster de test..."
$testData = Join-Path $env:TEMP "geoaino-pg-portable-test"
if (Test-Path $testData) { Remove-Item $testData -Recurse -Force }

& (Join-Path $dest "bin\initdb.exe") -D $testData -U postgres -A trust -E UTF8 | Out-Null
& (Join-Path $dest "bin\pg_ctl.exe") -D $testData -l (Join-Path $testData "log.txt") -o "-p 55432 -c listen_addresses=127.0.0.1" start | Out-Null
Start-Sleep -Seconds 2
& (Join-Path $dest "bin\psql.exe") -h 127.0.0.1 -p 55432 -U postgres -c "CREATE EXTENSION postgis; SELECT PostGIS_Version();"
$ok = $LASTEXITCODE -eq 0
& (Join-Path $dest "bin\pg_ctl.exe") -D $testData -m fast stop | Out-Null
Start-Sleep -Seconds 1
Remove-Item $testData -Recurse -Force

if (-not $ok) {
    throw "Echec : CREATE EXTENSION postgis a echoue sur le bundle assemble."
}
Write-Host "OK : $dest contient un PostgreSQL 16 + PostGIS fonctionnel."
