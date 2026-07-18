// ==UserScript==
// @name         E-Hentai Gallery Bulk Favorite & Download
// @namespace    https://www.e-hentai.org/
// @version      1.0
// @description  Adds bulk favorite and download functionality to E-Hentai gallery listing pages
// @author       Gemini
// @match        https://exhentai.org/
// @match        https://e-hentai.org/
// @match        https://exhentai.org/?*
// @match        https://e-hentai.org/?*
// @match        https://exhentai.org/uploader*
// @match        https://exhentai.org/favorites.php*
// @match        https://e-hentai.org/favorites.php*
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


// TODO: ADD uploader page support
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
      showDownloadStatus: true,        // Show download status in UI
      batchDelay: 2000,                // Delay between batch operations (ms)
      maxConcurrent: 3,                // Maximum concurrent operations
      oneClickMode: true,              // Enable one-click favorite + download
      showCategoryNames: true,         // Show category names instead of numbers
      showPanelByDefault: true,        // Show control panel by default
      showFloatingButton: true         // Show floating reopen button
  };

  // Load saved configuration
  const savedConfig = GM_getValue('hath_gallery_config', null);
  if (savedConfig) {
      Object.assign(HATH_CONFIG, savedConfig);
  }

  // Global state
  let isProcessing = false;
  let currentBatch = [];
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;

  // Wait for page to load with multiple detection methods
  const MAX_ATTEMPTS = 100;
  let attempts = 0;

  const interval = setInterval(() => {
      attempts++;
      
      // Try multiple ways to detect gallery page
      const galleryContainer = document.querySelector('#gdt') || 
                              document.querySelector('.gallery') ||
                              document.querySelector('#content') ||
                              document.querySelector('.container');
      
      const galleryItems = document.querySelectorAll('.gdtm, .gdtl, .gl1t, .gl2t, .gl3t, .gl4t, .gl5t, .gl1c, .gl2c, .gl3c, .gl4c, .gl5c, .gl1e, .gl2e, .gl3e, .gl4e, .gl5e, .gl1m, .gl2m, .gl3m, .gl4m, .gl5m');
      
      const galleryLinks = document.querySelectorAll('a[href*="/g/"]');
      
      console.log(`E-Hentai Gallery Script: Attempt ${attempts}, container: ${!!galleryContainer}, items: ${galleryItems.length}, links: ${galleryLinks.length}`);

      if (galleryContainer || galleryItems.length > 0 || galleryLinks.length > 0) {
          clearInterval(interval);
          main();
      } else if (attempts > MAX_ATTEMPTS) {
          clearInterval(interval);
          console.log('E-Hentai Gallery Script: Max attempts reached, giving up');
      }
  }, 200);

  function main() {
      // Check if we're on a gallery listing page
      if (!isGalleryPage()) {
          console.log('E-Hentai Gallery Script: Not a gallery page or no galleries found');
          return;
      }

      console.log('E-Hentai Gallery Script: Gallery page detected, adding controls');
      
      // Add individual gallery controls
      addGalleryControls();
      
      // Add floating reopen button
      addFloatingButton();
      
      // Add bulk controls if enabled by default
      if (HATH_CONFIG.showPanelByDefault) {
          addBulkControls();
      }
  }

  function isGalleryPage() {
      // Check if we're on a gallery listing page with multiple possible selectors
      const galleryContainer = document.querySelector('#gdt') || 
                              document.querySelector('.gallery') ||
                              document.querySelector('#content') ||
                              document.querySelector('.container');
      
      const galleryItems = document.querySelectorAll('.gdtm, .gdtl, .gl1t, .gl2t, .gl3t, .gl4t, .gl5t, .gl1c, .gl2c, .gl3c, .gl4c, .gl5c, .gl1e, .gl2e, .gl3e, .gl4e, .gl5e');
      
      console.log('E-Hentai Gallery Script: Found container:', !!galleryContainer);
      console.log('E-Hentai Gallery Script: Found gallery items:', galleryItems.length);
      
      return galleryItems.length > 0;
  }

  function addFloatingButton() {
      if (!HATH_CONFIG.showFloatingButton) return;
      
      // Remove existing floating button if any
      const existingButton = document.getElementById('gallery-floating-button');
      if (existingButton) {
          existingButton.remove();
      }
      
      // Create floating button
      const floatingButton = document.createElement('div');
      floatingButton.id = 'gallery-floating-button';
      floatingButton.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          width: 50px;
          height: 50px;
          background: #4CAF50;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
          z-index: 9999;
          transition: all 0.3s ease;
          font-size: 20px;
          color: white;
          user-select: none;
      `;
      
      floatingButton.innerHTML = '⚙️';
      floatingButton.title = 'Open Gallery Controls';
      
      // Add hover effects
      floatingButton.addEventListener('mouseenter', () => {
          floatingButton.style.transform = 'scale(1.1)';
          floatingButton.style.background = '#45a049';
      });
      
      floatingButton.addEventListener('mouseleave', () => {
          floatingButton.style.transform = 'scale(1)';
          floatingButton.style.background = '#4CAF50';
      });
      
      // Add click handler
      floatingButton.addEventListener('click', () => {
          const existingPanel = document.getElementById('bulk-controls');
          if (existingPanel) {
              existingPanel.remove();
              floatingButton.style.display = 'flex';
          } else {
              addBulkControls();
              floatingButton.style.display = 'none';
          }
      });
      
      document.body.appendChild(floatingButton);
  }

  function addBulkControls() {
      // Remove existing panel if any
      const existingPanel = document.getElementById('bulk-controls');
      if (existingPanel) {
          existingPanel.remove();
      }
      
      // Create bulk control panel
      const bulkPanel = document.createElement('div');
      bulkPanel.id = 'bulk-controls';
      bulkPanel.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          background: white;
          border: 2px solid #4CAF50;
          border-radius: 8px;
          padding: 15px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
          z-index: 10000;
          min-width: 300px;
          max-width: 400px;
      `;

      bulkPanel.innerHTML = `
          <h3 style="margin: 0 0 15px 0; color: #333; font-size: 16px;">🎯 Bulk Gallery Operations</h3>
          
          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Favorite Category:</label>
              <select id="bulk-favcat" style="width: 100%; padding: 5px; margin-bottom: 10px;">
                  ${favcats.map((cat, i) => `<option value="${i}">${cat}</option>`).join('')}
              </select>
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Operation:</label>
              <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                  <button id="bulk-favorite" style="flex: 1; padding: 8px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">Add to Favorites</button>
                  <button id="bulk-download" style="flex: 1; padding: 8px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">Download Only</button>
              </div>
              <button id="bulk-both" style="width: 100%; padding: 8px; background: #FF9800; color: white; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">Add to Favorites + Download</button>
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Selection:</label>
              <div style="display: flex; gap: 10px;">
                  <button id="select-all" style="flex: 1; padding: 5px; background: #607D8B; color: white; border: none; border-radius: 4px; cursor: pointer;">Select All</button>
                  <button id="select-none" style="flex: 1; padding: 5px; background: #607D8B; color: white; border: none; border-radius: 4px; cursor: pointer;">Select None</button>
              </div>
          </div>

          <div id="bulk-status" style="font-size: 12px; color: #666; margin-bottom: 10px;">
              Ready to process galleries
          </div>

          <div style="display: flex; gap: 10px;">
              <button id="bulk-config" style="flex: 1; padding: 5px; background: #9C27B0; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">H@H Settings</button>
              <button id="bulk-close" style="flex: 1; padding: 5px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Close</button>
          </div>
      `;

      document.body.appendChild(bulkPanel);

      // Add event listeners
      document.getElementById('bulk-favorite').addEventListener('click', () => processBulkOperation('favorite'));
      document.getElementById('bulk-download').addEventListener('click', () => processBulkOperation('download'));
      document.getElementById('bulk-both').addEventListener('click', () => processBulkOperation('both'));
      document.getElementById('select-all').addEventListener('click', selectAllGalleries);
      document.getElementById('select-none').addEventListener('click', selectNoGalleries);
      document.getElementById('bulk-config').addEventListener('click', showHathConfigPanel);
      document.getElementById('bulk-close').addEventListener('click', () => {
          bulkPanel.remove();
          // Show floating button when panel is closed
          const floatingButton = document.getElementById('gallery-floating-button');
          if (floatingButton) {
              floatingButton.style.display = 'flex';
          }
      });
  }

  function addGalleryControls() {
      // First, try to find gallery items using the most common selectors
      let galleryItems = document.querySelectorAll('.gdtm, .gdtl, .gl1t, .gl2t, .gl3t, .gl4t, .gl5t, .gl1c, .gl2c, .gl3c, .gl4c, .gl5c, .gl1e, .gl2e, .gl3e, .gl4e, .gl5e, .gl1m, .gl2m, .gl3m, .gl4m, .gl5m');
      
      console.log('E-Hentai Gallery Script: Found gallery items:', galleryItems.length);
      
      // If no standard gallery items found, try alternative approach
      if (galleryItems.length === 0) {
          console.log('E-Hentai Gallery Script: No standard gallery items found, trying gallery links');
          const allLinks = document.querySelectorAll('a[href*="/g/"]');
          console.log('E-Hentai Gallery Script: Found gallery links:', allLinks.length);
          
          // Process gallery links and find their containers
          const processedGids = new Set();
          allLinks.forEach((link) => {
              const href = link.href;
              const urlMatch = href.match(/\/g\/(\d+)\/([a-f0-9]{10,})/);
              if (urlMatch) {
                  const gid = urlMatch[1];
                  const token = urlMatch[2];
                  
                  // Skip if already processed this gallery
                  if (processedGids.has(gid)) {
                      return;
                  }
                  processedGids.add(gid);
                  
                  // Find the best container for this link
                  let container = link.closest('.gdtm, .gdtl, .gl1t, .gl2t, .gl3t, .gl4t, .gl5t, .gl1c, .gl2c, .gl3c, .gl4c, .gl5c, .gl1e, .gl2e, .gl3e, .gl4e, .gl5e, .gl1m, .gl2m, .gl3m, .gl4m, .gl5m');
                  if (!container) {
                      // If no standard container, use the link's parent or the link itself
                      container = link.parentElement || link;
                  }
                  
                  console.log('E-Hentai Gallery Script: Processing gallery link', gid);
                  addControlsToElement(container, gid, token, href);
              }
          });
          return;
      }
      
      // Process standard gallery items
      const processedGids = new Set();
      galleryItems.forEach((item, index) => {
          // Skip if already processed
          if (item.querySelector('.gallery-controls')) {
              return;
          }

          // Extract gallery info - try multiple ways to find the link
          let link = item.querySelector('a');
          if (!link) {
              // Try to find link in parent or child elements
              link = item.closest('a') || item.querySelector('a') || item.parentElement?.querySelector('a');
          }
          
          if (!link) {
              console.log('E-Hentai Gallery Script: No link found for item', index);
              return;
          }

          const href = link.href;
          const urlMatch = href.match(/\/g\/(\d+)\/([a-f0-9]{10,})/);
          if (!urlMatch) {
              console.log('E-Hentai Gallery Script: No valid gallery URL found for', href);
              return;
          }

          const gid = urlMatch[1];
          const token = urlMatch[2];
          
          // Skip if already processed this gallery
          if (processedGids.has(gid)) {
              return;
          }
          processedGids.add(gid);
          
          console.log('E-Hentai Gallery Script: Adding controls for gallery', gid);
          addControlsToElement(item, gid, token, href);
      });
  }

  function addControlsToElement(element, gid, token, href) {
      // Skip if already processed
      if (element.querySelector('.gallery-controls')) {
          return;
      }

      // Create control container
      const controlContainer = document.createElement('div');
      controlContainer.className = 'gallery-controls';
      controlContainer.style.cssText = `
          position: absolute;
          top: 5px;
          right: 5px;
          background: rgba(0,0,0,0.9);
          border-radius: 4px;
          padding: 4px;
          display: flex;
          flex-wrap: wrap;
          gap: 2px;
          max-width: 200px;
          opacity: 0;
          transition: opacity 0.3s;
          z-index: 1000;
          font-size: 0;
      `;

      // Add checkbox
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'gallery-checkbox';
      checkbox.dataset.gid = gid;
      checkbox.dataset.token = token;
      checkbox.dataset.href = href;
      checkbox.style.cssText = `
          margin: 0;
          width: 16px;
          height: 16px;
      `;

      // Add quick favorite buttons (all 10 categories)
      const favButtons = favcats.map((cat, i) => {
          const btn = document.createElement('button');
          // Show category names or numbers based on setting
          btn.textContent = HATH_CONFIG.showCategoryNames ? 
              (cat.length > 4 ? cat.substring(0, 4) : cat) : 
              i.toString();
          btn.title = `Add to ${cat}${HATH_CONFIG.oneClickMode ? ' + Download' : ''}`;
          btn.dataset.favcat = i;
          btn.dataset.gid = gid;
          btn.dataset.token = token;
          btn.style.cssText = `
              padding: 2px 4px;
              font-size: 8px;
              background: #2196F3;
              color: white;
              border: none;
              border-radius: 2px;
              cursor: pointer;
              min-width: ${HATH_CONFIG.showCategoryNames ? '24px' : '16px'};
              text-align: center;
              white-space: nowrap;
          `;
          btn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (HATH_CONFIG.oneClickMode) {
                  handleOneClickFavoriteAndDownload(btn, gid, token, i);
              } else {
                  handleQuickFavorite(btn, gid, token);
              }
          });
          return btn;
      });

      // Add download button
      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = '⬇';
      downloadBtn.title = 'Download';
      downloadBtn.dataset.gid = gid;
      downloadBtn.dataset.token = token;
      downloadBtn.style.cssText = `
          padding: 2px 4px;
          font-size: 9px;
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 2px;
          cursor: pointer;
          min-width: 16px;
          text-align: center;
      `;
      downloadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleQuickDownload(downloadBtn, gid, token);
      });

      // Assemble controls
      controlContainer.appendChild(checkbox);
      favButtons.forEach(btn => controlContainer.appendChild(btn));
      controlContainer.appendChild(downloadBtn);

      // Add to element
      element.style.position = 'relative';
      element.appendChild(controlContainer);

      // Show controls on hover
      element.addEventListener('mouseenter', () => {
          controlContainer.style.opacity = '1';
      });
      element.addEventListener('mouseleave', () => {
          controlContainer.style.opacity = '0';
      });
  }

  function selectAllGalleries() {
      const checkboxes = document.querySelectorAll('.gallery-checkbox');
      checkboxes.forEach(cb => cb.checked = true);
      updateBulkStatus();
  }

  function selectNoGalleries() {
      const checkboxes = document.querySelectorAll('.gallery-checkbox');
      checkboxes.forEach(cb => cb.checked = false);
      updateBulkStatus();
  }

  function updateBulkStatus() {
      const checkboxes = document.querySelectorAll('.gallery-checkbox');
      const selected = Array.from(checkboxes).filter(cb => cb.checked).length;
      const status = document.getElementById('bulk-status');
      if (status) {
          status.textContent = `${selected} galleries selected`;
      }
  }

  function processBulkOperation(operation) {
      if (isProcessing) {
          alert('Please wait for current operation to complete');
          return;
      }

      const checkboxes = Array.from(document.querySelectorAll('.gallery-checkbox:checked'));
      if (checkboxes.length === 0) {
          alert('Please select at least one gallery');
          return;
      }

      isProcessing = true;
      processedCount = 0;
      successCount = 0;
      errorCount = 0;

      const galleries = checkboxes.map(cb => ({
          gid: cb.dataset.gid,
          token: cb.dataset.token,
          href: cb.dataset.href
      }));

      currentBatch = galleries;
      processNextGallery(operation);
  }

  function processNextGallery(operation) {
      if (processedCount >= currentBatch.length) {
          // All done
          isProcessing = false;
          const status = document.getElementById('bulk-status');
          if (status) {
              status.textContent = `Completed: ${successCount} success, ${errorCount} errors`;
          }
          return;
      }

      const gallery = currentBatch[processedCount];
      processedCount++;

      const status = document.getElementById('bulk-status');
      if (status) {
          status.textContent = `Processing ${processedCount}/${currentBatch.length}: ${gallery.gid}`;
      }

      if (operation === 'favorite' || operation === 'both') {
          const favcatId = document.getElementById('bulk-favcat').value;
          addToFavorites(gallery.gid, gallery.token, favcatId, () => {
              if (operation === 'both') {
                  // Also download
                  sendHathDownloadRequest(gallery.gid, gallery.token, window.location.hostname, 
                      () => successCount++,
                      () => errorCount++
                  );
              } else {
                  successCount++;
              }
              setTimeout(() => processNextGallery(operation), HATH_CONFIG.batchDelay);
          }, () => {
              errorCount++;
              setTimeout(() => processNextGallery(operation), HATH_CONFIG.batchDelay);
          });
      } else if (operation === 'download') {
          sendHathDownloadRequest(gallery.gid, gallery.token, window.location.hostname, 
              () => {
                  successCount++;
                  setTimeout(() => processNextGallery(operation), HATH_CONFIG.batchDelay);
              },
              () => {
                  errorCount++;
                  setTimeout(() => processNextGallery(operation), HATH_CONFIG.batchDelay);
              }
          );
      }
  }

  function handleOneClickFavoriteAndDownload(button, gid, token, favcatId) {
      const originalText = button.textContent;
      button.textContent = '...';
      button.disabled = true;

      // First add to favorites
      addToFavorites(gid, token, favcatId, 
          () => {
              // Favorite success, now download
              button.textContent = '✓';
              button.style.background = '#4CAF50';
              
              if (HATH_CONFIG.enabled) {
                  sendHathDownloadRequest(gid, token, window.location.hostname,
                      (downloadMessage) => {
                          button.textContent = '✓✓';
                          button.style.background = '#4CAF50';
                          button.title = `Added to ${favcats[favcatId]} + Downloaded`;
                          setTimeout(() => {
                              button.textContent = originalText;
                              button.style.background = '#2196F3';
                              button.disabled = false;
                          }, 3000);
                      },
                      (downloadError) => {
                          button.textContent = '✓!';
                          button.style.background = '#FF9800';
                          button.title = `Added to ${favcats[favcatId]} but download failed`;
                          setTimeout(() => {
                              button.textContent = originalText;
                              button.style.background = '#2196F3';
                              button.disabled = false;
                          }, 3000);
                      }
                  );
              } else {
                  // Download disabled, just show favorite success
                  button.title = `Added to ${favcats[favcatId]}`;
                  setTimeout(() => {
                      button.textContent = originalText;
                      button.style.background = '#2196F3';
                      button.disabled = false;
                  }, 2000);
              }
          },
          () => {
              // Favorite failed
              button.textContent = '✗';
              button.style.background = '#f44336';
              setTimeout(() => {
                  button.textContent = originalText;
                  button.style.background = '#2196F3';
                  button.disabled = false;
              }, 2000);
          }
      );
  }

  function handleQuickFavorite(button, gid, token) {
      const favcatId = button.dataset.favcat;
      const originalText = button.textContent;
      button.textContent = '...';
      button.disabled = true;

      addToFavorites(gid, token, favcatId, 
          () => {
              button.textContent = '✓';
              button.style.background = '#4CAF50';
              setTimeout(() => {
                  button.textContent = originalText;
                  button.style.background = '#2196F3';
                  button.disabled = false;
              }, 2000);
          },
          () => {
              button.textContent = '✗';
              button.style.background = '#f44336';
              setTimeout(() => {
                  button.textContent = originalText;
                  button.style.background = '#2196F3';
                  button.disabled = false;
              }, 2000);
          }
      );
  }

  function handleQuickDownload(button, gid, token) {
      button.textContent = '...';
      button.disabled = true;

      sendHathDownloadRequest(gid, token, window.location.hostname,
          () => {
              button.textContent = '✓';
              button.style.background = '#4CAF50';
              setTimeout(() => {
                  button.textContent = '⬇';
                  button.style.background = '#4CAF50';
                  button.disabled = false;
              }, 2000);
          },
          () => {
              button.textContent = '✗';
              button.style.background = '#f44336';
              setTimeout(() => {
                  button.textContent = '⬇';
                  button.style.background = '#4CAF50';
                  button.disabled = false;
              }, 2000);
          }
      );
  }

  function addToFavorites(gid, token, favcatId, onSuccess, onError) {
      const hostname = window.location.hostname;
      const requestUrl = `https://${hostname}/gallerypopups.php?gid=${gid}&t=${token}&act=addfav`;
      const formData = `favcat=${favcatId}&favnote=&apply=Add+to+Favorites&update=1`;

      GM_xmlhttpRequest({
          method: "POST",
          url: requestUrl,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          data: formData,
          onload: function(response) {
              const successSignature = 'window.opener.document.getElementById("favoritelink")';
              if (response.status === 200 && response.responseText.includes(successSignature)) {
                  onSuccess();
              } else {
                  onError();
              }
          },
          onerror: function() {
              onError();
          }
      });
  }

  // *** H@H Download Functions (same as main script) ***
  
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

  function sendRealDownloadRequest(gid, token, hostname, onSuccess, onError) {
      try {
          const archiverUrl = `https://${hostname}/archiver.php?gid=${gid}&token=${token}`;
          const formData = 'hathdl_xres=org';
          
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
                      } else {
                          onSuccess('Download request sent');
                      }
                  } else if (response.status === 302 || response.status === 301) {
                      onSuccess('Download initiated (redirected)');
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

  function sendDirectDownloadRequest(gid, token, hostname, onSuccess, onError) {
      try {
          const archiverUrl = `https://${hostname}/archiver.php?gid=${gid}&token=${token}`;
          const formData = 'hathdl_xres=org';
          
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
                          onSuccess('Download request sent');
                      }
                  } else if (response.status === 302 || response.status === 301) {
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

  function sendLinkDownloadRequest(gid, token, hostname, onSuccess, onError) {
      try {
          const archiverUrl = `https://${hostname}/archiver.php?gid=${gid}&token=${token}`;
          const downloadWindow = window.open(archiverUrl, '_blank', 'width=800,height=600,scrollbars=yes,resizable=yes');
          
          if (downloadWindow) {
              onSuccess('Archiver page opened in new tab');
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
          z-index: 10001;
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
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">One-Click Mode:</label>
              <input type="checkbox" id="one-click-mode" ${HATH_CONFIG.oneClickMode ? 'checked' : ''} style="margin-right: 5px;">
              <span>Favorite buttons will also download (one-click operation)</span>
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Show Category Names:</label>
              <input type="checkbox" id="show-category-names" ${HATH_CONFIG.showCategoryNames ? 'checked' : ''} style="margin-right: 5px;">
              <span>Show category names on buttons instead of numbers</span>
          </div>

          <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Panel Behavior:</label>
              <div style="margin-left: 10px;">
                  <div style="margin-bottom: 5px;">
                      <input type="checkbox" id="show-panel-default" ${HATH_CONFIG.showPanelByDefault ? 'checked' : ''} style="margin-right: 5px;">
                      <span>Show control panel by default</span>
                  </div>
                  <div>
                      <input type="checkbox" id="show-floating-button" ${HATH_CONFIG.showFloatingButton ? 'checked' : ''} style="margin-right: 5px;">
                      <span>Show floating reopen button (⚙️)</span>
                  </div>
              </div>
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
              <label style="display: block; margin-bottom: 5px; font-weight: bold;">Batch Settings:</label>
              <div style="display: flex; gap: 10px;">
                  <div style="flex: 1;">
                      <label style="font-size: 12px;">Delay (ms):</label>
                      <input type="number" id="batch-delay" value="${HATH_CONFIG.batchDelay}" style="width: 100%; padding: 3px; font-size: 12px;">
                  </div>
                  <div style="flex: 1;">
                      <label style="font-size: 12px;">Max Concurrent:</label>
                      <input type="number" id="max-concurrent" value="${HATH_CONFIG.maxConcurrent}" style="width: 100%; padding: 3px; font-size: 12px;">
                  </div>
              </div>
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
          HATH_CONFIG.oneClickMode = document.getElementById('one-click-mode').checked;
          HATH_CONFIG.showCategoryNames = document.getElementById('show-category-names').checked;
          HATH_CONFIG.showPanelByDefault = document.getElementById('show-panel-default').checked;
          HATH_CONFIG.showFloatingButton = document.getElementById('show-floating-button').checked;
          HATH_CONFIG.method = document.getElementById('hath-method').value;
          HATH_CONFIG.xeHentaiUrl = document.getElementById('xeHentai-url').value;
          HATH_CONFIG.xeHentaiApiKey = document.getElementById('xeHentai-key').value;
          HATH_CONFIG.customDownloadUrl = document.getElementById('custom-url').value;
          HATH_CONFIG.quality = document.getElementById('hath-quality').value;
          HATH_CONFIG.batchDelay = parseInt(document.getElementById('batch-delay').value);
          HATH_CONFIG.maxConcurrent = parseInt(document.getElementById('max-concurrent').value);
          HATH_CONFIG.showDownloadStatus = document.getElementById('hath-status').checked;

          // Save to storage
          GM_setValue('hath_gallery_config', HATH_CONFIG);
          
          // Close panel
          overlay.remove();
          
          // Show success message
          alert('H@H configuration saved successfully! Please refresh the page to see changes.');
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
