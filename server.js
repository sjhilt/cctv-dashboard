const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple JSON file DB ────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'cameras.json');

function loadCameras() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return []; }
}

function saveCameras(cameras) {
  fs.writeFileSync(DB_FILE, JSON.stringify(cameras, null, 2));
}

// ─── WebSocket broadcast ────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Network helpers ────────────────────────────────────────────────────────
function getLocalSubnet() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return '192.168.1';
}

function tcpProbe(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (val) => { if (!done) { done = true; socket.destroy(); resolve(val); } };
    socket.setTimeout(timeout);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Common camera ports
const CAMERA_PORTS = [80, 443, 554, 8080, 8443, 8554, 37777, 34567, 9000];

// Fingerprint known camera brands by port patterns / http headers
async function fingerprintCamera(ip) {
  const openPorts = [];
  await Promise.all(CAMERA_PORTS.map(async p => {
    const open = await tcpProbe(ip, p);
    if (open) openPorts.push(p);
  }));

  if (openPorts.length === 0) return null;

  let brand = 'Unknown';
  let model = '';
  let streamUrl = '';
  let httpPort = openPorts.find(p => [80, 8080].includes(p)) || openPorts[0];

  // Try HTTP banner grab
  try {
    const resp = await axios.get(`http://${ip}:${httpPort}/`, {
      timeout: 2000,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const body = (resp.data || '').toString().toLowerCase();
    const headers = JSON.stringify(resp.headers).toLowerCase();

    if (body.includes('amcrest') || headers.includes('amcrest')) brand = 'Amcrest';
    else if (body.includes('reolink') || headers.includes('reolink')) brand = 'Reolink';
    else if (body.includes('dahua') || headers.includes('dahua')) brand = 'Dahua';
    else if (body.includes('hikvision') || headers.includes('hikvision') || body.includes('webs')) brand = 'Hikvision';
    else if (body.includes('axis') || headers.includes('axis')) brand = 'Axis';
    else if (body.includes('foscam') || headers.includes('foscam')) brand = 'Foscam';
    else if (body.includes('vivotek') || headers.includes('vivotek')) brand = 'Vivotek';
    else if (body.includes('hanwha') || headers.includes('hanwha')) brand = 'Hanwha';
  } catch {}

  // Guess RTSP stream URL by brand
  const rtspPort = openPorts.includes(554) ? 554 : (openPorts.includes(8554) ? 8554 : null);
  if (rtspPort) {
    if (brand === 'Amcrest' || brand === 'Dahua') streamUrl = `rtsp://${ip}:${rtspPort}/cam/realmonitor?channel=1&subtype=0`;
    else if (brand === 'Reolink') streamUrl = `rtsp://${ip}:${rtspPort}//h264Preview_01_main`;
    else if (brand === 'Hikvision') streamUrl = `rtsp://${ip}:${rtspPort}/Streaming/Channels/101`;
    else if (brand === 'Axis') streamUrl = `rtsp://${ip}:${rtspPort}/axis-media/media.amp`;
    else streamUrl = `rtsp://${ip}:${rtspPort}/stream1`;
  }

  return {
    id: `discovered_${ip.replace(/\./g, '_')}`,
    ip,
    brand,
    model,
    name: `${brand} @ ${ip}`,
    status: 'discovered',
    openPorts,
    httpPort,
    streamUrl,
    webUrl: httpPort ? `http://${ip}:${httpPort}` : '',
    username: '',
    password: '',
    location: '',
    type: 'IP Camera',
    addedAt: new Date().toISOString(),
    source: 'scan'
  };
}

// ─── Scan state ─────────────────────────────────────────────────────────────
let scanActive = false;
let scanProgress = 0;
let scanResults = [];

async function runNetworkScan(subnet, startHost = 1, endHost = 254) {
  scanActive = true;
  scanProgress = 0;
  scanResults = [];
  broadcast({ type: 'scan_started', subnet });

  const total = endHost - startHost + 1;
  let done = 0;

  // Scan in batches of 20 for speed
  const BATCH = 20;
  for (let h = startHost; h <= endHost; h += BATCH) {
    if (!scanActive) break;
    const batch = [];
    for (let i = h; i < Math.min(h + BATCH, endHost + 1); i++) {
      batch.push(i);
    }
    await Promise.all(batch.map(async (host) => {
      const ip = `${subnet}.${host}`;
      // Quick TCP check on port 80 or 554 first
      const alive = await tcpProbe(ip, 80, 500) || await tcpProbe(ip, 554, 500);
      if (alive) {
        const cam = await fingerprintCamera(ip);
        if (cam) {
          scanResults.push(cam);
          broadcast({ type: 'scan_found', camera: cam });
        }
      }
      done++;
      scanProgress = Math.round((done / total) * 100);
      broadcast({ type: 'scan_progress', progress: scanProgress, scanned: done, total });
    }));
  }

  scanActive = false;
  broadcast({ type: 'scan_complete', found: scanResults.length, cameras: scanResults });
}

// ─── API Routes ──────────────────────────────────────────────────────────────

// GET all cameras
app.get('/api/cameras', (req, res) => {
  res.json(loadCameras());
});

// GET single camera
app.get('/api/cameras/:id', (req, res) => {
  const cameras = loadCameras();
  const cam = cameras.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'Not found' });
  res.json(cam);
});

// POST add camera manually
app.post('/api/cameras', (req, res) => {
  const cameras = loadCameras();
  const cam = {
    id: `cam_${Date.now()}`,
    name: req.body.name || 'New Camera',
    brand: req.body.brand || 'Unknown',
    model: req.body.model || '',
    ip: req.body.ip || '',
    httpPort: req.body.httpPort || 80,
    rtspPort: req.body.rtspPort || 554,
    streamUrl: req.body.streamUrl || '',
    webUrl: req.body.webUrl || '',
    username: req.body.username || '',
    password: req.body.password || '',
    location: req.body.location || '',
    type: req.body.type || 'IP Camera',
    status: 'manual',
    openPorts: [],
    addedAt: new Date().toISOString(),
    source: 'manual'
  };
  cameras.push(cam);
  saveCameras(cameras);
  broadcast({ type: 'camera_added', camera: cam });
  res.status(201).json(cam);
});

// PUT update camera
app.put('/api/cameras/:id', (req, res) => {
  const cameras = loadCameras();
  const idx = cameras.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  cameras[idx] = { ...cameras[idx], ...req.body, id: cameras[idx].id };
  saveCameras(cameras);
  broadcast({ type: 'camera_updated', camera: cameras[idx] });
  res.json(cameras[idx]);
});

// DELETE camera
app.delete('/api/cameras/:id', (req, res) => {
  let cameras = loadCameras();
  const cam = cameras.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'Not found' });
  cameras = cameras.filter(c => c.id !== req.params.id);
  saveCameras(cameras);
  broadcast({ type: 'camera_removed', id: req.params.id });
  res.json({ success: true });
});

// POST bulk ping all cameras (must be before /:id/ping route)
app.post('/api/cameras/ping-all', async (req, res) => {
  const cameras = loadCameras();
  const results = await Promise.all(cameras.map(async cam => {
    const alive = cam.ip ? await tcpProbe(cam.ip, cam.httpPort || 80, 2000) : false;
    return { id: cam.id, online: alive };
  }));
  const updated = cameras.map(cam => {
    const r = results.find(r => r.id === cam.id);
    return r ? { ...cam, online: r.online, lastSeen: r.online ? new Date().toISOString() : cam.lastSeen } : cam;
  });
  saveCameras(updated);
  broadcast({ type: 'cameras_status_update', cameras: updated });
  res.json(results);
});

// POST save discovered camera
app.post('/api/cameras/save-discovered', (req, res) => {
  const cameras = loadCameras();
  const cam = { ...req.body, id: `cam_${Date.now()}`, source: 'discovered', status: 'online' };
  if (cameras.find(c => c.ip === cam.ip)) {
    return res.status(409).json({ error: 'Camera with this IP already exists' });
  }
  cameras.push(cam);
  saveCameras(cameras);
  broadcast({ type: 'camera_added', camera: cam });
  res.status(201).json(cam);
});

// POST start network scan
app.post('/api/scan/start', (req, res) => {
  if (scanActive) return res.status(409).json({ error: 'Scan already running' });
  const subnet = req.body.subnet || getLocalSubnet();
  const startHost = req.body.startHost || 1;
  const endHost = req.body.endHost || 254;
  runNetworkScan(subnet, startHost, endHost); // async, don't await
  res.json({ message: 'Scan started', subnet });
});

// POST stop scan
app.post('/api/scan/stop', (req, res) => {
  scanActive = false;
  res.json({ message: 'Scan stopping' });
});

// GET scan status
app.get('/api/scan/status', (req, res) => {
  res.json({ active: scanActive, progress: scanProgress, found: scanResults.length });
});

// GET detected subnet
app.get('/api/network/subnet', (req, res) => {
  res.json({ subnet: getLocalSubnet() });
});

// ─── Home Assistant Integration ─────────────────────────────────────────────
const HA_CONFIG_FILE = path.join(__dirname, 'ha-config.json');

function loadHAConfig() {
  if (!fs.existsSync(HA_CONFIG_FILE)) return { url: '', token: '' };
  try { return JSON.parse(fs.readFileSync(HA_CONFIG_FILE, 'utf8')); }
  catch { return { url: '', token: '' }; }
}

function saveHAConfig(config) {
  fs.writeFileSync(HA_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// GET HA config (without token)
app.get('/api/ha/config', (req, res) => {
  const cfg = loadHAConfig();
  res.json({ url: cfg.url, hasToken: !!cfg.token });
});

// POST save HA config
app.post('/api/ha/config', (req, res) => {
  const { url, token } = req.body;
  saveHAConfig({ url: (url || '').replace(/\/$/, ''), token: token || '' });
  res.json({ success: true });
});

// GET fetch cameras from Home Assistant
app.get('/api/ha/cameras', async (req, res) => {
  const cfg = loadHAConfig();
  if (!cfg.url || !cfg.token) {
    return res.status(400).json({ error: 'Home Assistant not configured. Set URL and token in Settings.' });
  }

  try {
    // Fetch all states from HA
    const response = await axios.get(`${cfg.url}/api/states`, {
      timeout: 8000,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type': 'application/json'
      }
    });

    const states = response.data;

    // Filter camera entities
    const cameraEntities = states.filter(s => s.entity_id.startsWith('camera.'));

    const cameras = cameraEntities.map(entity => {
      const entityId = entity.entity_id;
      const friendlyName = entity.attributes.friendly_name || entityId;
      const streamSource = entity.attributes.stream_source || '';
      const brand = entity.attributes.brand || 'Home Assistant';
      const model = entity.attributes.model_name || '';
      const isOn = entity.state === 'idle' || entity.state === 'recording' || entity.state === 'streaming';

      return {
        id: `ha_${entityId.replace(/\./g, '_')}`,
        entityId,
        name: friendlyName,
        brand: brand || 'Home Assistant',
        model,
        type: 'HA Proxy Camera',
        source: 'homeassistant',
        state: entity.state,
        online: isOn,
        streamUrl: streamSource,
        // HA proxy snapshot URL (works with HA token)
        snapshotUrl: `${cfg.url}/api/camera_proxy/${entityId}`,
        // HA proxy stream URL
        proxyStreamUrl: `${cfg.url}/api/camera_proxy_stream/${entityId}`,
        webUrl: `${cfg.url}/lovelace`,
        haUrl: cfg.url,
        attributes: entity.attributes,
        lastChanged: entity.last_changed,
        lastUpdated: entity.last_updated,
      };
    });

    res.json(cameras);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Invalid Home Assistant token.' });
    if (status === 404) return res.status(404).json({ error: 'Home Assistant API not found. Check URL.' });
    res.status(500).json({ error: `Failed to connect to Home Assistant: ${err.message}` });
  }
});

// GET proxy HA camera snapshot image (avoids CORS issues in browser)
app.get('/api/ha/snapshot/:entityId', async (req, res) => {
  const cfg = loadHAConfig();
  if (!cfg.url || !cfg.token) return res.status(400).json({ error: 'HA not configured' });

  try {
    const response = await axios.get(
      `${cfg.url}/api/camera_proxy/${req.params.entityId}`,
      {
        timeout: 8000,
        responseType: 'arraybuffer',
        headers: { 'Authorization': `Bearer ${cfg.token}` }
      }
    );
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(response.data);
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch snapshot from Home Assistant' });
  }
});

// POST import HA camera into dashboard
app.post('/api/ha/import', async (req, res) => {
  const { entityId } = req.body;
  const cfg = loadHAConfig();
  if (!cfg.url || !cfg.token) return res.status(400).json({ error: 'HA not configured' });

  try {
    const response = await axios.get(`${cfg.url}/api/states/${entityId}`, {
      timeout: 5000,
      headers: { 'Authorization': `Bearer ${cfg.token}` }
    });
    const entity = response.data;
    const cameras = loadCameras();

    // Check if already imported
    if (cameras.find(c => c.entityId === entityId)) {
      return res.status(409).json({ error: 'Camera already imported' });
    }

    const cam = {
      id: `cam_${Date.now()}`,
      entityId,
      name: entity.attributes.friendly_name || entityId,
      brand: entity.attributes.brand || 'Home Assistant',
      model: entity.attributes.model_name || '',
      type: 'HA Proxy Camera',
      source: 'homeassistant',
      state: entity.state,
      online: entity.state !== 'unavailable',
      streamUrl: entity.attributes.stream_source || '',
      snapshotUrl: `${cfg.url}/api/camera_proxy/${entityId}`,
      proxyStreamUrl: `${cfg.url}/api/camera_proxy_stream/${entityId}`,
      localSnapshotUrl: `/api/ha/snapshot/${entityId}`,
      webUrl: `${cfg.url}/lovelace`,
      ip: '',
      httpPort: 80,
      rtspPort: 554,
      location: entity.attributes.location || '',
      username: '',
      password: '',
      addedAt: new Date().toISOString(),
    };

    cameras.push(cam);
    saveCameras(cameras);
    broadcast({ type: 'camera_added', camera: cam });
    res.status(201).json(cam);
  } catch (err) {
    res.status(500).json({ error: `Failed to import camera: ${err.message}` });
  }
});

// POST check camera online status
app.post('/api/cameras/:id/ping', async (req, res) => {
  const cameras = loadCameras();
  const cam = cameras.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'Not found' });
  const alive = await tcpProbe(cam.ip, cam.httpPort || 80, 2000);
  const idx = cameras.findIndex(c => c.id === req.params.id);
  cameras[idx].lastSeen = alive ? new Date().toISOString() : cameras[idx].lastSeen;
  cameras[idx].online = alive;
  saveCameras(cameras);
  broadcast({ type: 'camera_updated', camera: cameras[idx] });
  res.json({ online: alive, lastSeen: cameras[idx].lastSeen });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥 CCTV Dashboard running at http://localhost:${PORT}\n`);
});
