import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");

const WIDGET = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/";
const FRAME_URL = `${WIDGET}widget-a`;
const SENDER = { tab: { id: 7 }, frameId: 3, url: FRAME_URL };
const REQUEST = { action: "detectAndClickTurnstile", payload: { xRatio: 0.1, yRatio: 0.5 } };
const PAGE_FRAME = { id: "main", url: "https://site.example/" };

// Content boxes are 300x65 at x=100, with each owner iframe stacked 100px lower.
const contentBox = (backendNodeId) => {
    const top = backendNodeId * 100;
    return [100, top, 400, top, 400, top + 65, 100, top + 65];
};

// targets: chrome.debugger.getTargets() rows (out-of-process frames).
// childFrames: same-process frames under the page in Page.getFrameTree.
// owners: frameId -> backendNodeId of its <iframe> in this tab.
function load({ targets = [], childFrames = [], owners = {}, scroll = { pageX: 0, pageY: 0 }, hit } = {}) {
    const calls = [];
    let listener;
    const chrome = {
        runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
        debugger: {
            attach: (target, version, callback) => { calls.push(["attach"]); callback(); },
            detach: (target, callback) => { calls.push(["detach"]); callback(); },
            getTargets: async () => targets,
            sendCommand: async (target, method, params) => {
                calls.push([method, params]);
                if (method === "Page.getFrameTree") {
                    return { frameTree: { frame: PAGE_FRAME, childFrames: childFrames.map((frame) => ({ frame })) } };
                }
                if (method === "DOM.getFrameOwner") {
                    if (!(params.frameId in owners)) throw new Error("Frame with the given id was not found.");
                    return { backendNodeId: owners[params.frameId] };
                }
                if (method === "DOM.getBoxModel") return { model: { content: contentBox(params.backendNodeId) } };
                if (method === "Page.getLayoutMetrics") return { cssVisualViewport: scroll };
                if (method === "DOM.getNodeForLocation") return hit(params);
                return {};
            },
        },
    };
    const quiet = { log() {}, warn() {}, error() {} };
    vm.runInContext(source, vm.createContext({ chrome, URL, console: quiet, setTimeout: (fn) => fn() }));
    // Responses come from the sandbox realm; compare them as plain JSON.
    const send = (request, sender) => new Promise((resolve) => listener(request, sender, resolve))
        .then((response) => JSON.parse(JSON.stringify(response)));
    const clicks = () => calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => [params.type, params.x, params.y]);
    return { send, calls, clicks };
}

test("rejects frames whose URL only mentions the Turnstile host", async () => {
    const harness = load();
    for (const url of [
        "https://evil.example/?challenges.cloudflare.com",
        "https://challenges.cloudflare.com.evil.example/",
        "http://challenges.cloudflare.com/",
    ]) {
        const response = await harness.send(REQUEST, { ...SENDER, url });
        assert.equal(response.success, false, url);
    }
    assert.equal(await harness.send(REQUEST, { ...SENDER, frameId: 0 }).then((r) => r.success), false);
    assert.equal(harness.calls.length, 0, "the debugger is never attached");
});

test("rejects click ratios outside the iframe", async () => {
    const harness = load();
    for (const payload of [
        { xRatio: 1.5, yRatio: 0.5 },
        { xRatio: 0.5, yRatio: -0.1 },
        { xRatio: Number.NaN, yRatio: 0.5 },
        { xRatio: "0.5", yRatio: 0.5 },
    ]) {
        const response = await harness.send({ ...REQUEST, payload }, SENDER);
        assert.equal(response.success, false, JSON.stringify(payload));
    }
    assert.equal(harness.calls.length, 0);
});

test("clicks the requesting frame's owner, not a decoy whose src copies its URL", async () => {
    // A srcdoc decoy keeps the copied src attribute but commits about:srcdoc.
    const harness = load({
        targets: [{ type: "other", id: "turnstile-a", url: FRAME_URL }],
        childFrames: [{ id: "decoy", url: "about:srcdoc" }],
        owners: { "turnstile-a": 2, decoy: 1 },
        hit: () => ({ backendNodeId: 2, frameId: "main" }),
    });
    assert.deepEqual(await harness.send(REQUEST, SENDER), { success: true });
    assert.deepEqual(harness.clicks(), [["mousePressed", 130, 232.5], ["mouseReleased", 130, 232.5]]);
    assert.deepEqual(harness.calls.at(-1), ["detach"]);
});

test("picks the requesting widget among several", async () => {
    const harness = load({
        targets: [
            { type: "other", id: "turnstile-b", url: `${WIDGET}widget-b` },
            { type: "other", id: "turnstile-a", url: FRAME_URL },
        ],
        owners: { "turnstile-b": 1, "turnstile-a": 2 },
        hit: ({ y }) => ({ backendNodeId: Math.floor(y / 100), frameId: "main" }),
    });
    assert.deepEqual(await harness.send(REQUEST, SENDER), { success: true });
    assert.deepEqual(harness.clicks()[0], ["mousePressed", 130, 232.5]);
});

test("refuses when the requesting frame is missing or ambiguous", async () => {
    const hit = ({ y }) => ({ backendNodeId: Math.floor(y / 100), frameId: "main" });
    // The only Turnstile frame in the tab is a different widget.
    const otherWidget = load({
        targets: [{ type: "other", id: "turnstile-b", url: `${WIDGET}widget-b` }],
        owners: { "turnstile-b": 1 },
        hit,
    });
    assert.equal((await otherWidget.send(REQUEST, SENDER)).success, false);
    assert.deepEqual(otherWidget.clicks(), []);

    // Two frames in this tab committed the requesting URL.
    const duplicate = load({
        targets: [{ type: "other", id: "copy-1", url: FRAME_URL }, { type: "other", id: "copy-2", url: FRAME_URL }],
        owners: { "copy-1": 1, "copy-2": 2 },
        hit,
    });
    assert.equal((await duplicate.send(REQUEST, SENDER)).success, false);
    assert.deepEqual(duplicate.clicks(), []);
});

test("ignores frames with the same URL in other tabs", async () => {
    const harness = load({
        targets: [{ type: "other", id: "other-tab", url: FRAME_URL }, { type: "other", id: "turnstile-a", url: FRAME_URL }],
        owners: { "turnstile-a": 2 },
        hit: () => ({ backendNodeId: 2, frameId: "main" }),
    });
    assert.deepEqual(await harness.send(REQUEST, SENDER), { success: true });
    assert.equal(harness.clicks().length, 2);
});

test("hit-tests in document coordinates but clicks in viewport coordinates", async () => {
    const harness = load({
        targets: [{ type: "other", id: "turnstile-a", url: FRAME_URL }],
        owners: { "turnstile-a": 2 },
        scroll: { pageX: 40, pageY: 300 },
        hit: ({ x, y }) => ({ backendNodeId: x === 170 && y === 533 ? 2 : 0, frameId: "main" }),
    });
    assert.deepEqual(await harness.send(REQUEST, SENDER), { success: true });
    assert.deepEqual(harness.clicks()[0], ["mousePressed", 130, 232.5]);
});

test("accepts a hit test that lands inside a same-process Turnstile frame", async () => {
    const harness = load({
        childFrames: [{ id: "turnstile-frame", url: FRAME_URL }],
        owners: { "turnstile-frame": 2 },
        hit: () => ({ backendNodeId: 999, frameId: "turnstile-frame" }),
    });
    assert.deepEqual(await harness.send(REQUEST, SENDER), { success: true });
    assert.equal(harness.clicks().length, 2);
});

test("refuses to click when another element covers the checkbox", async () => {
    const harness = load({
        targets: [{ type: "other", id: "turnstile-a", url: FRAME_URL }],
        owners: { "turnstile-a": 2 },
        hit: () => ({ backendNodeId: 999, frameId: "main" }),
    });
    const response = await harness.send(REQUEST, SENDER);
    assert.equal(response.success, false);
    assert.deepEqual(harness.clicks(), []);
    assert.deepEqual(harness.calls.at(-1), ["detach"]);
});
