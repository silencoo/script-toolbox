# PT Site Keeper (PT Helper)

A Tampermonkey userscript designed to help Private Tracker (PT) users maintain their accounts by automatically visiting sites daily.

## Key Features

- **Automated Daily Visits**: Automatically opens a configured list of PT sites once a day to keep accounts active.
- **Cross-Browser/Tab Mutex**: Uses sophisticated locking mechanisms to ensure sites are only opened ONCE per day, even if you have multiple tabs or browser windows open.
- **Background Loading**: Opens sites in background tabs to minimize disruption.
- **Login Detection**: Detects if you are logged in by checking for keywords like "Upload", "Ratio", "Bonus", etc.
- **Notifications**:
  - **Browser Notifications**: Alerts you when tasks start/finish or if login fails.
  - **Bark Integration**: Push notifications to your mobile device via the Bark app.

## Configuration

1. **Site List**: Click the "配置 PT 站点列表" menu command to edit the list of URLs to visit.
2. **Schedule**: Default trigger time is set to 12:00 PM (local time).
3. **Bark**: Click "配置 Bark 推送地址" to set up mobile notifications.

## Menu Commands

- **配置 PT 站点列表**: Edit the list of sites.
- **设置自动开启间隔**: Set how often the script runs (default: every 1 day).
- **配置 Bark 推送地址**: Set Bark API URL.
- **开启/关闭单站登录通知**: Toggle notifications for individual site logins.
- **开启/关闭登录调试日志**: Enable verbose logging for debugging.

## How It Works

The script runs in the background on any page you visit (`*://*/*`). It checks the last run time stored in `GM_setValue`. If the configured interval has passed (e.g., it's a new day), it will trigger the opening of all configured PT sites in background tabs. It then monitors these tabs to verify successful loading and login status.
