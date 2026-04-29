(() => {
  // ── Theme init (runs before first render to avoid flash) ──────────────────
  const _mq = window.matchMedia('(prefers-color-scheme: dark)');
  function _applyTheme(name) {
    if (name === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  const _storedTheme = localStorage.getItem('hermes-theme');
  _applyTheme(_storedTheme || (_mq.matches ? 'dark' : 'light'));
  // Follow OS changes only when user hasn't made a manual choice
  _mq.addEventListener('change', e => {
    if (!localStorage.getItem('hermes-theme')) {
      _applyTheme(e.matches ? 'dark' : 'light');
    }
  });

  // ── State ──
  let currentSessionId = localStorage.getItem('hermes-session-id') || null;
  let streaming = false;

  // ── DOM refs ──
  const loginOverlay = document.getElementById('login-overlay');
  const appEl = document.getElementById('app');
  const pwInput = document.getElementById('pw-input');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');
  const sessionList = document.getElementById('session-list');
  const thread = document.getElementById('thread');
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const newSessionBtn = document.getElementById('new-session-btn');
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sessionLostBanner = document.getElementById('session-lost-banner');
  const sessionLostDismiss = document.getElementById('session-lost-dismiss');
  const logoutBtn = document.getElementById('logout-btn');
  const searchInput = document.getElementById('search-input');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');

  // ── Utilities ──
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
  }
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('open');
  }
  hamburger.addEventListener('click', openSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);

  function scrollToBottom() {
    thread.scrollTop = thread.scrollHeight;
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts.includes('T') || ts.includes('Z') ? ts : ts + 'Z');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }

  // Auto-resize textarea
  msgInput.addEventListener('input', () => {
    // Capture scroll state before layout changes
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 10;
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px';
    // Restore bottom-pinned position after reflow
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  });

  // Enter = send, Shift+Enter = newline
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) sendMessage();
    }
  });

  // ── Login ──
  async function checkAuth() {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      showApp();
    } else {
      loginOverlay.classList.remove('hidden');
    }
  }

  async function doLogin() {
    loginError.textContent = '';
    const pw = pwInput.value;
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) {
      loginOverlay.classList.add('hidden');
      // Fresh login always starts with a clean session slate.
      // Prevents the session-lost banner from firing when the server was
      // restarted (in-memory mapping cleared) but localStorage still holds
      // a stale session ID from a prior run.
      currentSessionId = null;
      localStorage.removeItem('hermes-session-id');
      // Reset any iOS zoom that may have been triggered by the password field
      const mv = document.querySelector('meta[name=viewport]');
      if (mv) {
        mv.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
      }
      showApp();
    } else if (res.status === 401) {
      loginError.textContent = 'Wrong password';
    } else if (res.status === 429) {
      loginError.textContent = 'Too many attempts — wait 60 s';
    } else {
      loginError.textContent = 'Login failed';
    }
  }

  loginBtn.addEventListener('click', doLogin);
  pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  function showApp() {
    loginOverlay.classList.add('hidden');
    appEl.classList.remove('hidden');
    loadSessions();
    validateSession();
  }

  async function validateSession() {
    // Only meaningful if the client thinks it has an active session.
    // If currentSessionId is null we're already in a clean state.
    if (!currentSessionId) return;
    try {
      const res = await fetch('/api/session/validate');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.valid) {
        sessionLostBanner.classList.add('visible');
      }
    } catch {}
  }

  function dismissSessionLostBanner() {
    sessionLostBanner.classList.remove('visible');
  }

  sessionLostDismiss.addEventListener('click', dismissSessionLostBanner);

  logoutBtn.addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    localStorage.removeItem('hermes-session-id');
    location.reload();
  });

  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    _applyTheme(next);
    localStorage.setItem('hermes-theme', next);
  });

  // ── Sessions ──
  async function loadSessions() {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      const sessions = await res.json();
      // Don't overwrite active search results
      if (!searchInput.value.trim()) {
        renderSessions(sessions);
      }
      // Always update the active highlight (works on whatever is currently in the list)
      updateActiveSession();
    } catch {}
  }

  async function _renameSession(id, titleEl) {
    const currentName = titleEl.textContent;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-title-input';
    input.value = currentName;

    // Prevent taps on the input from bubbling to the session-item click listener
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    async function commit() {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch(`/api/sessions/${encodeURIComponent(id)}/rename`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
          titleEl.textContent = newName;
        } catch {
          titleEl.textContent = currentName;
        }
      } else {
        titleEl.textContent = currentName;
      }
      input.replaceWith(titleEl);
    }

    function cancel() {
      if (committed) return;
      committed = true;
      titleEl.textContent = currentName;
      input.replaceWith(titleEl);
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  function renderSessions(sessions, searchMode = false) {
    sessionList.innerHTML = '';
    for (const s of sessions) {
      const el = document.createElement('div');
      el.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      el.dataset.id = s.id;
      const title = s.title || s.id.slice(0, 16) + '…';
      el.innerHTML = `<div class="session-title">${esc(title)}</div>
        <div class="session-date">${esc(formatDate(s.started_at))}</div>`;
      if (searchMode && s.match_snippet) {
        el.innerHTML += `<div class="session-snippet">${esc(s.match_snippet)}</div>`;
      }
      el.addEventListener('click', () => {
        const anchor = searchMode ? (s.match_offset || null) : null;
        loadSession(s.id, anchor);
        if (searchMode) {
          searchInput.value = '';
          loadSessions();
        }
      });
      const titleEl = el.querySelector('.session-title');
      titleEl.addEventListener('dblclick', e => {
        e.stopPropagation();
        _renameSession(s.id, titleEl);
      });
      // Mobile: single tap on title of already-active session triggers rename.
      // Guard: skip if titleEl is already replaced by the rename input (dblclick fires
      // two click events on desktop -- the second would re-enter _renameSession).
      titleEl.addEventListener('click', e => {
        if (currentSessionId === s.id && titleEl.isConnected) {
          e.stopPropagation();
          _renameSession(s.id, titleEl);
        }
      });
      sessionList.appendChild(el);
    }
    sessionList.scrollTop = 0;
  }

  function _addOptimisticSession(firstMsg) {
    // Remove any existing optimistic entry first
    const existing = document.getElementById('optimistic-session');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'optimistic-session';
    el.className = 'session-item active';
    el.innerHTML = `<div class="session-title">${esc(firstMsg.slice(0, 72))}</div>
      <div class="session-date">Just now</div>`;
    sessionList.prepend(el);
    sessionList.scrollTop = 0;
  }

  // ── Search ──
  let _searchTimer = null;
  function _onSearchInput() {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (!q) {
        loadSessions();
        return;
      }
      try {
        const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const sessions = await res.json();
        renderSessions(sessions, true);
      } catch {}
    }, 300);
  }
  searchInput.addEventListener('input', _onSearchInput);
  searchInput.addEventListener('search', _onSearchInput);

  async function loadSession(id, anchorTs = null) {
    currentSessionId = id;
    dismissSessionLostBanner();
    closeSidebar();
    updateActiveSession();
    // Reset any iOS zoom that may have been triggered by the search input
    const mv = document.querySelector('meta[name=viewport]');
    if (mv) mv.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
    thread.innerHTML = '';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
      if (!res.ok) return;
      const messages = await res.json();
      for (const m of messages) {
        appendMessage(m.role, m.content, m.timestamp);
      }
      scrollToBottom();
      if (anchorTs) {
        const target = thread.querySelector(`[data-ts-raw="${anchorTs}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    } catch {}
  }

  function updateActiveSession() {
    document.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === currentSessionId);
    });
  }

  newSessionBtn.addEventListener('click', () => {
    currentSessionId = null;
    localStorage.removeItem('hermes-session-id');
    dismissSessionLostBanner();
    thread.innerHTML = '';
    updateActiveSession();
    closeSidebar();
    msgInput.focus();
  });

  // ── Message rendering ──
  function _attachCopyButtons(bubble) {
    bubble.querySelectorAll('pre').forEach(pre => {
      // Don't double-add if already present
      if (pre.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code');
        const text = code ? code.innerText : pre.innerText;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        } catch {
          btn.textContent = 'Error';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        }
      });
      pre.appendChild(btn);
    });
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    if (!ts) return '';
    try {
      // ts can be a Unix float (from DB) or ms timestamp (from Date.now())
      const ms = ts > 1e11 ? ts : ts * 1000;
      const d = new Date(ms);
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return ''; }
  }

  function appendMessage(role, content, ts = null) {
    const msg = document.createElement('div');
    msg.className = `msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'assistant') {
      bubble.innerHTML = content ? DOMPurify.sanitize(marked.parse(content)) : '';
      _attachCopyButtons(bubble);
    } else {
      bubble.textContent = content || '';
    }
    if (ts) {
      bubble.dataset.ts = formatTime(ts);
      bubble.dataset.tsRaw = ts;  // raw value for anchor lookup
    }
    msg.appendChild(bubble);
    thread.appendChild(msg);
    scrollToBottom();
    return bubble;
  }

  function showThinking() {
    const msg = document.createElement('div');
    msg.id = 'thinking-indicator';
    msg.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.style.cssText = 'color:var(--accent);letter-spacing:3px;animation:pulse 1.2s ease-in-out infinite;';
    bubble.textContent = '● ● ●';
    msg.appendChild(bubble);
    thread.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function removeThinking() {
    const el = document.getElementById('thinking-indicator');
    if (el) el.remove();
  }

  // ── Send ──
  sendBtn.addEventListener('click', sendMessage);

  async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || streaming) return;

    streaming = true;
    sendBtn.disabled = true;
    msgInput.value = '';
    msgInput.style.height = 'auto';
    dismissSessionLostBanner();

    // Optimistic session entry for new sessions — replaced by loadSessions() at stream end
    if (!currentSessionId && !searchInput.value.trim()) {
      _addOptimisticSession(text);
    }
    appendMessage('user', text, Date.now());
    showThinking();

    let assistantBubble = null;
    let assistantContent = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: currentSessionId }),
      });

      if (!res.ok) {
        removeThinking();
        appendMessage('assistant', '_(Error contacting server)_');
        return;
      }

      // Capture session id from response headers
      const newSessionId = res.headers.get('X-Hermes-Session-Id');
      if (newSessionId) {
        const wasNew = !currentSessionId;
        currentSessionId = newSessionId;
        localStorage.setItem('hermes-session-id', currentSessionId);
        if (wasNew) await loadSessions();
        updateActiveSession();
      }

      const reader = res.body.getReader();
        const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (split on double newline)
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete last part

        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = 'message';
          let dataLine = null;
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLine = line.slice(5).trim();
            }
          }
          if (!dataLine || dataLine === '[DONE]') continue;
          try {
            const json = JSON.parse(dataLine);
            if (eventType === 'session' && json.hermes_session_id) {
              // Capture session ID emitted by proxy at end of stream
              currentSessionId = json.hermes_session_id;
              localStorage.setItem('hermes-session-id', currentSessionId);
              await loadSessions();
              updateActiveSession();
            } else {
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) {
                if (!assistantBubble) {
                  removeThinking();
                  const msg = document.createElement('div');
                  msg.className = 'msg assistant';
                  assistantBubble = document.createElement('div');
                  assistantBubble.className = 'bubble';
                  assistantBubble.dataset.ts = formatTime(Date.now());
                  msg.appendChild(assistantBubble);
                  thread.appendChild(msg);
                }
                assistantContent += delta;
                assistantBubble.innerHTML = DOMPurify.sanitize(marked.parse(assistantContent));
                scrollToBottom();
              }
            }
          } catch {}
        }
      }

      // Process any remaining buffer
      if (buffer) {
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content;
            if (delta) {
              assistantContent += delta;
              if (assistantBubble) {
                assistantBubble.innerHTML = DOMPurify.sanitize(marked.parse(assistantContent));
                scrollToBottom();
              }
            }
          } catch {}
        }
      }

      // Final render (ensure complete markdown)
      if (assistantBubble && assistantContent) {
        assistantBubble.innerHTML = DOMPurify.sanitize(marked.parse(assistantContent));
        _attachCopyButtons(assistantBubble);
      }

      // Refresh sessions after first message in new session
      if (newSessionId) await loadSessions();

    } catch (err) {
      removeThinking();
      if (!assistantBubble) {
        appendMessage('assistant', '_(Stream error)_');
      }
    } finally {
      streaming = false;
      sendBtn.disabled = false;
      msgInput.focus();
    }
  }

  // ── Boot ──
  checkAuth();
})();