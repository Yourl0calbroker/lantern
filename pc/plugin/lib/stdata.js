import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readCardFromPng } from './png.js';
import { ApiError } from './util.js';

const MAX_PREVIEW_LENGTH = 160;

function sanitizeName(value) {
    return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim() || 'Character';
}

function parseChatLines(text) {
    return text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function toMessage(entry, index) {
    const swipes = Array.isArray(entry.swipes) ? entry.swipes.map(String) : [];
    const swipeId = Number.isInteger(entry.swipe_id) ? entry.swipe_id : 0;
    const text = typeof entry.mes === 'string' ? entry.mes : '';
    return {
        index,
        name: typeof entry.name === 'string' ? entry.name : '',
        isUser: entry.is_user === true,
        isSystem: entry.is_system === true,
        text,
        sendDate: typeof entry.send_date === 'string' ? entry.send_date : null,
        swipes: swipes.length > 0 ? swipes : [text],
        swipeId: swipes.length > 0 ? Math.min(Math.max(swipeId, 0), swipes.length - 1) : 0,
        extra: entry.extra && typeof entry.extra === 'object' ? entry.extra : {},
    };
}

export function createStData({ dataRoot }) {
    const charactersDirectory = path.join(dataRoot, 'characters');
    const chatsDirectory = path.join(dataRoot, 'chats');
    const worldsDirectory = path.join(dataRoot, 'worlds');
    const settingsFile = path.join(dataRoot, 'settings.json');
    const presetDirectories = {
        textgen: path.join(dataRoot, 'TextGen Settings'),
        kobold: path.join(dataRoot, 'KoboldAI Settings'),
        openai: path.join(dataRoot, 'OpenAI Settings'),
    };

    const characterCache = new Map();
    let settingsCache = { stamp: 0, value: null };

    async function statStamp(file) {
        try {
            const stat = await fsp.stat(file);
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return null;
        }
    }

    async function readSettings() {
        const stamp = await statStamp(settingsFile);
        if (stamp && settingsCache.value && settingsCache.stamp === stamp) {
            return settingsCache.value;
        }
        try {
            const parsed = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
            settingsCache = { stamp: stamp ?? 0, value: parsed };
            return parsed;
        } catch {
            return settingsCache.value ?? {};
        }
    }

    async function loadCard(file, avatar) {
        const stamp = await statStamp(file);
        const cached = characterCache.get(avatar);
        if (cached && stamp && cached.stamp === stamp) {
            return cached.card;
        }
        let card = null;
        if (file.endsWith('.png')) {
            card = await readCardFromPng(file);
        } else if (file.endsWith('.json')) {
            try {
                card = JSON.parse(await fsp.readFile(file, 'utf8'));
            } catch {
                card = null;
            }
        }
        const payload = card && typeof card === 'object'
            ? (card.data && typeof card.data === 'object' ? card : { spec: 'unknown', data: card })
            : null;
        if (stamp) {
            characterCache.set(avatar, { stamp, card: payload });
        }
        return payload;
    }

    async function listCharacters() {
        const entries = await fsp.readdir(charactersDirectory, { withFileTypes: true });
        const files = entries
            .filter(entry => entry.isFile() && (entry.name.endsWith('.png') || entry.name.endsWith('.json')))
            .map(entry => entry.name);

        const characters = [];
        for (const avatar of files) {
            const card = await loadCard(path.join(charactersDirectory, avatar), avatar);
            const data = card?.data ?? {};
            characters.push({
                avatar,
                name: typeof data.name === 'string' && data.name.trim() ? data.name : avatar.replace(/\.(png|json)$/i, ''),
                creator: typeof data.creator === 'string' ? data.creator : '',
                tags: Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : [],
                favorite: data.fav === true || data.favorite === true,
                chatCount: 0,
            });
        }

        const chatCounts = await countChatsByFolder();
        const countsByLower = new Map(
            [...chatCounts].map(([folder, count]) => [folder.toLowerCase(), count]),
        );
        for (const character of characters) {
            const avatarName = character.avatar.replace(/\.(png|json)$/i, '');
            character.chatCount = 0;
            for (const candidate of [character.name, avatarName]) {
                const key = sanitizeName(candidate);
                if (chatCounts.has(key)) {
                    character.chatCount = chatCounts.get(key);
                    break;
                }
                const insensitive = countsByLower.get(key.toLowerCase());
                if (insensitive !== undefined) {
                    character.chatCount = insensitive;
                    break;
                }
            }
        }

        characters.sort((left, right) => left.name.localeCompare(right.name));
        return characters;
    }

    async function countChatsByFolder() {
        const counts = new Map();
        let folders = [];
        try {
            folders = await fsp.readdir(chatsDirectory, { withFileTypes: true });
        } catch {
            return counts;
        }
        for (const folder of folders) {
            if (!folder.isDirectory()) {
                continue;
            }
            try {
                const files = await fsp.readdir(path.join(chatsDirectory, folder.name));
                counts.set(folder.name, files.filter(file => file.endsWith('.jsonl')).length);
            } catch {
                counts.set(folder.name, 0);
            }
        }
        return counts;
    }

    async function resolveCharacterFile(avatar) {
        const safe = path.basename(avatar);
        if (safe !== avatar) {
            throw new ApiError(400, 'invalid_avatar', 'Invalid character identifier.');
        }
        const directoryEntries = await fsp.readdir(charactersDirectory);
        if (!directoryEntries.includes(safe)) {
            throw new ApiError(404, 'character_not_found', 'Character not found on the PC.');
        }
        return path.join(charactersDirectory, safe);
    }

    async function getCharacter(avatar) {
        const file = await resolveCharacterFile(avatar);
        const card = await loadCard(file, avatar);
        const data = card?.data ?? {};
        return {
            avatar,
            spec: typeof card?.spec === 'string' ? card.spec : 'unknown',
            name: typeof data.name === 'string' ? data.name : avatar.replace(/\.(png|json)$/i, ''),
            description: data.description ?? '',
            personality: data.personality ?? '',
            scenario: data.scenario ?? '',
            firstMessage: data.first_mes ?? '',
            exampleMessages: data.mes_example ?? '',
            creatorNotes: data.creator_notes ?? '',
            systemPrompt: data.system_prompt ?? '',
            postHistoryInstructions: data.post_history_instructions ?? '',
            creator: data.creator ?? '',
            characterVersion: data.character_version ?? '',
            tags: Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : [],
            alternateGreetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.filter(item => typeof item === 'string') : [],
            embeddedLorebook: data.character_book?.entries?.length ?? 0,
            chatFolder: sanitizeName(typeof data.name === 'string' && data.name.trim() ? data.name : avatar),
        };
    }

    async function resolveChatFolder(characterName) {
        const candidate = sanitizeName(characterName);
        let folders = [];
        try {
            folders = await fsp.readdir(chatsDirectory, { withFileTypes: true });
        } catch {
            return null;
        }
        const exact = folders.find(folder => folder.isDirectory() && folder.name === candidate);
        if (exact) {
            return path.join(chatsDirectory, exact.name);
        }
        const insensitive = folders.find(folder => folder.isDirectory() && folder.name.toLowerCase() === candidate.toLowerCase());
        return insensitive ? path.join(chatsDirectory, insensitive.name) : null;
    }

    async function listChats(avatar) {
        const character = await getCharacter(avatar);
        const folder = await resolveChatFolder(character.name);
        if (!folder) {
            return [];
        }
        const files = (await fsp.readdir(folder)).filter(file => file.endsWith('.jsonl'));
        const chats = [];
        for (const file of files) {
            const fullPath = path.join(folder, file);
            const stat = await fsp.stat(fullPath);
            let messageCount = 0;
            let preview = '';
            let lastDate = null;
            let favorite = false;
            try {
                const entries = parseChatLines(await fsp.readFile(fullPath, 'utf8'));
                const header = entries[0] && !('mes' in entries[0]) ? entries[0] : null;
                favorite = header?.chat_metadata?.favorite === true || header?.chat_metadata?.fav === true;
                const messages = entries.slice(1);
                messageCount = messages.length;
                const lastText = [...messages].reverse().find(entry => typeof entry.mes === 'string' && entry.mes.trim());
                preview = lastText ? lastText.mes.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW_LENGTH) : '';
                lastDate = typeof messages.at(-1)?.send_date === 'string' ? messages.at(-1).send_date : null;
            } catch {
                preview = '';
            }
            const rawTitle = file.replace(/\.jsonl$/i, '');
            const dated = /^(.*?)\s+-\s+(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d{3})ms$/i.exec(rawTitle);
            chats.push({
                file,
                title: dated ? dated[1] : rawTitle,
                chatDate: dated ? `${dated[2]}-${dated[3]}-${dated[4]} ${dated[5]}:${dated[6]}` : null,
                updatedAt: stat.mtime.toISOString(),
                createdAt: stat.birthtime.toISOString(),
                messageCount,
                preview,
                lastMessageAt: lastDate,
                favorite,
            });
        }

        chats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return chats;
    }

    async function resolveChatPath(avatar, file) {
        const character = await getCharacter(avatar);
        const folder = await resolveChatFolder(character.name);
        const safeFile = path.basename(file);
        if (!folder || safeFile !== file || !safeFile.endsWith('.jsonl')) {
            throw new ApiError(404, 'chat_not_found', 'Conversation not found on the PC.');
        }
        const fullPath = path.join(folder, safeFile);
        try {
            await fsp.access(fullPath);
        } catch {
            throw new ApiError(404, 'chat_not_found', 'Conversation not found on the PC.');
        }
        return { character, folder, fullPath };
    }

    async function readChat(avatar, file) {
        const { fullPath } = await resolveChatPath(avatar, file);
        const content = await fsp.readFile(fullPath, 'utf8');
        const entries = parseChatLines(content);
        const header = entries[0] && !('mes' in entries[0]) ? entries[0] : null;
        const rawMessages = header ? entries.slice(1) : entries;
        const messages = rawMessages.map((entry, index) => toMessage(entry, index));
        return {
            messages,
            total: messages.length,
            revision: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
            metadata: header?.chat_metadata ?? {},
        };
    }

    async function chatRevision(avatar, file) {
        const { fullPath } = await resolveChatPath(avatar, file);
        const content = await fsp.readFile(fullPath, 'utf8');
        const count = parseChatLines(content).filter(entry => 'mes' in entry).length;
        return { revision: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16), messageCount: count };
    }

    async function listRecentChats(limit = 60) {
        const characters = await listCharacters();
        const byFolder = new Map();
        for (const character of characters) {
            byFolder.set(sanitizeName(character.name).toLowerCase(), character);
        }

        let folders = [];
        try {
            folders = await fsp.readdir(chatsDirectory, { withFileTypes: true });
        } catch {
            return [];
        }

        const candidates = [];
        for (const folder of folders) {
            if (!folder.isDirectory()) continue;
            const character = byFolder.get(folder.name.toLowerCase());
            if (!character) continue;
            let files = [];
            try {
                files = await fsp.readdir(path.join(chatsDirectory, folder.name));
            } catch {
                continue;
            }
            for (const file of files) {
                if (!file.endsWith('.jsonl')) continue;
                const fullPath = path.join(chatsDirectory, folder.name, file);
                try {
                    const stat = await fsp.stat(fullPath);
                    candidates.push({
                        avatar: character.avatar,
                        characterName: character.name,
                        file,
                        fullPath,
                        stat,
                    });
                } catch {
                }
            }
        }

        candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
        const chats = [];
        for (const item of candidates.slice(0, limit)) {
            let messageCount = 0;
            let preview = '';
            let lastDate = null;
            let favorite = false;
            try {
                const entries = parseChatLines(await fsp.readFile(item.fullPath, 'utf8'));
                const header = entries[0] && !('mes' in entries[0]) ? entries[0] : null;
                favorite = header?.chat_metadata?.favorite === true || header?.chat_metadata?.fav === true;
                const messages = entries.slice(1);
                messageCount = messages.length;
                const lastText = [...messages].reverse().find(entry => typeof entry.mes === 'string' && entry.mes.trim());
                preview = lastText ? lastText.mes.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW_LENGTH) : '';
                lastDate = typeof messages.at(-1)?.send_date === 'string' ? messages.at(-1).send_date : null;
            } catch {
                preview = '';
            }
            const rawTitle = item.file.replace(/\.jsonl$/i, '');
            const dated = /^(.*?)\s+-\s+(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d{3})ms$/i.exec(rawTitle);
            chats.push({
                avatar: item.avatar,
                characterName: item.characterName,
                file: item.file,
                title: dated ? dated[1] : rawTitle,
                chatDate: dated ? `${dated[2]}-${dated[3]}-${dated[4]} ${dated[5]}:${dated[6]}` : null,
                updatedAt: item.stat.mtime.toISOString(),
                createdAt: item.stat.birthtime.toISOString(),
                messageCount,
                preview,
                lastMessageAt: lastDate,
                favorite,
            });
        }
        return chats;
    }

    async function listWorlds() {
        let files = [];
        try {
            files = (await fsp.readdir(worldsDirectory)).filter(file => file.endsWith('.json'));
        } catch {
            return [];
        }
        const worlds = [];
        for (const file of files) {
            const fullPath = path.join(worldsDirectory, file);
            const stat = await fsp.stat(fullPath);
            let entryCount = 0;
            try {
                const parsed = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
                entryCount = Object.keys(parsed?.entries ?? {}).length;
            } catch {
                entryCount = 0;
            }
            worlds.push({
                name: file.replace(/\.json$/i, ''),
                file,
                entryCount,
                updatedAt: stat.mtime.toISOString(),
            });
        }
        worlds.sort((left, right) => left.name.localeCompare(right.name));
        return worlds;
    }

    async function readWorld(name) {
        const safe = path.basename(name);
        if (safe !== name) {
            throw new ApiError(400, 'invalid_world', 'Invalid lorebook name.');
        }
        const fullPath = path.join(worldsDirectory, `${safe}.json`);
        let parsed;
        try {
            parsed = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
        } catch {
            throw new ApiError(404, 'world_not_found', 'Lorebook not found on the PC.');
        }
        const entries = Object.values(parsed?.entries ?? {}).map(entry => ({
            uid: entry.uid ?? 0,
            keys: Array.isArray(entry.key) ? entry.key : [],
            secondaryKeys: Array.isArray(entry.keysecondary) ? entry.keysecondary : [],
            comment: entry.comment ?? '',
            content: entry.content ?? '',
            constant: entry.constant === true,
            selective: entry.selective === true,
            selectiveLogic: entry.selectiveLogic ?? 0,
            order: entry.order ?? 100,
            position: entry.position ?? 0,
            depth: entry.depth ?? 4,
            probability: entry.probability ?? 100,
            useProbability: entry.useProbability !== false,
            disable: entry.disable === true,
            excludeRecursion: entry.excludeRecursion === true,
            preventRecursion: entry.preventRecursion === true,
            matchWholeWords: entry.matchWholeWords === true,
            caseSensitive: entry.caseSensitive === true,
        }));
        entries.sort((left, right) => left.order - right.order || left.uid - right.uid);
        return {
            name: safe,
            entries,
            entryCount: entries.length,
        };
    }

    async function listPresets() {
        const result = {};
        for (const [kind, directory] of Object.entries(presetDirectories)) {
            try {
                const files = (await fsp.readdir(directory)).filter(file => file.endsWith('.json'));
                result[kind] = files.map(file => ({ name: file.replace(/\.json$/i, ''), file }));
            } catch {
                result[kind] = [];
            }
        }
        return result;
    }

    async function readPreset(kind, name) {
        const directory = presetDirectories[kind];
        if (!directory) {
            throw new ApiError(400, 'invalid_preset_kind', 'Unknown preset category.');
        }
        const safe = path.basename(name);
        if (safe !== name) {
            throw new ApiError(400, 'invalid_preset', 'Invalid preset name.');
        }
        try {
            const parsed = JSON.parse(await fsp.readFile(path.join(directory, `${safe}.json`), 'utf8'));
            return { kind, name: safe, values: parsed };
        } catch {
            throw new ApiError(404, 'preset_not_found', 'Preset not found on the PC.');
        }
    }

    async function snapshot() {
        const settings = await readSettings();
        const characters = await listCharacters();
        const activeAvatar = typeof settings.active_character === 'string' ? settings.active_character : null;
        const textgenSettings = settings.textgenerationwebui_settings ?? {};
        return {
            activeCharacter: activeAvatar,
            userName: settings.username ?? 'User',
            mainApi: settings.main_api ?? 'unknown',
            maxContext: Number(settings.max_context ?? 0),
            maxResponseLength: Number(settings.amount_gen ?? 0),
            activePreset: textgenSettings.preset ?? settings.kai_settings?.preset ?? null,
            characterCount: characters.length,
            worldCount: (await listWorlds()).length,
        };
    }

    return {
        listCharacters,
        getCharacter,
        listChats,
        listRecentChats,
        readChat,
        chatRevision,
        resolveChatPath,
        listWorlds,
        readWorld,
        listPresets,
        readPreset,
        readSettings,
        snapshot,
        paths: { dataRoot, charactersDirectory, chatsDirectory, worldsDirectory },
        sanitizeName,
    };
}
