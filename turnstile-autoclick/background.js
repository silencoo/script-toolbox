// background.js - CDP-based Turnstile detection and clicking
const DEBUGGER_VERSION = "1.3";
const TURNSTILE_HOST = "challenges.cloudflare.com";

// Compare the parsed hostname; a substring check would also accept URLs such
// as https://evil.example/?challenges.cloudflare.com
function isTurnstileUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === TURNSTILE_HOST;
    } catch {
        return false;
    }
}

function isRatio(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function attachDebuggerWithRetry(tabId, maxRetries = 3, retryDelay = 500) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // We wrap the callback-based attach function in a Promise
            // to use it with async/await.
            await new Promise((resolve, reject) => {
                chrome.debugger.attach({ tabId: tabId }, DEBUGGER_VERSION, () => {
                    if (chrome.runtime.lastError) {
                        // On failure, reject the promise to trigger the catch block.
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        // On success, resolve the promise to continue execution.
                        resolve();
                    }
                });
            });
            
            return; // Exit successfully

        } catch (error) {
            console.warn(`[CDP] Attempt ${attempt}/${maxRetries} to attach debugger failed: ${error.message}`);
            if (attempt < maxRetries) {
                // Wait before trying again
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
                // If all retries fail, throw the final error to be caught by the caller.
                throw new Error(`Failed to attach debugger after ${maxRetries} attempts.`);
            }
        }
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Ensure this is our action and it contains the required data
    if (request.action === "detectAndClickTurnstile" && request.payload) {
        // Only a Turnstile subframe may ask for a click, and only inside its own box
        const { xRatio, yRatio } = request.payload;
        if (!sender.tab || !(sender.frameId > 0) || !isTurnstileUrl(sender.url) ||
            !isRatio(xRatio) || !isRatio(yRatio)) {
            sendResponse({ success: false, error: "Rejected click request" });
            return;
        }
        const tabId = sender.tab.id;
        (async () => {
            try {
                // 1. Attempt to attach the debugger with retries
                await attachDebuggerWithRetry(tabId);
                const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);

                await send("Page.enable");    // Suggested: obtain navigation/load events
                await send("Runtime.enable"); // Suggested: Runtime.* may be used later
                await send("DOM.enable");     // Critical: enable the DOM domain
                // 2. If attachment is successful, run your main logic
                const clickResult = await findIframeAndClickAtRatio(tabId, { xRatio, yRatio }, sender.url);
                sendResponse(clickResult);

            } catch (error) {
                // This will catch errors from both attachment and your main logic
                console.error('[CDP] A critical error occurred:', error);
                sendResponse({ success: false, error: error.message });
            } finally {
                // 3. IMPORTANT: Always detach the debugger when done
                chrome.debugger.detach({ tabId: tabId }, () => {});
            }
        })();

        return true; // Keep the message channel open for asynchronous response
    }
});

// Find the <iframe> element hosting the frame that sent the request. Its src
// attribute is page-controlled (srcdoc, or navigating the frame elsewhere, leaves
// src unchanged), so match frames by committed URL and map back to their owner.
async function findRequestingFrame(tabId, frameUrl) {
    const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);
    const frameIds = new Set();
    // Turnstile sends Origin-Agent-Cluster, so Chrome normally runs it out of
    // process (even on cloudflare.com sites) and lists it only as a target
    for (const target of await chrome.debugger.getTargets()) {
        if (target.url === frameUrl) frameIds.add(target.id);
    }
    // With site isolation off it stays in the page's frame tree instead
    const { frameTree } = await send("Page.getFrameTree");
    const pending = [frameTree];
    while (pending.length) {
        const { frame, childFrames = [] } = pending.pop();
        if (frame.url === frameUrl) frameIds.add(frame.id);
        pending.push(...childFrames);
    }

    const owners = [];
    for (const frameId of frameIds) {
        try {
            const { backendNodeId } = await send("DOM.getFrameOwner", { frameId });
            owners.push({ frameId, backendNodeId });
        } catch {
            // The target belongs to another tab
        }
    }
    if (owners.length !== 1) {
        throw new Error(owners.length
            ? 'Several Turnstile frames share the requesting URL'
            : 'Requesting Turnstile frame not found in this tab');
    }
    return owners[0];
}

async function findIframeAndClickAtRatio(tabId, payload, frameUrl) {
    const { xRatio, yRatio } = payload;
    const maxRetries = 3;
    const retryDelay = 1000;
    const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);

    for (let i = 0; i < maxRetries; i++) {
        try {
            const owner = await findRequestingFrame(tabId, frameUrl);
            const { model: iframeBox } = await send("DOM.getBoxModel", {
                backendNodeId: owner.backendNodeId
            });

            // Compute viewport coordinates using the provided ratios
            const [x_start, y_start, , , x_end, y_end] = iframeBox.content;
            const iframeWidth = x_end - x_start;
            const iframeHeight = y_end - y_start;
            const clickX = x_start + (iframeWidth * xRatio);
            const clickY = y_start + (iframeHeight * yRatio);

            // The trusted click lands on whatever is topmost at these coordinates,
            // so refuse if the page has placed another element over the checkbox.
            // getNodeForLocation takes document coordinates, so add the scroll offset.
            const { cssVisualViewport: viewport } = await send("Page.getLayoutMetrics");
            const hit = await send("DOM.getNodeForLocation", {
                x: Math.round(clickX + viewport.pageX),
                y: Math.round(clickY + viewport.pageY)
            });
            const hitsTurnstile = hit.backendNodeId === owner.backendNodeId ||
                hit.frameId === owner.frameId;
            if (!hitsTurnstile) throw new Error('Turnstile checkbox is covered by another element');

            // Click at the viewport coordinates
            await clickAtCoordinates(tabId, clickX, clickY);
            return { success: true };

        } catch (error) {
            console.warn(`[CDP] Attempt ${i + 1} error:`, error.message || error);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    return { success: false, error: 'Failed to find and click iframe after all retries' };
}


/**
 * Creates a temporary red dot at the specified coordinates for debugging.
 */
async function showClickIndicator(tabId, x, y) {
    const expression = `
        (function() {
            const indicator = document.createElement('div');
            indicator.id = 'cdp-click-indicator';
            Object.assign(indicator.style, {
                position: 'absolute',
                left: '${x - 5}px',
                top: '${y - 5}px',
                width: '10px',
                height: '10px',
                backgroundColor: 'red',
                borderRadius: '50%',
                zIndex: '2147483647',
                pointerEvents: 'none'
            });
            document.body.appendChild(indicator);
            console.log('[CDP Debug] Click indicator shown at (${x}, ${y})');
            setTimeout(() => {
                indicator.remove();
                console.log('[CDP Debug] Click indicator removed.');
            }, 2000); // Keep visible for 2 seconds
        })();
    `;
    await chrome.debugger.sendCommand(
        { tabId: tabId },
        "Runtime.evaluate",
        { expression: expression }
    );
}

/**
 * Click at coordinates using CDP Input.dispatchMouseEvent
 */
async function clickAtCoordinates(tabId, x, y) {
    // Show a visual indicator for the click
    // await showClickIndicator(tabId, x, y);

    const dispatchMouseEvent = (type, button) => {
        return chrome.debugger.sendCommand(
            { tabId: tabId },
            "Input.dispatchMouseEvent",
            {
                type: type,
                x: x,
                y: y,
                button: button,
                buttons: button === "left" ? 1 : 0,
                clickCount: 1
            }
        );
    };

    // Simulate click sequence with a human-like delay
    await dispatchMouseEvent("mousePressed", "left");
    await new Promise(resolve => setTimeout(resolve, Math.random() * 30 + 20));
    await dispatchMouseEvent("mouseReleased", "left");
}