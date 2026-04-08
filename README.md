# CCTV Dashboard

A self-hosted, browser-based CCTV camera dashboard with local network scanning, manual camera entry, and Home Assistant integration.

---

## Features

- **Camera Dashboard** — Live grid view with online/offline status, adjustable layout (1-4 columns), and auto-refresh
- **Network Scanner** — Scans your local subnet to automatically discover cameras using ONVIF and common HTTP probing
- **Manual Camera Entry** — Add cameras by IP with brand presets for Amcrest, Ring, Reolink, Hikvision, Dahua, and generic RTSP sources
- **Home Assistant Integration** — Connect via URL and long-lived access token to import HA cameras directly into the dashboard
- **Settings** — Dark/light theme, grid layout, refresh interval

---

## Requirements

- [Node.js](https://nodejs.org) v16 or later
- macOS, Linux, or Windows (WSL recommended on Windows)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/cctv-dashboard.git
cd cctv-dashboard
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the dashboard

```bash
./start.sh
```

The dashboard will open automatically at `http://localhost:3000`.

### 4. Stop the dashboard

```bash
./stop.sh
```

---

## Usage

### Adding Cameras Manually

1. Go to **Add Camera** in the sidebar
2. Select your camera brand (Amcrest, Ring, Reolink, etc.)
3. Enter the camera IP address and credentials
4. The RTSP/snapshot URL is auto-generated based on the brand

### Network Scan

1. Go to **Network Scanner**
2. Enter your subnet (e.g. `192.168.1`) or leave it to auto-detect
3. Click **Scan** — discovered cameras will appear and can be added to the dashboard

### Home Assistant Integration

1. Go to **Home Assistant** in the sidebar
2. Enter your HA URL (e.g. `http://homeassistant.local:8123`)
3. Paste a long-lived access token (Settings > Profile > Long-Lived Access Tokens in HA)
4. Click **Connect** to fetch all cameras, then import whichever you want

---

## Configuration

The app stores data in local JSON files (gitignored by default):

| File | Purpose |
|------|---------|
| `cameras.json` | Saved camera list |
| `ha-config.json` | Home Assistant URL and token |
| `dashboard.log` | Server log output |

These files are created automatically on first run and are excluded from version control.

---

## Project Structure

```
cctv-dashboard/
  server.js          # Express + WebSocket backend
  start.sh           # Start script (auto-opens browser)
  stop.sh            # Stop script
  package.json
  public/
    index.html       # Single-page app shell
    style.css        # Dark/light theme styles
    app.js           # Frontend logic
```

---

## Security Notes

- This dashboard is intended for use on a **trusted local network**
- Camera credentials are stored in plaintext in `cameras.json` — do not expose the data directory
- The Home Assistant token is stored in `ha-config.json` — treat it like a password
- Do not expose port 3000 to the public internet without authentication

---

## License

MIT
