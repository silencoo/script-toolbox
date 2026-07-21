// ==UserScript==
// @name         色花堂搜索结果排序增强
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  在色花堂(sehuatang.org)的搜索结果页面提供一个悬浮工具栏，可以按回复、查看、时间进行客户端排序，无需刷新页面，避免搜索频率限制。同时增加高亮热门、恢复默认排序和自动排序配置功能。
// @author       Gemini AI
// @match        https://sehuatang.org/search.php?mod=forum*
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  // --- 样式定义 ---
  GM_addStyle(`
      #sht-sorter-panel {
          position: fixed;
          top: 150px;
          right: 20px;
          z-index: 9999;
          background-color: rgba(255, 255, 255, 0.9);
          border: 1px solid #ccc;
          border-radius: 8px;
          padding: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.2);
          font-size: 14px;
          transition: opacity 0.3s;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }
      #sht-sorter-panel.hidden {
          opacity: 0;
          pointer-events: none;
      }
      #sht-sorter-panel h4 {
          margin: 0 0 10px 0;
          text-align: center;
          font-weight: bold;
          color: #333;
          border-bottom: 1px solid #eee;
          padding-bottom: 5px;
      }
      #sht-sorter-panel .sht-button {
          display: block;
          width: 100%;
          padding: 8px 12px;
          margin-bottom: 5px;
          border: 1px solid #ddd;
          background-color: #f7f7f7;
          color: #555;
          cursor: pointer;
          border-radius: 4px;
          text-align: left;
          transition: background-color 0.2s, color 0.2s;
      }
      #sht-sorter-panel .sht-button:hover {
          background-color: #007bff;
          color: white;
          border-color: #007bff;
      }
      #sht-sorter-panel .sht-button:active {
          transform: translateY(1px);
      }
      #sht-sorter-panel .sht-checkbox-container {
          margin: 10px 0;
          padding: 8px;
          background-color: #f9f9f9;
          border-radius: 4px;
          border: 1px solid #e0e0e0;
      }
      #sht-sorter-panel .sht-checkbox-container label {
          display: flex;
          align-items: center;
          cursor: pointer;
          font-size: 13px;
          color: #555;
      }
      #sht-sorter-panel .sht-checkbox-container input[type="checkbox"] {
          margin-right: 8px;
          transform: scale(1.1);
      }
      #sht-sorter-panel .sht-checkbox-container select {
          margin-left: 8px;
          padding: 2px 6px;
          border: 1px solid #ccc;
          border-radius: 3px;
          font-size: 12px;
      }
      #sht-sorter-close-btn {
          position: absolute;
          top: 5px;
          right: 8px;
          cursor: pointer;
          font-size: 20px;
          color: #999;
          font-weight: bold;
      }
      #sht-sorter-close-btn:hover {
          color: #333;
      }
      #sht-sorter-opener {
          position: fixed;
          top: 150px;
          right: 20px;
          z-index: 9998;
          width: 40px;
          height: 40px;
          background-color: rgba(255, 255, 255, 0.9);
          border: 1px solid #ccc;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 10px rgba(0,0,0,0.2);
          font-size: 24px;
          display: none; /* Initially hidden */
      }
      .sht-hot-thread {
          background-color: #fff8e1 !important;
          border-left: 4px solid #ffc107;
      }
  `);

  // --- 配置管理 ---
  const CONFIG_KEY = 'sht_sorter_config';
  
  const defaultConfig = {
      autoSort: false,
      autoSortType: 'replies',
      autoSortOrder: 'desc',
      autoHighlight: false,
      highlightThreshold: 'auto', // 'auto', 'high', 'medium', 'low'
      autoSizeQuotaSort: false,
      sizeQuotaSortType: 'size', // 'size', 'quota', 'both'
      filterQiuPian: false // 是否过滤求片问答悬赏区的帖子
  };
  
  function getConfig() {
      try {
          const saved = localStorage.getItem(CONFIG_KEY);
          return saved ? { ...defaultConfig, ...JSON.parse(saved) } : defaultConfig;
      } catch (e) {
          console.log('SHT Sorter: 无法读取配置，使用默认配置');
          return defaultConfig;
      }
  }
  
  function saveConfig(config) {
      try {
          localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch (e) {
          console.log('SHT Sorter: 无法保存配置');
      }
  }

  // 解析文件大小和配额信息
  function parseSizeAndQuota(text) {
      let fileSize = 0; // 以MB为单位
      let quota = 0;
      
      // 解析文件大小 - 支持多种格式
      const sizePatterns = [
          /(\d+(?:\.\d+)?)\s*GB/i,  // 7.12G, 7.12GB
          /(\d+(?:\.\d+)?)\s*G\b/i,  // 7.12G
          /(\d+(?:\.\d+)?)\s*MB/i,   // 1024MB
          /(\d+(?:\.\d+)?)\s*M\b/i,  // 1024M
          /(\d+(?:\.\d+)?)\s*TB/i,   // 1.5TB
          /(\d+(?:\.\d+)?)\s*T\b/i,  // 1.5T
          /【影片容量】：\s*(\d+(?:\.\d+)?)\s*G/i,  // 【影片容量】：1.07G
          /【影片容量】：\s*(\d+(?:\.\d+)?)\s*GB/i, // 【影片容量】：1.07GB
          /【影片容量】：\s*(\d+(?:\.\d+)?)\s*M/i,  // 【影片容量】：1024M
          /【影片容量】：\s*(\d+(?:\.\d+)?)\s*MB/i, // 【影片容量】：1024MB
          /容量[：:]\s*(\d+(?:\.\d+)?)\s*G/i,       // 容量：1.07G
          /容量[：:]\s*(\d+(?:\.\d+)?)\s*GB/i,      // 容量：1.07GB
          /容量[：:]\s*(\d+(?:\.\d+)?)\s*M/i,       // 容量：1024M
          /容量[：:]\s*(\d+(?:\.\d+)?)\s*MB/i       // 容量：1024MB
      ];
      
      for (const pattern of sizePatterns) {
          const match = text.match(pattern);
          if (match) {
              const value = parseFloat(match[1]);
              if (pattern.source.includes('GB') || pattern.source.includes('G\\b') || pattern.source.includes('G/i')) {
                  fileSize = value * 1024; // GB转MB
              } else if (pattern.source.includes('TB') || pattern.source.includes('T\\b') || pattern.source.includes('T/i')) {
                  fileSize = value * 1024 * 1024; // TB转MB
              } else {
                  fileSize = value; // MB
              }
              break;
          }
      }
      
      // 解析配额 - 专门匹配标题中的配额格式
      // 1. 先统一数字格式（全角转半角，去逗号）
      const normalizedText = text
          .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
          .replace(/,/g, '');
      
      // 2. 匹配最后一个紧挨"配额"的数字
      // 支持格式：120配额、120/xxx配额、【xxx/xxx/120配额】等
      const quotaMatch = normalizedText.match(/(\d+)(?:\/[^/]*)*配额/i);
      if (quotaMatch) {
          quota = parseInt(quotaMatch[1], 10);
          console.log(`SHT Sorter: 配额解析成功 - 原文: "${text.substring(0, 50)}..." 匹配: "${quotaMatch[0]}" 配额: ${quota}`);
      }
      
      return { fileSize, quota };
  }

  // 检查是否为求片区帖子
  function isQiuPianPost(item) {
      // 直接检查分类链接
      const categoryLink = item.querySelector('a.xi1');
      if (categoryLink) {
          const categoryText = categoryLink.innerText || '';
          // 直接匹配"求片问答悬赏区"
          if (categoryText === '求片问答悬赏区') {
              return true;
          }
      }
      
      return false;
  }

  // --- 主逻辑 ---
  window.addEventListener('load', function() {
      const threadListContainer = document.querySelector('#threadlist ul');
      if (!threadListContainer) {
          console.log('SHT Sorter: 无法找到帖子列表容器。');
          return;
      }

      const threadItems = Array.from(threadListContainer.querySelectorAll('li.pbw'));
      if (threadItems.length === 0) {
          console.log('SHT Sorter: 未找到任何帖子项。');
          return;
      }

      // 1. 数据提取和解析
      const parsedThreads = threadItems.map(item => {
          const statsText = item.querySelector('p.xg1')?.innerText || '';
          const dateText = item.querySelector('p:last-of-type span:first-of-type')?.innerText || '';
          // 优先使用title属性获取完整标题，否则使用innerText
          const titleElement = item.querySelector('a.xst');
          const titleText = titleElement?.title || titleElement?.innerText || '';
          const contentText = item.querySelector('p:not(.xg1):not(:last-of-type)')?.innerText || '';

          const replies = parseInt((statsText.match(/(\d+)\s*个回复/) || [0, 0])[1], 10);
          const views = parseInt((statsText.match(/-\s*(\d+)\s*次查看/) || [0, 0])[1], 10);

          // 兼容 YYYY-MM-DD HH:MM 和 YYYY-M-D 格式
          const postDate = new Date(dateText.replace(/-/g, '/')).getTime();

          // 解析文件大小和配额 - 从标题和内容中解析
          const titleSizeQuota = parseSizeAndQuota(titleText);
          const contentSizeQuota = parseSizeAndQuota(contentText);
          
          // 文件大小优先使用内容中的信息，配额只从标题解析
          const fileSize = contentSizeQuota.fileSize || titleSizeQuota.fileSize;
          const quota = titleSizeQuota.quota; // 配额只从标题解析

          // 检查是否为求片区帖子
          const isQiuPian = isQiuPianPost(item);

          // 调试信息
          if (fileSize > 0 || quota > 0) {
              console.log(`SHT Sorter: 解析到文件信息 - 标题: "${titleText.substring(0, 50)}..." 大小: ${fileSize}MB 配额: ${quota}`);
          }
          if (isQiuPian) {
              console.log(`SHT Sorter: 识别到求片区帖子 - 标题: "${titleText.substring(0, 50)}..."`);
          }
          
          // 调试配额解析
          if (quota > 0) {
              console.log(`SHT Sorter: 配额解析 - 标题: "${titleText.substring(0, 30)}..." 配额: ${quota}`);
          }
          
          // 调试配额信息（临时）
          if (titleText.includes('配额')) {
              console.log(`SHT Sorter: 发现配额关键词 - 标题: "${titleText}" 解析结果: ${quota}`);
          }

          return { element: item, replies, views, postDate, fileSize, quota, title: titleText, isQiuPian };
      });

      const originalOrder = [...parsedThreads.map(t => t.element)];

      // 统计信息
      const threadsWithSize = parsedThreads.filter(t => t.fileSize > 0).length;
      const threadsWithQuota = parsedThreads.filter(t => t.quota > 0).length;
      console.log(`SHT Sorter: 统计信息 - 总帖子: ${parsedThreads.length}, 有文件大小: ${threadsWithSize}, 有配额: ${threadsWithQuota}`);
      
      // 显示有配额的帖子详情
      if (threadsWithQuota > 0) {
          console.log('SHT Sorter: 有配额的帖子:');
          parsedThreads.filter(t => t.quota > 0).forEach(thread => {
              console.log(`  - "${thread.title.substring(0, 40)}..." 配额: ${thread.quota}`);
          });
      }

      // 2. 获取配置
      let config = getConfig();

      // 3. 创建UI
      const panel = document.createElement('div');
      panel.id = 'sht-sorter-panel';
      panel.innerHTML = `
          <h4>排序增强工具</h4>
          <span id="sht-sorter-close-btn">&times;</span>
          <div class="sht-checkbox-container">
              <label>
                  <input type="checkbox" id="auto-sort-checkbox" ${config.autoSort ? 'checked' : ''}>
                  自动排序
                  <select id="auto-sort-type">
                      <option value="replies" ${config.autoSortType === 'replies' ? 'selected' : ''}>按回复数</option>
                      <option value="views" ${config.autoSortType === 'views' ? 'selected' : ''}>按查看数</option>
                      <option value="postDate" ${config.autoSortType === 'postDate' ? 'selected' : ''}>按时间</option>
                  </select>
                  <select id="auto-sort-order">
                      <option value="desc" ${config.autoSortOrder === 'desc' ? 'selected' : ''}>降序</option>
                      <option value="asc" ${config.autoSortOrder === 'asc' ? 'selected' : ''}>升序</option>
                  </select>
              </label>
          </div>
          <div class="sht-checkbox-container">
              <label>
                  <input type="checkbox" id="auto-highlight-checkbox" ${config.autoHighlight ? 'checked' : ''}>
                  自动高亮热门
                  <select id="highlight-threshold">
                      <option value="auto" ${config.highlightThreshold === 'auto' ? 'selected' : ''}>自动</option>
                      <option value="high" ${config.highlightThreshold === 'high' ? 'selected' : ''}>高门槛</option>
                      <option value="medium" ${config.highlightThreshold === 'medium' ? 'selected' : ''}>中门槛</option>
                      <option value="low" ${config.highlightThreshold === 'low' ? 'selected' : ''}>低门槛</option>
                  </select>
              </label>
          </div>
          <div class="sht-checkbox-container">
              <label>
                  <input type="checkbox" id="auto-size-quota-sort-checkbox" ${config.autoSizeQuotaSort ? 'checked' : ''}>
                  自动大小排序
                  <select id="size-quota-sort-type">
                      <option value="size" ${config.sizeQuotaSortType === 'size' ? 'selected' : ''}>按文件大小</option>
                      <option value="quota" ${config.sizeQuotaSortType === 'quota' ? 'selected' : ''}>按配额</option>
                      <option value="both" ${config.sizeQuotaSortType === 'both' ? 'selected' : ''}>综合排序</option>
                  </select>
              </label>
          </div>
          <div class="sht-checkbox-container">
              <label>
                  <input type="checkbox" id="filter-qiu-pian-checkbox" ${config.filterQiuPian ? 'checked' : ''}>
                  过滤求片区帖子
              </label>
          </div>
          <hr style="margin: 10px 0; border: none; border-top: 1px solid #eee;">
          <button class="sht-button" data-sort="replies">🔼 按回复数量排序</button>
          <button class="sht-button" data-sort="views">🔼 按查看次数排序</button>
          <button class="sht-button" data-sort="postDate">🔼 按发布时间排序</button>
          <button class="sht-button" data-sort="fileSize">🔼 按文件大小排序</button>
          <button class="sht-button" data-sort="quota">🔽 按配额排序</button>
          <hr style="margin: 10px 0; border: none; border-top: 1px solid #eee;">
          <button class="sht-button" data-action="highlight">⭐ 高亮热门帖子</button>
          <button class="sht-button" data-action="filter">🚫 手动过滤求片区</button>
          <button class="sht-button" data-action="restore">🔄 恢复默认排序</button>
      `;
      document.body.appendChild(panel);

      const opener = document.createElement('div');
      opener.id = 'sht-sorter-opener';
      opener.innerHTML = '🔧';
      document.body.appendChild(opener);

      // 4. 排序和DOM更新逻辑
      const reorderDOM = (sortedThreads) => {
          sortedThreads.forEach(thread => {
              threadListContainer.appendChild(thread.element);
          });
      };

      // 自动排序函数
      const performAutoSort = () => {
          if (!config.autoSort) return;
          
          const sortKey = config.autoSortType;
          const isDescending = config.autoSortOrder === 'desc';
          
          if (isDescending) {
              parsedThreads.sort((a, b) => b[sortKey] - a[sortKey]);
          } else {
              parsedThreads.sort((a, b) => a[sortKey] - b[sortKey]);
          }
          
          reorderDOM(parsedThreads);
          console.log(`SHT Sorter: 已自动按${sortKey}${isDescending ? '降序' : '升序'}排序`);
      };

      // 文件大小和配额排序函数
      const performSizeQuotaSort = () => {
          if (!config.autoSizeQuotaSort) return;
          
          const sortType = config.sizeQuotaSortType;
          
          if (sortType === 'both') {
              // 综合排序：优先按文件大小，然后按配额
              parsedThreads.sort((a, b) => {
                  if (a.fileSize !== b.fileSize) {
                      return b.fileSize - a.fileSize; // 文件大小降序
                  }
                  return b.quota - a.quota; // 配额降序
              });
          } else {
              // 单一排序
              const sortKey = sortType === 'size' ? 'fileSize' : 'quota';
              parsedThreads.sort((a, b) => b[sortKey] - a[sortKey]); // 降序
          }
          
          reorderDOM(parsedThreads);
          console.log(`SHT Sorter: 已自动按${sortType === 'both' ? '综合' : sortType}排序`);
      };

      // 过滤求片区帖子函数
      const performFilter = (force = false) => {
          if (!force && !config.filterQiuPian) {
              // 如果关闭过滤，显示所有帖子
              parsedThreads.forEach(thread => {
                  thread.element.style.display = '';
              });
              return;
          }
          
          let filteredCount = 0;
          parsedThreads.forEach(thread => {
              if (thread.isQiuPian) {
                  thread.element.style.display = 'none';
                  filteredCount++;
              } else {
                  thread.element.style.display = '';
              }
          });
          
          console.log(`SHT Sorter: 已过滤掉${filteredCount}个求片区帖子`);
      };

      // 高亮热门帖子函数
      const performHighlight = (force = false) => {
          if (!force && !config.autoHighlight) return;
          
          // 清除之前的高亮
          parsedThreads.forEach(thread => {
              thread.element.classList.remove('sht-hot-thread');
          });
          
          // 计算门槛值
          const avgReplies = parsedThreads.reduce((sum, t) => sum + t.replies, 0) / parsedThreads.length;
          const avgViews = parsedThreads.reduce((sum, t) => sum + t.views, 0) / parsedThreads.length;
          
          let thresholdReplies, thresholdViews;
          
          switch (config.highlightThreshold) {
              case 'high':
                  thresholdReplies = Math.max(50, avgReplies * 3);
                  thresholdViews = Math.max(2000, avgViews * 2.5);
                  break;
              case 'medium':
                  thresholdReplies = Math.max(20, avgReplies * 2);
                  thresholdViews = Math.max(1000, avgViews * 2);
                  break;
              case 'low':
                  thresholdReplies = Math.max(5, avgReplies * 1.5);
                  thresholdViews = Math.max(200, avgViews * 1.5);
                  break;
              case 'auto':
              default:
                  thresholdReplies = Math.max(10, avgReplies * 2);
                  thresholdViews = Math.max(500, avgViews * 1.5);
                  break;
          }
          
          // 应用高亮
          let highlightedCount = 0;
          parsedThreads.forEach(thread => {
              if (thread.replies > thresholdReplies || thread.views > thresholdViews) {
                  thread.element.classList.add('sht-hot-thread');
                  highlightedCount++;
              }
          });
          
          console.log(`SHT Sorter: 已高亮${highlightedCount}个热门帖子 (回复>${thresholdReplies} 或 查看>${thresholdViews})`);
      };

      // 执行自动排序、高亮、大小排序和过滤
      performAutoSort();
      performHighlight();
      performSizeQuotaSort();
      performFilter();

      // 5. 配置保存事件监听
      const autoSortCheckbox = document.getElementById('auto-sort-checkbox');
      const autoSortTypeSelect = document.getElementById('auto-sort-type');
      const autoSortOrderSelect = document.getElementById('auto-sort-order');
      const autoHighlightCheckbox = document.getElementById('auto-highlight-checkbox');
      const highlightThresholdSelect = document.getElementById('highlight-threshold');
      const autoSizeQuotaSortCheckbox = document.getElementById('auto-size-quota-sort-checkbox');
      const sizeQuotaSortTypeSelect = document.getElementById('size-quota-sort-type');
      const filterQiuPianCheckbox = document.getElementById('filter-qiu-pian-checkbox');

      const updateConfig = () => {
          config.autoSort = autoSortCheckbox.checked;
          config.autoSortType = autoSortTypeSelect.value;
          config.autoSortOrder = autoSortOrderSelect.value;
          config.autoHighlight = autoHighlightCheckbox.checked;
          config.highlightThreshold = highlightThresholdSelect.value;
          config.autoSizeQuotaSort = autoSizeQuotaSortCheckbox.checked;
          config.sizeQuotaSortType = sizeQuotaSortTypeSelect.value;
          config.filterQiuPian = filterQiuPianCheckbox.checked;
          saveConfig(config);
          
          // 如果启用了自动排序，立即执行
          if (config.autoSort) {
              performAutoSort();
          }
          
          // 如果启用了自动高亮，立即执行
          if (config.autoHighlight) {
              performHighlight();
          } else {
              // 如果关闭了自动高亮，清除所有高亮
              parsedThreads.forEach(thread => {
                  thread.element.classList.remove('sht-hot-thread');
              });
          }
          
          // 如果启用了文件大小排序，立即执行
          if (config.autoSizeQuotaSort) {
              performSizeQuotaSort();
          }
          
          // 执行过滤
          performFilter();
      };

      autoSortCheckbox.addEventListener('change', updateConfig);
      autoSortTypeSelect.addEventListener('change', updateConfig);
      autoSortOrderSelect.addEventListener('change', updateConfig);
      autoHighlightCheckbox.addEventListener('change', updateConfig);
      highlightThresholdSelect.addEventListener('change', updateConfig);
      autoSizeQuotaSortCheckbox.addEventListener('change', updateConfig);
      sizeQuotaSortTypeSelect.addEventListener('change', updateConfig);
      filterQiuPianCheckbox.addEventListener('change', updateConfig);

      panel.addEventListener('click', function(e) {
          if (e.target.tagName !== 'BUTTON') return;

          const sortKey = e.target.dataset.sort;
          const action = e.target.dataset.action;

          if (sortKey) {
              // 升序/降序切换
              const isAscending = e.target.innerHTML.includes('🔽');
              
              // 调试信息 - 显示排序前的数据
              if (sortKey === 'quota') {
                  console.log('SHT Sorter: 配额排序前的前5个帖子:');
                  parsedThreads.slice(0, 5).forEach((thread, index) => {
                      console.log(`  ${index + 1}. "${thread.title.substring(0, 30)}..." 配额: ${thread.quota}`);
                  });
              }
              
              if (isAscending) {
                  parsedThreads.sort((a, b) => b[sortKey] - a[sortKey]); // 降序
                  e.target.innerHTML = e.target.innerHTML.replace('🔽', '🔼');
              } else {
                  parsedThreads.sort((a, b) => a[sortKey] - b[sortKey]); // 升序
                  e.target.innerHTML = e.target.innerHTML.replace('🔼', '🔽');
              }
              reorderDOM(parsedThreads);
              
              // 调试信息 - 显示排序后的数据
              if (sortKey === 'quota') {
                  console.log('SHT Sorter: 配额排序后的前5个帖子:');
                  parsedThreads.slice(0, 5).forEach((thread, index) => {
                      console.log(`  ${index + 1}. "${thread.title.substring(0, 30)}..." 配额: ${thread.quota}`);
                  });
              }
              
              // 显示排序信息
              const sortTypeNames = {
                  'replies': '回复数',
                  'views': '查看数',
                  'postDate': '发布时间',
                  'fileSize': '文件大小',
                  'quota': '配额'
              };
              console.log(`SHT Sorter: 已按${sortTypeNames[sortKey]}${isAscending ? '降序' : '升序'}排序`);
          }

          if (action) {
              switch (action) {
                  case 'highlight':
                      // 使用配置的门槛设置进行高亮
                      performHighlight(true);
                      break;
                  case 'filter':
                      // 手动执行过滤
                      performFilter(true);
                      break;
                  case 'restore':
                      originalOrder.forEach(element => {
                          threadListContainer.appendChild(element);
                      });
                      // 重置按钮文字
                      panel.querySelectorAll('[data-sort]').forEach(btn => {
                          btn.innerHTML = btn.innerHTML.replace('🔽', '🔼');
                      });
                      // 显示所有帖子
                      parsedThreads.forEach(thread => {
                          thread.element.style.display = '';
                      });
                      break;
              }
          }
      });

      // 4. UI交互
      document.getElementById('sht-sorter-close-btn').addEventListener('click', () => {
          panel.classList.add('hidden');
          opener.style.display = 'flex';
      });

      opener.addEventListener('click', () => {
          panel.classList.remove('hidden');
          opener.style.display = 'none';
      });
  });
})();