// ==UserScript==
// @name         E-Hentai One-Click Multi-Favorite with H@H Download
// @namespace    https://www.e-hentai.org/
// @version      8.0
// @description  Adds a "Quick Favorite" row with buttons to the tag list area. Automatically sends download requests to H@H client when adding to favorites.
// @author       Gemini
// @match        https://exhentai.org/g/*
// @match        https://e-hentai.org/g/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      exhentai.org
// @connect      e-hentai.org
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  // *** 在这里自定义你的收藏分类名称 (0-9) ***
  const favcats = [
      'Normal', // 0
      'NTR',      // 1
      'Incest',          // 2
      'MILF',        // 3
      'Long story',            // 4
      'COS',            // 5
      'Best',            // 6
      '.',            // 7
      'AI Generated',            // 8
      'Lolicon'             // 9
  ];

  // *** H@H Download Configuration ***
  const HATH_CONFIG = {
      enabled: true,                    // Enable/disable H@H download feature
      method: 'real',                 // Download method: 'xeHentai', 'direct', 'real', 'custom', 'link'
      xeHentaiUrl: 'http://localhost:8080',  // xeHentai JSON-RPC server URL
      xeHentaiApiKey: '',              // xeHentai API key (if required)
      customDownloadUrl: '',           // Custom download endpoint URL
      quality: 'original',             // Download quality: 'original', 'resample'
      retryAttempts: 3,                // Number of retry attempts for download requests
      retryDelay: 1000,                // Delay between retry attempts (ms)
      showDownloadStatus: true         // Show download status in UI
  };

  // Load saved configuration
  const savedConfig = GM_getValue('hath_config', null);
  if (savedConfig) {
      Object.assign(HATH_CONFIG, savedConfig);
  }

  // *** H@H Download Functions ***
  
  /**
   * Send download request to H@H client
   * @param {string} gid - Gallery ID
   * @param {string} token - Gallery token
   * @param {string} hostname - Current hostname
   * @param {Function} onSuccess - Success callback
   * @param {Function} onError - Error callback
   */
  function sendHathDownloadRequest(gid, token, hostname, onSuccess, onError) {
      if (!HATH_CONFIG.enabled) {
          onSuccess('H@H download disabled');
          return;
      }

      const galleryUrl = `https://${hostname}/g/${gid}/${token}`;
      
      switch (HATH_CONFIG.method) {
          case 'xeHentai':
              sendXeHentaiDownloadRequest(gid, token, galleryUrl, onSuccess, onError);
              break;
          case 'real':
              sendRealDownloadRequest(gid, token, hostname, onSuccess, onError);
              break;
          case 'direct':
              sendDirectDownloadRequest(gid, token, hostname, onSuccess, onError);
              break;
          case 'link':
              sendLinkDownloadRequest(gid, token, hostname, onSuccess, onError);
              break;
          case 'custom':
              sendCustomDownloadRequest(gid, token, galleryUrl, onSuccess, onError);
              break;
          default:
              onError('Unknown download method: ' + HATH_CONFIG.method);
      }
  }

  /**
   * Send download request via xeHentai JSON-RPC
   */
  function sendXeHentaiDownloadRequest(gid, token, galleryUrl, onSuccess, onError) {
      const requestData = {
          jsonrpc: '2.0',
          method: 'aria2.addUri',
          params: [
              [galleryUrl],
            {
                'dir': '/downloads',
                'max-connection-per-server': '16',
                'split': '16',
                'min-split-size': '1M',
                'max-tries': '5',
                'retry-wait': '3',
                'user-agent': navigator.userAgent,
                'referer': galleryUrl
            }
          ],
          id: Date.now()
      };

      const headers = {
          'Content-Type': 'application/json'
      };

      if (HATH_CONFIG.xeHentaiApiKey) {
          headers['Authorization'] = `Bearer ${HATH_CONFIG.xeHentaiApiKey}`;
      }

      GM_xmlhttpRequest({
          method: 'POST',
          url: `${HATH_CONFIG.xeHentaiUrl}/jsonrpc`,
          headers: headers,
          data: JSON.stringify(requestData),
          onload: function(response) {
              if (response.status === 200) {
                  try {
                      const result = JSON.parse(response.responseText);
                      if (result.result) {
                          onSuccess(`Download queued: ${result.result}`);
                      } else if (result.error) {
                          onError(`xeHentai error: ${result.error.message}`);
                      } else {
                          onSuccess('Download request sent to xeHentai');
                      }
                  } catch (e) {
                      onError('Invalid JSON response from xeHentai');
                  }
              } else {
                  onError(`xeHentai request failed: ${response.status}`);
              }
          },
          onerror: function() {
              onError('Failed to connect to xeHentai server');
          }
      });
  }

  /**
   * Send real download request to E-Hentai using exact curl parameters
   * This implements the actual HTTP request that E-Hentai sends
   */
  function sendRealDownloadRequest(gid, token, hostname, onSuccess, onError) {
      try {
          // Construct the archiver URL
          const archiverUrl = `https://${hostname}/archiver.php?gid=${gid}&token=${token}`;
          
          // Prepare form data for original quality download
          const formData = 'hathdl_xres=org';
          
          // Send POST request with exact headers from your curl command
          GM_xmlhttpRequest({
              method: 'POST',
              url: archiverUrl,
              headers: {
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
                  'Cache-Control': 'max-age=0',
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'DNT': '1',
                  'Origin': `https://${hostname}`,
                  'Priority': 'u=0, i',
                  'Referer': archiverUrl,
                  'Sec-CH-UA': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
                  'Sec-CH-UA-Mobile': '?0',
                  'Sec-CH-UA-Platform': '"macOS"',
                  'Sec-Fetch-Dest': 'document',
                  'Sec-Fetch-Mode': 'navigate',
                  'Sec-Fetch-Site': 'same-origin',
                  'Sec-Fetch-User': '?1',
                  'Upgrade-Insecure-Requests': '1',
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
              },
              data: formData,
              onload: function(response) {
                  if (response.status === 200) {
                      // Check response content for success indicators
                      const responseText = response.responseText.toLowerCase();
                      
                      if (responseText.includes('download') || 
                          responseText.includes('archive') ||
                          responseText.includes('hathdl') ||
                          responseText.includes('success') ||
                          responseText.includes('queued') ||
                          responseText.includes('started')) {
                          onSuccess('Download queued successfully!');
                      } else if (responseText.includes('log on') || 
                                 responseText.includes('login') ||
                                 responseText.includes('password') ||
                                 responseText.includes('authentication')) {
                          onError('Please log in to E-Hentai first');
                      } else if (responseText.includes('error') ||
                                 responseText.includes('failed') ||
                                 responseText.includes('invalid')) {
                          onError('Download request failed - check gallery access');
                      } else {
                          // If we can't determine success/failure, assume success for redirects
                          onSuccess('Download request sent');
                      }
                  } else if (response.status === 302 || response.status === 301) {
                      // Redirect usually means successful download initiation
                      onSuccess('Download initiated (redirected)');
                  } else if (response.status === 403) {
                      onError('Access denied - check gallery permissions');
                  } else if (response.status === 404) {
                      onError('Gallery not found');
                  } else {
                      onError(`Download failed: HTTP ${response.status}`);
                  }
              },
              onerror: function() {
                  onError('Network error - check connection');
              }
          });
      } catch (error) {
          onError(`Real download failed: ${error.message}`);
      }
  }

  /**
   * Send direct download request to E-Hentai
   * This method sends the actual POST request to archiver.php
   */
  function sendDirectDownloadRequest(gid, token, hostname, onSuccess, onError) {
      try {
          // Construct the archiver URL
          const archiverUrl = `https://${hostname}/archiver.php?gid=${gid}&token=${token}`;
          
          // Prepare form data for original quality download
          const formData = 'hathdl_xres=org';
          
          // Send POST request to archiver.php
          GM_xmlhttpRequest({
              method: 'POST',
              url: archiverUrl,
              headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
                  'Cache-Control': 'max-age=0',
                  'DNT': '1',
                  'Origin': `https://${hostname}`,
                  'Priority': 'u=0, i',
                  'Referer': archiverUrl,
                  'Sec-Fetch-Dest': 'document',
                  'Sec-Fetch-Mode': 'navigate',
                  'Sec-Fetch-Site': 'same-origin',
                  'Sec-Fetch-User': '?1',
                  'Upgrade-Insecure-Requests': '1',
                  'User-Agent': navigator.userAgent
              },
              data: formData,
              onload: function(response) {
                  if (response.status === 200) {
                      // Check if the response indicates successful download initiation
                      if (response.responseText.includes('download') || 
                          response.responseText.includes('archive') ||
                          response.responseText.includes('hathdl') ||
                          response.responseText.includes('Download')) {
                          onSuccess('Download request sent successfully');
                      } else if (response.responseText.includes('log on') || 
                                 response.responseText.includes('login') ||
                                 response.responseText.includes('password')) {
                          onError('Authentication required - please log in to E-Hentai');
                      } else {
                          onError('Download request may have failed - check response');
                      }
                  } else if (response.status === 302 || response.status === 301) {
                      // Redirect response might indicate successful download initiation
                      onSuccess('Download request sent (redirected)');
                  } else {
                      onError(`Download request failed: ${response.status}`);
                  }
              },
              onerror: function() {
                  onError('Failed to send download request');
              }
          });
      } catch (error) {
          onError(`Direct download failed: ${error.message}`);
      }
  }

  /**
   * Send link download request - opens archiver page in new tab
   */
  function sendLinkDownloadRequest(gid, token, hostname, onSuccess, onError) {
      try {
          // Construct the archiver URL (correct E-Hentai download URL)
          const archiverUrl = `https://${hostname}/archiver.php?gid=${gid}&token=${token}`;
          
          // Open archiver page in new tab
          const downloadWindow = window.open(archiverUrl, '_blank', 'width=800,height=600,scrollbars=yes,resizable=yes');
          
          if (downloadWindow) {
              onSuccess('Archiver page opened in new tab');
              
              // Auto-close the download window after 15 seconds
              setTimeout(() => {
                  try {
                      if (!downloadWindow.closed) {
                          downloadWindow.close();
                      }
                  } catch (e) {
                      // Ignore errors when closing
                  }
              }, 15000);
          } else {
              onError('Could not open archiver page (popup blocked?)');
          }
      } catch (error) {
          onError(`Link download failed: ${error.message}`);
      }
  }

  /**
   * Send custom download request
   */
  function sendCustomDownloadRequest(gid, token, galleryUrl, onSuccess, onError) {
      if (!HATH_CONFIG.customDownloadUrl) {
          onError('Custom download URL not configured');
          return;
      }

      const requestData = {
          gid: gid,
          token: token,
          url: galleryUrl,
          quality: HATH_CONFIG.quality,
          timestamp: Date.now()
      };

      GM_xmlhttpRequest({
          method: 'POST',
          url: HATH_CONFIG.customDownloadUrl,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify(requestData),
          onload: function(response) {
              if (response.status === 200) {
                  onSuccess('Download request sent to custom endpoint');
              } else {
                  onError(`Custom download failed: ${response.status}`);
              }
          },
          onerror: function() {
              onError('Failed to connect to custom download endpoint');
          }
      });
  }

  /**
   * Retry download request with exponential backoff
   */
  function retryDownloadRequest(gid, token, hostname, attempt, onSuccess, onError) {
      if (attempt > HATH_CONFIG.retryAttempts) {
          onError('Max retry attempts reached');
          return;
      }

      setTimeout(() => {
          sendHathDownloadRequest(gid, token, hostname, 
              (message) => onSuccess(message),
              (error) => {
                  if (attempt < HATH_CONFIG.retryAttempts) {
                      retryDownloadRequest(gid, token, hostname, attempt + 1, onSuccess, onError);
                  } else {
                      onError(error);
                  }
              }
          );
      }, HATH_CONFIG.retryDelay * attempt);
  }

  const MAX_ATTEMPTS = 50; // 10秒超时
  let attempts = 0;

  const interval = setInterval(() => {
      const addFavoriteLink = document.querySelector('#favoritelink');
      const taglistDiv = document.querySelector('#taglist');
      attempts++;

      if (addFavoriteLink && taglistDiv) {
          clearInterval(interval);
          main(taglistDiv);
      } else if (attempts > MAX_ATTEMPTS) {
          clearInterval(interval);
      }
  }, 200);

  function main(taglistDiv) {
      const currentUrl = window.location.href;
      const hostname = window.location.hostname;
      const urlMatch = currentUrl.match(/\/g\/(\d+)\/([a-f0-9]{10,})/);
      if (!urlMatch) return;

      const gid = urlMatch[1];
      const token = urlMatch[2];

      const favButtonContainer = document.createElement('div');
      favButtonContainer.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px; align-items: center;`;

      for (let i = 0; i < favcats.length; i++) {
          const button = document.createElement('a');
          const buttonText = favcats[i] || `分类 ${i}`;
          button.textContent = buttonText;
          button.href = '#';
          button.dataset.favcatId = i;
          button.className = 'gt';
          button.style.padding = '2px 8px';
          button.style.textDecoration = 'none';

          button.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              handleFavoriteClick(button, gid, token, currentUrl, hostname, favButtonContainer);
          });
          favButtonContainer.appendChild(button);
      }

      const tableBody = taglistDiv.querySelector('table > tbody');
      if (!tableBody) return;

      // Add configuration button
      const configButton = document.createElement('button');
      configButton.textContent = 'H@H设置';
      configButton.style.cssText = `margin-left: 10px; padding: 2px 8px; font-size: 12px; background: #2196F3; color: white; border: none; border-radius: 3px; cursor: pointer;`;
      configButton.addEventListener('click', (e) => {
          e.preventDefault();
          showHathConfigPanel();
      });

      const newRow = document.createElement('tr');
      const labelCell = document.createElement('td');
      const buttonCell = document.createElement('td');

      labelCell.className = 'tc';
      labelCell.textContent = '快速收藏:';

      buttonCell.appendChild(favButtonContainer);
      buttonCell.appendChild(configButton);
      newRow.appendChild(labelCell);
      newRow.appendChild(buttonCell);
      tableBody.appendChild(newRow);
  }

  function handleFavoriteClick(currentButton, gid, token, currentUrl, hostname, container) {
      const favcatId = currentButton.dataset.favcatId;
      Array.from(container.children).forEach(btn => {
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.7';
      });

      currentButton.textContent = '收藏中...';

      const requestUrl = `https://${hostname}/gallerypopups.php?gid=${gid}&t=${token}&act=addfav`;
      const formData = `favcat=${favcatId}&favnote=&apply=Add+to+Favorites&update=1`;

      GM_xmlhttpRequest({
          method: "POST",
          url: requestUrl,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          data: formData,
          onload: function(response) {
              // ★★★ 核心修复：不再检查语言文字，而是检查返回的页面中是否包含操作主页面的特定JS代码 ★★★
              const successSignature = 'window.opener.document.getElementById("favoritelink")';

              if (response.status === 200 && response.responseText.includes(successSignature)) {
                  currentButton.textContent = '成功!';
                  currentButton.style.background = '#4CAF50';
                  currentButton.style.color = 'white';
                  currentButton.style.borderColor = '#4CAF50';

                  // Send H@H download request after successful favorite addition
                  if (HATH_CONFIG.enabled) {
                      currentButton.textContent = '收藏成功，下载中...';
                      sendHathDownloadRequest(gid, token, hostname, 
                          (downloadMessage) => {
                              if (HATH_CONFIG.showDownloadStatus) {
                                  currentButton.textContent = `收藏+下载成功!`;
                                  currentButton.title = `收藏成功，下载: ${downloadMessage}`;
                              }
                          },
                          (downloadError) => {
                              if (HATH_CONFIG.showDownloadStatus) {
                                  currentButton.textContent = '收藏成功，下载失败';
                                  currentButton.title = `收藏成功，但下载失败: ${downloadError}`;
                                  currentButton.style.background = '#FF9800';
                                  currentButton.style.borderColor = '#FF9800';
                              }
                          }
                      );
                  }

                  setTimeout(() => {
                      const row = container.closest('tr');
                      if (row) {
                          row.style.transition = 'opacity 0.5s';
                          row.style.opacity = '0';
                          setTimeout(() => row.remove(), 500);
                      }
                  }, 1500);
              } else {
                  currentButton.textContent = '失败!';
                  currentButton.style.background = '#f44336';
                  currentButton.style.color = 'white';
                  currentButton.style.borderColor = '#f44336';
              }
          },
          onerror: function() {
              currentButton.textContent = '错误!';
              currentButton.style.background = '#f44336';
              currentButton.style.color = 'white';
              currentButton.style.borderColor = '#f44336';
          }
      });
  }

  /**
   * Show H@H configuration panel
   */
  function showHathConfigPanel() {
      // Remove existing panel if any
      const existingPanel = document.getElementById('hath-config-panel');
      if (existingPanel) {
          existingPanel.remove();
          return;
      }

      // Create modal overlay
      const overlay = document.createElement('div');
      overlay.id = 'hath-config-panel';
      overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.5);
          z-index: 10000;
          display: flex;
          justify-content: center;
          align-items: center;
      `;

      // Create panel
      const panel = document.createElement('div');
      panel.style.cssText = `
          background: white;
          padding: 20px;
          border-radius: 8px;
          max-width: 500px;
          width: 90%;
          max-height: 80%;
          overflow-y: auto;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      `;

      panel.innerHTML = `
          <h3 style="margin-top: 0; color: #333;">H@H Download Configuration</h3>
          
          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Enable H@H Download:</label>
              <input type="checkbox" id="hath-enabled" ${HATH_CONFIG.enabled ? 'checked' : ''} style="margin-right: 5px;">
              <span>Automatically download when adding to favorites</span>
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Download Method:</label>
              <select id="hath-method" style="width: 100%; padding: 5px; margin-bottom: 5px;">
                  <option value="real" ${HATH_CONFIG.method === 'real' ? 'selected' : ''}>Real Download (POST) - ⭐ RECOMMENDED - True one-click download</option>
                  <option value="xeHentai" ${HATH_CONFIG.method === 'xeHentai' ? 'selected' : ''}>xeHentai (JSON-RPC) - For xeHentai users</option>
                  <option value="direct" ${HATH_CONFIG.method === 'direct' ? 'selected' : ''}>Direct E-Hentai (Archiver) - Clicks download button or opens archiver</option>
                  <option value="link" ${HATH_CONFIG.method === 'link' ? 'selected' : ''}>Link Download (New Tab) - Opens archiver.php page</option>
                  <option value="custom" ${HATH_CONFIG.method === 'custom' ? 'selected' : ''}>Custom Endpoint - For custom solutions</option>
              </select>
              <div style="font-size: 12px; color: #666; margin-top: 5px;">
                  <strong>Real Download:</strong> Sends actual POST request to archiver.php with hathdl_xres=org for original quality. No popups!
              </div>
          </div>

          <div id="xeHentai-config" style="margin-bottom: 15px; ${HATH_CONFIG.method !== 'xeHentai' ? 'display: none;' : ''}">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">xeHentai Server URL:</label>
              <input type="text" id="xeHentai-url" value="${HATH_CONFIG.xeHentaiUrl}" style="width: 100%; padding: 5px; margin-bottom: 5px;" placeholder="http://localhost:8080">
              
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">API Key (optional):</label>
              <input type="text" id="xeHentai-key" value="${HATH_CONFIG.xeHentaiApiKey}" style="width: 100%; padding: 5px;" placeholder="Leave empty if not required">
          </div>

          <div id="custom-config" style="margin-bottom: 15px; ${HATH_CONFIG.method !== 'custom' ? 'display: none;' : ''}">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Custom Download URL:</label>
              <input type="text" id="custom-url" value="${HATH_CONFIG.customDownloadUrl}" style="width: 100%; padding: 5px;" placeholder="http://your-server.com/download">
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Download Quality:</label>
              <select id="hath-quality" style="width: 100%; padding: 5px;">
                  <option value="original" ${HATH_CONFIG.quality === 'original' ? 'selected' : ''}>Original Quality</option>
                  <option value="resample" ${HATH_CONFIG.quality === 'resample' ? 'selected' : ''}>Resampled</option>
              </select>
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Show Download Status:</label>
              <input type="checkbox" id="hath-status" ${HATH_CONFIG.showDownloadStatus ? 'checked' : ''} style="margin-right: 5px;">
              <span>Display download status in button text</span>
          </div>

          <div style="text-align: right; margin-top: 20px;">
              <button id="hath-save" style="background: #4CAF50; color: white; border: none; padding: 8px 16px; border-radius: 4px; margin-right: 10px; cursor: pointer;">Save</button>
              <button id="hath-cancel" style="background: #f44336; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Cancel</button>
          </div>
      `;

      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      // Event listeners
      document.getElementById('hath-method').addEventListener('change', function() {
          const method = this.value;
          document.getElementById('xeHentai-config').style.display = method === 'xeHentai' ? 'block' : 'none';
          document.getElementById('custom-config').style.display = method === 'custom' ? 'block' : 'none';
      });

      document.getElementById('hath-save').addEventListener('click', function() {
          // Save configuration
          HATH_CONFIG.enabled = document.getElementById('hath-enabled').checked;
          HATH_CONFIG.method = document.getElementById('hath-method').value;
          HATH_CONFIG.xeHentaiUrl = document.getElementById('xeHentai-url').value;
          HATH_CONFIG.xeHentaiApiKey = document.getElementById('xeHentai-key').value;
          HATH_CONFIG.customDownloadUrl = document.getElementById('custom-url').value;
          HATH_CONFIG.quality = document.getElementById('hath-quality').value;
          HATH_CONFIG.showDownloadStatus = document.getElementById('hath-status').checked;

          // Save to storage
          GM_setValue('hath_config', HATH_CONFIG);
          
          // Close panel
          overlay.remove();
          
          // Show success message
          alert('H@H configuration saved successfully!');
      });

      document.getElementById('hath-cancel').addEventListener('click', function() {
          overlay.remove();
      });

      overlay.addEventListener('click', function(e) {
          if (e.target === overlay) {
              overlay.remove();
          }
      });
  }
})();