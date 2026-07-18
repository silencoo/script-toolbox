# E-Hentai One-Click Multi-Favorite with H@H Download

## Overview
Enhanced version of the E-Hentai One-Click Multi-Favorite userscript that automatically sends download requests to your Hentai@Home (H@H) client when adding comics to favorites.

## New Features

### 🚀 Automatic H@H Download Integration
- **One-Click Operation**: When you add a comic to favorites, it automatically queues a download request to your H@H client
- **Original Quality**: Downloads are requested in original quality by default
- **Multiple Download Methods**: Support for different H@H client types and configurations

### ⚙️ Flexible Configuration
- **Easy Setup**: Click the "H@H设置" button to configure download settings
- **Multiple Methods**: Support for xeHentai, direct E-Hentai, and custom endpoints
- **Persistent Settings**: Configuration is saved and restored between sessions

### 📊 Download Status Feedback
- **Real-time Status**: Button text updates to show download progress
- **Error Handling**: Clear feedback when downloads fail
- **Visual Indicators**: Color-coded status (green for success, orange for partial success, red for failure)

## Download Methods

### 1. xeHentai (Recommended)
- **Description**: Uses xeHentai's JSON-RPC API to queue downloads
- **Requirements**: xeHentai client running with JSON-RPC server enabled
- **Default URL**: `http://localhost:8080`
- **Features**: Full aria2 integration, retry logic, connection optimization

### 2. Direct E-Hentai
- **Description**: Sends download requests directly to E-Hentai's download system
- **Requirements**: None (uses E-Hentai's built-in download functionality)
- **Features**: Simple and reliable, works with any H@H client

### 3. Custom Endpoint
- **Description**: Sends download requests to your custom server/script
- **Requirements**: Custom download endpoint that accepts JSON requests
- **Features**: Maximum flexibility for custom setups

## Configuration

### Accessing Configuration
1. Navigate to any E-Hentai gallery page
2. Look for the "H@H设置" button next to the favorite buttons
3. Click to open the configuration panel

### Configuration Options

#### Basic Settings
- **Enable H@H Download**: Toggle automatic download functionality
- **Download Method**: Choose between xeHentai, Direct E-Hentai, or Custom
- **Download Quality**: Original or Resampled
- **Show Download Status**: Display download progress in button text

#### xeHentai Settings
- **Server URL**: xeHentai JSON-RPC server address (default: `http://localhost:8080`)
- **API Key**: Optional authentication key if required

#### Custom Endpoint Settings
- **Download URL**: Your custom download endpoint URL

## Installation

1. Install a userscript manager (Tampermonkey, Greasemonkey, etc.)
2. Copy the contents of `ehentai_util.js`
3. Create a new userscript and paste the code
4. Save and enable the script

## Usage

### Basic Usage
1. Navigate to any E-Hentai gallery
2. Click any favorite category button
3. The script will:
   - Add the comic to your favorites
   - Automatically send a download request to your H@H client
   - Show status updates in the button text

### Configuration
1. Click the "H@H设置" button
2. Configure your preferred download method and settings
3. Click "Save" to apply changes

## Technical Details

### Supported Sites
- `https://exhentai.org/g/*`
- `https://e-hentai.org/g/*`

### Browser Permissions
- `GM_xmlhttpRequest`: For API calls
- `GM_setValue`/`GM_getValue`: For configuration storage
- `@connect` permissions for localhost and E-Hentai domains

### Error Handling
- Automatic retry with exponential backoff
- Graceful fallback when download requests fail
- Clear error messages and status indicators

## Troubleshooting

### Common Issues

#### Download Not Starting
1. Check if H@H download is enabled in configuration
2. Verify your H@H client is running and accessible
3. For xeHentai: Ensure JSON-RPC server is enabled
4. Check browser console for error messages

#### xeHentai Connection Failed
1. Verify xeHentai server URL is correct
2. Check if xeHentai is running on the specified port
3. Ensure no firewall is blocking the connection
4. Try using `127.0.0.1` instead of `localhost`

#### Configuration Not Saving
1. Ensure your userscript manager has storage permissions
2. Try refreshing the page after saving configuration
3. Check if other userscripts are interfering

### Debug Mode
Enable browser developer tools to see detailed error messages and network requests.

## Compatibility

- **Browser**: Chrome, Firefox, Safari, Edge (with userscript manager)
- **Userscript Managers**: Tampermonkey, Greasemonkey, Violentmonkey
- **H@H Clients**: xeHentai, standard H@H clients, custom solutions

## Version History

### v8.0 (Current)
- Added H@H download integration
- Multiple download methods support
- Configuration panel
- Enhanced error handling and status feedback

### v7.2 (Previous)
- Basic one-click favorite functionality
- Multi-category support

## Support

For issues or feature requests, please check:
1. This documentation
2. Browser console for error messages
3. H@H client logs
4. Network connectivity to your H@H client

## License

MIT License - Feel free to modify and distribute.
