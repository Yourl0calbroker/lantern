import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ApiError, readJsonFile, writeJsonFile } from './util.js';

const runGit = promisify(execFile);

const REPOSITORY = 'Yourl0calbroker/lantern';
const RELEASE_TAG = 'WebApp';
const RELEASE_URL = `https://github.com/${REPOSITORY}/releases/tag/${RELEASE_TAG}`;
const COMMIT_URL = `https://api.github.com/repos/${REPOSITORY}/commits/${RELEASE_TAG}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPOSITORY}/${RELEASE_TAG}`;
const USER_AGENT = 'Lantern-Bridge-WebUpdater/1.1.0';
const MAX_REDIRECTS = 5;
const ALLOWED_HOSTS = new Set([
    'api.github.com',
    'github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
]);

function parseVersion(value) {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
    if (!match) {
        return null;
    }
    return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function compareVersions(left, right) {
    const a = String(left ?? '').split('.').map(Number);
    const b = String(right ?? '').split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
            return difference > 0 ? 1 : -1;
        }
    }
    return 0;
}

async function fetchWithRules(url, options = {}) {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (current.protocol !== 'https:' || !ALLOWED_HOSTS.has(current.hostname.toLowerCase())) {
            throw new ApiError(502, 'unsafe_redirect', 'The update URL left GitHub, so the download was refused.');
        }
        const response = await fetch(current, {
            ...options,
            redirect: 'manual',
            headers: {
                'User-Agent': USER_AGENT,
                ...(options.headers ?? {}),
            },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) {
                throw new ApiError(502, 'bad_redirect', 'GitHub returned a redirect without a destination.');
            }
            current = new URL(location, current);
            continue;
        }
        return response;
    }
    throw new ApiError(502, 'too_many_redirects', 'The update download redirected too many times.');
}

function parseChecksums(text) {
    const hashes = new Map();
    for (const rawLine of String(text).split(/\r?\n/)) {
        const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(rawLine.trim());
        if (!match) {
            continue;
        }
        const name = match[2].replace(/^\.\//, '').replace(/\\/g, '/');
        hashes.set(name, match[1].toLowerCase());
    }
    return hashes;
}

async function git(directory, args) {
    try {
        const { stdout } = await runGit('git', ['-C', directory, ...args], {
            timeout: 120 * 1000,
            maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim();
    } catch (error) {
        throw new ApiError(500, 'git_failed', `Git update step failed: ${error.message}`);
    }
}

async function readRemoteInfo() {
    let commitResponse;
    let packageResponse;
    try {
        commitResponse = await fetchWithRules(COMMIT_URL, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        packageResponse = await fetchWithRules(`${RAW_BASE}/pc/plugin/package.json`);
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(502, 'release_check_failed', `Could not reach GitHub: ${error.message}`);
    }

    if (!commitResponse.ok) {
        throw new ApiError(502, 'release_check_failed', `GitHub returned ${commitResponse.status} while checking the WebApp tag.`);
    }
    if (!packageResponse.ok) {
        throw new ApiError(502, 'release_check_failed', `GitHub returned ${packageResponse.status} while reading the WebApp package version.`);
    }

    const commit = (await commitResponse.json()).sha;
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
        throw new ApiError(502, 'release_check_failed', 'The WebApp tag did not resolve to a valid commit.');
    }

    let packageJson;
    try {
        packageJson = JSON.parse(await packageResponse.text());
    } catch {
        throw new ApiError(502, 'release_check_failed', 'The WebApp tag has an invalid plugin package.json.');
    }
    const latestVersion = parseVersion(packageJson.version);
    if (!latestVersion) {
        throw new ApiError(502, 'release_version_missing', 'The WebApp tag does not declare a valid plugin version.');
    }

    let checksums = new Map();
    let checksumAvailable = false;
    try {
        const checksumResponse = await fetchWithRules(`${RAW_BASE}/WEBAPP-SHA256SUMS.txt`);
        if (checksumResponse.ok) {
            checksums = parseChecksums(await checksumResponse.text());
            checksumAvailable = checksums.size > 0;
        }
    } catch {
        checksumAvailable = false;
    }

    return { commit, latestVersion, checksums, checksumAvailable };
}

async function localCommit(extensionDirectory) {
    if (!extensionDirectory || !await fsp.stat(extensionDirectory).then(stat => stat.isDirectory(), () => false)) {
        return null;
    }
    if (!await fsp.stat(path.join(extensionDirectory, '.git')).then(() => true, () => false)) {
        return null;
    }
    return git(extensionDirectory, ['rev-parse', 'HEAD']).catch(() => null);
}

async function verifyCheckout(extensionDirectory, checksums) {
    let verified = 0;
    for (const [name, expected] of checksums) {
        if (!name.startsWith('pc/plugin/') && !name.startsWith('pc/extension/')) {
            continue;
        }
        const parts = name.split('/');
        if (parts.some(part => part === '..' || part === '.' || part === '')) {
            throw new ApiError(400, 'checksum_mismatch', 'The WebApp checksum file contains an unsafe path.');
        }
        const target = path.join(extensionDirectory, ...parts);
        const fullTarget = path.resolve(target);
        const fullRoot = path.resolve(extensionDirectory);
        if (!fullTarget.startsWith(fullRoot + path.sep)) {
            throw new ApiError(400, 'checksum_mismatch', 'The WebApp checksum file contains an unsafe path.');
        }
        let bytes;
        try {
            bytes = await fsp.readFile(fullTarget);
        } catch {
            throw new ApiError(400, 'checksum_mismatch', `The WebApp checkout is missing ${name}.`);
        }
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actual !== expected) {
            throw new ApiError(400, 'checksum_mismatch', `The WebApp checkout failed checksum verification for ${name}.`);
        }
        verified += 1;
    }
    return verified;
}

async function copyDirectory(source, destination) {
    const entries = await fsp.readdir(source, { withFileTypes: true }).catch(() => []);
    await fsp.mkdir(destination, { recursive: true });
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            continue;
        }
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(from, to);
        } else if (entry.isFile()) {
            await fsp.copyFile(from, to);
        }
    }
}

async function syncPlugin(extensionDirectory, pluginDirectory) {
    const source = path.join(extensionDirectory, 'pc', 'plugin');
    const packagePath = path.join(source, 'package.json');
    const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
    if (packageJson.name !== 'lantern-bridge') {
        throw new ApiError(400, 'invalid_zip', 'The WebApp checkout does not contain the Lantern Bridge server plugin.');
    }

    await fsp.mkdir(pluginDirectory, { recursive: true });
    const written = new Set();
    async function copyPayload(fromDirectory, toDirectory) {
        const entries = await fsp.readdir(fromDirectory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const from = path.join(fromDirectory, entry.name);
            const to = path.join(toDirectory, entry.name);
            if (entry.isDirectory()) {
                await copyPayload(from, to);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            written.add(path.relative(source, from).split(path.sep).join('/').toLowerCase());
            await fsp.mkdir(path.dirname(to), { recursive: true });
            await fsp.copyFile(from, to);
        }
    }

    async function removeStale(directory) {
        const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const full = path.join(directory, entry.name);
            const lower = entry.name.toLowerCase();
            if (entry.isDirectory()) {
                if (lower === 'node_modules' || lower.startsWith('yt_dlp')) {
                    continue;
                }
                await removeStale(full);
                continue;
            }
            if (!entry.isFile() || !/\.(js|json)$/i.test(entry.name)) {
                continue;
            }
            const relative = path.relative(pluginDirectory, full).split(path.sep).join('/').toLowerCase();
            if (!written.has(relative)) {
                await fsp.rm(full, { force: true });
            }
        }
    }

    await copyPayload(source, pluginDirectory);
    await removeStale(pluginDirectory);
    return parseVersion(packageJson.version);
}

export function createUpdater({ currentVersion, stateDirectory, pluginDirectory, extensionDirectory }) {
    const updateDirectory = path.join(stateDirectory, 'updates');
    const markerFile = path.join(updateDirectory, 'restart-required.json');
    let version = parseVersion(currentVersion) ?? String(currentVersion ?? '0.0.0');

    async function restartRequired() {
        const marker = await readJsonFile(markerFile, null);
        if (!marker?.version) {
            return null;
        }
        return { version: marker.version, installedAt: marker.installedAt ?? null };
    }

    async function clearRestart() {
        await fsp.rm(markerFile, { force: true });
    }

    async function check() {
        const remote = await readRemoteInfo();
        const local = await localCommit(extensionDirectory);
        const versionBehind = compareVersions(remote.latestVersion, version) > 0;
        const commitBehind = Boolean(local && local !== remote.commit);
        return {
            currentVersion: version,
            latestVersion: remote.latestVersion,
            updateAvailable: versionBehind || commitBehind,
            asset: {
                name: `Git tag ${RELEASE_TAG}`,
                size: 0,
                url: RELEASE_URL,
            },
            checksum: remote.checksumAvailable ? 'SHA256SUMS.txt in WebApp tag' : null,
            releaseUrl: RELEASE_URL,
            notes: `WebApp commit ${remote.commit.slice(0, 7)}${local ? ` · local ${local.slice(0, 7)}` : ''}`,
            restartRequired: await restartRequired(),
        };
    }

    async function install() {
        const remote = await readRemoteInfo();
        if (!extensionDirectory || !await fsp.stat(extensionDirectory).then(stat => stat.isDirectory(), () => false)) {
            throw new ApiError(409, 'extension_missing', 'Install the Lantern Bridge extension from SillyTavern first.');
        }
        if (!await fsp.stat(path.join(extensionDirectory, '.git')).then(() => true, () => false)) {
            throw new ApiError(409, 'extension_not_git', 'The Lantern Bridge extension was not installed from Git, so it cannot self-update.');
        }

        const local = await localCommit(extensionDirectory);
        if (compareVersions(remote.latestVersion, version) <= 0 && local === remote.commit) {
            throw new ApiError(409, 'up_to_date', 'This web plugin is already up to date.');
        }
        const previousVersion = version;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupRoot = path.join(updateDirectory, 'backups', stamp);
        const pluginBackup = path.join(backupRoot, 'plugin');
        const extensionBackup = path.join(backupRoot, 'extension');
        await fsp.mkdir(backupRoot, { recursive: true });
        await copyDirectory(pluginDirectory, pluginBackup);
        await copyDirectory(extensionDirectory, extensionBackup);

        try {
            await git(extensionDirectory, ['fetch', '--force', 'origin', `${RELEASE_TAG}:refs/remotes/origin/${RELEASE_TAG}`]);
            await git(extensionDirectory, ['checkout', '-B', RELEASE_TAG, `refs/remotes/origin/${RELEASE_TAG}`]);
            await git(extensionDirectory, ['reset', '--hard', `refs/remotes/origin/${RELEASE_TAG}`]);
            const verifiedFiles = await verifyCheckout(extensionDirectory, remote.checksums);
            if (remote.checksumAvailable && verifiedFiles === 0) {
                throw new ApiError(400, 'checksum_missing', 'WEBAPP-SHA256SUMS.txt has no web plugin entries.');
            }
            const installedVersion = await syncPlugin(extensionDirectory, pluginDirectory);
            if (!installedVersion || compareVersions(installedVersion, version) <= 0) {
                throw new ApiError(409, 'up_to_date', 'The WebApp tag is not newer than the installed copy.');
            }

            await writeJsonFile(markerFile, {
                version: installedVersion,
                installedAt: new Date().toISOString(),
                releaseUrl: RELEASE_URL,
                commit: remote.commit,
                verifiedFiles,
            });
            version = installedVersion;
            return {
                installedVersion,
                previousVersion,
                checksum: remote.checksumAvailable ? `verified ${verifiedFiles} files` : 'git tag WebApp',
                asset: `Git tag ${RELEASE_TAG}`,
                backupDirectory: backupRoot,
                restartRequired: true,
                reloadBrowserTab: true,
                commit: remote.commit,
            };
        } catch (error) {
            await fsp.rm(pluginDirectory, { recursive: true, force: true }).catch(() => {});
            await fsp.rm(extensionDirectory, { recursive: true, force: true }).catch(() => {});
            await copyDirectory(pluginBackup, pluginDirectory);
            await copyDirectory(extensionBackup, extensionDirectory);
            if (error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(500, 'install_failed', `Could not install the web plugin: ${error.message}`);
        }
    }

    return {
        check,
        install,
        currentVersion: () => version,
        setCurrentVersion: next => { version = parseVersion(next) ?? String(next ?? version); },
        restartRequired,
        clearRestart,
        releaseUrl: () => RELEASE_URL,
    };
}
