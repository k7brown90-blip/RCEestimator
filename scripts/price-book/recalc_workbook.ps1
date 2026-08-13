<#
.SYNOPSIS
  Recalculate a COPY of price-book.xlsx in Excel and emit its computed values as JSON.

.DESCRIPTION
  The live workbook carries NO cached formula values -- 3,117 formula cells, 0 cached,
  because it was last written by openpyxl, which does not calculate. So the workbook's
  own computed totals cannot be read out of the file. This script is how they are
  obtained: Excel opens the file, rebuilds every formula in memory, and the results are
  read back.

  SAFETY, AND IT IS NOT NEGOTIABLE -- the caller (extract_workbook.py) passes a path to a
  TEMPORARY COPY, never the live workbook. On top of that this script:
    * opens ReadOnly:$true, so Excel cannot save back to it
    * sets DisplayAlerts off so no dialog can block a headless run
    * closes with SaveChanges:$false and quits Excel in a finally block
    * refuses to run at all if the path looks like the live workbook (see -AllowLiveFile)

  Values are read with Range.Value2 a block at a time rather than cell by cell: one COM
  round trip per column block instead of ~1,700, which is the difference between seconds
  and minutes.

.PARAMETER WorkbookCopy
  Path to the temporary copy to recalculate.

.PARAMETER OutJson
  Path the computed-value JSON is written to.

.PARAMETER AllowLiveFile
  Escape hatch for a deliberate run against a file literally named price-book.xlsx.
  Not used by the pipeline.

.OUTPUTS
  JSON: { assemblies: {id: {...}}, atomics: {id: {...}}, supplierPrices: {"item|supplier": {...}} }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorkbookCopy,
    [Parameter(Mandatory = $true)][string]$OutJson,
    [switch]$AllowLiveFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $WorkbookCopy)) {
    Write-Error "Workbook copy not found: $WorkbookCopy"
    exit 3
}

$full = (Resolve-Path -LiteralPath $WorkbookCopy).Path
if (-not $AllowLiveFile -and (Split-Path -Leaf $full) -eq 'price-book.xlsx') {
    Write-Error @"
REFUSING TO OPEN THE LIVE WORKBOOK.
  $full
This script is only ever pointed at a temporary copy. The workbook is read-only to this
pipeline (Scope - do not: 'Do not edit price-book.xlsx or any workbook tab. Ever.').
Pass -AllowLiveFile only if you have decided otherwise, deliberately.
"@
    exit 5
}

# Columns read back per sheet class. Keep in step with RECALC_TARGETS in extract_workbook.py.
$AssemblyCols = [ordered]@{
    'F'  = 'totalLaborNormal';   'L'  = 'laborHoursAdjusted'; 'M'  = 'laborDollars'
    'N'  = 'materialCost';       'O'  = 'materialSell';       'P'  = 'jobAdderHours'
    'Q'  = 'jobAdderDollars';    'R'  = 'permitFee';          'S'  = 'totalFlatRate'
    'U'  = 'componentsUnpriced'; 'W'  = 'materialComplete';   'X'  = 'totalJobHours'
    'AF' = 'jobFixedCost';       'AG' = 'totalWithFixedCost'
}
$AtomicCols        = [ordered]@{ 'K' = 'costBasisUsed'; 'W' = 'markupTier'; 'X' = 'sellPricePerUnit' }
$SupplierPriceCols = [ordered]@{ 'F' = 'unitCost';      'L' = 'quotableKey' }

function ConvertTo-ColumnIndex([string]$Letter) {
    $n = 0
    foreach ($ch in $Letter.ToUpper().ToCharArray()) { $n = $n * 26 + ([int][char]$ch - 64) }
    return $n
}

# Read one column as a flat array of values. Range.Value2 returns a 2-D COM array for a
# multi-cell range and a bare scalar for a single cell -- both cases handled.
function Read-Column($Sheet, [string]$Letter, [int]$FirstRow, [int]$LastRow) {
    if ($LastRow -lt $FirstRow) { return @() }
    $ci = ConvertTo-ColumnIndex $Letter
    $range = $Sheet.Range($Sheet.Cells($FirstRow, $ci), $Sheet.Cells($LastRow, $ci))
    $v = $range.Value2
    $out = New-Object object[] ($LastRow - $FirstRow + 1)
    if ($null -eq $v) { return $out }
    if ($v -isnot [Array]) { $out[0] = $v; return $out }
    for ($i = 1; $i -le ($LastRow - $FirstRow + 1); $i++) { $out[$i - 1] = $v.GetValue($i, 1) }
    return $out
}

function Get-LastRow($Sheet) {
    try { return [int]$Sheet.UsedRange.Rows.Count + [int]$Sheet.UsedRange.Row - 1 }
    catch { return 1 }
}

$excel = $null
$wb = $null
$result = [ordered]@{
    assemblies     = [ordered]@{}
    atomics        = [ordered]@{}
    supplierPrices = [ordered]@{}
}

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false
    $excel.EnableEvents = $false
    $excel.ScreenUpdating = $false

    # UpdateLinks=0 (never), ReadOnly=$true, AddToMru=$false
    $wb = $excel.Workbooks.Open($full, 0, $true, [Type]::Missing, [Type]::Missing,
        [Type]::Missing, $true, [Type]::Missing, [Type]::Missing, [Type]::Missing,
        [Type]::Missing, [Type]::Missing, $false)

    $excel.Application.CalculateFullRebuild()

    foreach ($sheetName in @('Assemblies-Residential', 'Assemblies-Commercial')) {
        $ws = $wb.Worksheets.Item($sheetName)
        $last = Get-LastRow $ws
        if ($last -lt 2) { continue }
        $ids = Read-Column $ws 'A' 2 $last
        $cols = @{}
        foreach ($k in $AssemblyCols.Keys) { $cols[$k] = Read-Column $ws $k 2 $last }
        for ($i = 0; $i -lt $ids.Count; $i++) {
            $id = $ids[$i]
            if ($null -eq $id -or "$id".Trim() -eq '') { continue }
            $rec = [ordered]@{}
            foreach ($k in $AssemblyCols.Keys) { $rec[$AssemblyCols[$k]] = $cols[$k][$i] }
            $result.assemblies["$($id.ToString().Trim())"] = $rec
        }
    }

    $ws = $wb.Worksheets.Item('Atomics')
    $last = Get-LastRow $ws
    if ($last -ge 2) {
        $ids = Read-Column $ws 'A' 2 $last
        $cols = @{}
        foreach ($k in $AtomicCols.Keys) { $cols[$k] = Read-Column $ws $k 2 $last }
        for ($i = 0; $i -lt $ids.Count; $i++) {
            $id = $ids[$i]
            if ($null -eq $id -or "$id".Trim() -eq '') { continue }
            $rec = [ordered]@{}
            foreach ($k in $AtomicCols.Keys) { $rec[$AtomicCols[$k]] = $cols[$k][$i] }
            $result.atomics["$($id.ToString().Trim())"] = $rec
        }
    }

    $ws = $wb.Worksheets.Item('Supplier Prices')
    $last = Get-LastRow $ws
    if ($last -ge 2) {
        $items = Read-Column $ws 'A' 2 $last
        $sups = Read-Column $ws 'B' 2 $last
        $cols = @{}
        foreach ($k in $SupplierPriceCols.Keys) { $cols[$k] = Read-Column $ws $k 2 $last }
        for ($i = 0; $i -lt $items.Count; $i++) {
            $it = $items[$i]; $sp = $sups[$i]
            if ($null -eq $it -or $null -eq $sp) { continue }
            if ("$it".Trim() -eq '' -or "$sp".Trim() -eq '') { continue }
            $rec = [ordered]@{}
            foreach ($k in $SupplierPriceCols.Keys) { $rec[$SupplierPriceCols[$k]] = $cols[$k][$i] }
            $result.supplierPrices["$($it.ToString().Trim())|$($sp.ToString().Trim())"] = $rec
        }
    }
}
catch {
    Write-Error "Excel recalculation failed: $($_.Exception.Message)"
    exit 6
}
finally {
    if ($null -ne $wb) { try { $wb.Close($false) } catch { } }
    if ($null -ne $excel) { try { $excel.Quit() } catch { } }
    if ($null -ne $wb) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb) } catch { } }
    if ($null -ne $excel) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) } catch { } }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}

$json = $result | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("recalc OK: assemblies={0} atomics={1} supplierPrices={2}" -f `
    $result.assemblies.Count, $result.atomics.Count, $result.supplierPrices.Count)
exit 0
