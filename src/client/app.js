// Pi Web Gateway Client Logic

class PiWebClient {
  constructor() {
    this.currentDeviceId = 'localhost';
    this.devices = [];
    this.term = null;
    this.fitAddon = null;
    this.termWS = null;
    this.agentWS = null;

    this.initElements();
    this.bindEvents();
    this.initTerminal();
    this.refreshDevices();
  }

  initElements() {
    this.deviceSelect = document.getElementById('deviceSelect');
    this.deviceStatusDot = document.getElementById('deviceStatusDot');
    this.addDeviceBtn = document.getElementById('addDeviceBtn');
    this.refreshBtn = document.getElementById('refreshBtn');

    // Tabs
    this.tabButtons = document.querySelectorAll('.tab-btn');
    this.tabPanes = document.querySelectorAll('.tab-pane');

    // Terminal
    this.terminalContainer = document.getElementById('terminalContainer');
    this.termCmdInput = document.getElementById('termCmdInput');
    this.reconnectTermBtn = document.getElementById('reconnectTermBtn');
    this.clearTermBtn = document.getElementById('clearTermBtn');

    // Agent
    this.agentMessages = document.getElementById('agentMessages');
    this.promptInput = document.getElementById('promptInput');
    this.sendPromptBtn = document.getElementById('sendPromptBtn');
    this.abortAgentBtn = document.getElementById('abortAgentBtn');
    this.clearAgentBtn = document.getElementById('clearAgentBtn');

    // Files
    this.filePathInput = document.getElementById('filePathInput');
    this.loadFilesBtn = document.getElementById('loadFilesBtn');
    this.fileList = document.getElementById('fileList');
    this.filePreviewHeader = document.getElementById('filePreviewHeader');
    this.filePreviewBody = document.getElementById('filePreviewBody');

    // Git
    this.gitCwdInput = document.getElementById('gitCwdInput');
    this.refreshGitBtn = document.getElementById('refreshGitBtn');
    this.gitStatusPre = document.getElementById('gitStatusPre');
    this.gitDiffPre = document.getElementById('gitDiffPre');

    // Modal
    this.addDeviceModal = document.getElementById('addDeviceModal');
    this.closeModalBtn = document.getElementById('closeModalBtn');
    this.cancelModalBtn = document.getElementById('cancelModalBtn');
    this.addDeviceForm = document.getElementById('addDeviceForm');
  }

  bindEvents() {
    // Tab switching
    this.tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        this.switchTab(tab);
      });
    });

    // Device selection
    this.deviceSelect.addEventListener('change', () => {
      this.currentDeviceId = this.deviceSelect.value;
      this.updateDeviceStatus();
      this.connectTerminal();
      this.connectAgent();
    });

    this.refreshBtn.addEventListener('click', () => this.refreshDevices());

    // Modal
    this.addDeviceBtn.addEventListener('click', () => {
      this.addDeviceModal.classList.remove('hidden');
    });
    this.closeModalBtn.addEventListener('click', () => {
      this.addDeviceModal.classList.add('hidden');
    });
    this.cancelModalBtn.addEventListener('click', () => {
      this.addDeviceModal.classList.add('hidden');
    });

    this.addDeviceForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(this.addDeviceForm);
      const payload = Object.fromEntries(formData.entries());
      payload.port = Number(payload.port) || 22;

      try {
        const res = await fetch('/api/devices/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        this.addDeviceModal.classList.add('hidden');
        this.addDeviceForm.reset();
        await this.refreshDevices();
        this.deviceSelect.value = payload.id;
        this.currentDeviceId = payload.id;
        this.updateDeviceStatus();
        this.connectTerminal();
      } catch (err) {
        alert('连接设备失败: ' + err.message);
      }
    });

    // Terminal controls
    this.reconnectTermBtn.addEventListener('click', () => this.connectTerminal());
    this.clearTermBtn.addEventListener('click', () => this.term && this.term.clear());

    // Agent controls
    this.sendPromptBtn.addEventListener('click', () => this.sendPrompt());
    this.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendPrompt();
      }
    });
    this.abortAgentBtn.addEventListener('click', () => this.abortAgent());
    this.clearAgentBtn.addEventListener('click', () => {
      this.agentMessages.innerHTML = '';
    });

    // Files controls
    this.loadFilesBtn.addEventListener('click', () => this.loadFiles());

    // Git controls
    this.refreshGitBtn.addEventListener('click', () => this.refreshGit());
  }

  switchTab(tabName) {
    this.tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    this.tabPanes.forEach(pane => {
      pane.classList.toggle('active', pane.id === `${tabName}Tab`);
    });

    if (tabName === 'terminal' && this.fitAddon) {
      setTimeout(() => this.fitAddon.fit(), 50);
    } else if (tabName === 'files') {
      this.loadFiles();
    } else if (tabName === 'git') {
      this.refreshGit();
    } else if (tabName === 'agent') {
      if (!this.agentWS || this.agentWS.readyState !== WebSocket.OPEN) {
        this.connectAgent();
      }
    }
  }

  async refreshDevices() {
    try {
      const res = await fetch('/api/devices');
      const data = await res.json();
      this.devices = data.devices || [];

      this.deviceSelect.innerHTML = '';
      for (const dev of this.devices) {
        const opt = document.createElement('option');
        opt.value = dev.id;
        const modeBadge = dev.mode === 'reverse_tunnel' ? '[反向隧道]' : (dev.id === 'localhost' ? '[本地]' : '[主动SSH]');
        opt.textContent = `${dev.name || dev.id} ${modeBadge} (${dev.remoteAddr})`;
        this.deviceSelect.appendChild(opt);
      }

      if (this.devices.some(d => d.id === this.currentDeviceId)) {
        this.deviceSelect.value = this.currentDeviceId;
      } else if (this.devices.length > 0) {
        this.currentDeviceId = this.devices[0].id;
        this.deviceSelect.value = this.currentDeviceId;
      }

      this.updateDeviceStatus();
    } catch (err) {
      console.error('Failed to fetch devices:', err);
    }
  }

  updateDeviceStatus() {
    const dev = this.devices.find(d => d.id === this.currentDeviceId);
    const online = dev && dev.status === 'online';
    this.deviceStatusDot.className = `status-dot ${online ? 'online' : 'offline'}`;
  }

  // --- Terminal ---
  initTerminal() {
    if (typeof Terminal === 'undefined') return;

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
      },
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.terminalContainer);
    this.fitAddon.fit();

    window.addEventListener('resize', () => {
      if (this.fitAddon) {
        this.fitAddon.fit();
        if (this.termWS && this.termWS.readyState === WebSocket.OPEN) {
          this.termWS.send(JSON.stringify({
            type: 'resize',
            cols: this.term.cols,
            rows: this.term.rows,
          }));
        }
      }
    });

    this.term.onData((data) => {
      if (this.termWS && this.termWS.readyState === WebSocket.OPEN) {
        this.termWS.send(data);
      }
    });

    this.connectTerminal();
  }

  connectTerminal() {
    if (!this.term) return;
    if (this.termWS) {
      try { this.termWS.close(); } catch {}
      this.termWS = null;
    }

    this.term.reset();
    this.term.writeln(`\x1b[33m[Pi Web Gateway]\x1b[0m 正在连接设备终端: ${this.currentDeviceId}...`);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const cmd = encodeURIComponent(this.termCmdInput.value.trim());
    const wsUrl = `${protocol}//${host}/ws/terminal?deviceId=${encodeURIComponent(this.currentDeviceId)}&cols=${this.term.cols}&rows=${this.term.rows}${cmd ? `&cmd=${cmd}` : ''}`;

    this.termWS = new WebSocket(wsUrl);

    this.termWS.onopen = () => {
      this.term.writeln(`\x1b[32m[Pi Web Gateway]\x1b[0m 设备终端通道已建立。\r\n`);
    };

    this.termWS.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'exit') {
            this.term.writeln(`\r\n\x1b[33m[Process exited with code ${parsed.code}]\x1b[0m\r\n`);
            return;
          }
        } catch {}
        this.term.write(event.data);
      } else if (event.data instanceof Blob) {
        event.data.text().then(t => this.term.write(t));
      }
    };

    this.termWS.onclose = () => {
      this.term.writeln(`\r\n\x1b[31m[Pi Web Gateway]\x1b[0m 终端连接已断开。\r\n`);
    };

    this.termWS.onerror = (err) => {
      this.term.writeln(`\r\n\x1b[31m[WebSocket Error]\x1b[0m 无法连接到终端网关。\r\n`);
    };
  }

  // --- Pi Agent RPC ---
  connectAgent() {
    if (this.agentWS) {
      try { this.agentWS.close(); } catch {}
      this.agentWS = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/agent?deviceId=${encodeURIComponent(this.currentDeviceId)}`;

    this.agentWS = new WebSocket(wsUrl);

    this.agentWS.onopen = () => {
      this.appendAgentMessage('system', `已挂载设备 [${this.currentDeviceId}] 的 Pi RPC 远程通道`);
    };

    this.agentWS.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleAgentEvent(msg);
      } catch {
        this.appendAgentMessage('assistant', event.data);
      }
    };

    this.agentWS.onclose = () => {
      this.abortAgentBtn.disabled = true;
    };
  }

  sendPrompt() {
    const text = this.promptInput.value.trim();
    if (!text) return;

    if (!this.agentWS || this.agentWS.readyState !== WebSocket.OPEN) {
      this.connectAgent();
    }

    this.appendAgentMessage('user', text);
    this.promptInput.value = '';
    this.abortAgentBtn.disabled = false;

    // Send RPC message
    this.agentWS.send(JSON.stringify({
      type: 'prompt',
      message: text,
    }));
  }

  abortAgent() {
    if (this.agentWS && this.agentWS.readyState === WebSocket.OPEN) {
      this.agentWS.send(JSON.stringify({ type: 'abort' }));
      this.abortAgentBtn.disabled = true;
      this.appendAgentMessage('system', '⏹️ 已发送中止指令');
    }
  }

  handleAgentEvent(msg) {
    if (msg.type === 'message_update') {
      // Streamed token chunk
      this.updateLastAssistantBubble(msg.content || msg.delta || '');
    } else if (msg.type === 'tool_call') {
      this.appendAgentMessage('tool', `🛠️ 工具调用: ${msg.tool} ${JSON.stringify(msg.args)}`);
    } else if (msg.type === 'tool_result') {
      this.appendAgentMessage('tool', `✅ 工具返回: ${msg.output?.slice(0, 200)}...`);
    } else if (msg.type === 'agent_settled' || msg.type === 'turn_complete') {
      this.abortAgentBtn.disabled = true;
      this.appendAgentMessage('system', '✓ 本轮回答结束');
    } else if (msg.type === 'error') {
      this.appendAgentMessage('system', `❌ 错误: ${msg.error}`);
      this.abortAgentBtn.disabled = true;
    }
  }

  appendAgentMessage(type, content) {
    const bubble = document.createElement('div');
    bubble.className = `agent-msg-bubble ${type}`;
    bubble.textContent = content;
    this.agentMessages.appendChild(bubble);
    this.agentMessages.scrollTop = this.agentMessages.scrollHeight;
    return bubble;
  }

  updateLastAssistantBubble(chunk) {
    let last = this.agentMessages.lastElementChild;
    if (!last || !last.classList.contains('assistant')) {
      last = this.appendAgentMessage('assistant', '');
    }
    last.textContent += chunk;
    this.agentMessages.scrollTop = this.agentMessages.scrollHeight;
  }

  // --- Remote Files ---
  async loadFiles() {
    const dir = this.filePathInput.value.trim() || '.';
    this.fileList.innerHTML = '<div style="padding: 8px; color: var(--text-muted)">正在读取远程文件...</div>';

    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(this.currentDeviceId)}/files?path=${encodeURIComponent(dir)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.fileList.innerHTML = '';

      // Back to parent directory
      if (dir !== '.' && dir !== '/' && dir !== '') {
        const parentItem = document.createElement('div');
        parentItem.className = 'file-item';
        parentItem.textContent = '📁 ..';
        parentItem.onclick = () => {
          const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
          parts.pop();
          this.filePathInput.value = parts.join('/') || '.';
          this.loadFiles();
        };
        this.fileList.appendChild(parentItem);
      }

      data.entries.sort((a, b) => (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0) || a.name.localeCompare(b.name));

      for (const item of data.entries) {
        const itemEl = document.createElement('div');
        itemEl.className = 'file-item';
        itemEl.textContent = `${item.isDirectory ? '📁' : '📄'} ${item.name}`;

        itemEl.onclick = () => {
          document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
          itemEl.classList.add('selected');

          if (item.isDirectory) {
            this.filePathInput.value = item.path;
            this.loadFiles();
          } else {
            this.previewFile(item.path);
          }
        };

        this.fileList.appendChild(itemEl);
      }
    } catch (err) {
      this.fileList.innerHTML = `<div style="padding: 8px; color: var(--danger)">读取失败: ${err.message}</div>`;
    }
  }

  async previewFile(filePath) {
    this.filePreviewHeader.textContent = `查看文件: ${filePath}`;
    this.filePreviewBody.textContent = '正在加载内容...';

    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(this.currentDeviceId)}/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      this.filePreviewBody.textContent = text;
    } catch (err) {
      this.filePreviewBody.textContent = `无法加载文件内容: ${err.message}`;
    }
  }

  // --- Git Status & Diff ---
  async refreshGit() {
    const cwd = this.gitCwdInput.value.trim() || '.';
    this.gitStatusPre.textContent = '正在查询 Git Status...';
    this.gitDiffPre.textContent = '正在查询 Git Diff...';

    try {
      const statusRes = await fetch(`/api/devices/${encodeURIComponent(this.currentDeviceId)}/git/status?cwd=${encodeURIComponent(cwd)}`);
      const statusData = await statusRes.json();
      this.gitStatusPre.textContent = statusData.stdout || (statusData.stderr ? `Error: ${statusData.stderr}` : 'Working tree clean');

      const diffRes = await fetch(`/api/devices/${encodeURIComponent(this.currentDeviceId)}/git/diff?cwd=${encodeURIComponent(cwd)}`);
      const diffData = await diffRes.json();
      this.gitDiffPre.textContent = diffData.stdout || '无变更 (No diff)';
    } catch (err) {
      this.gitStatusPre.textContent = `Git 查询失败: ${err.message}`;
      this.gitDiffPre.textContent = '';
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PiWebClient();
});
