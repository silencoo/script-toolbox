Set-StrictMode -Version Latest

$nativeType = ([System.Management.Automation.PSTypeName]'SunshineVddSkill.NativeDisplay').Type
if (-not $nativeType) {
    $source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

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

    public sealed class TopologyOperation
    {
        public string DisplayName { get; set; }
        public int ActivePathCountBefore { get; set; }
        public int SelectedPathCount { get; set; }
        public int SelectedModeCount { get; set; }
        public int ValidationCode { get; set; }
        public int ApplyCode { get; set; }
        public bool Applied { get; set; }
    }

    public static class NativeDisplay
    {
        private const int ENUM_CURRENT_SETTINGS = -1;
        private const uint DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
        private const uint DISPLAY_DEVICE_PRIMARY_DEVICE = 0x4;
        private const uint DISPLAY_DEVICE_REMOTE = 0x04000000;
        private const uint DISPLAY_DEVICE_DISCONNECT = 0x02000000;
        private const uint QDC_ONLY_ACTIVE_PATHS = 0x2;
        private const uint DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME = 1;
        private const uint DISPLAYCONFIG_PATH_MODE_IDX_INVALID = 0xFFFFFFFF;
        private const uint SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x20;
        private const uint SDC_VALIDATE = 0x40;
        private const uint SDC_APPLY = 0x80;
        private const uint SDC_SAVE_TO_DATABASE = 0x200;
        private const uint SDC_ALLOW_CHANGES = 0x400;

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

        private enum DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY : uint
        {
            Other = 0xFFFFFFFF
        }

        private enum DISPLAYCONFIG_ROTATION : uint
        {
            Identity = 1
        }

        private enum DISPLAYCONFIG_SCALING : uint
        {
            Identity = 1
        }

        private enum DISPLAYCONFIG_SCANLINE_ORDERING : uint
        {
            Unspecified = 0
        }

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

        private enum DISPLAYCONFIG_MODE_INFO_TYPE : uint
        {
            Source = 1,
            Target = 2,
            DesktopImage = 3
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINTL
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_2DREGION
        {
            public uint cx;
            public uint cy;
        }

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
        private struct DISPLAYCONFIG_TARGET_MODE
        {
            public DISPLAYCONFIG_VIDEO_SIGNAL_INFO targetVideoSignalInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DISPLAYCONFIG_SOURCE_MODE
        {
            public uint width;
            public uint height;
            public uint pixelFormat;
            public POINTL position;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECTL
        {
            public int left;
            public int top;
            public int right;
            public int bottom;
        }

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

        private static void QueryActive(out DISPLAYCONFIG_PATH_INFO[] paths, out DISPLAYCONFIG_MODE_INFO[] modes)
        {
            for (int attempt = 0; attempt < 4; attempt++)
            {
                uint pathCount;
                uint modeCount;
                int sizeCode = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out pathCount, out modeCount);
                if (sizeCode != 0) throw new Win32Exception(sizeCode, "GetDisplayConfigBufferSizes failed");
                var pathBuffer = new DISPLAYCONFIG_PATH_INFO[pathCount];
                var modeBuffer = new DISPLAYCONFIG_MODE_INFO[modeCount];
                int queryCode = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref pathCount, pathBuffer, ref modeCount, modeBuffer, IntPtr.Zero);
                if (queryCode == 122) continue;
                if (queryCode != 0) throw new Win32Exception(queryCode, "QueryDisplayConfig failed");
                Array.Resize(ref pathBuffer, (int)pathCount);
                Array.Resize(ref modeBuffer, (int)modeCount);
                paths = pathBuffer;
                modes = modeBuffer;
                return;
            }
            throw new InvalidOperationException("The active display topology changed repeatedly while it was being queried.");
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

        public static TopologyOperation KeepOnlyDisplay(string displayName, bool apply)
        {
            if (String.IsNullOrWhiteSpace(displayName)) throw new ArgumentException("A GDI display name such as \\\\.\\DISPLAY3 is required.", "displayName");

            DISPLAYCONFIG_PATH_INFO[] allPaths;
            DISPLAYCONFIG_MODE_INFO[] allModes;
            QueryActive(out allPaths, out allModes);

            var selectedPaths = new List<DISPLAYCONFIG_PATH_INFO>();
            foreach (var path in allPaths)
            {
                if (String.Equals(GetSourceName(path), displayName, StringComparison.OrdinalIgnoreCase)) selectedPaths.Add(path);
            }
            if (selectedPaths.Count == 0) throw new InvalidOperationException("The requested display is not an active desktop path: " + displayName);

            var selectedModes = new List<DISPLAYCONFIG_MODE_INFO>();
            var indexMap = new Dictionary<uint, uint>();
            for (int i = 0; i < selectedPaths.Count; i++)
            {
                var path = selectedPaths[i];
                path.sourceInfo.modeInfoIdx = CopyMode(path.sourceInfo.modeInfoIdx, allModes, selectedModes, indexMap);
                path.targetInfo.modeInfoIdx = CopyMode(path.targetInfo.modeInfoIdx, allModes, selectedModes, indexMap);
                selectedPaths[i] = path;
            }

            var pathArray = selectedPaths.ToArray();
            var modeArray = selectedModes.ToArray();
            uint validateFlags = SDC_VALIDATE | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES;
            int validationCode = SetDisplayConfig((uint)pathArray.Length, pathArray, (uint)modeArray.Length, modeArray, validateFlags);
            if (validationCode != 0 && apply) throw new Win32Exception(validationCode, "Windows rejected the proposed physical-only display topology");

            int applyCode = 0;
            if (apply)
            {
                uint applyFlags = SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_SAVE_TO_DATABASE | SDC_ALLOW_CHANGES;
                applyCode = SetDisplayConfig((uint)pathArray.Length, pathArray, (uint)modeArray.Length, modeArray, applyFlags);
                if (applyCode != 0) throw new Win32Exception(applyCode, "Windows could not apply the physical-only display topology");
            }

            return new TopologyOperation {
                DisplayName = displayName,
                ActivePathCountBefore = allPaths.Length,
                SelectedPathCount = pathArray.Length,
                SelectedModeCount = modeArray.Length,
                ValidationCode = validationCode,
                ApplyCode = applyCode,
                Applied = apply
            };
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
            IsMttVdd       = ($display.DeviceId -match '(?i)ROOT\\MTTVDD|MTTVDD') -or ($display.DeviceString -match '(?i)Virtual Display Driver')
            IsOtherVirtual = (($text -match '(?i)virtual|indirect|idd|parsec|spacedesk') -and -not (($display.DeviceId -match '(?i)ROOT\\MTTVDD|MTTVDD') -or ($display.DeviceString -match '(?i)Virtual Display Driver')))
        }
    }
}

function Set-VddSingleDisplayTopology {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^\\\\\.\\DISPLAY\d+$')]
        [string]$DisplayName,

        [switch]$Apply
    )

    [SunshineVddSkill.NativeDisplay]::KeepOnlyDisplay($DisplayName, $Apply.IsPresent)
}

Export-ModuleMember -Function Get-VddDisplayInventory, Set-VddSingleDisplayTopology
