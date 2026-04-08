/* ═══════════════════════════════════════════════════════════
   CCTV Dashboard – app.js
   ═══════════════════════════════════════════════════════════ */

const API = '';  // same origin
let cameras = [];
let ws = null;
let pingIntervalId = null;
let currentView = 'dashboard';
let activeCols = 2;

// Brand → RTSP URL template builder
const RTSP_TEMPLATES = {
  Amcrest:   (ip, port, user, pass) => `rtsp://${cred(user,pass)}${ip}:${port}/cam/realmonitor?channel=1&subtype=0`,
  Dahua:     (ip, port, user, pass) => `rtsp://${cred(user,pass)}${ip}:${port}/cam/realmonitor?channel=1&subtype=0`,
  Reolink:   (ip, port, user, pass) => `rtsp://${cred(user,pass)}${ip}:${port}//h264Preview_01_main`,
  Hikvision: (ip, port, user, pass) => `rtsp://${cred(user,pass)}${ip}:${port}/Streaming/Channels/101`,
  Axis:      (ip, port, user, pass) => `rtsp://${cred(user,pass)}${ip}:${port}/axis-media/media.amp`,
  Foscam:    (ip, port, user, pass) => `rtsp://${cred(user,pass)}${ip}:${port}/videoMain`,
  Ring:      () => '',  // Ring uses cloud
};

const BRAND_ICONS = {
  Amcrest: 'fas fa-video',
  Ring: 'fas fa-bell',
  Reolink: 'fas fa-camera',
  Hikvision: 'fas fa-shield-alt',
  Dahua: 'fas fa-eye',
  Axis: 'fas fa-circle',
  Foscam: 'fas fa-video',
  Unknown: 'fas fa-question-circle',
  Generic: 'fas fa-question-circle',
};

function cred(user, pass) {
  if (user && pass) return `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  if (user) return `${encodeURIComponent(user)}@`;
  return '';
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  loadSettings();
  setupNav();
  setupModals();
  setupForms();
  setupFilters();
  connectWS();
  await fetchCameras();
  await fetchSubnet();
  startAutoPing();

  document.getElementById('pingAllBtn').addEventListener('click', pingAll);
  document.getElementById('addCameraBtn').addEventListener('click', () => switchView('add-manual'));
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Close sidebar on mobile when clicking main
  document.querySelector('.main-content').addEventListener('click', () => {
    if (window.innerWidth < 600) {
      document.getElementById('sidebar').classList.remove('open');
    }
  });
});

/* ══════════════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════════════ */
function loadSettings() {
  const theme = localStorage.getItem('cctv_theme') || 'dark';
  setTheme(theme, false);
  document.getElementById('themeSelect').value = theme;

  const cols = parseInt(localStorage.getItem('cctv_cols') || '2');
  activeCols = cols;
  setGridCols(cols, false);
  document.getElementById('defaultCols').value = cols;

  const interval = localStorage.getItem('cctv_ping_interval') || '60';
  document.getElementById('pingInterval').value = interval;
}

function setTheme(val, save = true) {
  document.body.classList.toggle('light', val === 'light');
  if (save) localStorage.setItem('cctv_theme', val);
}

function setDefaultCols(val) {
  activeCols = parseInt(val);
  setGridCols(activeCols);
  localStorage.setItem('cctv_cols', val);
}

function setGridCols(cols, save = true) {
  const grid = document.getElementById('dashboardGrid');
  grid.className = `camera-grid cols-${cols}`;
  document.querySelectorAll('.layout-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.cols) === cols);
  });
  if (save) localStorage.setItem('cctv_cols', cols);
}

function setPingInterval(val) {
  localStorage.setItem('cctv_ping_interval', val);
  startAutoPing();
}

function startAutoPing() {
  if (pingIntervalId) clearInterval(pingIntervalId);
  const interval = parseInt(localStorage.getItem('cctv_ping_interval') || '60');
  if (interval > 0) {
    pingIntervalId = setInterval(pingAll, interval * 1000);
  }
}

/* ══════════════════════════════════════════════════════════════
   WEBSOCKET
   ══════════════════════════════════════════════════════════════ */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  const statusEl = document.getElementById('wsStatus');

  ws.onopen = () => {
    statusEl.innerHTML = '<span class="dot online"></span> Live';
  };
  ws.onclose = () => {
    statusEl.innerHTML = '<span class="dot offline"></span> Disconnected';
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    } catch {}
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'camera_added':
      if (!cameras.find(c => c.id === msg.camera.id)) {
        cameras.push(msg.camera);
        renderAll();
      }
      break;
    case 'camera_updated': {
      const idx = cameras.findIndex(c => c.id === msg.camera.id);
      if (idx !== -1) { cameras[idx] = msg.camera; renderAll(); }
      break;
    }
    case 'camera_removed':
      cameras = cameras.filter(c => c.id !== msg.id);
      renderAll();
      break;
    case 'cameras_status_update':
      cameras = msg.cameras;
      renderAll();
      break;
    case 'scan_started':
      document.getElementById('scanProgressWrap').style.display = 'block';
      document.getElementById('startScanBtn').style.display = 'none';
      document.getElementById('stopScanBtn').style.display = 'inline-flex';
      document.getElementById('scanResults').innerHTML = '';
      document.getElementById('scanResultsBadge').textContent = '0';
      document.getElementById('scanProgressText').textContent = `Scanning ${msg.subnet}.x ...`;
      break;
    case 'scan_progress':
      document.getElementById('scanProgressBar').style.width = msg.progress + '%';
      document.getElementById('scanProgressText').textContent =
        `Scanned ${msg.scanned} / ${msg.total}`;
      break;
    case 'scan_found':
      appendScanResult(msg.camera);
      break;
    case 'scan_complete':
      document.getElementById('startScanBtn').style.display = 'inline-flex';
      document.getElementById('stopScanBtn').style.display = 'none';
      document.getElementById('scanProgressText').textContent = 'Scan complete';
      document.getElementById('scanProgressBar').style.width = '100%';
      document.getElementById('scanFoundCount').textContent = `${msg.found} device(s) found`;
      if (msg.found === 0) {
        document.getElementById('scanResults').innerHTML =
          `<div class="empty-state"><i class="fas fa-search"></i><p>No camera-like devices found on this subnet.</p></div>`;
      }
      showToast(`Scan complete – ${msg.found} device(s) found`, 'info');
      break;
  }
}

/* ══════════════════════════════════════════════════════════════
   FETCH
   ══════════════════════════════════════════════════════════════ */
async function fetchCameras() {
  try {
    const r = await fetch(`${API}/api/cameras`);
    cameras = await r.json();
    renderAll();
  } catch (e) {
    showToast('Could not load cameras from server', 'error');
  }
}

async function fetchSubnet() {
  try {
    const r = await fetch(`${API}/api/network/subnet`);
    const { subnet } = await r.json();
    document.getElementById('scanSubnet').value = subnet;
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════════════ */
function renderAll() {
  updateStats();
  renderDashboard();
  renderCameraList();
}

function updateStats() {
  const total = cameras.length;
  const online = cameras.filter(c => c.online === true).length;
  const offline = cameras.filter(c => c.online === false).length;
  const unknown = cameras.filter(c => c.online === undefined || c.online === null).length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statOnline').textContent = online;
  document.getElementById('statOffline').textContent = offline;
  document.getElementById('statUnknown').textContent = unknown;
}

function getFilteredCameras() {
  const brand = document.getElementById('filterBrand').value;
  const status = document.getElementById('filterStatus').value;
  return cameras.filter(c => {
    if (brand && c.brand !== brand) return false;
    if (status === 'online' && !c.online) return false;
    if (status === 'offline' && c.online !== false) return false;
    return true;
  });
}

function renderDashboard() {
  const grid = document.getElementById('dashboardGrid');
  const empty = document.getElementById('dashboardEmpty');
  const filtered = getFilteredCameras();

  // Remove existing camera cards (keep empty state node)
  grid.querySelectorAll('.camera-card').forEach(el => el.remove());

  if (filtered.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  filtered.forEach(cam => {
    grid.appendChild(buildCameraCard(cam));
  });
}

function buildCameraCard(cam) {
  const card = document.createElement('div');
  card.className = `camera-card ${cam.online === true ? 'is-online' : cam.online === false ? 'is-offline' : ''}`;
  card.dataset.id = cam.id;

  const statusClass = cam.online === true ? 'online' : cam.online === false ? 'offline' : 'unknown';
  const statusLabel = cam.online === true ? 'Online' : cam.online === false ? 'Offline' : 'Unknown';
  const brandClass = cam.brand || 'Unknown';
  const icon = BRAND_ICONS[cam.brand] || 'fas fa-camera';

  card.innerHTML = `
    <div class="cam-feed">
      <div class="cam-feed-placeholder">
        <i class="${icon}"></i>
        <span>${cam.type || 'IP Camera'}</span>
      </div>
      <div class="cam-overlay">
        <span class="cam-badge ${statusClass}">${statusLabel}</span>
        ${cam.brand !== 'Unknown' ? `<span class="cam-badge">${cam.brand}</span>` : ''}
      </div>
    </div>
    <div class="cam-info">
      <div class="cam-name">
        <span class="status-dot ${statusClass}"></span>${cam.name}
      </div>
      <div class="cam-meta">
        <span class="cam-ip">${cam.ip || 'No IP'}${cam.httpPort && cam.httpPort !== 80 ? ':'+cam.httpPort : ''}</span>
        <span class="cam-brand-tag ${brandClass}">${cam.brand || 'Unknown'}</span>
        ${cam.location ? `<span style="font-size:0.72rem;color:var(--text2)"><i class="fas fa-map-marker-alt"></i> ${cam.location}</span>` : ''}
      </div>
    </div>
    <div class="cam-actions">
      <button class="cam-btn" onclick="event.stopPropagation();openCameraDetail('${cam.id}')">
        <i class="fas fa-info-circle"></i> Details
      </button>
      ${cam.webUrl ? `<button class="cam-btn" onclick="event.stopPropagation();window.open('${cam.webUrl}','_blank')">
        <i class="fas fa-external-link-alt"></i> Web UI
      </button>` : ''}
      <button class="cam-btn" onclick="event.stopPropagation();openEditModal('${cam.id}')">
        <i class="fas fa-edit"></i> Edit
      </button>
      <button class="cam-btn danger" onclick="event.stopPropagation();deleteCamera('${cam.id}')">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;

  card.addEventListener('click', () => openCameraDetail(cam.id));
  return card;
}

function renderCameraList() {
  const list = document.getElementById('cameraList');
  const search = document.getElementById('cameraSearch').value.toLowerCase();
  list.innerHTML = '';

  const filtered = cameras.filter(c =>
    !search ||
    (c.name || '').toLowerCase().includes(search) ||
    (c.ip || '').includes(search) ||
    (c.brand || '').toLowerCase().includes(search) ||
    (c.location || '').toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state" style="grid-column:1"><i class="fas fa-search"></i><p>No cameras found</p></div>`;
    return;
  }

  filtered.forEach(cam => {
    const icon = BRAND_ICONS[cam.brand] || 'fas fa-camera';
    const statusClass = cam.online === true ? 'online' : cam.online === false ? 'offline' : 'unknown';
    const lastSeen = cam.lastSeen ? new Date(cam.lastSeen).toLocaleString() : 'Never';
    const row = document.createElement('div');
    row.className = `camera-row ${cam.online === true ? 'is-online' : cam.online === false ? 'is-offline' : ''}`;
    row.innerHTML = `
      <div class="cam-row-icon"><i class="${icon}"></i></div>
      <div class="cam-row-info">
        <div class="cam-row-name">
          <span class="status-dot ${statusClass}"></span>${cam.name}
        </div>
        <div class="cam-row-sub">
          <span><i class="fas fa-map-marker-alt"></i> ${cam.location || 'No location'}</span>
          <span><i class="fas fa-tag"></i> ${cam.brand || 'Unknown'}</span>
          <span><i class="fas fa-network-wired"></i> ${cam.ip || 'No IP'}</span>
          <span><i class="fas fa-clock"></i> Last seen: ${lastSeen}</span>
        </div>
      </div>
      <div class="cam-row-actions">
        ${cam.webUrl ? `<button class="btn btn-sm btn-ghost" onclick="window.open('${cam.webUrl}','_blank')" title="Open Web UI"><i class="fas fa-external-link-alt"></i></button>` : ''}
        <button class="btn btn-sm btn-ghost" onclick="openCameraDetail('${cam.id}')" title="Details"><i class="fas fa-info-circle"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="openEditModal('${cam.id}')" title="Edit"><i class="fas fa-edit"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="pingCamera('${cam.id}')" title="Ping"><i class="fas fa-heartbeat"></i></button>
        <button class="btn btn-sm btn-ghost" style="color:var(--danger)" onclick="deleteCamera('${cam.id}')" title="Delete"><i class="fas fa-trash"></i></button>
      </div>
    `;
    list.appendChild(row);
  });
}

/* ══════════════════════════════════════════════════════════════
   NAVIGATION
   ══════════════════════════════════════════════════════════════ */
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCols = parseInt(btn.dataset.cols);
      setGridCols(activeCols);
    });
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    cameras: 'All Cameras',
    scanner: 'Network Scanner',
    'add-manual': 'Add Camera',
    homeassistant: 'Home Assistant',
    settings: 'Settings'
  };
  document.getElementById('viewTitle').textContent = titles[view] || view;

  if (view === 'cameras') renderCameraList();
}

/* ══════════════════════════════════════════════════════════════
   FILTERS
   ══════════════════════════════════════════════════════════════ */
function setupFilters() {
  document.getElementById('filterBrand').addEventListener('change', renderDashboard);
  document.getElementById('filterStatus').addEventListener('change', renderDashboard);
  document.getElementById('cameraSearch').addEventListener('input', renderCameraList);
}

/* ══════════════════════════════════════════════════════════════
   CAMERA DETAIL MODAL
   ══════════════════════════════════════════════════════════════ */
function openCameraDetail(id) {
  const cam = cameras.find(c => c.id === id);
  if (!cam) return;

  document.getElementById('modalCameraName').textContent = cam.name;
  const statusClass = cam.online === true ? 'online' : cam.online === false ? 'offline' : 'unknown';
  const statusLabel = cam.online === true ? '🟢 Online' : cam.online === false ? '🔴 Offline' : '⚪ Unknown';

  const rtspUrl = cam.streamUrl || buildRtspUrl(cam);

  document.getElementById('modalBody').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item">
        <label>Status</label>
        <span class="status-dot ${statusClass}"></span>
        <span>${statusLabel}</span>
      </div>
      <div class="detail-item">
        <label>Brand</label>
        <span><span class="cam-brand-tag ${cam.brand || 'Unknown'}">${cam.brand || 'Unknown'}</span></span>
      </div>
      <div class="detail-item">
        <label>Model</label>
        <span>${cam.model || '—'}</span>
      </div>
      <div class="detail-item">
        <label>Type</label>
        <span>${cam.type || 'IP Camera'}</span>
      </div>
      <div class="detail-item">
        <label>IP Address</label>
        <span>${cam.ip || '—'}<button class="copy-btn" onclick="copyText('${cam.ip}')"><i class="fas fa-copy"></i></button></span>
      </div>
      <div class="detail-item">
        <label>Location</label>
        <span>${cam.location || '—'}</span>
      </div>
      <div class="detail-item">
        <label>HTTP Port</label>
        <span>${cam.httpPort || 80}</span>
      </div>
      <div class="detail-item">
        <label>RTSP Port</label>
        <span>${cam.rtspPort || 554}</span>
      </div>
      ${rtspUrl ? `
      <div class="detail-item full">
        <label>RTSP Stream URL</label>
        <span style="font-family:monospace;font-size:0.8rem">${rtspUrl}<button class="copy-btn" onclick="copyText('${rtspUrl.replace(/'/g,"\\'")}')"><i class="fas fa-copy"></i></button></span>
      </div>` : ''}
      ${cam.webUrl ? `
      <div class="detail-item full">
        <label>Web Interface</label>
        <span style="font-family:monospace;font-size:0.8rem">${cam.webUrl}<button class="copy-btn" onclick="copyText('${cam.webUrl}')"><i class="fas fa-copy"></i></button></span>
      </div>` : ''}
      ${cam.openPorts && cam.openPorts.length > 0 ? `
      <div class="detail-item full">
        <label>Open Ports</label>
        <span>${cam.openPorts.map(p => `<span class="port-tag ${p===554||p===8554?'rtsp':[80,8080,443].includes(p)?'http':''}">${p}</span>`).join(' ')}</span>
      </div>` : ''}
      <div class="detail-item">
        <label>Added</label>
        <span>${cam.addedAt ? new Date(cam.addedAt).toLocaleDateString() : '—'}</span>
      </div>
      <div class="detail-item">
        <label>Source</label>
        <span style="text-transform:capitalize">${cam.source || 'manual'}</span>
      </div>
    </div>
    <div class="detail-actions">
      ${cam.webUrl ? `<a href="${cam.webUrl}" target="_blank" class="btn btn-primary btn-sm"><i class="fas fa-external-link-alt"></i> Open Web UI</a>` : ''}
      ${rtspUrl ? `<button class="btn btn-ghost btn-sm" onclick="copyText('${rtspUrl.replace(/'/g,"\\'")}')"><i class="fas fa-copy"></i> Copy RTSP</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="pingCamera('${cam.id}')"><i class="fas fa-heartbeat"></i> Ping</button>
      <button class="btn btn-ghost btn-sm" onclick="closeModal();openEditModal('${cam.id}')"><i class="fas fa-edit"></i> Edit</button>
      <button class="btn btn-danger btn-sm" onclick="closeModal();deleteCamera('${cam.id}')"><i class="fas fa-trash"></i> Delete</button>
    </div>
  `;

  document.getElementById('cameraModal').classList.add('open');
}

function buildRtspUrl(cam) {
  if (cam.streamUrl) return cam.streamUrl;
  const fn = RTSP_TEMPLATES[cam.brand];
  if (fn && cam.ip) return fn(cam.ip, cam.rtspPort || 554, cam.username, cam.password);
  return '';
}

function closeModal() {
  document.getElementById('cameraModal').classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   EDIT MODAL
   ══════════════════════════════════════════════════════════════ */
function openEditModal(id) {
  const cam = cameras.find(c => c.id === id);
  if (!cam) return;
  document.getElementById('ec_id').value = cam.id;
  document.getElementById('ec_name').value = cam.name || '';
  document.getElementById('ec_brand').value = cam.brand || 'Unknown';
  document.getElementById('ec_model').value = cam.model || '';
  document.getElementById('ec_location').value = cam.location || '';
  document.getElementById('ec_ip').value = cam.ip || '';
  document.getElementById('ec_httpPort').value = cam.httpPort || 80;
  document.getElementById('ec_rtspPort').value = cam.rtspPort || 554;
  document.getElementById('ec_type').value = cam.type || 'IP Camera';
  document.getElementById('ec_streamUrl').value = cam.streamUrl || '';
  document.getElementById('ec_webUrl').value = cam.webUrl || '';
  document.getElementById('ec_username').value = cam.username || '';
  document.getElementById('ec_password').value = cam.password || '';
  document.getElementById('editModal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   MODALS SETUP
   ══════════════════════════════════════════════════════════════ */
function setupModals() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('editModalClose').addEventListener('click', closeEditModal);

  // Close on overlay click
  document.getElementById('cameraModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEditModal();
  });

  // Edit form submit
  document.getElementById('editCameraForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('ec_id').value;
    const data = {
      name: document.getElementById('ec_name').value,
      brand: document.getElementById('ec_brand').value,
      model: document.getElementById('ec_model').value,
      location: document.getElementById('ec_location').value,
      ip: document.getElementById('ec_ip').value,
      httpPort: parseInt(document.getElementById('ec_httpPort').value),
      rtspPort: parseInt(document.getElementById('ec_rtspPort').value),
      type: document.getElementById('ec_type').value,
      streamUrl: document.getElementById('ec_streamUrl').value,
      webUrl: document.getElementById('ec_webUrl').value,
      username: document.getElementById('ec_username').value,
      password: document.getElementById('ec_password').value,
    };
    try {
      const r = await fetch(`${API}/api/cameras/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error();
      const updated = await r.json();
      const idx = cameras.findIndex(c => c.id === id);
      if (idx !== -1) cameras[idx] = updated;
      renderAll();
      closeEditModal();
      showToast('Camera updated successfully', 'success');
    } catch {
      showToast('Failed to update camera', 'error');
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   ADD CAMERA FORM
   ══════════════════════════════════════════════════════════════ */
function setupForms() {
  // Brand presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const brand = btn.dataset.brand;
      applyBrandPreset(brand);
    });
  });

  document.getElementById('addCameraForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const brand = document.getElementById('fc_brand').value;
    const ip = document.getElementById('fc_ip').value.trim();
    const rtspPort = parseInt(document.getElementById('fc_rtspPort').value) || 554;
    const user = document.getElementById('fc_username').value;
    const pass = document.getElementById('fc_password').value;

    let streamUrl = document.getElementById('fc_streamUrl').value.trim();
    if (!streamUrl && brand && ip) {
      const fn = RTSP_TEMPLATES[brand];
      if (fn) streamUrl = fn(ip, rtspPort, user, pass);
    }

    let webUrl = document.getElementById('fc_webUrl').value.trim();
    if (!webUrl && ip) {
      const port = parseInt(document.getElementById('fc_httpPort').value) || 80;
      webUrl = `http://${ip}${port !== 80 ? ':'+port : ''}`;
    }

    const data = {
      name: document.getElementById('fc_name').value,
      brand,
      model: document.getElementById('fc_model').value,
      location: document.getElementById('fc_location').value,
      ip,
      httpPort: parseInt(document.getElementById('fc_httpPort').value) || 80,
      rtspPort,
      type: document.getElementById('fc_type').value,
      streamUrl,
      webUrl,
      username: user,
      password: pass,
    };

    try {
      const r = await fetch(`${API}/api/cameras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error();
      const cam = await r.json();
      // Only add if not already present (WebSocket may also fire camera_added)
      if (!cameras.find(c => c.id === cam.id)) {
        cameras.push(cam);
        renderAll();
      }
      resetAddForm();
      showToast(`${cam.name} added successfully`, 'success');
      switchView('dashboard');
    } catch {
      showToast('Failed to add camera', 'error');
    }
  });
}

function applyBrandPreset(brand) {
  const presets = {
    Amcrest:   { httpPort: 80, rtspPort: 554 },
    Ring:      { httpPort: 443, rtspPort: 0 },
    Reolink:   { httpPort: 80, rtspPort: 554 },
    Hikvision: { httpPort: 80, rtspPort: 554 },
    Dahua:     { httpPort: 80, rtspPort: 554 },
    Generic:   { httpPort: 80, rtspPort: 554 },
  };
  const p = presets[brand] || presets.Generic;
  document.getElementById('fc_brand').value = brand === 'Generic' ? 'Unknown' : brand;
  document.getElementById('fc_httpPort').value = p.httpPort;
  document.getElementById('fc_rtspPort').value = p.rtspPort;

  // Visual feedback
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.style.outline = b.dataset.brand === brand ? '2px solid white' : '';
  });
  showToast(`${brand} preset applied`, 'info');
}

function resetAddForm() {
  document.getElementById('addCameraForm').reset();
  document.querySelectorAll('.preset-btn').forEach(b => b.style.outline = '');
}

/* ══════════════════════════════════════════════════════════════
   SCANNER
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('startScanBtn').addEventListener('click', startScan);
  document.getElementById('stopScanBtn').addEventListener('click', stopScan);
});

async function startScan() {
  const subnet = document.getElementById('scanSubnet').value.trim();
  const startHost = parseInt(document.getElementById('scanStart').value) || 1;
  const endHost = parseInt(document.getElementById('scanEnd').value) || 254;

  if (!subnet) { showToast('Please enter a subnet', 'error'); return; }

  try {
    await fetch(`${API}/api/scan/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subnet, startHost, endHost })
    });
  } catch {
    showToast('Failed to start scan', 'error');
  }
}

async function stopScan() {
  await fetch(`${API}/api/scan/stop`, { method: 'POST' });
  document.getElementById('startScanBtn').style.display = 'inline-flex';
  document.getElementById('stopScanBtn').style.display = 'none';
  showToast('Scan stopped', 'info');
}

function appendScanResult(cam) {
  const container = document.getElementById('scanResults');
  // Remove empty state if present
  container.querySelector('.empty-state')?.remove();

  const count = container.querySelectorAll('.discovered-card').length + 1;
  document.getElementById('scanResultsBadge').textContent = count;
  document.getElementById('scanFoundCount').textContent = `${count} found`;

  const card = document.createElement('div');
  card.className = 'discovered-card';
  card.dataset.id = cam.id;

  const brandClass = cam.brand || 'Unknown';
  const portTags = (cam.openPorts || []).map(p => {
    const cls = p === 554 || p === 8554 ? 'rtsp' : [80,443,8080].includes(p) ? 'http' : '';
    return `<span class="port-tag ${cls}">${p}</span>`;
  }).join('');

  const alreadyAdded = cameras.some(c => c.ip === cam.ip);

  card.innerHTML = `
    <div class="disc-header">
      <div>
        <div class="disc-ip">${cam.ip}</div>
        <span class="cam-brand-tag ${brandClass}" style="margin-top:4px;display:inline-block">${cam.brand || 'Unknown'}</span>
      </div>
    </div>
    <div class="disc-ports">${portTags || '<span style="font-size:0.75rem;color:var(--text2)">No open ports detected</span>'}</div>
    ${cam.streamUrl ? `<div class="disc-stream"><i class="fas fa-play-circle"></i> ${cam.streamUrl}</div>` : ''}
    <div class="disc-actions">
      ${cam.webUrl ? `<a href="${cam.webUrl}" target="_blank" class="btn btn-ghost btn-sm"><i class="fas fa-external-link-alt"></i> Open</a>` : ''}
      ${alreadyAdded
        ? `<button class="btn btn-ghost btn-sm" disabled><i class="fas fa-check"></i> Already Added</button>`
        : `<button class="btn btn-success btn-sm" onclick="saveDiscoveredCamera(${JSON.stringify(cam).replace(/"/g,'&quot;')})"><i class="fas fa-plus"></i> Add to Dashboard</button>`
      }
    </div>
  `;
  container.appendChild(card);
}

async function saveDiscoveredCamera(cam) {
  try {
    const r = await fetch(`${API}/api/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cam)
    });
    if (r.status === 409) { showToast('Camera already in dashboard', 'info'); return; }
    if (!r.ok) throw new Error();
    const saved = await r.json();
    // Only add if not already present (WebSocket may also fire camera_added)
    if (!cameras.find(c => c.id === saved.id)) {
      cameras.push(saved);
      renderAll();
    }
    showToast(`${saved.name} added to dashboard`, 'success');

    // Update the card button
    const card = document.querySelector(`.discovered-card[data-id="${cam.id}"]`);
    if (card) {
      const btn = card.querySelector('.btn-success');
      if (btn) {
        btn.className = 'btn btn-ghost btn-sm';
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-check"></i> Added';
      }
    }
  } catch {
    showToast('Failed to save camera', 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   CAMERA OPERATIONS
   ══════════════════════════════════════════════════════════════ */
async function deleteCamera(id) {
  const cam = cameras.find(c => c.id === id);
  if (!cam) return;
  if (!confirm(`Delete "${cam.name}"? This cannot be undone.`)) return;
  try {
    const r = await fetch(`${API}/api/cameras/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error();
    cameras = cameras.filter(c => c.id !== id);
    renderAll();
    showToast(`${cam.name} deleted`, 'success');
  } catch {
    showToast('Failed to delete camera', 'error');
  }
}

async function pingCamera(id) {
  const cam = cameras.find(c => c.id === id);
  if (!cam) return;
  showToast(`Pinging ${cam.name}...`, 'info');
  try {
    const r = await fetch(`${API}/api/cameras/${id}/ping`, { method: 'POST' });
    const data = await r.json();
    const idx = cameras.findIndex(c => c.id === id);
    if (idx !== -1) {
      cameras[idx].online = data.online;
      cameras[idx].lastSeen = data.lastSeen;
    }
    renderAll();
    showToast(
      `${cam.name} is ${data.online ? '🟢 Online' : '🔴 Offline'}`,
      data.online ? 'success' : 'error'
    );
  } catch {
    showToast('Ping failed', 'error');
  }
}

async function pingAll() {
  if (cameras.length === 0) { showToast('No cameras to ping', 'info'); return; }
  showToast('Pinging all cameras...', 'info');
  try {
    const r = await fetch(`${API}/api/cameras/ping-all`, { method: 'POST' });
    await r.json();
    await fetchCameras();
    showToast('Status check complete', 'success');
  } catch {
    showToast('Ping all failed', 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   HOME ASSISTANT
   ══════════════════════════════════════════════════════════════ */

let haCameras = [];

async function loadHAConfig() {
  try {
    const r = await fetch(`${API}/api/ha/config`);
    const cfg = await r.json();
    if (cfg.url) {
      document.getElementById('ha_url').value = cfg.url;
      document.getElementById('haConfigStatus').textContent = cfg.hasToken ? '✅ Token saved' : '⚠️ No token saved';
    }
    return cfg;
  } catch { return {}; }
}

function toggleHAConfigPanel() {
  const panel = document.getElementById('haConfigPanel');
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) loadHAConfig();
}

async function saveHAConfig() {
  const url = document.getElementById('ha_url').value.trim();
  const token = document.getElementById('ha_token').value.trim();
  const statusEl = document.getElementById('haConfigStatus');

  if (!url) { showToast('Please enter the Home Assistant URL', 'error'); return; }

  statusEl.textContent = 'Saving...';
  try {
    const r = await fetch(`${API}/api/ha/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token })
    });
    if (!r.ok) throw new Error();
    statusEl.textContent = '✅ Saved!';
    showToast('Home Assistant config saved', 'success');
    document.getElementById('ha_token').value = '';
    // Auto-fetch cameras after saving
    setTimeout(() => fetchHACameras(), 500);
  } catch {
    statusEl.textContent = '❌ Failed to save';
    showToast('Failed to save HA config', 'error');
  }
}

async function fetchHACameras() {
  const btn = document.getElementById('haFetchBtn');
  btn.innerHTML = '<i class="fas fa-sync spin"></i> Fetching...';
  btn.disabled = true;

  const statusBar = document.getElementById('haStatusBar');
  statusBar.style.display = 'flex';

  try {
    const r = await fetch(`${API}/api/ha/cameras`);
    const data = await r.json();

    if (!r.ok) {
      document.getElementById('haConnectionStatus').innerHTML =
        `<span class="dot offline"></span> ${data.error || 'Connection failed'}`;
      showToast(data.error || 'Failed to fetch HA cameras', 'error');
      return;
    }

    haCameras = data;
    document.getElementById('haConnectionStatus').innerHTML =
      `<span class="dot online"></span> Connected`;
    document.getElementById('haFoundCount').textContent =
      `${haCameras.length} camera${haCameras.length !== 1 ? 's' : ''} found`;

    renderHACameras();
    showToast(`Found ${haCameras.length} Home Assistant camera(s)`, 'success');
  } catch (err) {
    document.getElementById('haConnectionStatus').innerHTML =
      `<span class="dot offline"></span> Error: ${err.message}`;
    showToast('Failed to reach Home Assistant', 'error');
  } finally {
    btn.innerHTML = '<i class="fas fa-sync"></i> Fetch Cameras';
    btn.disabled = false;
  }
}

function renderHACameras() {
  const grid = document.getElementById('haCameraGrid');
  const empty = document.getElementById('haEmpty');

  // Remove existing HA cards
  grid.querySelectorAll('.ha-card').forEach(el => el.remove());

  if (haCameras.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  haCameras.forEach(cam => {
    grid.appendChild(buildHACard(cam));
  });
}

function buildHACard(cam) {
  const card = document.createElement('div');
  const stateClass = cam.state === 'unavailable' ? 'is-unavailable'
    : cam.online ? 'is-online' : 'is-offline';
  card.className = `ha-card ${stateClass}`;
  card.dataset.entityId = cam.entityId;

  const isAlreadyImported = cameras.some(c => c.entityId === cam.entityId);
  const stateBadgeClass = ['idle', 'streaming', 'recording', 'unavailable'].includes(cam.state)
    ? cam.state : 'idle';

  // Build snapshot URL through our proxy (avoids CORS)
  const snapshotUrl = `/api/ha/snapshot/${cam.entityId}`;

  card.innerHTML = `
    <div class="ha-snapshot-placeholder" id="snap_${cam.entityId.replace(/\./g,'_')}">
      <i class="fas fa-home"></i>
      <span>Loading snapshot...</span>
    </div>
    <div class="ha-card-body">
      <div class="ha-card-name">
        <span class="status-dot ${cam.online ? 'online' : 'offline'}"></span>
        ${cam.name}
      </div>
      <div class="ha-card-meta">
        <span class="ha-state-badge ${stateBadgeClass}">${cam.state}</span>
        ${cam.model ? `<span><i class="fas fa-tag"></i> ${cam.model}</span>` : ''}
        <span class="ha-entity-id">${cam.entityId}</span>
      </div>
      <div class="ha-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="refreshHASnapshot('${cam.entityId}')">
          <i class="fas fa-camera"></i> Snapshot
        </button>
        ${cam.proxyStreamUrl ? `<a href="${cam.proxyStreamUrl}" target="_blank" class="btn btn-ghost btn-sm">
          <i class="fas fa-play"></i> Stream
        </a>` : ''}
        <a href="${cam.webUrl || '#'}" target="_blank" class="btn btn-ghost btn-sm">
          <i class="fas fa-external-link-alt"></i> HA
        </a>
        ${isAlreadyImported
          ? `<button class="btn btn-ghost btn-sm" disabled style="margin-left:auto">
               <i class="fas fa-check"></i> Imported
             </button>`
          : `<button class="btn btn-success btn-sm" style="margin-left:auto"
               onclick="importHACamera('${cam.entityId}')">
               <i class="fas fa-plus"></i> Add to Dashboard
             </button>`
        }
      </div>
    </div>
  `;

  // Load snapshot in background
  setTimeout(() => refreshHASnapshot(cam.entityId), 100);
  return card;
}

function refreshHASnapshot(entityId) {
  const key = entityId.replace(/\./g, '_');
  const container = document.getElementById(`snap_${key}`);
  if (!container) return;

  const url = `/api/ha/snapshot/${entityId}?t=${Date.now()}`;
  const img = new Image();
  img.className = 'ha-snapshot';
  img.onload = () => {
    container.replaceWith(img);
    img.id = `snap_${key}`;
  };
  img.onerror = () => {
    container.innerHTML = `<i class="fas fa-eye-slash"></i><span>Snapshot unavailable</span>`;
  };
  img.src = url;
}

async function importHACamera(entityId) {
  try {
    const r = await fetch(`${API}/api/ha/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId })
    });
    if (r.status === 409) { showToast('Camera already in dashboard', 'info'); return; }
    if (!r.ok) {
      const err = await r.json();
      showToast(err.error || 'Import failed', 'error');
      return;
    }
    const cam = await r.json();
    if (!cameras.find(c => c.id === cam.id)) {
      cameras.push(cam);
      renderAll();
    }
    showToast(`${cam.name} added to dashboard`, 'success');

    // Update the card button
    const card = document.querySelector(`.ha-card[data-entity-id="${entityId}"]`);
    if (card) {
      const btn = card.querySelector('.btn-success');
      if (btn) {
        btn.className = 'btn btn-ghost btn-sm';
        btn.disabled = true;
        btn.style.marginLeft = 'auto';
        btn.innerHTML = '<i class="fas fa-check"></i> Imported';
      }
    }
  } catch {
    showToast('Failed to import camera', 'error');
  }
}

// Load HA config on init
document.addEventListener('DOMContentLoaded', () => {
  loadHAConfig();
});

/* ══════════════════════════════════════════════════════════════
   CAMERA OPERATIONS (continued)
   ══════════════════════════════════════════════════════════════ */
async function clearAllCameras() {
  if (!confirm('Delete ALL cameras? This cannot be undone.')) return;
  try {
    await Promise.all(cameras.map(c =>
      fetch(`${API}/api/cameras/${c.id}`, { method: 'DELETE' })
    ));
    cameras = [];
    renderAll();
    showToast('All cameras cleared', 'success');
  } catch {
    showToast('Failed to clear cameras', 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════════ */
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard', 'success');
  }).catch(() => {
    showToast('Copy failed', 'error');
  });
}

function showToast(message, type = 'info') {
  const icons = { success: 'fas fa-check-circle', error: 'fas fa-times-circle', info: 'fas fa-info-circle' };
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="${icons[type]}"></i><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
