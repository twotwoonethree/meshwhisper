// MeshWhisper SDK - Demo UI Client
// Vanilla JS, no dependencies

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let ws = null;
  let reconnectTimer = null;
  let debugPollTimer = null;
  let selectedPeerId = null;
  let localPeerId = null;

  // peerId -> Array<{ text, from, timestamp, type }>
  const messageStore = new Map();

  // peerId -> unread count (for badges)
  const unreadCounts = new Map();

  // Latest peer list from server
  let peerList = [];

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------

  const dom = {
    peerName:          document.getElementById('peer-name'),
    statusIndicator:   document.getElementById('status-indicator'),
    connectAddress:    document.getElementById('connect-address'),
    connectBtn:        document.getElementById('connect-btn'),
    contactDataOutput: document.getElementById('contact-data-output'),
    generateContactBtn:document.getElementById('generate-contact-btn'),
    contactDataInput:  document.getElementById('contact-data-input'),
    acceptContactBtn:  document.getElementById('accept-contact-btn'),
    peersList:         document.getElementById('peers-list'),
    chatHeaderName:    document.getElementById('chat-header-name'),
    messagesContainer: document.getElementById('messages-container'),
    messageInput:      document.getElementById('message-input'),
    sendBtn:           document.getElementById('send-btn'),
    debugToggle:       document.getElementById('debug-toggle'),
    debugClose:        document.getElementById('debug-close'),
    debugPanel:        document.getElementById('debug-panel'),
    debugContent:      document.getElementById('debug-content'),
  };

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  const RECONNECT_DELAY = 2000;

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const url = `ws://${location.host}`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      setConnectionStatus(true);
      clearTimeout(reconnectTimer);
      send({ type: 'get_status' });
      send({ type: 'get_peers' });
      startDebugPolling();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.warn('Non-JSON message from server:', event.data);
        return;
      }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      setConnectionStatus(false);
      stopDebugPolling();
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // The close event will fire after this; reconnect happens there.
    });
  };

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  };

  // ---------------------------------------------------------------------------
  // Connection status indicator
  // ---------------------------------------------------------------------------

  const setConnectionStatus = (online) => {
    if (!dom.statusIndicator) return;
    dom.statusIndicator.classList.toggle('online', online);
    dom.statusIndicator.classList.toggle('offline', !online);
    dom.statusIndicator.title = online ? 'Connected' : 'Disconnected';
  };

  // ---------------------------------------------------------------------------
  // Server message dispatcher
  // ---------------------------------------------------------------------------

  const handleServerMessage = (msg) => {
    switch (msg.type) {
      case 'status':
        handleStatus(msg);
        break;
      case 'peers':
        handlePeers(msg);
        break;
      case 'message':
        handleIncomingMessage(msg);
        break;
      case 'sent':
        handleSentConfirmation(msg);
        break;
      case 'system':
        handleSystemMessage(msg);
        break;
      case 'contact_info':
        handleContactInfo(msg);
        break;
      case 'debug':
        handleDebug(msg);
        break;
      default:
        console.log('Unknown message type:', msg.type, msg);
    }
  };

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  const handleStatus = ({ peerId, peerName }) => {
    localPeerId = peerId;
    if (dom.peerName) {
      dom.peerName.textContent = peerName || peerId || 'Unknown';
    }
  };

  // ---------------------------------------------------------------------------
  // Peer list
  // ---------------------------------------------------------------------------

  const handlePeers = ({ list }) => {
    peerList = list || [];
    renderPeerList();
  };

  const renderPeerList = () => {
    if (!dom.peersList) return;
    dom.peersList.innerHTML = '';

    if (peerList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'peers-empty';
      empty.textContent = 'No contacts yet';
      dom.peersList.appendChild(empty);
      return;
    }

    peerList.forEach((peer) => {
      const item = document.createElement('div');
      item.className = 'peer-item';
      if (peer.id === selectedPeerId) {
        item.classList.add('active');
      }

      // Online/offline dot
      const dot = document.createElement('span');
      dot.className = `peer-status-dot ${peer.status === 'connected' ? 'online' : 'offline'}`;
      item.appendChild(dot);

      // Name
      const name = document.createElement('span');
      name.className = 'peer-name-label';
      name.textContent = peer.name || peer.id;
      item.appendChild(name);

      // Unread badge
      const unread = unreadCounts.get(peer.id) || 0;
      if (unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = unread > 99 ? '99+' : unread;
        item.appendChild(badge);
      }

      item.addEventListener('click', () => selectPeer(peer.id));
      dom.peersList.appendChild(item);
    });
  };

  const selectPeer = (peerId) => {
    selectedPeerId = peerId;

    // Clear unread count
    unreadCounts.set(peerId, 0);

    // Update header
    const peer = peerList.find((p) => p.id === peerId);
    if (dom.chatHeaderName) {
      dom.chatHeaderName.textContent = peer ? (peer.name || peer.id) : peerId;
    }

    // Enable send controls
    if (dom.messageInput) {
      dom.messageInput.disabled = false;
      dom.messageInput.focus();
    }
    if (dom.sendBtn) {
      dom.sendBtn.disabled = false;
    }

    renderPeerList();
    renderMessages();
  };

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  const ensureMessageList = (peerId) => {
    if (!messageStore.has(peerId)) {
      messageStore.set(peerId, []);
    }
    return messageStore.get(peerId);
  };

  const handleIncomingMessage = ({ from, fromName, text, timestamp }) => {
    const msgs = ensureMessageList(from);
    msgs.push({ text, from: fromName || from, timestamp, type: 'received' });

    if (from === selectedPeerId) {
      renderMessages();
    } else {
      // Increment unread badge
      unreadCounts.set(from, (unreadCounts.get(from) || 0) + 1);
      renderPeerList();
    }

    // Refresh peer list in case this is a new peer
    send({ type: 'get_peers' });
  };

  const handleSentConfirmation = ({ to, text, timestamp }) => {
    const msgs = ensureMessageList(to);
    msgs.push({ text, from: 'me', timestamp, type: 'sent' });

    if (to === selectedPeerId) {
      renderMessages();
    }
  };

  const handleSystemMessage = ({ text }) => {
    // Show system message in current chat (if a peer is selected) and also
    // as a global notification.  If it mentions a specific peer we could
    // route it, but for simplicity put it in the active conversation.
    if (selectedPeerId) {
      const msgs = ensureMessageList(selectedPeerId);
      msgs.push({ text, from: 'system', timestamp: Date.now(), type: 'system' });
      renderMessages();
    }

    // Refresh peers on system events (connections, etc.)
    send({ type: 'get_peers' });
  };

  const renderMessages = () => {
    if (!dom.messagesContainer) return;

    if (!selectedPeerId) {
      dom.messagesContainer.innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">&#11042;</div>' +
        '<p>Select a contact to start messaging</p>' +
        '<p class="text-muted">or connect to a peer using the sidebar</p></div>';
      return;
    }

    const msgs = messageStore.get(selectedPeerId) || [];

    if (msgs.length === 0) {
      dom.messagesContainer.innerHTML =
        '<div class="empty-state"><p>No messages yet. Say hello!</p></div>';
      return;
    }

    dom.messagesContainer.innerHTML = '';

    msgs.forEach(({ text, from, timestamp, type }) => {
      const wrapper = document.createElement('div');

      if (type === 'system') {
        // System message: centered label
        wrapper.className = 'message message-system';
        const span = document.createElement('span');
        span.className = 'message-system-text';
        span.textContent = text;
        wrapper.appendChild(span);
      } else {
        // Sent or received message bubble
        const cssType = type === 'sent' ? 'message-sent' : 'message-received';
        wrapper.className = `message ${cssType}`;

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        const p = document.createElement('p');
        p.className = 'message-text';
        p.textContent = text;
        bubble.appendChild(p);
        wrapper.appendChild(bubble);

        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = formatTime(timestamp);
        wrapper.appendChild(time);
      }

      dom.messagesContainer.appendChild(wrapper);
    });

    // Auto-scroll to bottom
    dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
  };

  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    return `${hours}:${mins}`;
  };

  const sendMessage = () => {
    if (!dom.messageInput) return;
    const text = dom.messageInput.value.trim();
    if (!text || !selectedPeerId) return;

    send({ type: 'send', to: selectedPeerId, text });
    dom.messageInput.value = '';
    dom.messageInput.focus();
  };

  // ---------------------------------------------------------------------------
  // Connect to peer
  // ---------------------------------------------------------------------------

  const connectToPeer = () => {
    if (!dom.connectAddress) return;
    const address = dom.connectAddress.value.trim();
    if (!address) return;
    send({ type: 'connect', address });
  };

  // ---------------------------------------------------------------------------
  // Contact exchange
  // ---------------------------------------------------------------------------

  const generateContactInfo = () => {
    send({ type: 'get_contact_info' });
  };

  const handleContactInfo = ({ data }) => {
    if (dom.contactDataOutput) {
      dom.contactDataOutput.textContent = data || '';
      dom.contactDataOutput.removeAttribute('hidden');
    }
  };

  const acceptContact = () => {
    if (!dom.contactDataInput) return;
    const data = dom.contactDataInput.value.trim();
    if (!data) return;
    send({ type: 'accept_contact', data });
    dom.contactDataInput.value = '';
  };

  // ---------------------------------------------------------------------------
  // Debug panel
  // ---------------------------------------------------------------------------

  const DEBUG_POLL_INTERVAL = 2000;

  const isDebugVisible = () => {
    if (!dom.debugPanel) return false;
    return !dom.debugPanel.classList.contains('collapsed');
  };

  const toggleDebug = () => {
    if (!dom.debugPanel) return;
    const isHidden = dom.debugPanel.classList.toggle('collapsed');
    if (!isHidden) {
      // Just became visible -- fetch immediately
      send({ type: 'get_debug' });
      startDebugPolling();
    } else {
      stopDebugPolling();
    }
  };

  const startDebugPolling = () => {
    stopDebugPolling();
    debugPollTimer = setInterval(() => {
      if (isDebugVisible()) {
        send({ type: 'get_debug' });
      }
    }, DEBUG_POLL_INTERVAL);
  };

  const stopDebugPolling = () => {
    clearInterval(debugPollTimer);
    debugPollTimer = null;
  };

  const handleDebug = (data) => {
    if (!dom.debugContent) return;
    // Remove the "type" field from displayed data for cleanliness
    const { type, ...rest } = data;
    const pre = dom.debugContent.querySelector('.debug-json') || dom.debugContent;
    pre.textContent = JSON.stringify(rest, null, 2);
  };

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  const bindEvents = () => {
    // Send message
    if (dom.sendBtn) {
      dom.sendBtn.addEventListener('click', sendMessage);
    }

    // Enter to send, Shift+Enter for newline
    if (dom.messageInput) {
      dom.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    // Connect to peer
    if (dom.connectBtn) {
      dom.connectBtn.addEventListener('click', connectToPeer);
    }
    if (dom.connectAddress) {
      dom.connectAddress.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          connectToPeer();
        }
      });
    }

    // Contact exchange
    if (dom.generateContactBtn) {
      dom.generateContactBtn.addEventListener('click', generateContactInfo);
    }
    if (dom.acceptContactBtn) {
      dom.acceptContactBtn.addEventListener('click', acceptContact);
    }

    // Debug toggle
    if (dom.debugToggle) {
      dom.debugToggle.addEventListener('click', toggleDebug);
    }
    if (dom.debugClose) {
      dom.debugClose.addEventListener('click', () => {
        if (dom.debugPanel) {
          dom.debugPanel.classList.add('collapsed');
          stopDebugPolling();
        }
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  const init = () => {
    setConnectionStatus(false);
    renderMessages(); // Show placeholder
    bindEvents();
    connect();
  };

  // Start once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
