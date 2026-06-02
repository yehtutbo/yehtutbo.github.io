#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  YHB Restream Manager — Uninstall Script
#
#  Usage:  sudo bash uninstall.sh
#
#  What this removes:
#   • systemd service (rtmp-manager)
#   • App directory (/opt/rtmp-manager)
#   • nginx site config (port 8080 only)
#   • nginx-rtmp include line from nginx.conf
#   • nginx-rtmp-module.conf
#   • HLS directory (/var/www/hls)
#
#  What it KEEPS:
#   • nginx itself (may be used by other services)
#   • Node.js
#   • ffmpeg
#   • Port 80 / 443 configs (untouched)
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
step()    { echo -e "\n${BOLD}━━━  $*  ━━━${NC}"; }

[[ $EUID -ne 0 ]] && { echo -e "${RED}[ERROR]${NC} Run as root: sudo bash uninstall.sh"; exit 1; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   YHB Restream Manager — Uninstaller     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Confirm ────────────────────────────────────────────────────────────────
echo -e "${YELLOW}This will remove YHB Restream Manager completely.${NC}"
echo -e "${YELLOW}Your nginx port 80/443 configs will NOT be affected.${NC}"
echo ""
read -rp "Continue? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── Step 1: Stop and disable service ──────────────────────────────────────
step "Stopping services"

if systemctl is-active --quiet rtmp-manager 2>/dev/null; then
    systemctl stop rtmp-manager
    success "Service stopped"
else
    info "rtmp-manager service not running"
fi

if systemctl is-enabled --quiet rtmp-manager 2>/dev/null; then
    systemctl disable rtmp-manager
    success "Service disabled"
fi

# Remove service file
if [[ -f /etc/systemd/system/rtmp-manager.service ]]; then
    rm -f /etc/systemd/system/rtmp-manager.service
    systemctl daemon-reload
    success "Service file removed"
fi

# ── Step 2: Remove app directory ──────────────────────────────────────────
step "Removing application files"

if [[ -d /opt/rtmp-manager ]]; then
    # Offer to backup config before deleting
    if [[ -f /opt/rtmp-manager/config.json ]]; then
        echo ""
        read -rp "  Backup config.json and auth.json to /tmp? [Y/n] " backup
        if [[ ! "$backup" =~ ^[Nn]$ ]]; then
            cp /opt/rtmp-manager/config.json /tmp/rtmp-manager-config.json 2>/dev/null && \
                info "Config backed up to /tmp/rtmp-manager-config.json"
            cp /opt/rtmp-manager/auth.json   /tmp/rtmp-manager-auth.json   2>/dev/null && \
                info "Auth backed up to /tmp/rtmp-manager-auth.json"
        fi
    fi
    rm -rf /opt/rtmp-manager
    success "Removed /opt/rtmp-manager"
else
    info "/opt/rtmp-manager not found"
fi

# ── Step 3: Remove nginx site config ──────────────────────────────────────
step "Removing nginx site config"

# Disable site
if [[ -L /etc/nginx/sites-enabled/rtmp-manager ]]; then
    rm -f /etc/nginx/sites-enabled/rtmp-manager
    success "nginx site disabled"
fi

# Remove site config
if [[ -f /etc/nginx/sites-available/rtmp-manager ]]; then
    rm -f /etc/nginx/sites-available/rtmp-manager
    success "nginx site config removed"
fi

# ── Step 4: Remove nginx-rtmp config ──────────────────────────────────────
step "Removing nginx-rtmp config"

# Remove include line from nginx.conf
NGINX_CONF="/etc/nginx/nginx.conf"
if grep -q "rtmp-manager-module.conf" "$NGINX_CONF" 2>/dev/null; then
    sed -i '/rtmp-manager-module\.conf/d' "$NGINX_CONF"
    success "Removed rtmp-manager include from nginx.conf"
fi

# Remove rtmp module config file
if [[ -f /etc/nginx/rtmp-manager-module.conf ]]; then
    rm -f /etc/nginx/rtmp-manager-module.conf
    success "Removed rtmp-manager-module.conf"
fi

# ── Step 5: Remove HLS directory ──────────────────────────────────────────
step "Removing HLS files"

if [[ -d /var/www/hls ]]; then
    rm -rf /var/www/hls
    success "Removed /var/www/hls"
fi

# ── Step 6: Remove log file ───────────────────────────────────────────────
if [[ -f /opt/rtmp-manager/stream.log ]]; then
    rm -f /opt/rtmp-manager/stream.log
fi

# ── Step 7: Reload nginx ──────────────────────────────────────────────────
step "Reloading nginx"

if nginx -t 2>/dev/null; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
    success "nginx reloaded"
else
    warn "nginx config has errors — check manually: sudo nginx -t"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Uninstallation Complete ✓            ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
info "nginx, Node.js, and ffmpeg were NOT removed (may be used by other services)"
echo ""
if [[ -f /tmp/rtmp-manager-config.json ]]; then
    info "Config backup: /tmp/rtmp-manager-config.json"
    info "Auth backup:   /tmp/rtmp-manager-auth.json"
fi
echo ""
