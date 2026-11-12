param([Parameter(Mandatory = $true)][string]$PrinterName)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Reply($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  $dllDir = Join-Path $env:LOCALAPPDATA 'Tecno Caja'
  $dllPath = Join-Path $dllDir 'rawprint-worker-v2.dll'
  [IO.Directory]::CreateDirectory($dllDir) | Out-Null
  # Solo la compilación se comparte entre impresoras. Los envíos son independientes.
  $mutex = [Threading.Mutex]::new($false, 'Local\TecnoCajaRawPrintWorkerV2')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(40000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'La preparación del componente de impresión está ocupada.' }
    if (Test-Path -LiteralPath $dllPath) {
      try { Add-Type -Path $dllPath } catch { Remove-Item -LiteralPath $dllPath -Force }
    }
    if (-not ('TecnoCajaRawWorker' -as [type])) {
      $code = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TecnoCajaRawWorker {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern int StartDocPrinter(IntPtr handle, int level, DOCINFO info);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  static void Check(bool ok, string step) {
    if (!ok) {
      int code = Marshal.GetLastWin32Error();
      throw new Win32Exception(code, step + " fallo: " + new Win32Exception(code).Message);
    }
  }
  public static int Print(string name, byte[] data) {
    IntPtr handle = IntPtr.Zero;
    bool doc = false, page = false;
    try {
      Check(OpenPrinter(name, out handle, IntPtr.Zero), "OpenPrinter");
      int job = StartDocPrinter(handle, 1, new DOCINFO { pDocName="Tecno Caja", pDataType="RAW" });
      Check(job != 0, "StartDocPrinter"); doc = true;
      Check(StartPagePrinter(handle), "StartPagePrinter"); page = true;
      int written;
      Check(WritePrinter(handle, data, data.Length, out written), "WritePrinter");
      if (written != data.Length) throw new Exception("Impresión incompleta; revisa la cola de Windows antes de repetir.");
      bool pageOk = EndPagePrinter(handle); page = false; Check(pageOk, "EndPagePrinter");
      bool docOk = EndDocPrinter(handle); doc = false; Check(docOk, "EndDocPrinter");
      return job;
    } finally {
      if (page) EndPagePrinter(handle);
      if (doc) EndDocPrinter(handle);
      if (handle != IntPtr.Zero) ClosePrinter(handle);
    }
  }
}
'@
      $buildPath = Join-Path $dllDir (([Guid]::NewGuid().ToString()) + '.dll')
      try {
        Add-Type -TypeDefinition $code -OutputAssembly $buildPath
        Move-Item -LiteralPath $buildPath -Destination $dllPath -Force
        Add-Type -Path $dllPath
      } finally {
        if (Test-Path -LiteralPath $buildPath) { Remove-Item -LiteralPath $buildPath -Force }
      }
    }
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  Reply @{ ready = $true }
} catch {
  Reply @{ fatal = $true; error = $_.Exception.Message }
  exit 1
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $job = $null
  try {
    $job = $line | ConvertFrom-Json
    $bytes = [Convert]::FromBase64String($job.data)
    $jobId = [TecnoCajaRawWorker]::Print($PrinterName, $bytes)
    Reply @{ id = $job.id; ok = $true; jobId = $jobId }
  } catch {
    Reply @{ id = $job.id; ok = $false; error = $_.Exception.GetBaseException().Message }
  }
}
