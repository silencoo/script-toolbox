Set-StrictMode -Version Latest

$nativeType = ([System.Management.Automation.PSTypeName]'SunshineVddSkill.NativeDisplay').Type
if (-not $nativeType) {
    $source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace SunshineVddSkill
{
    public sealed class DisplayRecord
    {
        public string DeviceName { get; set; }
        public string DeviceString { get; set; }
        public string DeviceId { get; set; }
        public string DeviceKey { get; set; }
        public uint StateFlags { get; set; }
        public bool Attached { get; set; }
        public bool Primary { get; set; }
        public bool Remote { get; set; }
        public bool Disconnect { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int RefreshRate { get; set; }
        public int BitsPerPel { get; set; }
        public int PositionX { get; set; }
        public int PositionY { get; set; }
    }

    public sealed class DisplayTopologySnapshot
    {
        public int SchemaVersion { get; set; }
        public string CapturedAtUtc { get; set; }
        public uint QueryFlags { get; set; }
        public int PathCount { get; set; }
        public int ModeCount { get; set; }
        public string PathsBase64 { get; set; }
        public string ModesBase64 { get; set; }
        public string[] SourceNames { get; set; }
        public string IntegritySha256 { get; set; }
    }

    public sealed class TopologyOperation
    {
        public string[] DisplayNames { get; set; }
        public int ActivePathCountBefore { get; set; }
        public int SelectedPathCount { get; set; }
        public int SelectedModeCount { get; set; }
        public uint QueryFlags { get; set; }
        public int ValidationCode { get; set; }
        public int ApplyCode { get; set; }
        public bool Applied { get; set; }
    }

    public static class NativeDisplay
    {
        private const int ENUM_CURRENT_SETTINGS = -1;
        private const int ERROR_INSUFFICIENT_BUFFER = 122;
        private const int ERROR_INVALID_PARAMETER = 87;
        private const uint DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
        private const uint DISPLAY_DEVICE_PRIMARY_DEVICE = 0x4;
        private const uint DISPLAY_DEVICE_REMOTE = 0x04000000;
        private const uint DISPLAY_DEVICE_DISCONNECT = 0x02000000;
        private const uint QDC_ONLY_ACTIVE_PATHS = 0x2;
        private const uint QDC_VIRTUAL_MODE_AWARE = 0x8000;
        private const uint QDC_VIRTUAL_REFRESH_RATE_AWARE = 0x20000;
        private const uint DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME = 1;
        private const uint DISPLAYCONFIG_PATH_SUPPORT_VIRTUAL_MODE = 0x8;
        private const uint DISPLAYCONFIG_PATH_MODE_IDX_INVALID = 0xFFFFFFFF;
        private const ushort DISPLAYCONFIG_PATH_MODE_IDX_INVALID_16 = 0xFFFF;
        private const uint SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x20;
        private const uint SDC_VALIDATE = 0x40;
        private const uint SDC_APPLY = 0x80;
        private const uint SDC_SAVE_TO_DATABASE = 0x200;
        private const uint SDC_ALLOW_CHANGES = 0x400;
        private const uint SDC_VIRTUAL_MODE_AWARE = 0x8000;
        private const uint SDC_VIRTUAL_REFRESH_RATE_AWARE = 0x20000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DISPLAY_DEVICE
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
            public uint StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DEVMODE
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
            public ushort dmSpecVersion;
            public ushort dmDriverVersion;
            public ushort dmSize;
            public ushort dmDriverExtra;
            public uint dmFields;
            public int dmPositionX;
            public int dmPositionY;
            public uint dmDisplayOrientation;
            public uint dmDisplayFixedOutput;
            public short dmColor;
            public short dmDuplex;
            public short dmYResolution;
            public short dmTTOption;
            public short dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
            public ushort dmLogPixels;
            public uint dmBitsPerPel;
            public uint dmPelsWidth;
            public uint dmPelsHeight;
            public uint dmDisplayFlags;
            public uint dmDisplayFrequency;
            public uint dmICMMethod;
            public uint dmICMIntent;
            public uint dmMediaType;
            public uint dmDitherType;
            public uint dmReserved1;
            public uint dmReserved2;
            public uint dmPanningWidth;
            public uint dmPanningHeight;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_RATIONAL
        {
            public uint Numerator;
            public uint Denominator;
        }

        private enum DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY : uint { Other = 0xFFFFFFFF }
        private enum DISPLAYCONFIG_ROTATION : uint { Identity = 1 }
        private enum DISPLAYCONFIG_SCALING : uint { Identity = 1 }
        private enum DISPLAYCONFIG_SCANLINE_ORDERING : uint { Unspecified = 0 }

        // modeInfoIdx is the storage for the documented legacy/virtual-aware union.
        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_PATH_SOURCE_INFO
        {
            public LUID adapterId;
            public uint id;
            public uint modeInfoIdx;
            public uint statusFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_PATH_TARGET_INFO
        {
            public LUID adapterId;
            public uint id;
            public uint modeInfoIdx;
            public DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY outputTechnology;
            public DISPLAYCONFIG_ROTATION rotation;
            public DISPLAYCONFIG_SCALING scaling;
            public DISPLAYCONFIG_RATIONAL refreshRate;
            public DISPLAYCONFIG_SCANLINE_ORDERING scanLineOrdering;
            [MarshalAs(UnmanagedType.Bool)] public bool targetAvailable;
            public uint statusFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_PATH_INFO
        {
            public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo;
            public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo;
            public uint flags;
        }

        private enum DISPLAYCONFIG_MODE_INFO_TYPE : uint { Source = 1, Target = 2, DesktopImage = 3 }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINTL { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_2DREGION { public uint cx; public uint cy; }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_VIDEO_SIGNAL_INFO
        {
            public ulong pixelRate;
            public DISPLAYCONFIG_RATIONAL hSyncFreq;
            public DISPLAYCONFIG_RATIONAL vSyncFreq;
            public DISPLAYCONFIG_2DREGION activeSize;
            public DISPLAYCONFIG_2DREGION totalSize;
            public uint videoStandard;
            public uint scanLineOrdering;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_TARGET_MODE { public DISPLAYCONFIG_VIDEO_SIGNAL_INFO targetVideoSignalInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_SOURCE_MODE
        {
            public uint width;
            public uint height;
            public uint pixelFormat;
            public POINTL position;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECTL { public int left; public int top; public int right; public int bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_DESKTOP_IMAGE_INFO
        {
            public POINTL PathSourceSize;
            public RECTL DesktopImageRegion;
            public RECTL DesktopImageClip;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct DISPLAYCONFIG_MODE_INFO_UNION
        {
            [FieldOffset(0)] public DISPLAYCONFIG_TARGET_MODE targetMode;
            [FieldOffset(0)] public DISPLAYCONFIG_SOURCE_MODE sourceMode;
            [FieldOffset(0)] public DISPLAYCONFIG_DESKTOP_IMAGE_INFO desktopImageInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_MODE_INFO
        {
            public DISPLAYCONFIG_MODE_INFO_TYPE infoType;
            public uint id;
            public LUID adapterId;
            public DISPLAYCONFIG_MODE_INFO_UNION modeInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_DEVICE_INFO_HEADER
        {
            public uint type;
            public uint size;
            public LUID adapterId;
            public uint id;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DISPLAYCONFIG_SOURCE_DEVICE_NAME
        {
            public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool EnumDisplaySettingsEx(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode, uint dwFlags);

        [DllImport("user32.dll")]
        private static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPathArrayElements, out uint numModeInfoArrayElements);

        [DllImport("user32.dll")]
        private static extern int QueryDisplayConfig(uint flags, ref uint numPathArrayElements, [Out] DISPLAYCONFIG_PATH_INFO[] pathInfoArray, ref uint numModeInfoArrayElements, [Out] DISPLAYCONFIG_MODE_INFO[] modeInfoArray, IntPtr currentTopologyId);

        [DllImport("user32.dll")]
        private static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_SOURCE_DEVICE_NAME requestPacket);

        [DllImport("user32.dll")]
        private static extern int SetDisplayConfig(uint numPathArrayElements, DISPLAYCONFIG_PATH_INFO[] pathArray, uint numModeInfoArrayElements, DISPLAYCONFIG_MODE_INFO[] modeInfoArray, uint flags);

        public static DisplayRecord[] Enumerate()
        {
            var result = new List<DisplayRecord>();
            uint index = 0;
            while (true)
            {
                var device = new DISPLAY_DEVICE();
                device.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
                if (!EnumDisplayDevices(null, index, ref device, 0)) break;

                var mode = new DEVMODE();
                mode.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
                bool hasMode = EnumDisplaySettingsEx(device.DeviceName, ENUM_CURRENT_SETTINGS, ref mode, 0);
                result.Add(new DisplayRecord {
                    DeviceName = device.DeviceName,
                    DeviceString = device.DeviceString,
                    DeviceId = device.DeviceID,
                    DeviceKey = device.DeviceKey,
                    StateFlags = device.StateFlags,
                    Attached = (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0,
                    Primary = (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0,
                    Remote = (device.StateFlags & DISPLAY_DEVICE_REMOTE) != 0,
                    Disconnect = (device.StateFlags & DISPLAY_DEVICE_DISCONNECT) != 0,
                    Width = hasMode ? (int)mode.dmPelsWidth : 0,
                    Height = hasMode ? (int)mode.dmPelsHeight : 0,
                    RefreshRate = hasMode ? (int)mode.dmDisplayFrequency : 0,
                    BitsPerPel = hasMode ? (int)mode.dmBitsPerPel : 0,
                    PositionX = hasMode ? mode.dmPositionX : 0,
                    PositionY = hasMode ? mode.dmPositionY : 0
                });
                index++;
            }
            return result.ToArray();
        }

        private static string GetSourceName(DISPLAYCONFIG_PATH_INFO path)
        {
            var name = new DISPLAYCONFIG_SOURCE_DEVICE_NAME();
            name.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            name.header.size = (uint)Marshal.SizeOf(typeof(DISPLAYCONFIG_SOURCE_DEVICE_NAME));
            name.header.adapterId = path.sourceInfo.adapterId;
            name.header.id = path.sourceInfo.id;
            int code = DisplayConfigGetDeviceInfo(ref name);
            if (code != 0) throw new Win32Exception(code, "DisplayConfigGetDeviceInfo failed");
            return name.viewGdiDeviceName;
        }

        private static void QueryActive(out DISPLAYCONFIG_PATH_INFO[] paths, out DISPLAYCONFIG_MODE_INFO[] modes, out uint queryFlags)
        {
            uint[] candidates = new uint[] {
                QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE | QDC_VIRTUAL_REFRESH_RATE_AWARE,
                QDC_ONLY_ACTIVE_PATHS | QDC_VIRTUAL_MODE_AWARE,
                QDC_ONLY_ACTIVE_PATHS
            };

            int lastCode = 0;
            foreach (uint flags in candidates)
            {
                for (int attempt = 0; attempt < 4; attempt++)
                {
                    uint pathCount;
                    uint modeCount;
                    int sizeCode = GetDisplayConfigBufferSizes(flags, out pathCount, out modeCount);
                    if (sizeCode == ERROR_INVALID_PARAMETER) { lastCode = sizeCode; break; }
                    if (sizeCode != 0) throw new Win32Exception(sizeCode, "GetDisplayConfigBufferSizes failed");
                    var pathBuffer = new DISPLAYCONFIG_PATH_INFO[pathCount];
                    var modeBuffer = new DISPLAYCONFIG_MODE_INFO[modeCount];
                    int queryCode = QueryDisplayConfig(flags, ref pathCount, pathBuffer, ref modeCount, modeBuffer, IntPtr.Zero);
                    if (queryCode == ERROR_INSUFFICIENT_BUFFER) continue;
                    if (queryCode == ERROR_INVALID_PARAMETER) { lastCode = queryCode; break; }
                    if (queryCode != 0) throw new Win32Exception(queryCode, "QueryDisplayConfig failed");
                    Array.Resize(ref pathBuffer, (int)pathCount);
                    Array.Resize(ref modeBuffer, (int)modeCount);
                    paths = pathBuffer;
                    modes = modeBuffer;
                    queryFlags = flags;
                    return;
                }
            }
            throw new Win32Exception(lastCode == 0 ? ERROR_INSUFFICIENT_BUFFER : lastCode, "Could not query a stable active display topology");
        }

        private static byte[] StructArrayToBytes<T>(T[] values) where T : struct
        {
            int itemSize = Marshal.SizeOf(typeof(T));
            byte[] bytes = new byte[checked(itemSize * values.Length)];
            IntPtr pointer = Marshal.AllocHGlobal(itemSize);
            try
            {
                for (int index = 0; index < values.Length; index++)
                {
                    Marshal.StructureToPtr(values[index], pointer, false);
                    Marshal.Copy(pointer, bytes, index * itemSize, itemSize);
                }
            }
            finally { Marshal.FreeHGlobal(pointer); }
            return bytes;
        }

        private static T[] BytesToStructArray<T>(byte[] bytes, int expectedCount) where T : struct
        {
            int itemSize = Marshal.SizeOf(typeof(T));
            if (expectedCount < 0 || bytes.Length != checked(itemSize * expectedCount))
                throw new InvalidOperationException("The topology snapshot has an invalid native buffer length.");
            var values = new T[expectedCount];
            IntPtr pointer = Marshal.AllocHGlobal(itemSize);
            try
            {
                for (int index = 0; index < expectedCount; index++)
                {
                    Marshal.Copy(bytes, index * itemSize, pointer, itemSize);
                    values[index] = (T)Marshal.PtrToStructure(pointer, typeof(T));
                }
            }
            finally { Marshal.FreeHGlobal(pointer); }
            return values;
        }

        private static string ComputeIntegrity(uint queryFlags, int pathCount, int modeCount, byte[] paths, byte[] modes)
        {
            byte[] header = new byte[12];
            Buffer.BlockCopy(BitConverter.GetBytes(queryFlags), 0, header, 0, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(pathCount), 0, header, 4, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(modeCount), 0, header, 8, 4);
            byte[] payload = new byte[header.Length + paths.Length + modes.Length];
            Buffer.BlockCopy(header, 0, payload, 0, header.Length);
            Buffer.BlockCopy(paths, 0, payload, header.Length, paths.Length);
            Buffer.BlockCopy(modes, 0, payload, header.Length + paths.Length, modes.Length);
            using (var sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "").ToLowerInvariant();
            }
        }

        public static DisplayTopologySnapshot CaptureTopology()
        {
            DISPLAYCONFIG_PATH_INFO[] paths;
            DISPLAYCONFIG_MODE_INFO[] modes;
            uint queryFlags;
            QueryActive(out paths, out modes, out queryFlags);
            byte[] pathBytes = StructArrayToBytes(paths);
            byte[] modeBytes = StructArrayToBytes(modes);
            return new DisplayTopologySnapshot {
                SchemaVersion = 1,
                CapturedAtUtc = DateTime.UtcNow.ToString("o"),
                QueryFlags = queryFlags,
                PathCount = paths.Length,
                ModeCount = modes.Length,
                PathsBase64 = Convert.ToBase64String(pathBytes),
                ModesBase64 = Convert.ToBase64String(modeBytes),
                SourceNames = paths.Select(GetSourceName).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(),
                IntegritySha256 = ComputeIntegrity(queryFlags, paths.Length, modes.Length, pathBytes, modeBytes)
            };
        }

        private static void DecodeAndValidateSnapshot(DisplayTopologySnapshot snapshot, out DISPLAYCONFIG_PATH_INFO[] paths, out DISPLAYCONFIG_MODE_INFO[] modes)
        {
            if (snapshot == null || snapshot.SchemaVersion != 1)
                throw new InvalidOperationException("Unsupported or missing display topology snapshot schema.");
            byte[] pathBytes = Convert.FromBase64String(snapshot.PathsBase64 ?? "");
            byte[] modeBytes = Convert.FromBase64String(snapshot.ModesBase64 ?? "");
            string integrity = ComputeIntegrity(snapshot.QueryFlags, snapshot.PathCount, snapshot.ModeCount, pathBytes, modeBytes);
            if (!String.Equals(integrity, snapshot.IntegritySha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Display topology snapshot integrity check failed.");
            paths = BytesToStructArray<DISPLAYCONFIG_PATH_INFO>(pathBytes, snapshot.PathCount);
            modes = BytesToStructArray<DISPLAYCONFIG_MODE_INFO>(modeBytes, snapshot.ModeCount);
        }

        private static uint GetAwareApplyFlags(uint queryFlags)
        {
            uint flags = 0;
            if ((queryFlags & QDC_VIRTUAL_MODE_AWARE) != 0) flags |= SDC_VIRTUAL_MODE_AWARE;
            if ((queryFlags & QDC_VIRTUAL_REFRESH_RATE_AWARE) != 0) flags |= SDC_VIRTUAL_REFRESH_RATE_AWARE;
            return flags;
        }

        private static TopologyOperation ApplyTopology(DISPLAYCONFIG_PATH_INFO[] paths, DISPLAYCONFIG_MODE_INFO[] modes, uint queryFlags, string[] displayNames, int pathCountBefore, bool apply)
        {
            uint awareFlags = GetAwareApplyFlags(queryFlags);
            uint validateFlags = SDC_VALIDATE | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES | awareFlags;
            int validationCode = SetDisplayConfig((uint)paths.Length, paths, (uint)modes.Length, modes, validateFlags);
            if (validationCode != 0 && apply) throw new Win32Exception(validationCode, "Windows rejected the proposed display topology");

            int applyCode = 0;
            if (apply)
            {
                uint applyFlags = SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_SAVE_TO_DATABASE | SDC_ALLOW_CHANGES | awareFlags;
                applyCode = SetDisplayConfig((uint)paths.Length, paths, (uint)modes.Length, modes, applyFlags);
                if (applyCode != 0) throw new Win32Exception(applyCode, "Windows could not apply the display topology");
            }
            return new TopologyOperation {
                DisplayNames = displayNames ?? new string[0],
                ActivePathCountBefore = pathCountBefore,
                SelectedPathCount = paths.Length,
                SelectedModeCount = modes.Length,
                QueryFlags = queryFlags,
                ValidationCode = validationCode,
                ApplyCode = applyCode,
                Applied = apply
            };
        }

        public static TopologyOperation RestoreTopology(DisplayTopologySnapshot snapshot, bool apply)
        {
            DISPLAYCONFIG_PATH_INFO[] paths;
            DISPLAYCONFIG_MODE_INFO[] modes;
            DecodeAndValidateSnapshot(snapshot, out paths, out modes);
            return ApplyTopology(paths, modes, snapshot.QueryFlags, snapshot.SourceNames, paths.Length, apply);
        }

        private static uint CopyMode(uint oldIndex, DISPLAYCONFIG_MODE_INFO[] sourceModes, List<DISPLAYCONFIG_MODE_INFO> destinationModes, Dictionary<uint, uint> indexMap)
        {
            if (oldIndex == DISPLAYCONFIG_PATH_MODE_IDX_INVALID) return oldIndex;
            if (oldIndex >= sourceModes.Length) throw new InvalidOperationException("A display path referenced a mode outside the mode array.");
            uint mapped;
            if (indexMap.TryGetValue(oldIndex, out mapped)) return mapped;
            mapped = (uint)destinationModes.Count;
            destinationModes.Add(sourceModes[oldIndex]);
            indexMap.Add(oldIndex, mapped);
            return mapped;
        }

        private static ushort CopyMode16(ushort oldIndex, DISPLAYCONFIG_MODE_INFO[] sourceModes, List<DISPLAYCONFIG_MODE_INFO> destinationModes, Dictionary<uint, uint> indexMap)
        {
            if (oldIndex == DISPLAYCONFIG_PATH_MODE_IDX_INVALID_16) return oldIndex;
            uint mapped = CopyMode(oldIndex, sourceModes, destinationModes, indexMap);
            if (mapped >= DISPLAYCONFIG_PATH_MODE_IDX_INVALID_16) throw new InvalidOperationException("The remapped display mode index exceeds the virtual-aware field width.");
            return (ushort)mapped;
        }

        private static DISPLAYCONFIG_PATH_INFO CopyPathModes(DISPLAYCONFIG_PATH_INFO path, DISPLAYCONFIG_MODE_INFO[] allModes, List<DISPLAYCONFIG_MODE_INFO> selectedModes, Dictionary<uint, uint> indexMap, uint queryFlags)
        {
            bool virtualAware = (queryFlags & QDC_VIRTUAL_MODE_AWARE) != 0 && (path.flags & DISPLAYCONFIG_PATH_SUPPORT_VIRTUAL_MODE) != 0;
            if (!virtualAware)
            {
                path.sourceInfo.modeInfoIdx = CopyMode(path.sourceInfo.modeInfoIdx, allModes, selectedModes, indexMap);
                path.targetInfo.modeInfoIdx = CopyMode(path.targetInfo.modeInfoIdx, allModes, selectedModes, indexMap);
                return path;
            }

            ushort cloneGroupId = (ushort)(path.sourceInfo.modeInfoIdx & 0xFFFF);
            ushort sourceModeIndex = (ushort)(path.sourceInfo.modeInfoIdx >> 16);
            sourceModeIndex = CopyMode16(sourceModeIndex, allModes, selectedModes, indexMap);
            path.sourceInfo.modeInfoIdx = (uint)cloneGroupId | ((uint)sourceModeIndex << 16);

            ushort desktopModeIndex = (ushort)(path.targetInfo.modeInfoIdx & 0xFFFF);
            ushort targetModeIndex = (ushort)(path.targetInfo.modeInfoIdx >> 16);
            desktopModeIndex = CopyMode16(desktopModeIndex, allModes, selectedModes, indexMap);
            targetModeIndex = CopyMode16(targetModeIndex, allModes, selectedModes, indexMap);
            path.targetInfo.modeInfoIdx = (uint)desktopModeIndex | ((uint)targetModeIndex << 16);
            return path;
        }

        public static TopologyOperation KeepOnlyDisplays(string[] displayNames, bool apply)
        {
            if (displayNames == null || displayNames.Length == 0)
                throw new ArgumentException("At least one GDI display name such as \\\\.\\DISPLAY3 is required.", "displayNames");
            var requested = new HashSet<string>(displayNames.Where(value => !String.IsNullOrWhiteSpace(value)), StringComparer.OrdinalIgnoreCase);
            if (requested.Count != displayNames.Length)
                throw new ArgumentException("Display names must be non-empty and unique.", "displayNames");

            DISPLAYCONFIG_PATH_INFO[] allPaths;
            DISPLAYCONFIG_MODE_INFO[] allModes;
            uint queryFlags;
            QueryActive(out allPaths, out allModes, out queryFlags);

            var selectedPaths = new List<DISPLAYCONFIG_PATH_INFO>();
            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in allPaths)
            {
                string sourceName = GetSourceName(path);
                if (requested.Contains(sourceName))
                {
                    selectedPaths.Add(path);
                    found.Add(sourceName);
                }
            }
            string[] missing = requested.Where(name => !found.Contains(name)).ToArray();
            if (missing.Length > 0)
                throw new InvalidOperationException("The requested display is not an active desktop path: " + String.Join(", ", missing));

            var selectedModes = new List<DISPLAYCONFIG_MODE_INFO>();
            var indexMap = new Dictionary<uint, uint>();
            for (int index = 0; index < selectedPaths.Count; index++)
                selectedPaths[index] = CopyPathModes(selectedPaths[index], allModes, selectedModes, indexMap, queryFlags);

            return ApplyTopology(selectedPaths.ToArray(), selectedModes.ToArray(), queryFlags, requested.ToArray(), allPaths.Length, apply);
        }
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
}

function Get-VddDisplayInventory {
    [CmdletBinding()]
    param()

    foreach ($display in [SunshineVddSkill.NativeDisplay]::Enumerate()) {
        $text = '{0} {1}' -f $display.DeviceString, $display.DeviceId
        $isMtt = ($display.DeviceId -match '(?i)ROOT\\MTTVDD|MTTVDD') -or ($display.DeviceString -match '(?i)Virtual Display Driver|IddSampleDriver Device HDR')
        [pscustomobject]@{
            DeviceName     = $display.DeviceName
            DeviceString   = $display.DeviceString
            DeviceId       = $display.DeviceId
            DeviceKey      = $display.DeviceKey
            StateFlags     = ('0x{0:X8}' -f $display.StateFlags)
            Attached       = $display.Attached
            Primary        = $display.Primary
            Remote         = $display.Remote
            Disconnect     = $display.Disconnect
            Width          = $display.Width
            Height         = $display.Height
            RefreshRate    = $display.RefreshRate
            BitsPerPel     = $display.BitsPerPel
            PositionX      = $display.PositionX
            PositionY      = $display.PositionY
            IsMttVdd       = $isMtt
            IsOtherVirtual = (($text -match '(?i)virtual|indirect|idd|parsec|spacedesk|meta|rustdesk') -and -not $isMtt)
        }
    }
}

function Get-VddDisplayTopologySnapshot {
    [CmdletBinding()]
    param()

    [SunshineVddSkill.NativeDisplay]::CaptureTopology()
}

function ConvertTo-VddNativeTopologySnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$InputObject)

    $snapshot = [SunshineVddSkill.DisplayTopologySnapshot]::new()
    $snapshot.SchemaVersion = [int]$InputObject.SchemaVersion
    $snapshot.CapturedAtUtc = [string]$InputObject.CapturedAtUtc
    $snapshot.QueryFlags = [uint32]$InputObject.QueryFlags
    $snapshot.PathCount = [int]$InputObject.PathCount
    $snapshot.ModeCount = [int]$InputObject.ModeCount
    $snapshot.PathsBase64 = [string]$InputObject.PathsBase64
    $snapshot.ModesBase64 = [string]$InputObject.ModesBase64
    $snapshot.SourceNames = @($InputObject.SourceNames | ForEach-Object { [string]$_ })
    $snapshot.IntegritySha256 = [string]$InputObject.IntegritySha256
    $snapshot
}

function New-VddDisplayTopologyBackup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Directory,
        [ValidatePattern('^[a-z0-9][a-z0-9-]*$')][string]$Reason = 'manual'
    )

    [void](New-Item -ItemType Directory -Path $Directory -Force)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $path = Join-Path $Directory "display-topology-before-$Reason-$stamp.json"
    $record = [pscustomobject][ordered]@{
        SchemaVersion = 1
        CapturedAt    = (Get-Date).ToString('o')
        Reason        = $Reason
        Topology      = Get-VddDisplayTopologySnapshot
        Displays      = @(Get-VddDisplayInventory)
    }
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding utf8
    $path
}

function Restore-VddDisplayTopology {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SnapshotPath,
        [switch]$Apply
    )

    if (-not (Test-Path -LiteralPath $SnapshotPath)) {
        throw "Display topology snapshot not found: $SnapshotPath"
    }
    $record = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
    if ([int]$record.SchemaVersion -ne 1 -or $null -eq $record.Topology) {
        throw "Unsupported display topology backup format: $SnapshotPath"
    }
    $snapshot = ConvertTo-VddNativeTopologySnapshot -InputObject $record.Topology
    [SunshineVddSkill.NativeDisplay]::RestoreTopology($snapshot, $Apply.IsPresent)
}

function Set-VddSelectedDisplayTopology {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateScript({ $_ -match '^\\\\\.\\DISPLAY\d+$' })]
        [string[]]$DisplayNames,

        [switch]$Apply
    )

    [SunshineVddSkill.NativeDisplay]::KeepOnlyDisplays($DisplayNames, $Apply.IsPresent)
}

function Set-VddSingleDisplayTopology {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^\\\\\.\\DISPLAY\d+$')]
        [string]$DisplayName,

        [switch]$Apply
    )

    Set-VddSelectedDisplayTopology -DisplayNames @($DisplayName) -Apply:$Apply
}

Export-ModuleMember -Function Get-VddDisplayInventory, Get-VddDisplayTopologySnapshot, New-VddDisplayTopologyBackup, Restore-VddDisplayTopology, Set-VddSelectedDisplayTopology, Set-VddSingleDisplayTopology
