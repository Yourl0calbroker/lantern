import { LanternPanel } from './panel.js';
import {
    capabilities,
    executeCommand,
    isGenerating,
    loadSillyTavern,
    requestHeaders,
    runGeneration,
    stopGeneration,
} from './st-bridge.js';

const state = {
    st: null,
    stVersion: null,
    capabilities: [],
    ws: null,
    config: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    replaced: false,
    activeJob: null,
    flushTimer: null,
    panel: null,
};

const TERMINAL = new Set(['done', 'error', 'canceled']);

function safeHeaders() {
    try {
        return requestHeaders();
    } catch {
        return {};
    }
}

async function start() {
    if (window.__lanternBridgeStarted) {
        return;
    }
    window.__lanternBridgeStarted = true;

    state.st = await loadSillyTavern();
    state.capabilities = state.st.capabilities ?? [];
    state.stVersion = await fetchVersion();

    state.panel = new LanternPanel({
        getHeaders: safeHeaders,
        onReconnect: () => {
            state.replaced = false;
            if (state.ws) {
                state.ws.close();
                state.ws = null;
            }
            void connect();
        },
        onRotate: async () => {
            const response = await fetch('/api/plugins/lantern-bridge/admin/pairing/rotate', {
                method: 'POST',
                headers: requestHeaders(),
            });
            if (!response.ok) {
                throw new Error(`Could not rotate the code (${response.status}).`);
            }
            return response.json();
        },
    });
    state.panel.mount();

    if (!state.st.ok) {
        state.panel.showError(`Incompatible SillyTavern: ${state.st.missing.join(', ')}`);
    }

    await connect();
}

async function fetchVersion() {
    try {
        const response = await fetch('/version');
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data.pkgVersion ?? null;
    } catch {
        return null;
    }
}

async function connect() {
    if (state.replaced) {
        return;
    }
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
        return;
    }
    clearTimeout(state.reconnectTimer);

    try {
        const response = await fetch('/api/plugins/lantern-bridge/host', { headers: safeHeaders() });
        if (!response.ok) {
            throw new Error(response.status === 404
                ? 'Lantern Bridge is not installed or server plugins are disabled.'
                : `Bridge config failed (${response.status}).`);
        }
        state.config = await response.json();
    } catch (error) {
        state.panel?.showError(error.message);
        scheduleReconnect();
        return;
    }

    let socket;
    try {
        socket = new WebSocket(`${state.config.url}?token=${encodeURIComponent(state.config.token)}`);
    } catch (error) {
        state.panel?.showError(error.message);
        scheduleReconnect();
        return;
    }
    state.ws = socket;

    socket.addEventListener('open', () => {
        state.reconnectAttempts = 0;
        state.panel?.setBridge({ connected: true, ready: false });
        send({
            type: 'hello',
            stVersion: state.stVersion,
            browser: navigator.userAgent,
            capabilities: state.capabilities,
            activeJob: jobSummary(),
        });
        if (state.activeJob) {
            sendJobSync();
            if (TERMINAL.has(state.activeJob.status)) {
                sendTerminalEvent();
            }
        }
    });

    socket.addEventListener('message', event => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        void handleMessage(message);
    });

    socket.addEventListener('close', () => {
        if (state.ws === socket) {
            state.ws = null;
        }
        state.panel?.setBridge({ connected: false, ready: false });
        if (!state.replaced) {
            scheduleReconnect();
        }
    });

    socket.addEventListener('error', () => {
        socket.close();
    });
}

function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const delay = Math.min(15000, 1500 * 2 ** Math.min(state.reconnectAttempts, 3));
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(() => {
        void connect();
    }, delay);
}

async function handleMessage(message) {
    switch (message.type) {
        case 'hello':
            state.panel?.setBridge({ connected: true, ready: true });
            break;
        case 'ping':
            send({ type: 'pong', at: message.at });
            break;
        case 'replaced':
            state.replaced = true;
            state.panel?.showError('Another SillyTavern tab took over the bridge. Click Reconnect to use this tab.');
            break;
        case 'cancel':
            cancelJob(message.jobId);
            break;
        case 'command':
            await handleCommand(message);
            break;
        default:
            break;
    }
}

async function handleCommand(message) {
    const { id, name, payload } = message;
    try {
        if (name === 'generation.start') {
            const result = await startGeneration(payload);
            send({ type: 'result', id, ok: true, data: result });
            return;
        }
        if (name === 'generation.reconcile') {
            send({ type: 'result', id, ok: true, data: { active: jobSummary() } });
            return;
        }
        const data = await executeCommand(name, payload);
        send({ type: 'result', id, ok: true, data });
    } catch (error) {
        send({
            type: 'result',
            id,
            ok: false,
            error: {
                status: Number.isInteger(error.status) ? error.status : 500,
                code: error.code ?? 'extension_error',
                message: error.message ?? 'The SillyTavern extension failed.',
            },
        });
    }
}

async function startGeneration(payload) {
    if (!state.st?.ok) {
        throw Object.assign(new Error(`SillyTavern is missing: ${state.st?.missing?.join(', ') ?? 'required modules'}`), {
            code: 'unsupported_st_version',
            status: 409,
        });
    }
    if (state.activeJob && !TERMINAL.has(state.activeJob.status)) {
        throw Object.assign(new Error('A generation is already running.'), {
            code: 'generation_busy',
            status: 409,
        });
    }
    if (isGenerating()) {
        throw Object.assign(new Error('SillyTavern is already generating in this tab. Stop it first.'), {
            code: 'generation_busy',
            status: 409,
        });
    }
    if (state.activeJob && TERMINAL.has(state.activeJob.status)) {
        state.activeJob = null;
    }

    const job = {
        jobId: payload.jobId,
        kind: payload.kind,
        avatar: payload.avatar,
        chatFile: payload.chatFile,
        text: '',
        pendingText: '',
        status: 'running',
        stopRequested: false,
        messageIndex: null,
        swipes: null,
        swipeId: null,
        error: null,
        startedAt: Date.now(),
    };
    state.activeJob = job;

    void runGeneration(payload, {
        isCanceled: () => state.activeJob !== job || job.stopRequested,
        onStart: () => {
            if (state.activeJob !== job) return;
            sendJob({ event: 'start', kind: job.kind });
        },
        onToken: text => {
            if (state.activeJob !== job || TERMINAL.has(job.status)) return;
            // SillyTavern emits the full response-so-far, not a delta. The
            // newest snapshot replaces the old one; appending duplicates words.
            job.text = text;
            job.pendingText = text;
            if (!state.flushTimer) {
                state.flushTimer = setTimeout(flushTokens, 45);
            }
        },
        onDone: result => finishJob(job, 'done', result),
        onError: error => finishJob(job, 'error', {
            error: {
                code: error.code ?? 'generation_failed',
                message: error.message ?? 'Generation failed in SillyTavern.',
            },
        }),
        onCanceled: result => finishJob(job, 'canceled', result),
    }).catch(error => {
        finishJob(job, 'error', {
            error: {
                code: error.code ?? 'generation_failed',
                message: error.message ?? 'Generation failed in SillyTavern.',
            },
        });
    });

    return { accepted: true };
}

function finishJob(job, status, result) {
    if (state.activeJob !== job || TERMINAL.has(job.status)) {
        return;
    }
    flushTokens();
    job.status = status;
    job.messageIndex = Number.isInteger(result?.messageIndex) ? result.messageIndex : null;
    job.swipes = Array.isArray(result?.swipes) ? result.swipes : null;
    job.swipeId = Number.isInteger(result?.swipeId) ? result.swipeId : null;
    job.error = result?.error ?? null;
    if (typeof result?.text === 'string') {
        job.text = result.text;
    }
    sendTerminalEvent();
    state.panel?.setBridge({ connected: Boolean(state.ws), ready: true });
}

function sendTerminalEvent() {
    const job = state.activeJob;
    if (!job || !TERMINAL.has(job.status)) {
        return;
    }
    if (job.status === 'done') {
        sendJob({
            event: 'done',
            text: job.text,
            messageIndex: job.messageIndex,
            swipes: job.swipes,
            swipeId: job.swipeId,
        });
    } else if (job.status === 'canceled') {
        sendJob({ event: 'canceled', text: job.text, messageIndex: job.messageIndex });
    } else {
        sendJob({ event: 'error', error: job.error });
    }
}

function sendJobSync() {
    const job = state.activeJob;
    if (!job) {
        return;
    }
    sendJob({ event: 'sync', text: job.text });
}

function sendJob(payload) {
    const job = state.activeJob;
    if (!job) {
        return false;
    }
    return send({ type: 'job', jobId: job.jobId, ...payload });
}

function flushTokens() {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    const job = state.activeJob;
    if (!job || !job.pendingText) {
        return;
    }
    const text = job.pendingText;
    job.pendingText = '';
    sendJob({ event: 'sync', text });
}

function cancelJob(jobId) {
    const job = state.activeJob;
    if (!job || job.jobId !== jobId || TERMINAL.has(job.status)) {
        return;
    }
    job.stopRequested = true;
    stopGeneration();
}

function jobSummary() {
    const job = state.activeJob;
    if (!job) {
        return [];
    }
    return [{
        jobId: job.jobId,
        status: job.status,
        text: job.text,
        messageIndex: job.messageIndex,
        swipes: job.swipes,
        swipeId: job.swipeId,
        error: job.error,
    }];
}

function send(message) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    try {
        state.ws.send(JSON.stringify(message));
        return true;
    } catch {
        return false;
    }
}

jQuery(async () => {
    await start();
});
