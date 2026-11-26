import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './lib/auth.js';
import { createUpdater } from './lib/updater.js';
import { createStData } from './lib/stdata.js';
import { createJobStore } from './lib/jobs.js';
import { createHostBridge } from './lib/host.js';
import {
    ApiError,
    clientAddress,
    isLoopback,
    isSameOriginRequest,
    logError,
    logInfo,
    nowIso,
    optionalInteger,
    optionalString,
    requireInteger,
    requireString,
    sendJson,
} from './lib/util.js';

export const info = {
    id: 'lantern-bridge',
    name: 'Lantern Bridge',
    description: 'Authenticated bridge between the Lantern Android client and SillyTavern\'s real generation pipeline.',
};

const PLUGIN_VERSION = '1.1.0';
const STARTED_AT = Date.now();
const PLUGIN_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_DEVICE_WINDOW_MS = 2 * 60 * 1000;

const GENERATION_FIELDS = {
    temp: { min: 0, max: 5 },
    top_p: { min: 0, max: 1 },
    top_k: { min: 0, max: 1000, integer: true },
    top_a: { min: 0, max: 1 },
    tfs: { min: 0, max: 1 },
    typical_p: { min: 0, max: 1 },
    epsilon_cutoff: { min: 0, max: 100 },
    eta_cutoff: { min: 0, max: 100 },
    min_p: { min: 0, max: 1 },
    rep_pen: { min: 0, max: 4 },
    rep_pen_range: { min: 0, max: 32768, integer: true },
    rep_pen_slope: { min: 0, max: 10 },
    rep_pen_decay: { min: 0, max: 1 },
    no_repeat_ngram_size: { min: 0, max: 20, integer: true },
    frequency_pen: { min: -2, max: 2 },
    presence_pen: { min: -2, max: 2 },
    dry_multiplier: { min: 0, max: 5 },
    dry_base: { min: 1, max: 8 },
    dry_allowed_length: { min: 1, max: 20, integer: true },
    dry_penalty_last_n: { min: 0, max: 32768, integer: true },
    xtc_probability: { min: 0, max: 1 },
    xtc_threshold: { min: 0, max: 1 },
    mirostat_mode: { min: 0, max: 2, integer: true },
    mirostat_tau: { min: 0, max: 20 },
    mirostat_eta: { min: 0, max: 1 },
    max_tokens_second: { min: 0, max: 1000, integer: true },
    seed: { min: -1, max: 2147483647, integer: true },
    nsigma: { min: 0, max: 5 },
    adaptive_target: { min: -1, max: 1 },
    adaptive_decay: { min: 0, max: 1 },
    streaming: { boolean: true },
};

const WORLD_ENTRY_FIELDS = [
    'key', 'keysecondary', 'comment', 'content', 'constant', 'selective', 'selectiveLogic',
    'order', 'position', 'depth', 'probability', 'useProbability', 'disable', 'excludeRecursion',
    'preventRecursion', 'matchWholePersonaDescription', 'matchWholeWords', 'caseSensitive',
    'role', 'vectorized', 'group', 'automationId', 'sticky', 'cooldown', 'delay', 'scanDepth',
    'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
    'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'weight', 'decorators',
];

const CHARACTER_TEXT_FIELDS = [
    'description', 'personality', 'scenario', 'firstMessage', 'exampleMessages',
    'creatorNotes', 'systemPrompt', 'postHistoryInstructions',
];

const CHARACTER_LIST_FIELDS = ['tags', 'alternateGreetings'];

function safeMediaId(value) {
    const id = String(value ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new ApiError(400, 'invalid_media_id', 'That media id is not valid.');
    }
    return id;
}

function sanitizeMediaTitle(value) {
    const cleaned = String(value ?? '')
        .replace(/[<>:"\\/|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return cleaned || 'Untitled';
}

function isYoutubeUrl(raw) {
    try {
        const url = new URL(String(raw ?? '').trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        return host === 'youtube.com' || host === 'm.youtube.com' ||
            host === 'music.youtube.com' || host === 'youtu.be';
    } catch {
        return false;
    }
}

function runChild(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: PLUGIN_DIRECTORY,
            windowsHide: true,
            env: {
                ...process.env,
                PYTHONPATH: [PLUGIN_DIRECTORY, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
            },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new ApiError(504, 'media_timeout', 'The download took too long. Try a shorter video.'));
        }, timeoutMs);
        timer.unref?.();
        child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => {
            finish(new ApiError(503, 'downloader_unavailable', `Could not start the downloader: ${error.message}`));
        });
        child.on('close', code => {
            if (code === 0) {
                finish(null, stdout);
            } else {
                const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
                finish(new ApiError(502, 'download_failed', detail || `Downloader exited with code ${code}.`));
            }
        });
    });
}

function ytDlpArgs() {
    return ['-m', process.env.LANTERN_YTDLP_MODULE || 'yt_dlp'];
}

async function downloadYoutubeMedia(url, kind, mediaDirectory) {
    const python = process.env.LANTERN_PYTHON || 'python';
    const metadataRaw = await runChild(
        python,
        [...ytDlpArgs(), '--no-playlist', '--skip-download', '--dump-single-json', url],
        120000,
    );
    let metadata;
    try {
        metadata = JSON.parse(metadataRaw.trim());
    } catch {
        throw new ApiError(502, 'metadata_invalid', 'YouTube did not return usable video information.');
    }
    const title = sanitizeMediaTitle(metadata.title || metadata.webpage_title || 'Untitled');
    const id = randomUUID().replace(/-/g, '').slice(0, 24);
    const template = path.join(mediaDirectory, `${id}.%(ext)s`);
    const downloadArgs = kind === 'mp3'
        ? [...ytDlpArgs(), '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '192K', '-o', template, url]
        : [...ytDlpArgs(), '--no-playlist', '-f', 'best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', template, url];
    await runChild(python, downloadArgs, 600000);
    const filePath = path.join(mediaDirectory, `${id}.${kind}`);
    const stats = await fsp.stat(filePath).catch(() => null);
    if (!stats || stats.size < 1024) {
        throw new ApiError(502, 'download_missing', `The ${kind.toUpperCase()} file was not created.`);
    }
    const record = {
        id,
        title,
        kind,
        fileName: `${title}.${kind}`,
        duration: Number(metadata.duration) || 0,
        size: stats.size,
    };
    await fsp.writeFile(path.join(mediaDirectory, `${id}.json`), JSON.stringify(record), 'utf8');
    return record;
}

function normalizedCard(card) {
    const source = card && typeof card === 'object' ? card : {};
    const text = value => typeof value === 'string' ? value.trim() : '';
    const list = value => Array.isArray(value)
        ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, 40)
        : [];
    return {
        name: text(source.name).slice(0, 120),
        description: text(source.description).slice(0, 12000),
        personality: text(source.personality).slice(0, 12000),
        scenario: text(source.scenario).slice(0, 12000),
        firstMessage: text(source.firstMessage).slice(0, 12000),
        exampleMessages: text(source.exampleMessages).slice(0, 20000),
        creatorNotes: text(source.creatorNotes).slice(0, 12000),
        systemPrompt: text(source.systemPrompt).slice(0, 12000),
        postHistoryInstructions: text(source.postHistoryInstructions).slice(0, 12000),
        tags: list(source.tags),
    };
}

async function findExtensionDirectory(userDirectory) {
    const extensionsRoot = path.join(userDirectory, 'extensions');
    const candidates = [path.join(extensionsRoot, 'lantern'), path.join(extensionsRoot, 'lantern-bridge')];
    for (const candidate of candidates) {
        const packagePath = path.join(candidate, 'pc', 'plugin', 'package.json');
        if (!await fsp.stat(packagePath).then(stat => stat.isFile(), () => false)) {
            continue;
        }
        try {
            const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
            if (packageJson?.name === 'lantern-bridge') {
                return candidate;
            }
        } catch {
        }
    }
    return path.join(extensionsRoot, 'lantern-bridge');
}

export async function init(router) {
    const dataRoot = path.resolve(globalThis.DATA_ROOT ?? path.join(process.cwd(), 'data'));
    const userDirectory = await resolveUserDirectory(dataRoot);
    const stateDirectory = path.join(dataRoot, 'lantern-bridge');
    await fsp.mkdir(stateDirectory, { recursive: true });

    const stdata = createStData({ dataRoot: userDirectory });
    const auth = createAuth({ stateDirectory });
    await auth.load();

    const extensionDirectory = await findExtensionDirectory(userDirectory);
    const updater = createUpdater({
        currentVersion: await readPluginVersion(),
        stateDirectory,
        pluginDirectory: PLUGIN_DIRECTORY,
        extensionDirectory,
    });
    let pluginVersion = updater.currentVersion();
    const pendingRestart = await updater.restartRequired();
    if (pendingRestart?.version === pluginVersion) {
        await updater.clearRestart();
    }
    const activeDevices = new Map();

    const host = createHostBridge();
    const jobs = createJobStore({ stateDirectory, agent: host });
    await jobs.load();

    let stVersion = 'unknown';
    try {
        const packageJson = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
        stVersion = packageJson.version ?? 'unknown';
    } catch {
    }
    const stPort = await readStPort();

    host.bind({
        onJobEvent: message => handleJobEvent(jobs, message),
        onReady: () => {
            void reconcileJobs(host, jobs);
        },
        onLost: () => {
            jobs.hostLost();
        },
    });

    try {
        await host.start();
    } catch (error) {
        logError('Could not start the loopback browser bridge. Reads will still work, generation will not.', error);
    }

    router.use(express.json({ limit: '12mb' }));
    router.use((request, response, next) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });

    const wrap = handler => async (request, response, next) => {
        try {
            await handler(request, response);
        } catch (error) {
            next(error);
        }
    };

    function requireDevice(request) {
        request.device = auth.authenticate(request);
        activeDevices.set(request.device.id, Date.now());
        return request.device;
    }

    function connectedDevice() {
        const now = Date.now();
        for (const [id, seen] of activeDevices) {
            if (now - seen > ACTIVE_DEVICE_WINDOW_MS) {
                activeDevices.delete(id);
            }
        }
        let best = null;
        for (const device of auth.listDevices()) {
            const seen = activeDevices.get(device.id);
            if (!seen) {
                continue;
            }
            if (!best || seen > activeDevices.get(best.id)) {
                best = { ...device, connectedAt: new Date(seen).toISOString() };
            }
        }
        return best;
    }

    function requireLocalUi(request) {
        if (!isSameOriginRequest(request) && !isLoopback(clientAddress(request))) {
            throw new ApiError(403, 'local_only', 'This endpoint is only available to the SillyTavern UI on the PC.');
        }
    }

    router.get('/ping', wrap(async (_request, response) => {
        sendJson(response, 200, {
            ok: true,
            plugin: { id: info.id, version: pluginVersion },
            st: { version: stVersion },
            protocol: 1,
            time: nowIso(),
        });
    }));

    router.get('/admin/summary', wrap(async (request, response) => {
        requireLocalUi(request);
        const pairing = await auth.currentPairing();
        sendJson(response, 200, {
            plugin: { id: info.id, version: pluginVersion },
            st: { version: stVersion },
            pairing: {
                code: pairing.code,
                expiresAt: new Date(pairing.createdAt + 10 * 60 * 1000).toISOString(),
            },
            connectedDevice: connectedDevice(),
            connection: connectionInfo(stPort),
            devices: auth.listDevices().length,
            host: host.state(),
            user: path.basename(userDirectory),
        });
    }));

    router.post('/admin/pairing/rotate', wrap(async (request, response) => {
        requireLocalUi(request);
        const pairing = await auth.rotatePairing();
        sendJson(response, 200, {
            code: pairing.code,
            expiresAt: new Date(pairing.createdAt + 10 * 60 * 1000).toISOString(),
        });
    }));

    router.post('/admin/devices/unpair', wrap(async (request, response) => {
        requireLocalUi(request);
        const requestedId = optionalString(request.body?.id, 'id', { min: 1, max: 100 });
        const targetId = requestedId ?? connectedDevice()?.id ?? null;
        if (!targetId) {
            throw new ApiError(404, 'no_connected_device', 'No device is currently connected.');
        }
        const removed = await auth.unpair(targetId);
        activeDevices.delete(targetId);
        sendJson(response, 200, { unpaired: true, id: targetId, removed });
    }));

    router.get('/admin/update/check', wrap(async (request, response) => {
        requireLocalUi(request);
        sendJson(response, 200, await updater.check());
    }));

    router.post('/admin/update/install', wrap(async (request, response) => {
        requireLocalUi(request);
        const result = await updater.install();
        pluginVersion = result.installedVersion;
        sendJson(response, 200, result);
    }));

    router.get('/host', wrap(async (request, response) => {
        requireLocalUi(request);
        sendJson(response, 200, host.getConfig());
    }));

    router.post('/pair', wrap(async (request, response) => {
        const code = requireString(request.body?.code, 'code', { min: 6, max: 6 });
        const deviceName = requireString(request.body?.deviceName, 'deviceName', { min: 1, max: 64 });
        const result = await auth.pair(request, { code, deviceName });
        logInfo(`Paired Android device "${result.device.name}"`);
        sendJson(response, 200, {
            token: result.token,
            device: publicDevice(result.device),
            server: { pluginVersion: pluginVersion, stVersion, user: path.basename(userDirectory) },
        });
    }));

    router.use((request, _response, next) => {
        try {
            requireDevice(request);
            next();
        } catch (error) {
            next(error);
        }
    });

    router.get('/state', wrap(async (_request, response) => {
        const snapshot = await stdata.snapshot();
        sendJson(response, 200, {
            ...snapshot,
            plugin: { id: info.id, version: pluginVersion },
            st: { version: stVersion },
            host: host.state(),
            devices: auth.listDevices().length,
            activeJobs: jobs.listActive(),
        });
    }));

    router.get('/characters', wrap(async (_request, response) => {
        const characters = await stdata.listCharacters();
        sendJson(response, 200, {
            characters: characters.map(character => ({
                ...character,
                avatarUrl: `/api/plugins/${info.id}/characters/${encodeURIComponent(character.avatar)}/avatar`,
            })),
        });
    }));

    router.post('/characters', wrap(async (request, response) => {
        const name = requireString(request.body?.name, 'name', { min: 1, max: 120 }).trim();
        const payload = {
            name,
            description: optionalString(request.body?.description, 'description', { max: 12000 }) ?? '',
            personality: optionalString(request.body?.personality, 'personality', { max: 12000 }) ?? '',
            scenario: optionalString(request.body?.scenario, 'scenario', { max: 12000 }) ?? '',
            firstMessage: optionalString(request.body?.firstMessage, 'firstMessage', { max: 12000 }) ?? '',
            exampleMessages: optionalString(request.body?.exampleMessages, 'exampleMessages', { max: 20000 }) ?? '',
            creatorNotes: optionalString(request.body?.creatorNotes, 'creatorNotes', { max: 12000 }) ?? '',
            systemPrompt: optionalString(request.body?.systemPrompt, 'systemPrompt', { max: 12000 }) ?? '',
            postHistoryInstructions: optionalString(request.body?.postHistoryInstructions, 'postHistoryInstructions', { max: 12000 }) ?? '',
            tags: Array.isArray(request.body?.tags)
                ? request.body.tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()).slice(0, 40)
                : [],
            avatarPng: optionalString(request.body?.avatarPng, 'avatarPng', { max: 12000000 }),
        };
        const result = await host.sendCommand('character.create', payload, 120000);
        sendJson(response, 201, {
            avatar: safeAvatar(result?.avatar),
            name: typeof result?.name === 'string' && result.name.trim() ? result.name.trim() : name,
        });
    }));

    router.post('/tools/draft-character', wrap(async (request, response) => {
        const prompt = requireString(request.body?.prompt, 'prompt', { min: 1, max: 12000 }).trim();
        const card = await host.sendCommand('character.draft', { prompt }, 180000);
        sendJson(response, 200, { card: normalizedCard(card) });
    }));

    router.post('/tools/scrape-character', wrap(async (request, response) => {
        const url = requireString(request.body?.url, 'url', { min: 1, max: 2048 }).trim();
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new ApiError(400, 'invalid_url', 'Enter a full http or https link.');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new ApiError(400, 'invalid_url', 'Enter a full http or https link.');
        }
        const result = await host.sendCommand('character.scrape', { url }, 120000);
        const avatar = safeAvatar(result?.avatar);
        const character = await stdata.getCharacter(avatar);
        sendJson(response, 201, { avatar, name: character.name });
    }));

    const mediaDirectory = path.join(stateDirectory, 'media');
    await fsp.mkdir(mediaDirectory, { recursive: true });

    router.post('/tools/download-media', wrap(async (request, response) => {
        const url = requireString(request.body?.url, 'url', { min: 1, max: 2048 }).trim();
        const kind = requireString(request.body?.kind, 'kind', { min: 3, max: 4 });
        if (!isYoutubeUrl(url)) {
            throw new ApiError(400, 'invalid_url', 'Paste a YouTube video link.');
        }
        if (kind !== 'mp3' && kind !== 'mp4') {
            throw new ApiError(400, 'invalid_format', 'Choose MP3 or MP4.');
        }
        sendJson(response, 201, await downloadYoutubeMedia(url, kind, mediaDirectory));
    }));

    router.get('/tools/media/:id', wrap(async (request, response) => {
        const id = safeMediaId(request.params.id);
        const recordPath = path.join(mediaDirectory, `${id}.json`);
        const record = await fsp.readFile(recordPath, 'utf8')
            .then(value => JSON.parse(value))
            .catch(() => null);
        if (!record || (record.kind !== 'mp3' && record.kind !== 'mp4')) {
            throw new ApiError(404, 'media_not_found', 'That download is no longer on the PC.');
        }
        const filePath = path.join(mediaDirectory, `${id}.${record.kind}`);
        const stats = await fsp.stat(filePath).catch(() => null);
        if (!stats) {
            throw new ApiError(404, 'media_not_found', 'That download is no longer on the PC.');
        }
        response.setHeader('Content-Type', record.kind === 'mp3' ? 'audio/mpeg' : 'video/mp4');
        response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.fileName)}"`);
        response.setHeader('Content-Length', stats.size);
        createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
    }));

    router.delete('/tools/media/:id', wrap(async (request, response) => {
        const id = safeMediaId(request.params.id);
        await Promise.all([
            fsp.rm(path.join(mediaDirectory, `${id}.mp3`), { force: true }),
            fsp.rm(path.join(mediaDirectory, `${id}.mp4`), { force: true }),
            fsp.rm(path.join(mediaDirectory, `${id}.json`), { force: true }),
        ]);
        sendJson(response, 200, { deleted: true, id });
    }));

    router.get('/characters/:avatar/avatar', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const full = request.query.full === '1';
        const served = await serveAvatar({ userDirectory, avatar, full, response });
        if (!served) {
            throw new ApiError(404, 'avatar_not_found', 'This character has no avatar image.');
        }
    }));

    router.get('/characters/:avatar', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const character = await stdata.getCharacter(avatar);
        sendJson(response, 200, {
            ...character,
            avatarUrl: `/api/plugins/${info.id}/characters/${encodeURIComponent(avatar)}/avatar`,
        });
    }));

    router.delete('/characters/:avatar', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        await host.sendCommand('character.delete', { avatar }, 45000);
        sendJson(response, 200, { deleted: true, avatar });
    }));

    router.patch('/characters/:avatar', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const updates = validateCharacterUpdates(request.body);
        await host.sendCommand('character.update', { avatar, ...updates }, 45000);
        sendJson(response, 200, { updated: true, avatar });
    }));

    router.get('/characters/:avatar/chats', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const chats = await stdata.listChats(avatar);
        sendJson(response, 200, { chats });
    }));

    router.post('/characters/:avatar/chats', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const result = await host.sendCommand('chat.create', { avatar }, 45000);
        const chatFile = safeChatFile(result?.chatFile);
        const revision = await stdata.chatRevision(avatar, chatFile);
        sendJson(response, 201, { chatFile, revision: revision.revision });
    }));

    router.patch('/characters/:avatar/chats/:file', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        const name = requireString(request.body?.name, 'name', { min: 1, max: 120 });
        const result = await host.sendCommand('chat.rename', { avatar, chatFile: file, name }, 45000);
        sendJson(response, 200, { chatFile: safeChatFile(result?.chatFile), previous: file });
    }));

    router.post('/characters/:avatar/chats/:file/favorite', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        if (typeof request.body?.favorite !== 'boolean') {
            throw new ApiError(400, 'invalid_request', 'favorite must be true or false.');
        }
        const favorite = request.body.favorite;
        await host.sendCommand('chat.favorite', { avatar, chatFile: file, favorite }, 45000);
        sendJson(response, 200, { favorite, avatar, chatFile: file });
    }));

    router.delete('/characters/:avatar/chats/:file', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        await host.sendCommand('chat.delete', { avatar, chatFile: file }, 45000);
        sendJson(response, 200, { deleted: true, chatFile: file });
    }));

    router.get('/characters/:avatar/chats/:file', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        const chat = await stdata.readChat(avatar, file);
        sendJson(response, 200, chat);
    }));

    router.post('/characters/:avatar/chats/:file/jobs', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        const kind = requireString(request.body?.kind, 'kind', { min: 1, max: 20 });
        if (!['send', 'regenerate', 'continue', 'impersonate'].includes(kind)) {
            throw new ApiError(400, 'invalid_kind', 'kind must be send, regenerate, continue, or impersonate.');
        }
        const expectedRevision = optionalString(request.body?.expectedRevision, 'expectedRevision', { min: 1, max: 64 });
        if (expectedRevision) {
            const current = await stdata.chatRevision(avatar, file);
            if (current.revision !== expectedRevision) {
                throw new ApiError(409, 'chat_changed', 'This conversation changed on the PC. Refresh it before sending.', {
                    revision: current.revision,
                    messageCount: current.messageCount,
                });
            }
        }
        const text = kind === 'send'
            ? requireString(request.body?.text, 'text', { min: 1, max: 64000 })
            : null;
        const clientRequestId = optionalString(request.body?.clientRequestId, 'clientRequestId', { min: 1, max: 100 });
        const messageIndex = optionalInteger(request.body?.messageIndex, 'messageIndex', { min: 0, max: 1000000 });

        const result = await jobs.create({
            kind,
            character: avatar,
            chatFile: file,
            clientRequestId,
            expectedRevision,
            messageIndex,
            request: { text },
        });
        sendJson(response, result.duplicate ? 200 : 202, {
            job: jobs.publicJob(result.job),
            duplicate: result.duplicate,
        });
    }));

    router.get('/jobs', wrap(async (_request, response) => {
        sendJson(response, 200, { jobs: jobs.recent() });
    }));

    router.get('/jobs/:id', wrap(async (request, response) => {
        sendJson(response, 200, { job: jobs.publicJob(jobs.get(request.params.id)) });
    }));

    router.get('/jobs/:id/events', wrap(async (request, response) => {
        const after = parseAfter(request);
        const cleanup = jobs.subscribe(request.params.id, after, response);
        request.on('close', cleanup);
        response.on('close', cleanup);
    }));

    router.post('/jobs/:id/cancel', wrap(async (request, response) => {
        const job = jobs.cancel(request.params.id);
        sendJson(response, 200, { job });
    }));

    router.get('/chats/recent', wrap(async (request, response) => {
        const limit = request.query.limit === undefined
            ? 60
            : requireInteger(request.query.limit, 'limit', { min: 1, max: 200 });
        sendJson(response, 200, { chats: await stdata.listRecentChats(limit) });
    }));

    router.get('/active', wrap(async (request, response) => {
        const avatar = optionalString(request.query.character, 'character', { min: 1, max: 260 });
        const file = optionalString(request.query.chat, 'chat', { min: 1, max: 260 });
        const job = avatar && file ? jobs.activeGenerationFor(avatar, file) : jobs.listActive()[0] ?? null;
        sendJson(response, 200, { job });
    }));

    router.post('/characters/:avatar/chats/:file/messages/:index/edit', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        const index = requireInteger(request.params.index, 'index', { min: 0, max: 1000000 });
        const text = requireString(request.body?.text, 'text', { min: 0, max: 200000 });
        const result = await host.sendCommand('message.edit', { avatar, chatFile: file, index, text }, 45000);
        const revision = await stdata.chatRevision(avatar, file);
        sendJson(response, 200, { ...result, revision: revision.revision });
    }));

    router.delete('/characters/:avatar/chats/:file/messages/:index', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        const index = requireInteger(request.params.index, 'index', { min: 0, max: 1000000 });
        await host.sendCommand('message.delete', { avatar, chatFile: file, index }, 45000);
        const revision = await stdata.chatRevision(avatar, file);
        sendJson(response, 200, { deleted: true, revision: revision.revision });
    }));

    router.post('/characters/:avatar/chats/:file/messages/:index/swipe', wrap(async (request, response) => {
        const avatar = safeAvatar(request.params.avatar);
        const file = safeChatFile(request.params.file);
        const index = requireInteger(request.params.index, 'index', { min: 0, max: 1000000 });
        const direction = requireString(request.body?.direction, 'direction', { min: 4, max: 5 });
        if (direction !== 'left' && direction !== 'right') {
            throw new ApiError(400, 'invalid_direction', 'direction must be left or right.');
        }
        const result = await host.sendCommand('message.swipe', { avatar, chatFile: file, index, direction }, 45000);
        const revision = await stdata.chatRevision(avatar, file);
        sendJson(response, 200, { ...result, revision: revision.revision });
    }));

    router.get('/settings/generation', wrap(async (_request, response) => {
        const settings = await stdata.readSettings();
        const textgen = settings.textgenerationwebui_settings ?? {};
        const presets = await stdata.listPresets();
        sendJson(response, 200, {
            mainApi: settings.main_api ?? 'unknown',
            preset: textgen.preset ?? null,
            type: textgen.type ?? null,
            maxContext: Number(settings.max_context ?? 0),
            maxResponseLength: Number(settings.amount_gen ?? 0),
            settings: pickGenerationSettings(textgen),
            presets: presets.textgen ?? [],
        });
    }));

    router.patch('/settings/generation', wrap(async (request, response) => {
        const updates = request.body?.settings;
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            throw new ApiError(400, 'invalid_request', 'settings must be an object.');
        }
        const clean = validateGenerationUpdates(updates);
        if (Object.keys(clean).length === 0) {
            throw new ApiError(400, 'invalid_request', 'No supported settings were provided.');
        }
        const result = await host.sendCommand('settings.update', { settings: clean }, 30000);
        sendJson(response, 200, {
            settings: result?.settings ?? clean,
            applied: clean,
        });
    }));

    router.post('/presets/textgen/:name/select', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'preset');
        const result = await host.sendCommand('preset.select', { name }, 30000);
        sendJson(response, 200, { preset: result?.preset ?? name });
    }));

    router.get('/presets', wrap(async (_request, response) => {
        sendJson(response, 200, { presets: await stdata.listPresets() });
    }));

    router.get('/presets/:kind/:name', wrap(async (request, response) => {
        const kind = requireString(request.params.kind, 'kind', { min: 1, max: 20 });
        const name = safeName(request.params.name, 'preset');
        sendJson(response, 200, await stdata.readPreset(kind, name));
    }));

    router.get('/worlds', wrap(async (_request, response) => {
        sendJson(response, 200, { worlds: await stdata.listWorlds() });
    }));

    router.post('/worlds', wrap(async (request, response) => {
        const name = safeName(request.body?.name, 'name');
        await host.sendCommand('world.create', { name }, 30000);
        sendJson(response, 201, await stdata.readWorld(name));
    }));

    router.get('/worlds/:name', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'world');
        sendJson(response, 200, await stdata.readWorld(name));
    }));

    router.patch('/worlds/:name', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'world');
        const newName = safeName(request.body?.name, 'world');
        await host.sendCommand('world.rename', { name, newName }, 45000);
        sendJson(response, 200, { name: newName });
    }));

    router.delete('/worlds/:name', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'world');
        await host.sendCommand('world.delete', { name }, 45000);
        sendJson(response, 200, { deleted: true, name });
    }));

    router.post('/worlds/:name/entries', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'world');
        const entry = validateWorldEntry(request.body?.entry);
        const result = await host.sendCommand('world.entry.save', { name, uid: null, entry }, 45000);
        const world = await stdata.readWorld(name);
        sendJson(response, 201, { uid: result?.uid ?? null, world });
    }));

    router.put('/worlds/:name/entries/:uid', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'world');
        const uid = requireInteger(request.params.uid, 'uid', { min: 0, max: 1000000 });
        const entry = validateWorldEntry(request.body?.entry);
        const result = await host.sendCommand('world.entry.save', { name, uid, entry }, 45000);
        const world = await stdata.readWorld(name);
        sendJson(response, 200, { uid: result?.uid ?? uid, world });
    }));

    router.delete('/worlds/:name/entries/:uid', wrap(async (request, response) => {
        const name = safeName(request.params.name, 'world');
        const uid = requireInteger(request.params.uid, 'uid', { min: 0, max: 1000000 });
        await host.sendCommand('world.entry.delete', { name, uid }, 45000);
        sendJson(response, 200, { deleted: true, world: await stdata.readWorld(name) });
    }));

    router.get('/devices', wrap(async (_request, response) => {
        sendJson(response, 200, { devices: auth.listDevices() });
    }));

    router.delete('/devices/:id', wrap(async (request, response) => {
        const id = requireString(request.params.id, 'id', { min: 1, max: 100 });
        await auth.revoke(id);
        sendJson(response, 200, { revoked: true });
    }));

    router.get('/diagnostics', wrap(async (_request, response) => {
        sendJson(response, 200, {
            plugin: { id: info.id, version: pluginVersion, uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) },
            st: { version: stVersion },
            node: process.version,
            platform: process.platform,
            host: host.state(),
            data: {
                root: dataRoot,
                user: userDirectory,
                characters: (await stdata.listCharacters()).length,
                worlds: (await stdata.listWorlds()).length,
            },
            devices: auth.listDevices(),
            jobs: jobs.recent(),
            time: nowIso(),
        });
    }));

    router.use((error, _request, response, _next) => {
        if (error instanceof ApiError) {
            sendJson(response, error.status, {
                error: {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                },
            });
            return;
        }
        logError('Unhandled API error', error);
        sendJson(response, 500, {
            error: {
                code: 'internal_error',
                message: 'The Lantern bridge hit an unexpected error. Check the SillyTavern console.',
            },
        });
    });

    logInfo(`Ready for ${path.basename(userDirectory)}. Pairing code is shown in the Lantern Bridge extension panel.`);
}

export async function exit() {
}

async function readPluginVersion() {
    try {
        const packageJson = JSON.parse(await fsp.readFile(path.join(PLUGIN_DIRECTORY, 'package.json'), 'utf8'));
        return packageJson.version ?? PLUGIN_VERSION;
    } catch {
        return PLUGIN_VERSION;
    }
}

async function readStPort() {
    const environmentPort = Number(process.env.PORT);
    if (Number.isInteger(environmentPort) && environmentPort > 0 && environmentPort <= 65535) {
        return environmentPort;
    }
    try {
        const config = await fsp.readFile(path.join(process.cwd(), 'config.yaml'), 'utf8');
        const match = /^port:\s*(\d{2,5})\s*$/m.exec(config);
        const configured = Number(match?.[1]);
        if (Number.isInteger(configured) && configured > 0 && configured <= 65535) {
            return configured;
        }
    } catch {
    }
    return 8000;
}

function isTailscaleAddress(address) {
    const parts = String(address).split('.').map(Number);
    return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isPrivateAddress(address) {
    const parts = String(address).split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
        return false;
    }
    if (parts[0] === 10) {
        return true;
    }
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
        return true;
    }
    return parts[0] === 192 && parts[1] === 168;
}

function connectionInfo(port) {
    const lan = [];
    const tailscale = [];
    const seen = new Set();
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) {
                continue;
            }
            const address = entry.address;
            if (seen.has(address)) {
                continue;
            }
            seen.add(address);
            if (isTailscaleAddress(address)) {
                tailscale.push(address);
            } else if (isPrivateAddress(address)) {
                lan.push(address);
            }
        }
    }
    const lanRank = address => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2;
    lan.sort((left, right) => lanRank(left) - lanRank(right) || left.localeCompare(right));
    tailscale.sort((left, right) => left.localeCompare(right));
    const addresses = [...lan, ...tailscale].map(address => ({
        address,
        value: `${address}:${port}`,
        kind: isTailscaleAddress(address) ? 'tailscale' : 'lan',
    }));
    return {
        port,
        primary: addresses[0]?.value ?? null,
        addresses,
    };
}

function publicDevice(device) {
    return {
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        address: device.address,
    };
}

function safeAvatar(value) {
    const avatar = String(value ?? '');
    if (!avatar || path.basename(avatar) !== avatar) {
        throw new ApiError(400, 'invalid_avatar', 'Invalid character identifier.');
    }
    return avatar;
}

function safeChatFile(value) {
    const file = String(value ?? '');
    if (!file.endsWith('.jsonl') || path.basename(file) !== file) {
        throw new ApiError(400, 'invalid_chat', 'Invalid conversation identifier.');
    }
    return file;
}

function safeName(value, field) {
    const name = String(value ?? '').trim();
    if (!name || name.length > 120 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
        throw new ApiError(400, 'invalid_name', `Invalid ${field} name.`);
    }
    return name;
}

function parseAfter(request) {
    const raw = request.query.after ?? request.headers['last-event-id'];
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

async function resolveUserDirectory(dataRoot) {
    const explicit = process.env.LANTERN_ST_USER;
    if (explicit) {
        const candidate = path.isAbsolute(explicit) ? explicit : path.join(dataRoot, explicit);
        if (await exists(path.join(candidate, 'settings.json'))) {
            return candidate;
        }
        throw new Error(`LANTERN_ST_USER does not point at a SillyTavern user directory: ${candidate}`);
    }
    const preferred = path.join(dataRoot, 'default-user');
    if (await exists(path.join(preferred, 'settings.json'))) {
        return preferred;
    }
    const entries = await fsp.readdir(dataRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) {
            continue;
        }
        const candidate = path.join(dataRoot, entry.name);
        if (await exists(path.join(candidate, 'settings.json'))) {
            return candidate;
        }
    }
    throw new Error(`No SillyTavern user directory with settings.json was found under ${dataRoot}`);
}

async function exists(file) {
    try {
        await fsp.access(file);
        return true;
    } catch {
        return false;
    }
}

async function serveAvatar({ userDirectory, avatar, full, response }) {
    const charactersDirectory = path.join(userDirectory, 'characters');
    const original = path.join(charactersDirectory, avatar);
    if (!(await exists(original))) {
        return false;
    }
    let file = original;
    if (!full && avatar.toLowerCase().endsWith('.png')) {
        const thumbnail = path.join(userDirectory, 'thumbnails', 'avatar', avatar);
        if (await exists(thumbnail)) {
            file = thumbnail;
        }
    }
    const buffer = await fsp.readFile(file);
    const contentType = detectImageType(buffer);
    if (!contentType) {
        return false;
    }
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.setHeader('Content-Length', String(buffer.length));
    response.end(buffer);
    return true;
}

function detectImageType(buffer) {
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return 'image/png';
    }
    if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

function pickGenerationSettings(textgen) {
    const picked = {};
    for (const key of Object.keys(GENERATION_FIELDS)) {
        if (textgen[key] !== undefined) {
            picked[key] = textgen[key];
        }
    }
    return picked;
}

function validateGenerationUpdates(updates) {
    const clean = {};
    for (const [key, value] of Object.entries(updates)) {
        const rule = GENERATION_FIELDS[key];
        if (!rule) {
            throw new ApiError(400, 'unsupported_setting', `Setting "${key}" is not editable from Lantern.`);
        }
        if (rule.boolean) {
            if (typeof value !== 'boolean') {
                throw new ApiError(400, 'invalid_setting', `${key} must be true or false.`);
            }
            clean[key] = value;
            continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new ApiError(400, 'invalid_setting', `${key} must be a number.`);
        }
        if (rule.integer && !Number.isInteger(value)) {
            throw new ApiError(400, 'invalid_setting', `${key} must be a whole number.`);
        }
        if (value < rule.min || value > rule.max) {
            throw new ApiError(400, 'invalid_setting', `${key} must be between ${rule.min} and ${rule.max}.`);
        }
        clean[key] = value;
    }
    return clean;
}

function validateCharacterUpdates(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'invalid_request', 'Character updates must be an object.');
    }
    const clean = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'favorite') {
            if (typeof value !== 'boolean') {
                throw new ApiError(400, 'invalid_character', 'favorite must be true or false.');
            }
            clean[key] = value;
            continue;
        }
        if (key === 'name') {
            clean[key] = requireString(value, 'name', { min: 1, max: 200 });
            continue;
        }
        if (CHARACTER_TEXT_FIELDS.includes(key)) {
            clean[key] = requireString(value, key, { min: 0, max: 200000 });
            continue;
        }
        if (CHARACTER_LIST_FIELDS.includes(key)) {
            if (!Array.isArray(value) || value.length > 200
                || value.some(item => typeof item !== 'string' || item.length > 500)) {
                throw new ApiError(400, 'invalid_character', `${key} must be an array of at most 200 strings of at most 500 characters.`);
            }
            clean[key] = value;
            continue;
        }
        throw new ApiError(400, 'unsupported_field', `Character field "${key}" is not editable from Lantern.`);
    }
    if (Object.keys(clean).length === 0) {
        throw new ApiError(400, 'invalid_request', 'No supported character fields were provided.');
    }
    return clean;
}

function validateWorldEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ApiError(400, 'invalid_entry', 'entry must be an object.');
    }
    const clean = {};
    for (const field of WORLD_ENTRY_FIELDS) {
        if (entry[field] !== undefined) {
            clean[field] = entry[field];
        }
    }
    if (clean.key !== undefined) {
        if (!Array.isArray(clean.key) || clean.key.some(key => typeof key !== 'string')) {
            throw new ApiError(400, 'invalid_entry', 'key must be an array of strings.');
        }
        clean.key = clean.key.map(key => key.trim()).filter(Boolean);
    }
    if (clean.keysecondary !== undefined) {
        if (!Array.isArray(clean.keysecondary) || clean.keysecondary.some(key => typeof key !== 'string')) {
            throw new ApiError(400, 'invalid_entry', 'keysecondary must be an array of strings.');
        }
        clean.keysecondary = clean.keysecondary.map(key => key.trim()).filter(Boolean);
    }
    if (clean.content !== undefined && (typeof clean.content !== 'string' || clean.content.length > 100000)) {
        throw new ApiError(400, 'invalid_entry', 'content must be a string under 100000 characters.');
    }
    if (clean.comment !== undefined && (typeof clean.comment !== 'string' || clean.comment.length > 500)) {
        throw new ApiError(400, 'invalid_entry', 'comment must be a short string.');
    }
    if (clean.order !== undefined && (!Number.isInteger(clean.order) || clean.order < -100000 || clean.order > 100000)) {
        throw new ApiError(400, 'invalid_entry', 'order must be an integer.');
    }
    if (clean.depth !== undefined && (!Number.isInteger(clean.depth) || clean.depth < 0 || clean.depth > 10000)) {
        throw new ApiError(400, 'invalid_entry', 'depth must be a non-negative integer.');
    }
    if (clean.probability !== undefined && (!Number.isInteger(clean.probability) || clean.probability < 0 || clean.probability > 100)) {
        throw new ApiError(400, 'invalid_entry', 'probability must be between 0 and 100.');
    }
    return clean;
}

async function handleJobEvent(jobs, message) {
    const jobId = typeof message.jobId === 'string' ? message.jobId : null;
    if (!jobId) {
        return;
    }
    try {
        switch (message.event) {
            case 'start':
                jobs.start(jobId);
                break;
            case 'token':
                jobs.append(jobId, String(message.text ?? ''));
                break;
            case 'sync':
                jobs.sync(jobId, String(message.text ?? ''));
                break;
            case 'done': {
                const job = jobs.get(jobId);
                if (job.cancelRequested) {
                    if (typeof message.text === 'string') {
                        jobs.sync(jobId, message.text);
                    }
                    jobs.markCanceled(jobId);
                    break;
                }
                jobs.complete(jobId, {
                    messageIndex: message.messageIndex,
                    text: message.text,
                    swipes: message.swipes,
                    swipeId: message.swipeId,
                });
                break;
            }
            case 'error':
                jobs.fail(jobId, message.error?.code ?? 'generation_failed', message.error?.message ?? 'Generation failed in SillyTavern.');
                break;
            case 'canceled':
                jobs.markCanceled(jobId);
                break;
            default:
                break;
        }
    } catch (error) {
        logError('Could not apply a job event from the browser', error);
    }
}

async function reconcileJobs(host, jobs) {
    const activeJobs = jobs.listActive();
    if (activeJobs.length === 0) {
        return;
    }
    let result;
    try {
        result = await host.sendCommand('generation.reconcile', {
            jobs: activeJobs.map(job => ({
                jobId: job.id,
                avatar: job.character,
                chatFile: job.chatFile,
                kind: job.kind,
                status: job.status,
            })),
        }, 15000);
    } catch (error) {
        logError('Could not reconcile jobs with the browser', error);
        return;
    }

    const browserJobs = new Map((result?.active ?? []).map(job => [job.jobId, job]));
    for (const job of activeJobs) {
        const browserJob = browserJobs.get(job.id);
        if (!browserJob) {
            if (job.status === 'queued') {
                try {
                    await host.dispatch(job);
                } catch (error) {
                    jobs.fail(job.id, error.code ?? 'host_error', error.message);
                }
            } else {
                jobs.fail(job.id, 'host_lost', 'The SillyTavern tab lost this generation. The response may be incomplete.');
            }
            continue;
        }
        if (typeof browserJob.text === 'string') {
            jobs.sync(job.id, browserJob.text);
        }
        if (browserJob.status === 'done') {
            jobs.complete(job.id, {
                messageIndex: browserJob.messageIndex,
                text: browserJob.text,
                swipes: browserJob.swipes,
                swipeId: browserJob.swipeId,
            });
        } else if (browserJob.status === 'error') {
            jobs.fail(job.id, browserJob.error?.code ?? 'generation_failed', browserJob.error?.message ?? 'Generation failed.');
        } else if (browserJob.status === 'canceled') {
            jobs.markCanceled(job.id);
        } else {
            jobs.start(job.id);
        }
    }
    jobs.hostReady();
    for (const job of jobs.listActive()) {
        if (job.status === 'queued') {
            try {
                await host.dispatch(job);
            } catch (error) {
                jobs.fail(job.id, error.code ?? 'host_error', error.message);
            }
        }
    }
}
