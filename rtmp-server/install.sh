#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  YHB Restream Manager — Install Script
#  Ubuntu 22.04 / 24.04 LTS
#
#  Usage:  sudo bash install.sh
#
#  What this script does:
#   1. Install nginx + nginx-rtmp module + Node.js 20 + ffmpeg
#   2. Create app directory /opt/rtmp-manager
#   3. Configure nginx (port 8080 only — does NOT touch port 80/443)
#   4. Configure nginx-rtmp (port 1935)
#   5. Create systemd service (runs as www-data)
#   6. Start everything
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()    { echo -e "\n${BOLD}━━━  $*  ━━━${NC}"; }

# ── Preflight ──────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Run as root:  sudo bash install.sh"

# Must run from the directory containing server.js
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/server.js" ]] || error "server.js not found in $SCRIPT_DIR. Run from the extracted folder."

APP_DIR="/opt/rtmp-manager"
SERVICE="rtmp-manager"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     YHB Restream Manager — Installer     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
info "Source: $SCRIPT_DIR"
info "Target: $APP_DIR"
echo ""

# ── Step 1: System packages ────────────────────────────────────────────────
step "Installing system packages"

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    nginx \
    libnginx-mod-rtmp \
    ffmpeg \
    curl \
    ca-certificates \
    gnupg \
    2>&1 | grep -E "^(Get:|Unpacking|Setting up|Processing)" || true

success "System packages installed"

# ── Step 2: Node.js 20 ────────────────────────────────────────────────────
step "Setting up Node.js 20"

if node --version 2>/dev/null | grep -q "^v2[0-9]"; then
    success "Node.js $(node --version) already installed"
else
    info "Installing Node.js 20 via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -3
    apt-get install -y nodejs 2>&1 | grep -E "^(Setting up|Processing)" || true
    success "Node.js $(node --version) installed"
fi

# ── Step 3: App directory ─────────────────────────────────────────────────
step "Setting up application directory"

mkdir -p "$APP_DIR/public"
mkdir -p /var/www/hls

# Copy application files
cp "$SCRIPT_DIR/server.js"    "$APP_DIR/"
cp "$SCRIPT_DIR/package.json" "$APP_DIR/"
cp -r "$SCRIPT_DIR/public/"   "$APP_DIR/public/"

# Install npm dependencies
cd "$APP_DIR"
npm install --production --silent 2>/dev/null || npm install --production
cd "$SCRIPT_DIR"

# Preserve existing config/auth if upgrading
if [[ -f "$APP_DIR/config.json" ]]; then
    info "Existing config.json preserved"
else
    info "Fresh install — config will be created on first run"
fi

# Permissions
chown -R www-data:www-data "$APP_DIR"
chown -R www-data:www-data /var/www/hls
chmod 750 "$APP_DIR"
chmod 755 "$APP_DIR/public"

success "App files deployed to $APP_DIR"

# ── Step 4: nginx-rtmp config ─────────────────────────────────────────────
step "Configuring nginx-rtmp (port 1935)"

RTMP_CONF="/etc/nginx/rtmp-manager-module.conf"

# Check if rtmp block already exists in nginx.conf
if grep -q "rtmp-manager-module.conf" /etc/nginx/nginx.conf 2>/dev/null; then
    info "nginx.conf already includes rtmp-manager-module.conf"
elif grep -q "^rtmp" /etc/nginx/nginx.conf 2>/dev/null; then
    warn "rtmp block already exists in nginx.conf — skipping rtmp module include"
    warn "Ensure your rtmp block has the on_publish callbacks pointing to port 3000"
else
    cp "$SCRIPT_DIR/nginx-rtmp-module.conf" "$RTMP_CONF"
    # Add include at the end of nginx.conf (before the last closing brace or at end)
    if ! grep -q "rtmp-manager-module" /etc/nginx/nginx.conf; then
        echo "" >> /etc/nginx/nginx.conf
        echo "include /etc/nginx/rtmp-manager-module.conf;" >> /etc/nginx/nginx.conf
    fi
    success "RTMP module configured"
fi

# ── Step 5: nginx site (port 8080) ────────────────────────────────────────
step "Configuring nginx site (port 8080)"

cp "$SCRIPT_DIR/nginx-rtmp-manager.conf" /etc/nginx/sites-available/rtmp-manager

# Enable site
if [[ ! -L /etc/nginx/sites-enabled/rtmp-manager ]]; then
    ln -s /etc/nginx/sites-available/rtmp-manager /etc/nginx/sites-enabled/rtmp-manager
fi

# Validate nginx config
if nginx -t 2>/dev/null; then
    success "nginx config valid"
else
    warn "nginx config test failed — check /etc/nginx/nginx.conf manually"
    nginx -t
fi

# ── Step 6: systemd service ───────────────────────────────────────────────
step "Setting up systemd service"

cp "$SCRIPT_DIR/rtmp-manager.service" /etc/systemd/system/rtmp-manager.service
systemctl daemon-reload
systemctl enable rtmp-manager

success "Service enabled: rtmp-manager"

# ── Step 7: Start services ─────────────────────────────────────────────────
step "Starting services"

systemctl restart nginx
sleep 1
systemctl restart rtmp-manager
sleep 2

# Check status
if systemctl is-active --quiet rtmp-manager; then
    success "rtmp-manager is running"
else
    error "rtmp-manager failed to start. Check: sudo journalctl -u rtmp-manager -n 30"
fi

if systemctl is-active --quiet nginx; then
    success "nginx is running"
else
    warn "nginx may have an issue. Check: sudo nginx -t && sudo systemctl status nginx"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║          Installation Complete! 🎉               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# Detect public IP
PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "  ${BOLD}Web UI:${NC}       http://${PUBLIC_IP}:8080"
echo -e "  ${BOLD}RTMP Ingest:${NC}  rtmp://${PUBLIC_IP}:1935/live"
echo ""
echo -e "  ${BOLD}Logs:${NC}         sudo journalctl -u rtmp-manager -f"
echo -e "  ${BOLD}Status:${NC}       sudo systemctl status rtmp-manager"
echo -e "  ${BOLD}Uninstall:${NC}    sudo bash uninstall.sh"
echo ""
echo -e "  ${YELLOW}Open the Web UI and create your admin account.${NC}"
echo ""
