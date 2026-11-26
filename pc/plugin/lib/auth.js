import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError, clientAddress, randomToken, readJsonFile, sha256, writeJsonFile } from './util.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 8;
const TOUCH_INTERVAL_MS = 60 * 1000;

export function createAuth({ stateDirectory }) {
    const devicesFile = path.join(stateDirectory, 'devices.json');
    const pairingFile = path.join(stateDirectory, 'pairing.json');
    const failures = new Map();
    let devices = [];

    function rotateCode() {
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        return { code, createdAt: Date.now() };
    }

    async function load() {
        devices = await readJsonFile(devicesFile, []);
        let pairing = await readJsonFile(pairingFile, null);
        if (!pairing || typeof pairing.code !== 'string' || Date.now() - pairing.createdAt > PAIRING_TTL_MS) {
            pairing = rotateCode();
            await writeJsonFile(pairingFile, pairing);
        }
        return pairing;
    }

    async function currentPairing() {
        const pairing = await readJsonFile(pairingFile, null);
        if (pairing && Date.now() - pairing.createdAt <= PAIRING_TTL_MS) {
            return pairing;
        }
        const fresh = rotateCode();
        await writeJsonFile(pairingFile, fresh);
        return fresh;
    }

    async function rotatePairing() {
        const fresh = rotateCode();
        await writeJsonFile(pairingFile, fresh);
        return fresh;
    }

    function assertRateLimit(request) {
        const address = clientAddress(request);
        const record = failures.get(address);
        if (!record) {
            return;
        }
        if (Date.now() - record.windowStart > FAILURE_WINDOW_MS) {
            failures.delete(address);
            return;
        }
        if (record.count >= MAX_FAILURES_PER_WINDOW) {
            throw new ApiError(429, 'rate_limited', 'Too many pairing attempts. Wait a minute and try again.');
        }
    }

    function recordFailure(request) {
        const address = clientAddress(request);
        const record = failures.get(address);
        if (!record || Date.now() - record.windowStart > FAILURE_WINDOW_MS) {
            failures.set(address, { count: 1, windowStart: Date.now() });
            return;
        }
        record.count += 1;
    }

    async function pair(request, { code, deviceName }) {
        assertRateLimit(request);
        const pairing = await currentPairing();
        const submitted = String(code ?? '').trim();
        if (submitted.length !== 6 || submitted !== pairing.code) {
            recordFailure(request);
            throw new ApiError(403, 'pairing_rejected', 'That pairing code is not valid.');
        }

        const token = randomToken(32);
        const device = {
            id: crypto.randomUUID(),
            name: String(deviceName ?? 'Android device').slice(0, 64),
            tokenHash: sha256(token),
            createdAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            address: clientAddress(request),
        };
        devices = [...devices.filter(entry => entry.name !== device.name || entry.tokenHash !== device.tokenHash), device];
        await writeJsonFile(devicesFile, devices);
        await writeJsonFile(pairingFile, rotateCode());
        failures.delete(clientAddress(request));
        return { device, token };
    }

    function authenticate(request) {
        const header = request.headers.authorization ?? '';
        const match = /^Bearer ([A-Za-z0-9+/_-]{20,}={0,2})$/.exec(header);
        if (!match) {
            throw new ApiError(401, 'unauthorized', 'This device is not paired.');
        }
        const presented = Buffer.from(sha256(match[1]), 'hex');
        let matchDevice = null;
        for (const device of devices) {
            if (device.revokedAt) {
                continue;
            }
            const stored = Buffer.from(device.tokenHash, 'hex');
            if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
                matchDevice = device;
            }
        }
        if (!matchDevice) {
            throw new ApiError(401, 'unauthorized', 'This device is not paired.');
        }
        if (Date.now() - Date.parse(matchDevice.lastSeenAt) > TOUCH_INTERVAL_MS) {
            matchDevice.lastSeenAt = new Date().toISOString();
            void writeJsonFile(devicesFile, devices);
        }
        return matchDevice;
    }

    async function revoke(deviceId) {
        devices = devices.map(device => device.id === deviceId ? { ...device, revokedAt: new Date().toISOString() } : device);
        await writeJsonFile(devicesFile, devices);
    }

    async function unpair(deviceId) {
        const remaining = devices.filter(device => device.id !== deviceId);
        if (remaining.length === devices.length) {
            return false;
        }
        devices = remaining;
        await writeJsonFile(devicesFile, devices);
        return true;
    }

    function listDevices() {
        return devices
            .filter(device => !device.revokedAt)
            .map(({ tokenHash, ...device }) => device);
    }

    return { load, pair, authenticate, revoke, unpair, listDevices, currentPairing, rotatePairing };
}
