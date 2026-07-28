@{
  SchemaVersion = 1

  Profiles = @{
    core = @{
      Description = 'Everyday security, archives, search, transfer, viewing, and layout'
      Packages = @(
        'KeePassXCTeam.KeePassXC'
        'M2Team.NanaZip'
        'Meta.Zstandard'
        'LocalSend.LocalSend'
        'WinDirStat.WinDirStat'
        'voidtools.Everything'
        'VideoLAN.VLC'
        'SumatraPDF.SumatraPDF'
        'Microsoft.PowerToys'
      )
      OptionalPackages = @()
    }

    media = @{
      Description = 'Media download, inspection, playback, and conversion'
      Packages = @(
        'yt-dlp.yt-dlp'
        'Gyan.FFmpeg'
        'HandBrake.HandBrake'
        'ImageMagick.ImageMagick'
        'OliverBetz.ExifTool'
        'aria2.aria2'
      )
      OptionalPackages = @(
        'mpv.net'
      )
    }

    maintenance = @{
      Description = 'Inspection, manual cleanup, storage, and backup tools'
      Packages = @(
        'Klocman.BulkCrapUninstaller'
        'WinDirStat.WinDirStat'
        'qarmin.krokiet'
        'QPDF.QPDF'
        'smartmontools.smartmontools'
        'REALiX.HWiNFO'
        'restic.restic'
        'Rclone.Rclone'
      )
      OptionalPackages = @()
    }

    desktop = @{
      Description = 'Screenshots, local transfer, layout, and optional launcher'
      Packages = @(
        'ShareX.ShareX'
        'LocalSend.LocalSend'
        'Microsoft.PowerToys'
      )
      OptionalPackages = @(
        'Flow-Launcher.Flow-Launcher'
      )
    }

    admin = @{
      Description = 'Explicit networking, recovery, remote, and encryption tools'
      Packages = @(
        'Microsoft.Sysinternals.Suite'
        'Rufus.Rufus'
        'WiresharkFoundation.Wireshark'
        'Insecure.Nmap'
        'Tailscale.Tailscale'
        'MoonlightGameStreamingProject.Moonlight'
        'LizardByte.Sunshine'
        'Cryptomator.Cryptomator'
      )
      OptionalPackages = @(
        'Ventoy.Ventoy'
        'IDRIX.VeraCrypt'
      )
    }

    'power-archive' = @{
      Description = 'Replace NanaZip with the full 7-Zip Zstandard Edition'
      Packages = @(
        'mcmilk.7zip-zstd'
      )
      OptionalPackages = @()
    }
  }

  Packages = @{
    'KeePassXCTeam.KeePassXC' = @{
      Name = 'KeePassXC'
      Purpose = 'Local password management'
    }
    'M2Team.NanaZip' = @{
      Name = 'NanaZip'
      Purpose = 'Archives'
      Conflicts = @(
        '7zip.7zip'
        'mcmilk.7zip-zstd'
      )
    }
    'Meta.Zstandard' = @{
      Name = 'Zstandard CLI'
      Purpose = 'Archives'
    }
    'LocalSend.LocalSend' = @{
      Name = 'LocalSend'
      Purpose = 'Local file transfer'
    }
    'WinDirStat.WinDirStat' = @{
      Name = 'WinDirStat'
      Purpose = 'Disk usage'
    }
    'voidtools.Everything' = @{
      Name = 'Everything'
      Purpose = 'Fast file search'
    }
    'VideoLAN.VLC' = @{
      Name = 'VLC'
      Purpose = 'Media player'
    }
    'SumatraPDF.SumatraPDF' = @{
      Name = 'SumatraPDF'
      Purpose = 'PDF viewer'
    }
    'Microsoft.PowerToys' = @{
      Name = 'Microsoft PowerToys'
      Purpose = 'Window management and desktop utilities'
    }
    'yt-dlp.yt-dlp' = @{
      Name = 'yt-dlp'
      Purpose = 'Permitted media downloads'
    }
    'Gyan.FFmpeg' = @{
      Name = 'FFmpeg'
      Purpose = 'Media conversion'
    }
    'HandBrake.HandBrake' = @{
      Name = 'HandBrake'
      Purpose = 'Video conversion'
    }
    'ImageMagick.ImageMagick' = @{
      Name = 'ImageMagick'
      Purpose = 'Image conversion'
    }
    'OliverBetz.ExifTool' = @{
      Name = 'ExifTool'
      Purpose = 'Media metadata'
    }
    'aria2.aria2' = @{
      Name = 'aria2'
      Purpose = 'Transfer CLI'
    }
    'mpv.net' = @{
      Name = 'mpv.net'
      Purpose = 'Alternative media player'
    }
    'Klocman.BulkCrapUninstaller' = @{
      Name = 'Bulk Crap Uninstaller'
      Purpose = 'Manual software removal'
    }
    'qarmin.krokiet' = @{
      Name = 'Krokiet'
      Purpose = 'Duplicate file inspection'
    }
    'QPDF.QPDF' = @{
      Name = 'qpdf'
      Purpose = 'PDF inspection and transformation'
    }
    'smartmontools.smartmontools' = @{
      Name = 'smartmontools'
      Purpose = 'Drive health inspection'
    }
    'REALiX.HWiNFO' = @{
      Name = 'HWiNFO'
      Purpose = 'Hardware and sensor monitoring'
    }
    'restic.restic' = @{
      Name = 'restic'
      Purpose = 'Encrypted backups'
    }
    'Rclone.Rclone' = @{
      Name = 'rclone'
      Purpose = 'Storage copy and synchronization'
    }
    'ShareX.ShareX' = @{
      Name = 'ShareX'
      Purpose = 'Screenshots'
    }
    'Flow-Launcher.Flow-Launcher' = @{
      Name = 'Flow Launcher'
      Purpose = 'Desktop launcher'
    }
    'Microsoft.Sysinternals.Suite' = @{
      Name = 'Sysinternals Suite'
      Purpose = 'System administration'
    }
    'Rufus.Rufus' = @{
      Name = 'Rufus'
      Purpose = 'Bootable media'
    }
    'Ventoy.Ventoy' = @{
      Name = 'Ventoy'
      Purpose = 'Alternative bootable media'
    }
    'WiresharkFoundation.Wireshark' = @{
      Name = 'Wireshark'
      Purpose = 'Network inspection'
    }
    'Insecure.Nmap' = @{
      Name = 'Nmap'
      Purpose = 'Network inspection'
    }
    'Tailscale.Tailscale' = @{
      Name = 'Tailscale'
      Purpose = 'Private networking'
    }
    'MoonlightGameStreamingProject.Moonlight' = @{
      Name = 'Moonlight'
      Purpose = 'Game-streaming client'
    }
    'LizardByte.Sunshine' = @{
      Name = 'Sunshine'
      Purpose = 'Self-hosted game-streaming server'
    }
    'Cryptomator.Cryptomator' = @{
      Name = 'Cryptomator'
      Purpose = 'Encrypted storage'
    }
    'IDRIX.VeraCrypt' = @{
      Name = 'VeraCrypt'
      Purpose = 'Alternative encrypted storage'
    }
    'mcmilk.7zip-zstd' = @{
      Name = '7-Zip Zstandard Edition'
      Purpose = 'Power-user archives'
      Replaces = @(
        'M2Team.NanaZip'
      )
      Conflicts = @(
        '7zip.7zip'
        'M2Team.NanaZip'
      )
    }
  }
}
