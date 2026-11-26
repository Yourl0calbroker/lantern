export class LanternPanel {
    constructor({ getHeaders, onReconnect, onRotate }) {
        this.getHeaders = getHeaders;
        this.onReconnect = onReconnect;
        this.onRotate = onRotate;
        this.root = null;
        this.summary = null;
        this.bridge = { connected: false, ready: false };
        this.timer = null;
        this.updateInfo = null;
        this.updateNote = '';
        this.updateChecking = false;
    }

    mount() {
        if (document.getElementById('lantern-bridge-panel')) {
            return;
        }
        const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
        if (!host) {
            return;
        }

        const root = document.createElement('div');
        root.id = 'lantern-bridge-panel';
        root.className = 'lantern-panel';

        const head = document.createElement('div');
        head.className = 'lantern-head';
        const dot = document.createElement('span');
        dot.className = 'lantern-dot';
        dot.setAttribute('aria-hidden', 'true');
        const title = document.createElement('strong');
        title.textContent = 'Lantern Bridge';
        const status = document.createElement('span');
        status.className = 'lantern-status';
        status.textContent = 'Checking';
        dot.dataset.state = 'waiting';
        head.append(dot, title, status);

        const copy = document.createElement('div');
        copy.className = 'lantern-copy';
        copy.textContent = 'Keep this SillyTavern tab open. The Android app sends generation and library requests through this bridge.';

        const connectionSection = document.createElement('div');
        connectionSection.className = 'lantern-connection';
        const connectionTitle = document.createElement('div');
        connectionTitle.className = 'lantern-subhead';
        connectionTitle.textContent = 'PC address for Lantern';
        const address = document.createElement('code');
        address.className = 'lantern-address';
        address.textContent = 'Detecting…';
        const connectionAlternatives = document.createElement('div');
        connectionAlternatives.className = 'lantern-meta';
        connectionSection.append(connectionTitle, address, connectionAlternatives);

        const codeRow = document.createElement('div');
        codeRow.className = 'lantern-code-row';
        const code = document.createElement('code');
        code.className = 'lantern-code';
        code.textContent = '------';
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'menu_button';
        copyButton.textContent = 'Select code';
        copyButton.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.summary?.pairing?.code ?? '');
                copyButton.textContent = 'Copied';
            } catch {
                copyButton.textContent = 'Select code';
            }
        });
        codeRow.append(code, copyButton);

        const expiry = document.createElement('div');
        expiry.className = 'lantern-meta';

        const actions = document.createElement('div');
        actions.className = 'lantern-actions';
        const rotate = document.createElement('button');
        rotate.type = 'button';
        rotate.className = 'menu_button';
        rotate.textContent = 'New code';
        rotate.addEventListener('click', async () => {
            rotate.disabled = true;
            try {
                await this.onRotate();
                await this.refresh();
            } catch (error) {
                this.showError(error.message);
            } finally {
                rotate.disabled = false;
            }
        });
        const reconnect = document.createElement('button');
        reconnect.type = 'button';
        reconnect.className = 'menu_button';
        reconnect.textContent = 'Reconnect';
        reconnect.addEventListener('click', () => {
            this.onReconnect();
            void this.refresh();
        });
        actions.append(rotate, reconnect);

        const updateSection = document.createElement('div');
        updateSection.className = 'lantern-update';
        const updateTitle = document.createElement('div');
        updateTitle.className = 'lantern-subhead';
        updateTitle.textContent = 'Web plugin';
        const updateStatus = document.createElement('div');
        updateStatus.className = 'lantern-meta lantern-update-status';
        updateStatus.textContent = 'Checking for updates…';
        const updateActions = document.createElement('div');
        updateActions.className = 'lantern-actions lantern-update-actions';
        const checkUpdate = document.createElement('button');
        checkUpdate.type = 'button';
        checkUpdate.className = 'menu_button';
        checkUpdate.textContent = 'Check for update';
        checkUpdate.addEventListener('click', () => { void this.checkUpdate(); });
        const installUpdate = document.createElement('button');
        installUpdate.type = 'button';
        installUpdate.className = 'menu_button';
        installUpdate.textContent = 'Install update';
        installUpdate.hidden = true;
        installUpdate.addEventListener('click', () => { void this.installUpdate(); });
        updateActions.append(checkUpdate, installUpdate);
        updateSection.append(updateTitle, updateStatus, updateActions);

        const hostLine = document.createElement('div');
        hostLine.className = 'lantern-meta lantern-host';

        const deviceSection = document.createElement('div');
        deviceSection.className = 'lantern-devices';
        const deviceTitle = document.createElement('div');
        deviceTitle.className = 'lantern-subhead';
        deviceTitle.textContent = 'Connected device';
        const deviceRow = document.createElement('div');
        deviceRow.className = 'lantern-device';
        const deviceNote = document.createElement('div');
        deviceNote.className = 'lantern-meta';
        deviceSection.append(deviceTitle, deviceRow, deviceNote);

        root.append(head, copy, connectionSection, codeRow, expiry, actions, updateSection, hostLine, deviceSection);
        host.append(root);
        this.root = root;
        this.address = address;
        this.connectionAlternatives = connectionAlternatives;
        this.code = code;
        this.expiry = expiry;
        this.hostLine = hostLine;
        this.deviceRow = deviceRow;
        this.deviceNote = deviceNote;
        this.updateStatus = updateStatus;
        this.checkUpdateButton = checkUpdate;
        this.installUpdateButton = installUpdate;
        this.status = status;
        this.dot = dot;
        this.copyButton = copyButton;

        void this.refresh().then(() => this.checkUpdate());
        this.timer = setInterval(() => { void this.refresh(); }, 60000);
    }

    async request(route, options = {}) {
        const headers = { ...this.getHeaders(), ...(options.headers ?? {}) };
        if (options.body && !headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
        }
        let response;
        try {
            response = await fetch(`/api/plugins/lantern-bridge${route}`, { ...options, headers });
        } catch (error) {
            throw new Error(`Could not reach the bridge: ${error.message}`);
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error?.message ?? `Plugin returned ${response.status}`);
        }
        return data;
    }

    async refresh() {
        try {
            this.summary = await this.request('/admin/summary');
            this.renderSummary();
        } catch (error) {
            this.showError(error.message);
        }
    }

    setBridge(bridge) {
        this.bridge = bridge;
        this.renderStatus();
    }

    showError(message) {
        if (!this.root) {
            return;
        }
        this.status.textContent = 'Unavailable';
        this.dot.dataset.state = 'error';
        this.hostLine.textContent = message;
    }

    renderSummary() {
        if (!this.summary || !this.root) {
            return;
        }
        const pairing = this.summary.pairing;
        const value = pairing?.code ?? '';
        this.code.textContent = value ? `${value.slice(0, 3)} ${value.slice(3)}` : '------';
        this.copyButton.disabled = !value;
        if (pairing?.expiresAt) {
            const minutes = Math.max(0, Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 60000));
            this.expiry.textContent = minutes > 0 ? `Code expires in ${minutes} min` : 'Code expired. Generate a new one.';
        }
        const connection = this.summary.connection ?? null;
        this.address.textContent = connection?.primary ?? 'No LAN address found';
        const alternatives = (connection?.addresses ?? [])
            .filter(item => item.value !== connection?.primary)
            .map(item => `${item.kind === 'tailscale' ? 'Tailscale' : 'LAN'} ${item.value}`);
        this.connectionAlternatives.textContent = alternatives.length > 0
            ? `Also: ${alternatives.join(' · ')}`
            : `SillyTavern port ${connection?.port ?? 'unknown'}`;
        this.renderConnectedDevice(this.summary.connectedDevice ?? null);
        this.renderStatus();
    }

    renderConnectedDevice(device) {
        if (!this.root) {
            return;
        }
        this.deviceRow.replaceChildren();
        if (!device) {
            const empty = document.createElement('div');
            empty.className = 'lantern-meta';
            empty.textContent = 'No device connected.';
            this.deviceRow.append(empty);
            return;
        }

        const name = document.createElement('span');
        name.className = 'lantern-device-name';
        name.textContent = device.name;
        const seen = document.createElement('span');
        seen.className = 'lantern-meta';
        seen.textContent = device.connectedAt ? `seen ${relativeTime(device.connectedAt)}` : '';
        const unpair = document.createElement('button');
        unpair.type = 'button';
        unpair.className = 'menu_button lantern-unpair';
        unpair.textContent = 'Unpair';
        unpair.addEventListener('click', () => { void this.unpairDevice(device); });
        this.deviceRow.append(name, seen, unpair);
    }

    async unpairDevice(device) {
        this.deviceNote.textContent = 'Unpairing…';
        try {
            await this.request('/admin/devices/unpair', {
                method: 'POST',
                body: JSON.stringify({ id: device.id }),
            });
            this.deviceNote.textContent = `${device.name} was unpaired.`;
            await this.refresh();
        } catch (error) {
            this.deviceNote.textContent = `Unpair failed: ${error.message}`;
        }
    }

    async checkUpdate(options = {}) {
        if (this.updateChecking || !this.root) {
            return;
        }
        this.updateChecking = true;
        this.checkUpdateButton.disabled = true;
        this.updateStatus.textContent = 'Checking GitHub…';
        try {
            this.updateInfo = await this.request('/admin/update/check');
            if (!options.preserveNote) {
                this.updateNote = '';
            }
            this.renderUpdate();
        } catch (error) {
            this.updateStatus.textContent = `Update check failed: ${error.message}`;
        } finally {
            this.updateChecking = false;
            this.checkUpdateButton.disabled = false;
        }
    }

    renderUpdate() {
        if (!this.root) {
            return;
        }
        const info = this.updateInfo;
        if (!info) {
            this.updateStatus.textContent = 'No update information yet.';
            this.installUpdateButton.hidden = true;
            return;
        }
        if (info.updateAvailable) {
            this.updateStatus.textContent = `${info.currentVersion} → ${info.latestVersion} is available`;
            this.installUpdateButton.hidden = false;
        } else {
            this.updateStatus.textContent = `${info.currentVersion} is up to date`;
            this.installUpdateButton.hidden = true;
        }
        const notes = [];
        if (info.restartRequired) {
            notes.push(`restart SillyTavern to load ${info.restartRequired.version}`);
        }
        if (this.updateNote) {
            notes.push(this.updateNote);
        }
        if (notes.length > 0) {
            this.updateStatus.textContent += ` · ${notes.join(' · ')}`;
        }
    }

    async installUpdate() {
        if (!this.root) {
            return;
        }
        this.checkUpdateButton.disabled = true;
        this.installUpdateButton.disabled = true;
        this.updateStatus.textContent = 'Downloading and verifying…';
        try {
            const result = await this.request('/admin/update/install', {
                method: 'POST',
                body: '{}',
            });
            this.updateNote = `${result.installedVersion} installed. Reload this tab, then restart SillyTavern.`;
            await this.refresh();
            await this.checkUpdate({ preserveNote: true });
        } catch (error) {
            this.updateStatus.textContent = `Install failed: ${error.message}`;
        } finally {
            this.checkUpdateButton.disabled = false;
            this.installUpdateButton.disabled = false;
        }
    }

    renderStatus() {
        if (!this.root) {
            return;
        }
        const host = this.summary?.host;
        if (this.bridge.ready) {
            this.status.textContent = 'Ready';
            this.dot.dataset.state = 'ready';
            this.hostLine.textContent = `This tab is connected${host?.host?.stVersion ? ` · SillyTavern ${host.host.stVersion}` : ''}`;
        } else if (this.bridge.connected) {
            this.status.textContent = 'Handshaking';
            this.dot.dataset.state = 'waiting';
            this.hostLine.textContent = 'Connected. Waiting for the bridge handshake.';
        } else {
            this.status.textContent = 'Tab not connected';
            this.dot.dataset.state = 'offline';
            this.hostLine.textContent = 'The Android app cannot start generation until this tab reconnects.';
        }
    }
}

function relativeTime(iso) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
}
