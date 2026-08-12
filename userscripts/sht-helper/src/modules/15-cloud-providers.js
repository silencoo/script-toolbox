    /*********************** 网盘提供方适配层 ***********************/
    const CLOUD_PROVIDERS = Object.freeze({
        pan115: {
            id: 'pan115',
            label: '115',
            isEnabled: () => Boolean(CFG.pan115Enabled),
            isConfigured: () => Boolean(CFG.pan115Cookie?.trim()),
            testConnection: credentials => testPan115Connection(credentials),
            submitBatch: (items, options = {}) => pan115AddTasks(items, { signal: options.signal })
        },
        pan123: {
            id: 'pan123',
            label: '123Pan',
            isEnabled: () => Boolean(CFG.pan123Enabled),
            isConfigured: () => Boolean(CFG.pan123Token && CFG.pan123LoginUuid && CFG.pan123Cookie),
            testConnection: credentials => testPan123Connection(credentials),
            submitOne: (item, options = {}) => processSingleMagnetOffline(item, item, { signal: options.signal })
        }
    });

    function getCloudProvider(id) {
        const provider = CLOUD_PROVIDERS[id];
        if (!provider) throw new Error(`未知网盘提供方: ${id}`);
        return provider;
    }

    async function testCloudProviderConnection(id, credentials) {
        const provider = getCloudProvider(id);
        diagnosticLog('debug', 'cloud-provider', `开始测试 ${provider.label} 连接`);
        const result = await provider.testConnection(credentials);
        diagnosticLog('debug', 'cloud-provider', `${provider.label} 连接测试成功`);
        return result;
    }

    function queueCloudProviderTask(id, run, options = {}) {
        const provider = getCloudProvider(id);
        return cloudTaskQueue.add(run, {
            label: options.label || `${provider.label} 任务`,
            retries: options.retries ?? 1,
            signal: options.signal || null
        });
    }
