let modules = null;
let missing = [];

export class StError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export async function loadSillyTavern() {
    if (modules) {
        return { ok: missing.length === 0, missing, capabilities: capabilities() };
    }

    try {
        const [script, events, world, textgen, preset] = await Promise.all([
            import('../../../../script.js'),
            import('../../../events.js'),
            import('../../../world-info.js'),
            import('../../../textgen-settings.js'),
            import('../../../preset-manager.js'),
        ]);
        modules = { script, events, world, textgen, preset };
    } catch (error) {
        return { ok: false, missing: ['module-import'], error: error.message, capabilities: [] };
    }

    const required = {
        'script.Generate': modules.script.Generate,
        'script.sendMessageAsUser': modules.script.sendMessageAsUser,
        'script.selectCharacterById': modules.script.selectCharacterById,
        'script.openCharacterChat': modules.script.openCharacterChat,
        'script.doNewChat': modules.script.doNewChat,
        'script.getCurrentChatId': modules.script.getCurrentChatId,
        'script.deleteMessage': modules.script.deleteMessage,
        'script.deleteCharacter': modules.script.deleteCharacter,
        'script.saveChatConditional': modules.script.saveChatConditional,
        'script.saveMetadata': modules.script.saveMetadata,
        'script.reloadCurrentChat': modules.script.reloadCurrentChat,
        'script.getCharacters': modules.script.getCharacters,
        'script.generateQuietPrompt': modules.script.generateQuietPrompt,
        'script.saveSettingsDebounced': modules.script.saveSettingsDebounced,
        'script.stopGeneration': modules.script.stopGeneration,
        'script.pingServer': modules.script.pingServer,
        'script.setOnlineStatus': modules.script.setOnlineStatus,
        'script.getRequestHeaders': modules.script.getRequestHeaders,
        'script.isGenerating': modules.script.isGenerating,
        'script.stopGeneration': modules.script.stopGeneration,
        'events.eventSource': modules.events.eventSource,
        'events.event_types': modules.events.event_types,
        'world.loadWorldInfo': modules.world.loadWorldInfo,
        'world.saveWorldInfo': modules.world.saveWorldInfo,
        'world.updateWorldInfoList': modules.world.updateWorldInfoList,
        'world.createWorldInfoEntry': modules.world.createWorldInfoEntry,
        'world.deleteWorldInfo': modules.world.deleteWorldInfo,
        'textgen.textgenerationwebui_settings': modules.textgen.textgenerationwebui_settings,
        'preset.getPresetManager': modules.preset.getPresetManager,
    };
    missing = Object.entries(required)
        .filter(([, value]) => value === undefined || value === null)
        .map(([name]) => name);
    if (!Array.isArray(modules.script.characters)) {
        missing.push('script.characters');
    }
    if (!Array.isArray(modules.script.chat)) {
        missing.push('script.chat');
    }
    return { ok: missing.length === 0, missing, capabilities: capabilities() };
}

export function requestHeaders(options = undefined) {
    return script().getRequestHeaders(options);
}

export function capabilities() {
    if (!modules || missing.length > 0) {
        return [];
    }
    return [
        'generation', 'streaming', 'chat.mutate', 'character.create', 'character.delete',
        'character.edit', 'character.favorite', 'character.scrape', 'character.draft',
        'chat.favorite', 'world.edit', 'world.delete', 'world.rename',
        'settings.edit', 'preset.select',
    ];
}

export async function ensureBackendOnline() {
    const st = script();
    if (typeof st.pingServer !== 'function' || typeof st.setOnlineStatus !== 'function') {
        return;
    }
    const reachable = await st.pingServer();
    if (!reachable) {
        throw new StError('backend_unavailable', 'SillyTavern cannot reach its inference backend.', 503);
    }
    if (st.online_status === 'no_connection') {
        const settings = modules.textgen.textgenerationwebui_settings;
        const endpoint = settings.server_urls?.[settings.type];
        if (!endpoint) {
            throw new StError('backend_unavailable', 'No text generation endpoint is configured in SillyTavern.', 503);
        }
        const response = await fetch('/api/backends/text-completions/status', {
            method: 'POST',
            headers: st.getRequestHeaders(),
            body: JSON.stringify({ api_server: endpoint, api_type: settings.type }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.result) {
            throw new StError('backend_unavailable', 'The SillyTavern backend status check failed. Check that the inference server on the PC is running.', 503);
        }
        st.setOnlineStatus(data.result);
    }
}

export function stVersionHint() {
    return modules ? '1.19.x' : null;
}

function script() {
    if (!modules) {
        throw new StError('not_ready', 'The Lantern extension has not finished loading.', 503);
    }
    return modules.script;
}

function requireCapabilities() {
    if (missing.length > 0) {
        throw new StError(
            'unsupported_st_version',
            `This SillyTavern build is missing: ${missing.join(', ')}. Update Lantern or SillyTavern.`,
            409,
        );
    }
}

function findCharacterIndex(avatar) {
    const index = script().characters.findIndex(character => character?.avatar === avatar);
    if (index < 0) {
        throw new StError('character_not_found', 'That character is no longer in the PC library.', 404);
    }
    return index;
}

async function ensureCharacter(avatar) {
    const index = findCharacterIndex(avatar);
    if (String(script().this_chid) !== String(index)) {
        await script().selectCharacterById(index);
    }
    if (script().characters[script().this_chid]?.avatar !== avatar) {
        throw new StError('character_switch_failed', 'SillyTavern could not open that character.', 502);
    }
    return index;
}

async function ensureChat(avatar, chatFile) {
    await ensureCharacter(avatar);
    const chatId = String(chatFile).replace(/\.jsonl$/i, '');
    if (script().getCurrentChatId() !== chatId) {
        await script().openCharacterChat(chatId);
    }
    if (script().getCurrentChatId() !== chatId) {
        throw new StError('chat_open_failed', 'SillyTavern could not open that conversation.', 502);
    }
}

export function isGenerating() {
    try {
        return script().isGenerating();
    } catch {
        return false;
    }
}

function stModule() {
    return modules.script;
}

export function stopGeneration() {
    try {
        script().stopGeneration();
    } catch {
    }
}

export async function runGeneration(payload, hooks) {
    requireCapabilities();
    const st = script();
    const events = modules.events;

    if (st.isGenerating()) {
        throw new StError('generation_busy', 'SillyTavern is already generating. Stop it on the PC first.', 409);
    }
    await ensureChat(payload.avatar, payload.chatFile);

    if (hooks.isCanceled?.()) {
        throw new StError('canceled', 'Generation was canceled.', 409);
    }

    if (payload.kind === 'regenerate' || payload.kind === 'continue') {
        const last = st.chat[st.chat.length - 1];
        if (!last || last.is_user) {
            throw new StError('no_reply_target', 'There is no character message to continue or regenerate.', 409);
        }
        if (payload.kind === 'regenerate' && payload.messageIndex !== null && payload.messageIndex !== undefined
            && Number(payload.messageIndex) !== st.chat.length - 1) {
            throw new StError(
                'unsupported_message',
                'Lantern can only regenerate the latest character message. Swipe to another alternative or edit it instead.',
                409,
            );
        }
    }

    let stopped = false;
    const onToken = text => {
        if (!stopped && typeof text === 'string' && text.length > 0) {
            hooks.onToken?.(text);
        }
    };
    const onStopped = () => {
        stopped = true;
    };
    events.eventSource.on(events.event_types.STREAM_TOKEN_RECEIVED, onToken);
    events.eventSource.on(events.event_types.GENERATION_STOPPED, onStopped);

    const textarea = document.getElementById('send_textarea');
    const draft = textarea instanceof HTMLTextAreaElement ? textarea.value : null;

    try {
        if (hooks.isCanceled?.()) {
            throw new StError('canceled', 'Generation was canceled.', 409);
        }

        await ensureBackendOnline();

        if (payload.kind === 'send') {
            if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
                throw new StError('empty_message', 'The message is empty.', 400);
            }
            if (textarea instanceof HTMLTextAreaElement) {
                textarea.value = '';
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await st.sendMessageAsUser(payload.text);
        }

        if (hooks.isCanceled?.()) {
            throw new StError('canceled', 'Generation was canceled.', 409);
        }

        hooks.onStart?.();

        if (payload.kind === 'send') {
            await st.Generate('normal', { automatic_trigger: true });
        } else if (payload.kind === 'regenerate') {
            await st.Generate('regenerate');
        } else if (payload.kind === 'continue') {
            await st.Generate('continue');
        } else if (payload.kind === 'impersonate') {
            await st.Generate('impersonate');
        } else {
            throw new StError('invalid_kind', 'Unknown generation type.', 400);
        }

        const messageIndex = st.chat.length - 1;
        const message = st.chat[messageIndex];
        if (!message || (message.is_user && payload.kind !== 'impersonate')) {
            throw new StError('no_reply', 'SillyTavern finished without producing a reply. Check the backend connection.', 502);
        }

        if (stopped || hooks.isCanceled?.()) {
            hooks.onCanceled?.({
                text: message.mes ?? '',
                messageIndex,
                swipes: Array.isArray(message.swipes) ? message.swipes : null,
                swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : null,
            });
        } else {
            hooks.onDone?.({
                text: message.mes ?? '',
                messageIndex,
                swipes: Array.isArray(message.swipes) ? message.swipes : null,
                swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : null,
            });
        }
    } catch (error) {
        if (error?.code === 'canceled' || stopped) {
            const last = st.chat[st.chat.length - 1];
            const keepLast = last && (!last.is_user || payload.kind === 'impersonate');
            hooks.onCanceled?.({
                text: keepLast ? last.mes ?? '' : '',
                messageIndex: keepLast ? st.chat.length - 1 : null,
                swipes: keepLast ? last.swipes ?? null : null,
                swipeId: keepLast && Number.isInteger(last?.swipe_id) ? last.swipe_id : null,
            });
        } else {
            hooks.onError?.(error);
        }
    } finally {
        events.eventSource.removeListener(events.event_types.STREAM_TOKEN_RECEIVED, onToken);
        events.eventSource.removeListener(events.event_types.GENERATION_STOPPED, onStopped);
        if (textarea instanceof HTMLTextAreaElement && draft !== null) {
            textarea.value = draft;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
}

export async function executeCommand(name, payload) {
    requireCapabilities();
    switch (name) {
        case 'message.edit':
            return editMessage(payload);
        case 'message.delete':
            return deleteMessage(payload);
        case 'message.swipe':
            return swipeMessage(payload);
        case 'chat.create':
            return createChat(payload);
        case 'chat.rename':
            return renameChat(payload);
        case 'chat.favorite':
            return favoriteChat(payload);
        case 'chat.delete':
            return deleteChat(payload);
        case 'character.create':
            return createCharacter(payload);
        case 'character.update':
            return updateCharacter(payload);
        case 'character.delete':
            return deleteCharacter(payload);
        case 'character.scrape':
            return scrapeCharacter(payload);
        case 'character.draft':
            return draftCharacter(payload);
        case 'settings.update':
            return updateSettings(payload);
        case 'preset.select':
            return selectPreset(payload);
        case 'world.create':
            return createWorld(payload);
        case 'world.rename':
            return renameWorld(payload);
        case 'world.delete':
            return deleteWorld(payload);
        case 'world.entry.save':
            return saveWorldEntry(payload);
        case 'world.entry.delete':
            return deleteWorldEntry(payload);
        default:
            throw new StError('unknown_command', `Unknown command: ${name}`, 400);
    }
}

async function editMessage({ avatar, chatFile, index, text }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before editing a message.', 409);
    }
    await ensureChat(avatar, chatFile);
    const message = script().chat[index];
    if (!message) {
        throw new StError('message_not_found', 'That message no longer exists.', 404);
    }
    message.mes = text;
    if (Array.isArray(message.swipes)) {
        const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        message.swipes[swipeId] = text;
    }
    await script().saveChatConditional();
    await modules.events.eventSource.emit(modules.events.event_types.MESSAGE_EDITED, index);
    await script().reloadCurrentChat();
    return { messageIndex: index };
}

async function deleteMessage({ avatar, chatFile, index }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before deleting a message.', 409);
    }
    await ensureChat(avatar, chatFile);
    if (!script().chat[index]) {
        throw new StError('message_not_found', 'That message no longer exists.', 404);
    }
    await script().deleteMessage(index, undefined, false);
    return { messageIndex: index };
}

async function swipeMessage({ avatar, chatFile, index, direction }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before swiping.', 409);
    }
    await ensureChat(avatar, chatFile);
    const message = script().chat[index];
    if (!message || message.is_user) {
        throw new StError('message_not_found', 'That message has no alternatives.', 404);
    }
    const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes];
    const current = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const next = current + (direction === 'right' ? 1 : -1);
    if (next < 0 || next >= swipes.length) {
        return { changed: false, swipeId: current, total: swipes.length, text: message.mes };
    }
    message.swipe_id = next;
    message.mes = swipes[next];
    await script().saveChatConditional();
    await modules.events.eventSource.emit(modules.events.event_types.MESSAGE_SWIPED, index);
    await script().reloadCurrentChat();
    return { changed: true, swipeId: next, total: swipes.length, text: message.mes };
}

async function createChat({ avatar }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before starting a new chat.', 409);
    }
    await ensureCharacter(avatar);
    await script().doNewChat({ deleteCurrentChat: false });
    const chatId = script().getCurrentChatId();
    if (!chatId) {
        throw new StError('chat_create_failed', 'SillyTavern did not create a conversation.', 502);
    }
    await script().saveChatConditional();
    return { chatFile: `${chatId}.jsonl` };
}

async function renameChat({ avatar, chatFile, name }) {
    const index = findCharacterIndex(avatar);
    const st = script();
    const original = String(chatFile);
    const renamed = `${String(name).trim()}.jsonl`;
    if (original === renamed) {
        return { chatFile: original };
    }
    const response = await fetch('/api/chats/rename', {
        method: 'POST',
        headers: st.getRequestHeaders(),
        body: JSON.stringify({
            is_group: false,
            avatar_url: st.characters[index].avatar,
            original_file: original,
            renamed_file: renamed,
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
        throw new StError('chat_rename_failed', 'SillyTavern could not rename that conversation.', 502);
    }
    const finalName = data.sanitizedFileName ? `${data.sanitizedFileName}.jsonl` : renamed;
    const oldId = original.replace(/\.jsonl$/i, '');
    const newId = finalName.replace(/\.jsonl$/i, '');
    if (st.characters[index].chat === oldId) {
        st.characters[index].chat = newId;
        await st.saveChatConditional();
        await st.reloadCurrentChat();
    }
    return { chatFile: finalName };
}

async function favoriteChat({ avatar, chatFile: requestedChatFile, favorite }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before favoriting a chat.', 409);
    }
    if (typeof favorite !== 'boolean') {
        throw new StError('invalid_favorite', 'favorite must be true or false.', 400);
    }
    await ensureCharacter(avatar);
    const chatFile = String(requestedChatFile ?? '').replace(/\.jsonl$/i, '');
    if (!chatFile) {
        throw new StError('invalid_chat', 'Invalid conversation identifier.', 400);
    }
    await script().openCharacterChat(chatFile);
    if (script().getCurrentChatId() !== chatFile) {
        throw new StError('chat_open_failed', 'SillyTavern could not open that conversation.', 502);
    }
    const st = script();
    if (!st.chat_metadata || typeof st.chat_metadata !== 'object') {
        throw new StError('chat_metadata_unavailable', 'SillyTavern did not load that conversation\'s metadata.', 502);
    }
    st.chat_metadata.favorite = favorite;
    await st.saveMetadata();
    return { favorite };
}

async function deleteChat({ avatar, chatFile }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before deleting a chat.', 409);
    }
    const index = findCharacterIndex(avatar);
    const chatId = String(chatFile).replace(/\.jsonl$/i, '');
    await script().deleteCharacterChatByName(index, chatId);
    return { deleted: true };
}

async function updateCharacter({ avatar, ...updates }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before editing a character.', 409);
    }
    const st = script();
    const index = findCharacterIndex(avatar);
    const fields = {
        name: 'name',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        firstMessage: 'first_mes',
        exampleMessages: 'mes_example',
        creatorNotes: 'creator_notes',
        systemPrompt: 'system_prompt',
        postHistoryInstructions: 'post_history_instructions',
        tags: 'tags',
        alternateGreetings: 'alternate_greetings',
    };
    const patch = {};
    const data = {};
    for (const [key, field] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
            patch[field] = updates[key];
            data[field] = updates[key];
        }
    }
    const changesFavorite = Object.prototype.hasOwnProperty.call(updates, 'favorite');
    if (changesFavorite) {
        if (typeof updates.favorite !== 'boolean') {
            throw new StError('invalid_favorite', 'favorite must be true or false.', 400);
        }
        patch.fav = updates.favorite;
        data.fav = updates.favorite;
        data.extensions = { fav: updates.favorite };
    }
    if (Object.keys(patch).length === 0) {
        throw new StError('invalid_request', 'No supported character fields were provided.', 400);
    }

    const merge = { avatar, data, ...patch };

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify(merge),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error) {
        throw new StError(
            'character_update_failed',
            result?.message ?? result?.error?.message ?? 'SillyTavern could not update that character.',
            502,
        );
    }

    const character = st.characters[index];
    if (!character || character.avatar !== avatar) {
        throw new StError('character_not_found', 'That character is no longer in the PC library.', 404);
    }
    for (const [key, field] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
            character[field] = patch[field];
            if (character.data && typeof character.data === 'object') {
                character.data[field] = patch[field];
            }
        }
    }
    if (changesFavorite) {
        character.fav = updates.favorite;
        if (character.data && typeof character.data === 'object') {
            if (!character.data.extensions || typeof character.data.extensions !== 'object') {
                character.data.extensions = {};
            }
            character.data.extensions.fav = updates.favorite;
        }
    }
    return { updated: true, avatar };
}

async function deleteCharacter({ avatar }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before deleting a character.', 409);
    }
    const st = script();
    const index = st.characters.findIndex(x => x.avatar === avatar);
    if (index < 0) {
        throw new StError('character_not_found', 'That character no longer exists on the PC.', 404);
    }
    const deleted = await st.deleteCharacter(avatar, { deleteChats: true });
    if (!deleted) {
        throw new StError('character_delete_failed', 'SillyTavern could not delete that character.', 502);
    }
    return { deleted: true, avatar };
}

async function updateSettings({ settings }) {
    const target = modules.textgen.textgenerationwebui_settings;
    for (const [key, value] of Object.entries(settings ?? {})) {
        target[key] = value;
    }
    script().saveSettingsDebounced();
    const applied = {};
    for (const key of Object.keys(settings ?? {})) {
        applied[key] = target[key];
    }
    return { settings: applied };
}

async function selectPreset({ name }) {
    const manager = modules.preset.getPresetManager('textgenerationwebui');
    if (!manager) {
        throw new StError('preset_unavailable', 'The text-generation preset manager is not available.', 409);
    }
    const value = manager.findPreset(name);
    if (value === undefined || value === null) {
        throw new StError('preset_not_found', 'That preset is not installed on the PC.', 404);
    }
    await manager.selectPreset(value);
    return { preset: name };
}

async function createWorld({ name }) {
    if (typeof modules.world.updateWorldInfoList === 'function') {
        await modules.world.updateWorldInfoList();
    }
    const names = Array.isArray(modules.world.world_names) ? modules.world.world_names : [];
    if (names.includes(name)) {
        throw new StError('world_exists', 'A lorebook with that name already exists.', 409);
    }
    await modules.world.saveWorldInfo(name, { entries: {} }, true);
    if (typeof modules.world.updateWorldInfoList === 'function') {
        await modules.world.updateWorldInfoList();
    }
    return { name };
}

async function renameWorld({ name, newName }) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before renaming a lorebook.', 409);
    }
    const oldName = String(name ?? '');
    const target = String(newName ?? '');
    if (!oldName || !target || oldName === target) {
        throw new StError('invalid_world_name', 'A different lorebook name is required.', 400);
    }

    const data = await modules.world.loadWorldInfo(oldName);
    if (!data) {
        throw new StError('world_not_found', 'That lorebook no longer exists.', 404);
    }

    if (typeof modules.world.updateWorldInfoList === 'function') {
        await modules.world.updateWorldInfoList();
    }
    const names = Array.isArray(modules.world.world_names) ? modules.world.world_names : [];
    if (!names.some(entry => String(entry).toLowerCase() === oldName.toLowerCase())) {
        throw new StError('world_not_found', 'That lorebook no longer exists.', 404);
    }
    if (names.some(entry => String(entry).toLowerCase() === target.toLowerCase())) {
        throw new StError('world_exists', 'A lorebook with that name already exists.', 409);
    }

    await modules.world.saveWorldInfo(target, data, true);
    const deleted = await modules.world.deleteWorldInfo(oldName);
    if (!deleted) {
        throw new StError('world_rename_failed', 'SillyTavern could not delete the old lorebook.', 502);
    }
    if (typeof modules.world.updateWorldInfoList === 'function') {
        await modules.world.updateWorldInfoList();
    }
    return { name: target };
}

async function deleteWorld({ name }) {
    if (typeof modules.world.deleteWorldInfo !== 'function') {
        throw new StError('world_delete_unsupported', 'This SillyTavern build cannot delete lorebooks.', 409);
    }
    if (typeof modules.world.updateWorldInfoList === 'function') {
        await modules.world.updateWorldInfoList();
    }
    const deleted = await modules.world.deleteWorldInfo(name);
    if (!deleted) {
        throw new StError('world_not_found', 'That lorebook no longer exists on the PC.', 404);
    }
    return { deleted: true, name };
}

async function saveWorldEntry({ name, uid, entry }) {
    const data = await modules.world.loadWorldInfo(name);
    if (!data) {
        throw new StError('world_not_found', 'That lorebook no longer exists.', 404);
    }
    let target;
    if (uid === null || uid === undefined) {
        target = modules.world.createWorldInfoEntry(name, data);
        if (!target) {
            throw new StError('entry_create_failed', 'SillyTavern could not allocate a lorebook entry.', 502);
        }
    } else {
        target = data.entries?.[uid];
        if (!target) {
            throw new StError('entry_not_found', 'That lorebook entry no longer exists.', 404);
        }
    }
    Object.assign(target, entry);
    await modules.world.saveWorldInfo(name, data, true);
    return { uid: target.uid };
}

async function deleteWorldEntry({ name, uid }) {
    const data = await modules.world.loadWorldInfo(name);
    if (!data || !data.entries?.[uid]) {
        throw new StError('entry_not_found', 'That lorebook entry no longer exists.', 404);
    }
    delete data.entries[uid];
    await modules.world.saveWorldInfo(name, data, true);
    return { deleted: true };
}

function safeFileName(value) {
    return String(value ?? '')
        .replace(/[<>:"\\/|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'Character';
}

function base64ToBytes(value) {
    const raw = String(value ?? '').replace(/^data:[^;]+;base64,/i, '');
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function base64Mime(value) {
    const match = String(value ?? '').match(/^data:([^;]+);base64,/i);
    return match ? match[1] : 'image/png';
}

async function bytesToPng(bytes, mime = 'image/png') {
    const blob = new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#F1ECE3';
    context.fillRect(0, 0, 512, 512);
    const scale = Math.max(512 / bitmap.width, 512 / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (512 - width) / 2, (512 - height) / 2, width, height);
    bitmap.close?.();
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!png) {
        throw new StError('avatar_failed', 'The selected photo could not be converted.', 502);
    }
    return await png.arrayBuffer();
}

async function defaultSilhouettePng() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#F1ECE3';
    context.fillRect(0, 0, 512, 512);
    context.strokeStyle = '#000000';
    context.lineWidth = 14;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.arc(256, 168, 70, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(128, 470);
    context.bezierCurveTo(138, 348, 188, 276, 256, 276);
    context.bezierCurveTo(324, 276, 374, 348, 384, 470);
    context.stroke();
    context.beginPath();
    context.moveTo(172, 404);
    context.lineTo(340, 404);
    context.stroke();
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!png) {
        throw new StError('avatar_failed', 'The default portrait could not be created.', 502);
    }
    return await png.arrayBuffer();
}

function parseContentDisposition(header) {
    const value = String(header ?? '');
    const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (encoded?.[1]) {
        try {
            return decodeURIComponent(encoded[1]);
        } catch {
            return encoded[1];
        }
    }
    const plain = value.match(/filename="?([^";]+)"?/i);
    return plain?.[1] ?? '';
}

function importExtension(fileName, contentType) {
    const extension = String(fileName ?? '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (['png', 'json', 'charx', 'yaml', 'yml', 'byaf'].includes(extension)) return extension;
    if (String(contentType ?? '').includes('json')) return 'json';
    if (String(contentType ?? '').includes('zip')) return 'charx';
    return 'png';
}

async function importCardFile(bytes, fileName, extension, contentType) {
    const form = new FormData();
    const file = new File([bytes], safeFileName(fileName), { type: contentType || 'application/octet-stream' });
    form.append('avatar', file);
    form.append('file_type', extension);
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: script().getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
    });
    if (!response.ok) {
        throw new StError('import_failed', `SillyTavern could not import the card (${response.status}).`, 502);
    }
    const data = await response.json().catch(() => ({}));
    if (data?.error || !data?.file_name) {
        throw new StError('import_invalid', 'SillyTavern could not read that card.', 502);
    }
    const avatar = String(data.file_name).endsWith('.png') ? String(data.file_name) : `${data.file_name}.png`;
    await refreshCharacters();
    return avatar;
}

async function refreshCharacters() {
    if (typeof script().getCharacters === 'function') {
        await script().getCharacters();
    }
}

async function createCharacter(payload) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before creating a character.', 409);
    }
    const name = String(payload?.name ?? '').trim();
    if (!name) {
        throw new StError('invalid_character', 'Give the character a name.', 400);
    }
    const tags = Array.isArray(payload?.tags) ? payload.tags : [];
    const form = new FormData();
    form.append('ch_name', name);
    form.append('description', String(payload?.description ?? ''));
    form.append('personality', String(payload?.personality ?? ''));
    form.append('scenario', String(payload?.scenario ?? ''));
    form.append('first_mes', String(payload?.firstMessage ?? ''));
    form.append('mes_example', String(payload?.exampleMessages ?? ''));
    form.append('creator_notes', String(payload?.creatorNotes ?? ''));
    form.append('system_prompt', String(payload?.systemPrompt ?? ''));
    form.append('post_history_instructions', String(payload?.postHistoryInstructions ?? ''));
    form.append('tags', tags.filter(tag => typeof tag === 'string' && tag.trim()).join(','));
    const pngBytes = payload?.avatarPng
        ? await bytesToPng(base64ToBytes(payload.avatarPng), base64Mime(payload.avatarPng))
        : await defaultSilhouettePng();
    form.append('avatar', new File([pngBytes], `${safeFileName(name)}.png`, { type: 'image/png' }));
    form.append('file_type', 'png');
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: script().getRequestHeaders({ omitContentType: true }),
        body: form,
        cache: 'no-cache',
    });
    if (!response.ok) {
        throw new StError('import_failed', `SillyTavern could not save the character (${response.status}).`, 502);
    }
    const data = await response.json().catch(() => ({}));
    if (data?.error || !data?.file_name) {
        throw new StError('import_invalid', 'SillyTavern could not read the character card.', 502);
    }
    const avatar = String(data.file_name).endsWith('.png') ? String(data.file_name) : `${data.file_name}.png`;
    await refreshCharacters();
    return { avatar, name };
}

async function scrapeCharacter(payload) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before scraping a card.', 409);
    }
    const url = String(payload?.url ?? '').trim();
    if (!url) {
        throw new StError('invalid_url', 'Paste a character card link.', 400);
    }
    const response = await fetch('/api/content-manager/importURL', {
        method: 'POST',
        headers: script().getRequestHeaders(),
        body: JSON.stringify({ url }),
        cache: 'no-cache',
    });
    if (!response.ok) {
        const status = response.status === 404
            ? 'This site is not supported or the card was not found.'
            : `The card site could not be reached (${response.status}).`;
        throw new StError('scrape_failed', status, 502);
    }
    const type = response.headers.get('X-Custom-Content-Type') || 'character';
    if (type !== 'character') {
        throw new StError('unsupported_content', 'That link points to a lorebook, not a character card.', 409);
    }
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    const fileName = parseContentDisposition(response.headers.get('Content-Disposition'))
        || 'scraped-character.png';
    const extension = importExtension(fileName, contentType);
    const bytes = await response.arrayBuffer();
    const avatar = await importCardFile(bytes, fileName, extension, contentType);
    return { avatar };
}

function normalizeDraftCard(card) {
    const source = card && typeof card === 'object' ? card : {};
    const text = value => typeof value === 'string' ? value.trim() : '';
    const list = value => Array.isArray(value)
        ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, 40)
        : [];
    return {
        name: text(source.name).slice(0, 120) || 'Untitled Character',
        description: text(source.description),
        personality: text(source.personality),
        scenario: text(source.scenario),
        firstMessage: text(source.firstMessage),
        exampleMessages: text(source.exampleMessages),
        creatorNotes: text(source.creatorNotes),
        systemPrompt: text(source.systemPrompt),
        postHistoryInstructions: text(source.postHistoryInstructions),
        tags: list(source.tags),
    };
}

async function draftCharacter(payload) {
    if (isGenerating()) {
        throw new StError('generation_busy', 'Stop generation before drafting a card.', 409);
    }
    await ensureBackendOnline();
    const request = String(payload?.prompt ?? '').trim();
    if (!request) {
        throw new StError('invalid_request', 'Describe the character first.', 400);
    }
    const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            personality: { type: 'string' },
            scenario: { type: 'string' },
            firstMessage: { type: 'string' },
            exampleMessages: { type: 'string' },
            creatorNotes: { type: 'string' },
            systemPrompt: { type: 'string' },
            postHistoryInstructions: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'personality', 'scenario', 'firstMessage', 'tags'],
    };
    const quietPrompt = [
        'Write one SillyTavern character card from the request below.',
        'Return a single JSON object and nothing else.',
        'Use plain prose, no markdown fences and no commentary.',
        'name is a short character name.',
        'description is the character physical and historical description.',
        'personality is a concise summary of temperament and speech.',
        'scenario is the current situation.',
        'firstMessage is the opening line spoken as the character.',
        'exampleMessages is a few short example lines separated by new lines.',
        'creatorNotes is a brief note about the card.',
        'systemPrompt and postHistoryInstructions should stay short and useful.',
        'tags is an array of short lowercase tags.',
        `Request: ${request}`,
    ].join('\n');
    const raw = await script().generateQuietPrompt({
        quietPrompt,
        jsonSchema: schema,
        responseLength: 1100,
        removeReasoning: true,
        trimToSentence: false,
    });
    let text = String(raw ?? '').trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new StError('draft_invalid', 'The model did not return a character card. Try a shorter description.', 502);
    }
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
        throw new StError('draft_invalid', 'The model response was not valid JSON. Try again.', 502);
    }
    return normalizeDraftCard(parsed);
}
