import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const nowIso = () => new Date().toISOString();

export class ApiError extends Error {
    constructor(status, code, message, details = undefined) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

export async function readJsonFile(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
        return fallback;
    }
}

export async function writeJsonFile(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(temporary, file);
}

export function sendJson(response, status, body) {
    response.status(status);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(body));
}

export function openEventStream(response) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    response.write('retry: 1500\n\n');
}

export function sendEvent(response, event, data, id = undefined) {
    let frame = '';
    if (id !== undefined) {
        frame += `id: ${id}\n`;
    }
    if (event) {
        frame += `event: ${event}\n`;
    }
    frame += `data: ${JSON.stringify(data)}\n\n`;
    response.write(frame);
}

export function startHeartbeat(response, intervalMs = 15000) {
    const timer = setInterval(() => {
        try {
            response.write(': ping\n\n');
        } catch {
            clearInterval(timer);
        }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

export function clientAddress(request) {
    const address = request.socket?.remoteAddress ?? '';
    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function isLoopback(address) {
    return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

export function isSameOriginRequest(request) {
    const site = request.headers['sec-fetch-site'];
    if (site === 'same-origin' || site === 'none') {
        return true;
    }
    const origin = request.headers.origin;
    if (!origin) {
        return false;
    }
    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
}

export function requireString(value, field, { min = 0, max = 10000 } = {}) {
    if (typeof value !== 'string') {
        throw new ApiError(400, 'invalid_request', `${field} must be a string.`);
    }
    if (value.length < min || value.length > max) {
        throw new ApiError(400, 'invalid_request', `${field} must be between ${min} and ${max} characters.`);
    }
    return value;
}

export function optionalString(value, field, options = {}) {
    if (value === undefined || value === null) {
        return null;
    }
    return requireString(value, field, options);
}

export function requireInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new ApiError(400, 'invalid_request', `${field} must be an integer between ${min} and ${max}.`);
    }
    return number;
}

export function optionalInteger(value, field, options = {}) {
    if (value === undefined || value === null) {
        return null;
    }
    return requireInteger(value, field, options);
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function logInfo(message) {
    console.log(`[Lantern] ${message}`);
}

export function logError(message, error = undefined) {
    console.error(`[Lantern] ${message}`, error ?? '');
}
