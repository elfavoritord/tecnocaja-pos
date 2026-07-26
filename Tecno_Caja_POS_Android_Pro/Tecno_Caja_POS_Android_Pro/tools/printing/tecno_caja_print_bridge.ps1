param(
    [int]$Port = 17840
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TecnoCajaRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool StartDocPrinter(IntPtr printer, int level, DOCINFO info);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndDocPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool StartPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

    public static void Send(string printerName, byte[] bytes) {
        IntPtr printer;
        if (!OpenPrinter(printerName, out printer, IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            var info = new DOCINFO {
                pDocName = "Tecno Caja POS",
                pDataType = "RAW"
            };
            if (!StartDocPrinter(printer, 1, info))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try {
                if (!StartPagePrinter(printer))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                try {
                    int written;
                    if (!WritePrinter(printer, bytes, bytes.Length, out written) || written != bytes.Length)
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                } finally { EndPagePrinter(printer); }
            } finally { EndDocPrinter(printer); }
        } finally { ClosePrinter(printer); }
    }
}
'@

function Send-Response {
    param($Context, [int]$Status, [hashtable]$Body)
    $json = $Body | ConvertTo-Json -Compress
    $data = [Text.Encoding]::UTF8.GetBytes($json)
    $Context.Response.StatusCode = $Status
    $Context.Response.ContentType = 'application/json; charset=utf-8'
    $Context.Response.Headers['Access-Control-Allow-Origin'] = '*'
    $Context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
    $Context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $Context.Response.ContentLength64 = $data.Length
    $Context.Response.OutputStream.Write($data, 0, $data.Length)
    $Context.Response.Close()
}

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Tecno Caja Print Service activo en 127.0.0.1:$Port"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
        if ($context.Request.HttpMethod -eq 'OPTIONS') {
            Send-Response $context 200 @{ ok = $true }
            continue
        }
        if ($context.Request.Url.AbsolutePath -eq '/health') {
            Send-Response $context 200 @{ ok = $true; service = 'Tecno Caja Print Service' }
            continue
        }
        if ($context.Request.HttpMethod -ne 'POST' -or
            $context.Request.Url.AbsolutePath -ne '/print') {
            Send-Response $context 404 @{ ok = $false; error = 'Ruta no encontrada.' }
            continue
        }

        $reader = [IO.StreamReader]::new(
            $context.Request.InputStream,
            $context.Request.ContentEncoding
        )
        $payload = $reader.ReadToEnd() | ConvertFrom-Json
        $printer = [string]$payload.printer
        if ([string]::IsNullOrWhiteSpace($printer)) {
            $printer = (Get-CimInstance Win32_Printer |
                Where-Object Default |
                Select-Object -First 1 -ExpandProperty Name)
        }
        $bytes = [Convert]::FromBase64String([string]$payload.data)
        [TecnoCajaRawPrinter]::Send($printer, $bytes)
        Send-Response $context 200 @{ ok = $true; printer = $printer; bytes = $bytes.Length }
    }
    catch {
        Send-Response $context 500 @{ ok = $false; error = $_.Exception.Message }
    }
}

