import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ApiError, clientAddress, isLoopback, logError, logInfo, randomToken } from './util.js';

const PROTOCOL_VERSION = 1;
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 55000;

export function createHostBridge() {
    let server = null;
    let socket = null;
    let port = null;
    let token = null;
    let connectedAt = null;
    let hostInfo = null;
    let lastPong = 0;
    let pingTimer = null;
    const pending = new Map();
    let handlers = {};

    function bind(nextHandlers) {
        handlers = nextHandlers;
    }

    async function start() {
        token = randomToken(32);
        server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 2 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        port = server.address().port;
        logInfo(`Browser bridge listening on 127.0.0.1:${port}`);

        server.on('connection', (ws, request) => {
            const address = clientAddress(request);
            if (!isLoopback(address)) {
                ws.close(1008, 'Loopback only');
                return;
            }
            let presented = '';
            try {
                presented = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? '';
            } catch {
                ws.close(1008, 'Bad request');
                return;
            }
            if (!safeEqual(presented, token)) {
                ws.close(1008, 'Unauthorized');
                return;
            }

            if (socket && socket.readyState === socket.OPEN) {
                try {
                    socket.send(JSON.stringify({ type: 'replaced', message: 'Another SillyTavern tab connected to Lantern.' }));
                    socket.close(4001, 'Replaced');
                } catch {
                }
            }

            socket = ws;
            connectedAt = new Date().toISOString();
            hostInfo = null;
            lastPong = Date.now();
            ws.send(JSON.stringify({
                type: 'hello',
                protocol: PROTOCOL_VERSION,
                port,
                pluginVersion: '1.0.1',
                serverTime: connectedAt,
            }));
            logInfo(`SillyTavern browser tab connected from ${address}`);

            ws.on('message', data => {
                let message;
                try {
                    message = JSON.parse(data.toString('utf8'));
                } catch {
                    return;
                }
                handleMessage(ws, message);
            });

            ws.on('close', () => {
                if (socket !== ws) {
                    return;
                }
                socket = null;
                hostInfo = null;
                connectedAt = null;
                rejectPending('SillyTavern closed the browser bridge.');
                logInfo('SillyTavern browser tab disconnected');
                handlers.onLost?.();
            });

            ws.on('error', error => {
                logError('Browser bridge socket error', error);
            });
        });

        pingTimer = setInterval(() => {
            if (!socket || socket.readyState !== socket.OPEN) {
                return;
            }
            if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
                logError('Browser bridge heartbeat timed out');
                socket.terminate();
                return;
            }
            try {
                socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
            } catch {
                socket.terminate();
            }
        }, PING_INTERVAL_MS);
        pingTimer.unref?.();
    }

    function handleMessage(ws, message) {
        switch (message.type) {
            case 'hello': {
                hostInfo = {
                    stVersion: typeof message.stVersion === 'string' ? message.stVersion : null,
                    browser: typeof message.browser === 'string' ? message.browser : null,
                    capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
                    activeJob: message.activeJob ?? null,
                };
                logInfo(`Bridge ready: SillyTavern ${hostInfo.stVersion ?? 'unknown'}`);
                handlers.onReady?.(hostInfo);
                break;
            }
            case 'pong':
                lastPong = Date.now();
                break;
            case 'result': {
                const entry = pending.get(message.id);
                if (!entry) {
                    break;
                }
                pending.delete(message.id);
                clearTimeout(entry.timer);
                if (message.ok) {
                    entry.resolve(message.data ?? null);
                } else {
                    const error = message.error ?? {};
                    entry.reject(new ApiError(
                        Number.isInteger(error.status) ? error.status : 500,
                        typeof error.code === 'string' ? error.code : 'host_error',
                        typeof error.message === 'string' ? error.message : 'SillyTavern reported an error.',
                    ));
                }
                break;
            }
            case 'job':
                handlers.onJobEvent?.(message);
                break;
            case 'pong-job':
                break;
            default:
                break;
        }
    }

    function rejectPending(reason) {
        for (const [id, entry] of pending) {
            pending.delete(id);
            clearTimeout(entry.timer);
            entry.reject(new ApiError(409, 'host_offline', reason));
        }
    }

    function sendRaw(message) {
        if (!socket || socket.readyState !== socket.OPEN) {
            throw new ApiError(409, 'host_offline', 'SillyTavern is not open in a browser on the PC.');
        }
        socket.send(JSON.stringify(message));
    }

    function sendCommand(name, payload = {}, timeoutMs = 30000) {
        if (!socket || socket.readyState !== socket.OPEN) {
            return Promise.reject(new ApiError(409, 'host_offline', 'SillyTavern is not open in a browser on the PC.'));
        }
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new ApiError(504, 'host_timeout', `SillyTavern did not answer ${name} in time.`));
            }, timeoutMs);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            try {
                sendRaw({ type: 'command', id, name, payload });
            } catch (error) {
                clearTimeout(timer);
                pending.delete(id);
                reject(error);
            }
        });
    }

    async function dispatch(job) {
        const result = await sendCommand('generation.start', {
            jobId: job.id,
            kind: job.kind,
            avatar: job.character,
            chatFile: job.chatFile,
            text: job.request?.text ?? null,
            messageIndex: job.messageIndex,
            expectedRevision: job.expectedRevision,
        }, 20000);
        if (!result?.accepted) {
            const error = result?.error ?? {};
            throw new ApiError(
                Number.isInteger(error.status) ? error.status : 409,
                typeof error.code === 'string' ? error.code : 'generation_rejected',
                typeof error.message === 'string' ? error.message : 'SillyTavern rejected the generation.',
            );
        }
    }

    function sendCancel(job) {
        try {
            sendRaw({ type: 'cancel', jobId: job.id });
        } catch {
        }
    }

    function hasHost() {
        return Boolean(socket && socket.readyState === socket.OPEN && hostInfo);
    }

    function state() {
        return {
            connected: Boolean(socket && socket.readyState === socket.OPEN),
            ready: hasHost(),
            port,
            connectedAt,
            host: hostInfo,
            protocol: PROTOCOL_VERSION,
        };
    }

    function getConfig() {
        if (!port || !token) {
            throw new ApiError(503, 'bridge_unavailable', 'The browser bridge has not started yet.');
        }
        return { protocol: PROTOCOL_VERSION, port, token, url: `ws://127.0.0.1:${port}/` };
    }

    async function stop() {
        clearInterval(pingTimer);
        rejectPending('SillyTavern is shutting down.');
        if (socket) {
            try {
                socket.close(1001, 'Server shutdown');
            } catch {
            }
            socket = null;
        }
        if (server) {
            await new Promise(resolve => server.close(resolve));
            server = null;
        }
    }

    return {
        bind,
        start,
        stop,
        dispatch,
        sendCommand,
        sendCancel,
        hasHost,
        state,
        getConfig,
    };
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}
