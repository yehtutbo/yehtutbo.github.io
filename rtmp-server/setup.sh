#!/bin/bash
# ════════════════════════════════════════════════════════════════
#   RTMP Restream Manager - VPS Setup Script
#   For Ubuntu 24.04 LTS
#   Usage: sudo bash setup.sh
# ════════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Check root ────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Run as root: sudo bash setup.sh"

APP_DIR="/opt/rtmp-manager"
WEB_DIR="/var/www/html/rtmp"
HLS_DIR="/var/www/hls"

echo -e "${CYAN}"
echo "  ██████╗ ████████╗███╗   ███╗██████╗ "
echo "  ██╔══██╗╚══██╔══╝████╗ ████║██╔══██╗"
echo "  ██████╔╝   ██║   ██╔████╔██║██████╔╝"
echo "  ██╔══██╗   ██║   ██║╚██╔╝██║██╔═══╝ "
echo "  ██║  ██║   ██║   ██║ ╚═╝ ██║██║     "
echo "  ╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚═╝╚═╝     "
echo -e "${NC}"
echo "  RTMP Restream Manager - Setup"
echo "  Ubuntu 24.04 LTS"
echo "  ─────────────────────────────────────"
echo ""

# ── Step 1: Update system ─────────────────────────────────────────────────
info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
success "System updated"

# ── Step 2: Install nginx with RTMP module ────────────────────────────────
info "Installing nginx + RTMP module..."
apt-get install -y -qq nginx libnginx-mod-rtmp

# Check if RTMP module is available
if ! dpkg -l | grep -q libnginx-mod-rtmp; then
  warn "libnginx-mod-rtmp not found, trying nginx-full..."
  apt-get install -y -qq nginx-full
fi

success "nginx installed"

# ── Step 3: Install ffmpeg ────────────────────────────────────────────────
info "Installing ffmpeg..."
apt-get install -y -qq ffmpeg
ffmpeg -version | head -1
success "ffmpeg installed"

# ── Step 4: Install Node.js 20 ───────────────────────────────────────────
info "Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
  apt-get install -y -qq nodejs
fi
node --version
success "Node.js installed: $(node --version)"

# ── Step 5: Create directories ────────────────────────────────────────────
info "Creating directories..."
mkdir -p $APP_DIR $HLS_DIR $APP_DIR/public
chown -R www-data:www-data $HLS_DIR
chmod 755 $HLS_DIR
success "Directories created"

# ── Step 6: Copy app files ────────────────────────────────────────────────
info "Installing application files..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "$SCRIPT_DIR/server.js"    $APP_DIR/
cp "$SCRIPT_DIR/package.json" $APP_DIR/
cp -r "$SCRIPT_DIR/public/"   $APP_DIR/public/

chown -R www-data:www-data $APP_DIR

cd $APP_DIR
npm install --production --quiet
success "App files installed"

# ── Step 7: Configure nginx (SAFE — does NOT touch port 80/443) ──────────
info "Configuring nginx (port 80/443 untouched)..."

# 7a: Copy site config for port 8080
cp "$SCRIPT_DIR/nginx-rtmp-manager.conf" /etc/nginx/sites-available/rtmp-manager
ln -sf /etc/nginx/sites-available/rtmp-manager /etc/nginx/sites-enabled/rtmp-manager
success "Site config installed → /etc/nginx/sites-available/rtmp-manager"

# 7b: Add rtmp{} block to main nginx.conf (only if not already there)
cp "$SCRIPT_DIR/nginx-rtmp-module.conf" /etc/nginx/rtmp-manager-module.conf
if ! grep -q "rtmp-manager-module.conf" /etc/nginx/nginx.conf; then
  printf '\n# RTMP Restream Manager\ninclude /etc/nginx/rtmp-manager-module.conf;\n' >> /etc/nginx/nginx.conf
  success "RTMP block injected into /etc/nginx/nginx.conf"
else
  warn "RTMP module already in nginx.conf — skipped"
fi

# 7c: Create HLS directory
chown www-data:www-data $HLS_DIR

# 7d: Validate
nginx -t && success "nginx config OK" || error "nginx config error — run: sudo nginx -t"

# ── Step 8: Configure sudo for nginx restart ─────────────────────────────
info "Configuring sudoers for nginx restart..."
cat > /etc/sudoers.d/rtmp-manager << 'EOF'
www-data ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
www-data ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
EOF
chmod 0440 /etc/sudoers.d/rtmp-manager
success "Sudoers configured"

# ── Step 9: Install systemd service ──────────────────────────────────────
info "Installing systemd service..."
cp "$SCRIPT_DIR/rtmp-manager.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable rtmp-manager
success "Service installed"

# ── Step 10: Configure firewall ───────────────────────────────────────────
info "Configuring firewall..."
if command -v ufw &> /dev/null; then
  ufw allow 22/tcp   comment "SSH"   2>/dev/null || true
  # port 80 already open (SSL) — skipping
  ufw allow 1935/tcp comment "RTMP"  2>/dev/null || true
  ufw allow 8080/tcp comment "RTMP Web UI" 2>/dev/null || true
  success "UFW rules added"
else
  warn "UFW not found, please configure firewall manually"
  warn "Required ports: 22 (SSH), 1935 (RTMP), 8080 (Web UI)"
fi

# ── Step 11: Start services ───────────────────────────────────────────────
info "Starting services..."
systemctl restart nginx
systemctl start rtmp-manager

sleep 2

if systemctl is-active --quiet nginx; then
  success "nginx is running"
else
  error "nginx failed to start - run: journalctl -u nginx -n 50"
fi

if systemctl is-active --quiet rtmp-manager; then
  success "rtmp-manager is running"
else
  warn "rtmp-manager may need a moment, check: journalctl -u rtmp-manager -f"
fi

# ── Done ──────────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Web UI:${NC}        http://${SERVER_IP}:8080"
echo -e "  ${CYAN}RTMP Ingest:${NC}   rtmp://${SERVER_IP}:1935/live/<key>"
echo -e "  ${CYAN}nginx Stats:${NC}   http://${SERVER_IP}:8080/stat"
echo -e "  ${CYAN}HLS Preview:${NC}   http://${SERVER_IP}:8080/hls/<key>.m3u8"
echo ""
echo -e "  ${YELLOW}Manage:${NC}"
echo -e "  sudo systemctl status rtmp-manager"
echo -e "  sudo journalctl -u rtmp-manager -f"
echo -e "  sudo systemctl restart rtmp-manager"
echo ""
echo -e "  ${YELLOW}App files:${NC} ${APP_DIR}"
echo -e "  ${YELLOW}Config:${NC}    ${APP_DIR}/config.json"
echo -e "  ${YELLOW}Logs:${NC}      ${APP_DIR}/stream.log"
echo ""
