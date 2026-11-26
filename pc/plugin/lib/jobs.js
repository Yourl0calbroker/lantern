import path from 'node:path';
import crypto from 'node:crypto';
import {
    ApiError,
    nowIso,
    openEventStream,
    readJsonFile,
    sendEvent,
    startHeartbeat,
    writeJsonFile,
} from './util.js';

const MAX_JOBS_IN_MEMORY = 60;
const MAX_TOKENS_PER_JOB = 40000;
const IDEMPOTENCY_LIMIT = 400;
const HOST_LOSS_GRACE_MS = 3 * 60 * 1000;

export function createJobStore({ stateDirectory, agent }) {
    const jobs = new Map();
    const subscribers = new Map();
    const idempotency = new Map();
    const idempotencyFile = path.join(stateDirectory, 'idempotency.json');
    let hostLossTimer = null;

    async function load() {
        const stored = await readJsonFile(idempotencyFile, {});
        for (const [key, value] of Object.entries(stored)) {
            idempotency.set(key, value);
        }
    }

    async function persistIdempotency() {
        const entries = [...idempotency.entries()].slice(-IDEMPOTENCY_LIMIT);
        await writeJsonFile(idempotencyFile, Object.fromEntries(entries));
    }

    function prune() {
        if (jobs.size <= MAX_JOBS_IN_MEMORY) {
            return;
        }
        const finished = [...jobs.values()]
            .filter(job => !isActive(job))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        for (const job of finished.slice(0, jobs.size - MAX_JOBS_IN_MEMORY)) {
            jobs.delete(job.id);
            subscribers.delete(job.id);
        }
    }

    function isActive(job) {
        return job.status === 'queued' || job.status === 'running' || job.status === 'paused';
    }

    function publicJob(job) {
        if (!job) {
            return null;
        }
        return {
            id: job.id,
            kind: job.kind,
            character: job.character,
            chatFile: job.chatFile,
            status: job.status,
            seq: job.seq,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            error: job.error,
            messageIndex: job.messageIndex,
            text: job.text,
            cancelRequested: job.cancelRequested,
            swipes: job.swipes ?? null,
            swipeId: job.swipeId ?? null,
            hostLost: job.status === 'paused',
        };
    }

    function notify(job, event, data) {
        const listeners = subscribers.get(job.id);
        if (!listeners) {
            return;
        }
        for (const listener of listeners) {
            try {
                if (event === 'job') {
                    sendEvent(listener.response, 'job', data);
                } else {
                    sendEvent(listener.response, 'token', data, data.seq);
                }
            } catch {
                listeners.delete(listener);
            }
        }
    }

    async function create({ kind, character, chatFile, clientRequestId, expectedRevision, messageIndex, request }) {
        const idempotencyKey = clientRequestId ? `${character}:${chatFile}:${clientRequestId}` : null;
        const existingId = idempotencyKey ? idempotency.get(idempotencyKey) : null;
        if (existingId && jobs.has(existingId)) {
            return { job: jobs.get(existingId), duplicate: true };
        }

        const active = findActive();
        if (active) {
            throw new ApiError(
                409,
                'generation_in_progress',
                'A response is already being generated. Stop it before starting another.',
                publicJob(active),
            );
        }

        if (!agent.hasHost()) {
            throw new ApiError(
                409,
                'host_offline',
                'SillyTavern is not open in a browser on the PC. Open it, then try again.',
            );
        }

        const job = {
            id: crypto.randomUUID(),
            kind,
            character,
            chatFile,
            clientRequestId: clientRequestId ?? null,
            expectedRevision: expectedRevision ?? null,
            messageIndex: messageIndex ?? null,
            request: request ?? null,
            status: 'queued',
            seq: 0,
            tokens: [],
            text: '',
            createdAt: nowIso(),
            startedAt: null,
            finishedAt: null,
            error: null,
            cancelRequested: false,
            swipes: null,
            swipeId: null,
        };
        jobs.set(job.id, job);
        subscribers.set(job.id, new Set());
        if (idempotencyKey) {
            idempotency.set(idempotencyKey, job.id);
            void persistIdempotency();
        }
        prune();

        try {
            await agent.dispatch(job);
        } catch (error) {
            job.status = 'failed';
            job.finishedAt = nowIso();
            job.error = {
                code: error.code ?? 'host_unavailable',
                message: error.message ?? 'SillyTavern could not start the generation.',
            };
            notify(job, 'job', publicJob(job));
            if (idempotencyKey) {
                idempotency.delete(idempotencyKey);
                void persistIdempotency();
            }
            throw error;
        }

        return { job, duplicate: false };
    }

    function findActive() {
        for (const job of jobs.values()) {
            if (isActive(job)) {
                return job;
            }
        }
        return null;
    }

    function start(jobId) {
        const job = jobs.get(jobId);
        if (!job || !isActive(job)) {
            return;
        }
        job.status = 'running';
        job.startedAt = job.startedAt ?? nowIso();
        notify(job, 'job', publicJob(job));
    }

    function append(jobId, text) {
        const job = jobs.get(jobId);
        if (!job || !isActive(job) || typeof text !== 'string' || text.length === 0) {
            return null;
        }
        job.seq += 1;
        job.text += text;
        job.tokens.push({ seq: job.seq, text, accumulated: job.text });
        if (job.tokens.length > MAX_TOKENS_PER_JOB) {
            job.tokens.splice(0, job.tokens.length - MAX_TOKENS_PER_JOB);
        }
        notify(job, 'token', job.tokens[job.tokens.length - 1]);
        return job.seq;
    }

    function sync(jobId, text) {
        const job = jobs.get(jobId);
        if (!job || !isActive(job) || typeof text !== 'string') {
            return null;
        }
        if (text.startsWith(job.text)) {
            return append(jobId, text.slice(job.text.length));
        }
        job.seq += 1;
        job.text = text;
        job.tokens = [{ seq: job.seq, text, replace: true }];
        notify(job, 'token', { seq: job.seq, text, replace: true, accumulated: text });
        return job.seq;
    }

    function complete(jobId, { messageIndex, text, swipes, swipeId }) {
        const job = jobs.get(jobId);
        if (!job || job.status === 'completed' || job.status === 'canceled') {
            return publicJob(job);
        }
        job.status = 'completed';
        job.finishedAt = nowIso();
        job.messageIndex = Number.isInteger(messageIndex) ? messageIndex : job.messageIndex;
        const finalText = typeof text === 'string' && text.length > 0 ? text : job.text;
        if (finalText !== job.text) {
            job.seq += 1;
            job.text = finalText;
            job.tokens = [{ seq: job.seq, text: finalText, replace: true, accumulated: finalText }];
            notify(job, 'token', job.tokens[0]);
        }
        job.swipes = Array.isArray(swipes) ? swipes : job.swipes;
        job.swipeId = Number.isInteger(swipeId) ? swipeId : job.swipeId;
        notify(job, 'job', publicJob(job));
        return publicJob(job);
    }

    function fail(jobId, code, message) {
        const job = jobs.get(jobId);
        if (!job || job.status === 'completed' || job.status === 'canceled') {
            return publicJob(job);
        }
        job.status = 'failed';
        job.finishedAt = nowIso();
        job.error = { code, message };
        notify(job, 'job', publicJob(job));
        return publicJob(job);
    }

    function cancel(jobId) {
        const job = jobs.get(jobId);
        if (!job) {
            throw new ApiError(404, 'job_not_found', 'That generation is no longer available.');
        }
        if (!isActive(job)) {
            return publicJob(job);
        }
        job.cancelRequested = true;
        agent.sendCancel(job);
        return publicJob(job);
    }

    function markCanceled(jobId) {
        const job = jobs.get(jobId);
        if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') {
            return job ? publicJob(job) : null;
        }
        job.status = 'canceled';
        job.finishedAt = nowIso();
        notify(job, 'job', publicJob(job));
        return publicJob(job);
    }

    function get(jobId) {
        const job = jobs.get(jobId);
        if (!job) {
            throw new ApiError(404, 'job_not_found', 'That generation is no longer available.');
        }
        return job;
    }

    function subscribe(jobId, afterSeq, response) {
        const job = get(jobId);
        openEventStream(response);
        sendEvent(response, 'job', publicJob(job));
        const replayFrom = Number.isFinite(afterSeq) ? afterSeq : 0;
        for (const token of job.tokens) {
            if (token.seq > replayFrom) {
                sendEvent(response, 'token', token, token.seq);
            }
        }
        if (!isActive(job)) {
            response.end();
            return () => { };
        }
        const entry = { response };
        subscribers.get(jobId)?.add(entry);
        const stopHeartbeat = startHeartbeat(response);
        return () => {
            stopHeartbeat();
            subscribers.get(jobId)?.delete(entry);
        };
    }

    function activeGenerationFor(character, chatFile) {
        for (const job of jobs.values()) {
            if (job.character !== character || job.chatFile !== chatFile) {
                continue;
            }
            if (isActive(job)) {
                return publicJob(job);
            }
            if (job.status === 'completed' && job.finishedAt && Date.now() - Date.parse(job.finishedAt) < 5 * 60 * 1000) {
                return publicJob(job);
            }
        }
        return null;
    }

    function hostLost() {
        if (!findActive()) {
            return;
        }
        for (const job of jobs.values()) {
            if (job.status === 'running') {
                job.status = 'paused';
                notify(job, 'job', publicJob(job));
            }
        }
        clearTimeout(hostLossTimer);
        hostLossTimer = setTimeout(() => {
            for (const job of jobs.values()) {
                if (job.status === 'paused') {
                    fail(job.id, 'host_lost', 'The SillyTavern tab stopped responding. The response may be incomplete.');
                }
            }
        }, HOST_LOSS_GRACE_MS);
        hostLossTimer.unref?.();
    }

    function hostReady() {
        clearTimeout(hostLossTimer);
        for (const job of jobs.values()) {
            if (job.status === 'paused') {
                job.status = 'running';
                notify(job, 'job', publicJob(job));
            }
        }
    }

    function listActive() {
        return [...jobs.values()].filter(isActive).map(publicJob);
    }

    function recent() {
        return [...jobs.values()]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .slice(0, 20)
            .map(publicJob);
    }

    return {
        load,
        create,
        start,
        append,
        sync,
        complete,
        fail,
        cancel,
        markCanceled,
        get,
        subscribe,
        activeGenerationFor,
        publicJob,
        findActive,
        hostLost,
        hostReady,
        listActive,
        recent,
    };
}
