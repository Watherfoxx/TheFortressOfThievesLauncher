const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const commandOptions = {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 1024 * 1024
}

const unknownStorage = () => ({ type: 'unknown', external: null })

function classifyMediaType(mediaType) {
    const normalized = String(mediaType || '').trim().toLowerCase()
    if (normalized === 'ssd' || normalized === 'solid state drive') return 'ssd'
    if (normalized === 'hdd' || normalized === 'hard disk drive') return 'hdd'
    return 'unknown'
}

function classifyExternalBus(busType) {
    const normalized = String(busType || '').trim().toLowerCase()
    if (!normalized || normalized === 'unknown' || normalized === 'unspecified') return null
    if (['usb', '1394', 'firewire', 'sd', 'network'].includes(normalized)) return true
    if (['ata', 'sata', 'sas', 'scsi', 'raid', 'nvme', 'pci', 'virtual', 'file backed virtual'].includes(normalized)) {
        return false
    }
    return null
}

function parseWindowsStorage(output) {
    const parsed = JSON.parse(String(output || '').trim())
    const storage = Array.isArray(parsed) ? parsed[0] : parsed
    return {
        type: classifyMediaType(storage?.MediaType),
        external: classifyExternalBus(storage?.BusType)
    }
}

function plistBoolean(output, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = String(output || '').match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<(true|false)\\s*/>`, 'i'))
    if (!match) return null
    return match[1].toLowerCase() === 'true'
}

function parseMacStorage(output) {
    const solidState = plistBoolean(output, 'SolidState')
    const internal = plistBoolean(output, 'Internal')
    return {
        type: solidState === null ? 'unknown' : solidState ? 'ssd' : 'hdd',
        external: internal === null ? null : !internal
    }
}

function parseLinuxStorage(output) {
    const rows = String(output || '')
        .split(/\r?\n/)
        .map(line => line.trim().split(/\s+/))
        .filter(columns => columns.length >= 2 && columns[0] === 'disk' && /^[01]$/.test(columns[1]))

    if (!rows.length) return unknownStorage()

    const rotationalValues = new Set(rows.map(columns => columns[1]))
    const type = rotationalValues.size !== 1
        ? 'unknown'
        : rotationalValues.has('1') ? 'hdd' : 'ssd'
    const transports = rows.map(columns => columns[2]).filter(Boolean)
    const externalValues = transports.map(classifyExternalBus).filter(value => value !== null)
    const external = externalValues.length && externalValues.every(value => value === externalValues[0])
        ? externalValues[0]
        : null

    return { type, external }
}

async function findExistingPath(targetPath) {
    let candidate = path.resolve(targetPath)

    while (true) {
        try {
            await fs.promises.access(candidate)
            return candidate
        } catch {
            const parent = path.dirname(candidate)
            if (parent === candidate) return candidate
            candidate = parent
        }
    }
}

async function detectWindowsStorage(targetPath, runCommand) {
    const encodedPath = Buffer.from(targetPath, 'utf8').toString('base64')
    const script = `
$TargetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$RootPath = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($TargetPath))
if ($RootPath.StartsWith('\\\\')) {
    [PSCustomObject]@{ MediaType = ''; BusType = 'Network' } | ConvertTo-Json -Compress
    exit
}
$DriveLetter = $RootPath.Substring(0, 1)
$ProbeSource = @'
using System;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

public static class StorageMediaProbe
{
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint OpenExisting = 3;
    private const uint StorageQueryProperty = 0x002D1400;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint controlCode,
        byte[] input,
        int inputSize,
        byte[] output,
        int outputSize,
        out int bytesReturned,
        IntPtr overlapped
    );

    public static string Inspect(string driveLetter)
    {
        using (SafeFileHandle device = CreateFile(
            @"\\\\.\\" + driveLetter + ":",
            0,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            0,
            IntPtr.Zero
        ))
        {
            if (device.IsInvalid) return "-1|-1";

            int seekPenalty = QuerySeekPenalty(device);
            int busType = QueryBusType(device);
            return seekPenalty + "|" + busType;
        }
    }

    private static int QuerySeekPenalty(SafeFileHandle device)
    {
        byte[] query = CreateQuery(7);
        byte[] descriptor = new byte[64];
        int bytesReturned;
        bool success = DeviceIoControl(
            device,
            StorageQueryProperty,
            query,
            query.Length,
            descriptor,
            descriptor.Length,
            out bytesReturned,
            IntPtr.Zero
        );
        if (!success || bytesReturned <= 8) return -1;
        return descriptor[8] == 0 ? 0 : 1;
    }

    private static int QueryBusType(SafeFileHandle device)
    {
        byte[] query = CreateQuery(0);
        byte[] descriptor = new byte[1024];
        int bytesReturned;
        bool success = DeviceIoControl(
            device,
            StorageQueryProperty,
            query,
            query.Length,
            descriptor,
            descriptor.Length,
            out bytesReturned,
            IntPtr.Zero
        );
        if (!success || bytesReturned <= 31) return -1;
        return BitConverter.ToInt32(descriptor, 28);
    }

    private static byte[] CreateQuery(int propertyId)
    {
        byte[] query = new byte[12];
        Buffer.BlockCopy(BitConverter.GetBytes(propertyId), 0, query, 0, 4);
        return query;
    }
}
'@
Add-Type -TypeDefinition $ProbeSource -ErrorAction Stop
$Probe = [StorageMediaProbe]::Inspect($DriveLetter).Split('|')
$MediaType = switch ($Probe[0]) {
    '0' { 'SSD' }
    '1' { 'HDD' }
    default { '' }
}
$BusType = switch ([int]$Probe[1]) {
    1 { 'SCSI' }
    2 { 'ATA' }
    3 { 'ATA' }
    4 { '1394' }
    7 { 'USB' }
    8 { 'RAID' }
    10 { 'SAS' }
    11 { 'SATA' }
    12 { 'SD' }
    13 { 'MMC' }
    14 { 'Virtual' }
    15 { 'File Backed Virtual' }
    16 { 'Spaces' }
    17 { 'NVMe' }
    default { '' }
}
[PSCustomObject]@{
    MediaType = $MediaType
    BusType = $BusType
} | ConvertTo-Json -Compress
`
    const { stdout } = await runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', script
    ], commandOptions)
    return parseWindowsStorage(stdout)
}

async function detectMacStorage(targetPath, runCommand) {
    try {
        const { stdout } = await runCommand('/usr/sbin/diskutil', ['info', '-plist', targetPath], commandOptions)
        return parseMacStorage(stdout)
    } catch {
        const { stdout: mountOutput } = await runCommand('/bin/df', ['-P', targetPath], commandOptions)
        const lines = mountOutput.trim().split(/\r?\n/)
        const device = lines.at(-1)?.trim().split(/\s+/)[0]
        if (!device) return unknownStorage()
        const { stdout } = await runCommand('/usr/sbin/diskutil', ['info', '-plist', device], commandOptions)
        return parseMacStorage(stdout)
    }
}

async function detectLinuxStorage(targetPath, runCommand) {
    const { stdout: sourceOutput } = await runCommand(
        'findmnt',
        ['-n', '-o', 'SOURCE', '--target', targetPath],
        commandOptions
    )
    const source = sourceOutput.trim().split(/\r?\n/)[0]?.replace(/\[.*$/, '')
    if (!source?.startsWith('/dev/')) return unknownStorage()

    const { stdout } = await runCommand(
        'lsblk',
        ['-n', '-o', 'TYPE,ROTA,TRAN', '-s', source],
        commandOptions
    )
    return parseLinuxStorage(stdout)
}

async function detectStorageMedia(targetPath, options = {}) {
    if (!targetPath || typeof targetPath !== 'string') return unknownStorage()

    const platform = options.platform || process.platform
    const runCommand = options.runCommand || execFileAsync

    try {
        const existingPath = await findExistingPath(targetPath)
        if (platform === 'win32') return await detectWindowsStorage(existingPath, runCommand)
        if (platform === 'darwin') return await detectMacStorage(existingPath, runCommand)
        if (platform === 'linux') return await detectLinuxStorage(existingPath, runCommand)
    } catch (error) {
        console.warn(`[Storage Media] Impossible d'identifier le support de ${targetPath} :`, error?.message || error)
    }

    return unknownStorage()
}

module.exports = {
    classifyExternalBus,
    classifyMediaType,
    detectStorageMedia,
    parseLinuxStorage,
    parseMacStorage,
    parseWindowsStorage
}
