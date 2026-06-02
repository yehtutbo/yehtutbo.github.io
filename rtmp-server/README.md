# RTMP Restream Manager

Ubuntu 24.04 VPS ပေါ်တွင် nginx-rtmp + Node.js ဖြင့် တည်ဆောက်ထားသော RTMP Restream Control Panel။

## ပါဝင်သည့်အရာများ

| File | Description |
|------|-------------|
| `setup.sh` | VPS one-click installation script |
| `nginx-rtmp.conf` | nginx RTMP + HTTP config |
| `server.js` | Express.js API backend |
| `package.json` | Node.js dependencies |
| `public/index.html` | Web UI dashboard |
| `rtmp-manager.service` | systemd service file |

## Installation

### 1. VPS ထဲသို့ upload

```bash
# Local မှ SCP
scp -r rtmp-server/ root@YOUR_VPS_IP:/tmp/rtmp-setup/

# သို့မဟုတ် git clone လုပ်ပြီး
```

### 2. Setup script run

```bash
cd /tmp/rtmp-setup
sudo bash setup.sh
```

Setup script သည် အောက်ပါတို့ကို auto-install လုပ်သည်:
- nginx + libnginx-mod-rtmp
- ffmpeg
- Node.js 20
- UFW firewall rules
- systemd service

### 3. Access

| Service | URL |
|---------|-----|
| Web Dashboard | `http://YOUR_IP:8080` |
| RTMP Ingest | `rtmp://YOUR_IP:1935/live/<key>` |
| nginx Stats | `http://YOUR_IP:8080/stat` |
| HLS Preview | `http://YOUR_IP:8080/hls/<key>.m3u8` |

---

## OBS Setup

1. **Settings → Stream**
2. Service: `Custom`
3. Server: `rtmp://YOUR_IP:1935/live`
4. Stream Key: Web UI မှ configure လုပ်ထားသော key (default: `live_stream_key`)

---

## Web UI Features

- **Dashboard** - Live signal status, active stream count, bandwidth
- **Destinations** - YouTube, Facebook, Twitch, TikTok, Custom RTMP
- **Quick Presets** - Platform URL auto-fill
- **Start/Stop** - Individual stream control
- **Start All / Stop All** - Bulk control
- **Auto-Restart** - Disconnect ဖြစ်သောအခါ auto reconnect
- **Stream Log** - Real-time ffmpeg output
- **Settings** - Ingest key management

---

## API Reference

```
GET  /api/status              # System status
GET  /api/config              # Current config
POST /api/config              # Update config
POST /api/destinations        # Add destination
PUT  /api/destinations/:id    # Update destination
DEL  /api/destinations/:id    # Remove destination
POST /api/stream/:id/start    # Start restream
POST /api/stream/:id/stop     # Stop restream
POST /api/stream/start-all    # Start all
POST /api/stream/stop-all     # Stop all
GET  /api/logs                # Stream logs
POST /api/nginx/restart       # Restart nginx
```

---

## Service Management

```bash
# Status
sudo systemctl status rtmp-manager
sudo systemctl status nginx

# Logs
sudo journalctl -u rtmp-manager -f
sudo journalctl -u nginx -f

# Restart
sudo systemctl restart rtmp-manager
sudo systemctl restart nginx

# Config location
/opt/rtmp-manager/config.json
/opt/rtmp-manager/stream.log
```

---

## Architecture

```
OBS/Encoder
    │
    │ RTMP push (port 1935)
    ▼
nginx-rtmp (ingest)
    │
    │ RTMP pull (127.0.0.1)
    ▼
Node.js (server.js)
    │
    ├─ ffmpeg process 1 ──► YouTube RTMP
    ├─ ffmpeg process 2 ──► Facebook RTMPS  
    ├─ ffmpeg process 3 ──► Twitch RTMP
    └─ ffmpeg process N ──► Custom RTMP
    
Web UI (port 8080 via nginx proxy)
    └─ API calls ──► Express.js (port 3000)
```

---

## Troubleshooting

### nginx RTMP module not found
```bash
apt-get install -y nginx-full
# or
apt-get install -y libnginx-mod-rtmp
```

### Stream not starting
```bash
# Check if ingest is receiving
curl http://localhost:8080/stat

# Check ffmpeg availability
which ffmpeg
ffmpeg -version
```

### Port 1935 blocked
```bash
sudo ufw allow 1935/tcp
sudo ufw reload
```

### Logs
```bash
tail -f /opt/rtmp-manager/stream.log
sudo journalctl -u rtmp-manager -f
```
