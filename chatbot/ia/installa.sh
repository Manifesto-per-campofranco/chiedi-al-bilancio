#!/bin/bash
# Chiedi al bilancio - Comune di Campofranco
# Fase 5: prepara la macchina virtuale (Ubuntu 24.04, Oracle Cloud Always Free, processori Arm).
#
# Fa tutto da solo, in quest'ordine:
#   1. apre le porte 80 e 443 sulla macchina e installa nginx, Node e gli altri programmi necessari;
#   2. pubblica una pagina di stato su http://INDIRIZZO/prova/ da cui seguire l'installazione;
#   3. installa Ollama, il programma open source che fa girare i modelli di linguaggio, e scarica i modelli da provare;
#   4. monta la pagina "Chiedi al bilancio" e la pubblica su http://INDIRIZZO/ (solo livello base, per ora);
#   5. prova a ottenere il certificato HTTPS per l'indirizzo IP (Let's Encrypt, profilo a breve durata);
#   6. misura i modelli sulle domande di prova (puo' durare un paio d'ore) e scrive il rapporto;
#   7. avvia il servizio IA con il modello consigliato dalla prova e lo collega alla pagina.
#
# Si lancia come amministratore dalla cartella scaricata da GitHub:   sudo bash /opt/chiedi/src/chatbot/ia/installa.sh
# Si puo' rilanciare: i passi gia' fatti vengono ripetuti senza danni.
# Variabili facoltative:
#   MODELLI="qwen3:4b,qwen3:1.7b,gemma4:e2b"   modelli di linguaggio da provare, in ordine
#   EMBEDDING="embeddinggemma"                 modello per scegliere gli esempi anche per significato ("" = non provarlo)
#   SALTA_PROVA=1                              non rifare la misura dei modelli (usa l'ultimo rapporto)
#   ORIGINI="https://utente.github.io"         siti da cui la pagina puo' chiamare il servizio (serve dalla Fase 7)
#   SENZA_HTTPS=1                              non chiedere il certificato
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME="${HOME:-/root}"
export NEEDRESTART_MODE=a

MODELLI="${MODELLI:-qwen3:4b,qwen3:1.7b,gemma4:e2b}"
EMBEDDING="${EMBEDDING-embeddinggemma}"
ORIGINI="${ORIGINI:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"        # cartella con chatbot/
WEB=/var/www/chiedi
PROVA="$WEB/prova"
ETC=/etc/chiedi

if [ "$(id -u)" != "0" ]; then echo "Va lanciato come amministratore: sudo bash $0"; exit 1; fi
if [ ! -f "$SRC/chatbot/ia/servizio.mjs" ] || [ ! -f "$SRC/chatbot/dati/bilancio.json" ]; then echo "Non trovo i file di Chiedi al bilancio in $SRC"; exit 1; fi

# Lanciato a mano da un terminale: continua in sottofondo, cosi' non si ferma se il collegamento cade.
if [ -t 1 ] && [ -z "${CHIEDI_IN_SOTTOFONDO:-}" ] && command -v systemd-run >/dev/null; then
  systemctl reset-failed chiedi-installa 2>/dev/null
  systemd-run --unit=chiedi-installa --collect --setenv=CHIEDI_IN_SOTTOFONDO=1 --setenv=MODELLI="$MODELLI" --setenv=EMBEDDING="$EMBEDDING" \
    --setenv=ORIGINI="$ORIGINI" --setenv=SALTA_PROVA="${SALTA_PROVA:-}" --setenv=SENZA_HTTPS="${SENZA_HTTPS:-}" --setenv=HOME=/root bash "$0" \
    && echo "Installazione avviata in sottofondo. Segui lo stato su http://INDIRIZZO-DELLA-MACCHINA/prova/ oppure con: sudo journalctl -fu chiedi-installa"
  exit 0
fi

mkdir -p "$PROVA" "$WEB/sito" "$WEB/acme" "$ETC"
REGISTRO="$PROVA/installa.txt"
exec > >(tee -a "$REGISTRO") 2>&1
PASSI_FALLITI=""
stato() { echo "$(date -u +%H:%M:%S) $*" > "$PROVA/stato.txt"; echo; echo "=== $(date -u '+%Y-%m-%d %H:%M:%S') UTC === $*"; }
fallito() { PASSI_FALLITI="$PASSI_FALLITI; $*"; echo "!!! NON RIUSCITO: $*"; }
riprova() { local n=0; until "$@"; do n=$((n + 1)); [ "$n" -ge 4 ] && return 1; echo "... riprovo tra 20 secondi ($n)"; sleep 20; done; }

stato "1 di 7 - programmi di base e porte"
echo "Sistema: $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m), $(nproc) processori, $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo) di memoria, disco libero $(df -h / | awk 'NR==2 {print $4}')"
# Le immagini Ubuntu di Oracle bloccano tutte le porte tranne la 22: si aprono la 80 e la 443.
# (Vanno aperte anche nella rete di Oracle, dalla console: vedi la guida.)
apri_porta() { iptables -C INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$1" -j ACCEPT; }
if command -v iptables >/dev/null; then
  apri_porta 80; apri_porta 443
  if [ -f /etc/iptables/rules.v4 ]; then iptables-save > /etc/iptables/rules.v4; fi
fi
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi
riprova apt-get update -q || fallito "apt-get update"
riprova apt-get install -y -q curl ca-certificates nginx python3 python3-venv zstd tar xz-utils || fallito "installazione dei programmi di base"
apt-get install -y -q nodejs || echo "Node non disponibile tra i pacchetti del sistema: lo scarico dal sito ufficiale"
# memoria di riserva su disco: evita che il sistema fermi un modello se la memoria non basta
if [ "$(swapon --noheadings | wc -l)" = "0" ] && [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab || echo "memoria di riserva non creata"
fi
# Node 18 o successivo (Ubuntu 24.04 distribuisce la 18). Se e' piu' vecchio si scarica la versione ufficiale.
NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ "$("$NODE" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 18 ]; then
  ARCH="$(uname -m)"; case "$ARCH" in aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; esac
  F="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$ARCH.tar.xz" | head -1)"
  if [ -n "$F" ] && curl -fsSL "https://nodejs.org/dist/latest-v22.x/$F" | tar -xJ -C /opt; then ln -sf "/opt/${F%.tar.xz}/bin/node" /usr/local/bin/node; NODE=/usr/local/bin/node; else fallito "Node non installato"; fi
fi
echo "Node: $("$NODE" --version 2>/dev/null)"
id chiedi >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin chiedi
chown -R chiedi:chiedi "$PROVA"

stato "2 di 7 - pagina di stato"
cp "$SRC/chatbot/ia/stato.html" "$PROVA/index.html"
IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || curl -fsS -m 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || IP=""
echo "Indirizzo pubblico: ${IP:-non trovato}"
echo "$IP" > "$ETC/indirizzo"
# Configurazione di nginx. Con "https" aggiunge la porta 443 con il certificato.
scrivi_nginx() {
  local https="" v6="" v6s=""
  # le porte IPv6 solo se il sistema le prevede, altrimenti nginx non parte
  if [ -f /proc/net/if_inet6 ]; then v6=" listen [::]:80 default_server;"; v6s=" listen [::]:443 ssl default_server;"; fi
  if [ "${1:-}" = "https" ]; then https="  listen 443 ssl default_server;$v6s
  ssl_certificate /etc/letsencrypt/live/chiedi/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/chiedi/privkey.pem;"; fi
  cat > /etc/nginx/conf.d/chiedi.conf <<NGINX
# Chiedi al bilancio. Scritto da installa.sh: non modificare a mano.
# Nessun registro degli accessi: gli indirizzi di chi usa la pagina non vengono conservati.
limit_req_zone \$binary_remote_addr zone=chiedi:1m rate=30r/m;
server {
  listen 80 default_server;$v6
$https
  server_name _;
  access_log off; error_log /var/log/nginx/error.log crit;
  charset utf-8; server_tokens off;
  root $WEB/sito; index index.html;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Robots-Tag "noindex, nofollow" always;
  add_header Referrer-Policy no-referrer always;
  location /.well-known/acme-challenge/ { root $WEB/acme; }
  location = /api/leggi {
    limit_req zone=chiedi burst=10 nodelay; limit_req_status 429; limit_req_log_level info;
    client_max_body_size 4k; proxy_read_timeout 30s;
    proxy_pass http://127.0.0.1:8787;
  }
  location = /api/salute { proxy_pass http://127.0.0.1:8787; }
  location /prova/ { alias $PROVA/; index index.html; types { text/html html; application/json json; } default_type text/plain; add_header Cache-Control no-store always; add_header X-Robots-Tag "noindex, nofollow" always; }
  location / { try_files \$uri \$uri/ =404; add_header Cache-Control no-cache always; add_header X-Content-Type-Options nosniff always; add_header X-Robots-Tag "noindex, nofollow" always; add_header Referrer-Policy no-referrer always; }
}
NGINX
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl enable nginx >/dev/null 2>&1 && (systemctl reload nginx 2>/dev/null || systemctl restart nginx)
}
HTTPS_OK=""
if [ -f /etc/letsencrypt/live/chiedi/fullchain.pem ]; then HTTPS_OK=1; scrivi_nginx https || { scrivi_nginx || fallito "nginx"; }; else scrivi_nginx || fallito "nginx"; fi
echo "Pagina di stato: http://${IP:-INDIRIZZO}/prova/"

stato "3 di 7 - Ollama e modelli di linguaggio"
if ! command -v ollama >/dev/null; then riprova bash -c "set -o pipefail; curl -fsSL https://ollama.com/install.sh | sh"; fi
command -v ollama >/dev/null || fallito "installazione di Ollama"
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/chiedi.conf <<'CONF'
# Chiedi al bilancio: il modello resta in memoria, una domanda alla volta, istruzioni lunghe fino a 8192 gettoni.
[Service]
Environment="OLLAMA_KEEP_ALIVE=-1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_CONTEXT_LENGTH=8192"
CONF
systemctl daemon-reload; systemctl enable ollama >/dev/null 2>&1; systemctl restart ollama
for i in $(seq 1 30); do curl -fsS -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 2; done
echo "Ollama: $(curl -fsS -m 3 http://127.0.0.1:11434/api/version 2>/dev/null || echo 'non risponde')"
if [ -z "${SALTA_PROVA:-}" ]; then
  for m in $(echo "$MODELLI,$EMBEDDING" | tr ',' ' '); do
    echo "Scarico $m ..."; riprova ollama pull "$m" >/dev/null 2>&1 && echo "  scaricato" || fallito "modello $m non scaricato"
  done
fi
ollama list 2>/dev/null || true
echo "Disco libero: $(df -h / | awk 'NR==2 {print $4}')"

stato "4 di 7 - pagina Chiedi al bilancio"
# La pagina si monta qui, dagli stessi file del progetto. Finche' l'IA non e' pronta usa il solo livello base.
imposta_pagina() {   # $1 = si|no (IA attiva)   $2 = politica
  (cd "$SRC" && python3 chatbot/build_app.py "$SRC" >/dev/null) || return 1
  cp "$SRC/pubblica/sito/index.html" "$SRC/pubblica/sito/bilancio.json" "$WEB/sito/" || return 1
  "$NODE" -e '
    const fs = require("fs"), [da, a, attiva, politica] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(da, "utf-8"));
    Object.assign(c.impostazioni, { ia_attiva: attiva, ia_url: attiva === "si" ? "/api/leggi" : "", ia_politica: politica || "dubbi" });
    fs.writeFileSync(a, JSON.stringify(c));' "$SRC/pubblica/sito/catalogo.json" "$WEB/sito/catalogo.json" "$1" "${2:-dubbi}"
}
imposta_pagina no || fallito "pagina non montata"
echo "Pagina: http://${IP:-INDIRIZZO}/"

stato "5 di 7 - certificato HTTPS per l'indirizzo IP"
# Let's Encrypt rilascia certificati per indirizzi IP solo con il profilo a breve durata (6 giorni), rinnovati in automatico.
# Serve Certbot 5.4 o successivo, che si installa in una cartella a parte. Se non riesce, la pagina resta raggiungibile in HTTP.
if [ -n "${SENZA_HTTPS:-}" ]; then echo "Saltato su richiesta."
elif [ -z "$IP" ]; then fallito "certificato: indirizzo pubblico non trovato"
else
  [ -x /opt/certbot/bin/certbot ] || { python3 -m venv /opt/certbot && /opt/certbot/bin/pip install -q --upgrade pip certbot; } || fallito "Certbot non installato"
  if [ -x /opt/certbot/bin/certbot ]; then
    echo "Certbot: $(/opt/certbot/bin/certbot --version 2>&1)"
    chiedi_certificato() { /opt/certbot/bin/certbot certonly --non-interactive --agree-tos "$@" --preferred-profile shortlived --webroot --webroot-path "$WEB/acme" --ip-address "$IP" --cert-name chiedi --deploy-hook "systemctl reload nginx"; }
    if chiedi_certificato --register-unsafely-without-email || chiedi_certificato; then
      HTTPS_OK=1; scrivi_nginx https || { fallito "nginx con HTTPS"; HTTPS_OK=""; scrivi_nginx; }
      cat > /etc/systemd/system/chiedi-certificato.service <<'UNIT'
[Unit]
Description=Chiedi al bilancio: rinnovo del certificato HTTPS
[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet
UNIT
      cat > /etc/systemd/system/chiedi-certificato.timer <<'UNIT'
[Unit]
Description=Chiedi al bilancio: rinnovo del certificato HTTPS, ogni otto ore
[Timer]
OnBootSec=10min
OnUnitActiveSec=8h
RandomizedDelaySec=20min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
      systemctl daemon-reload; systemctl enable --now chiedi-certificato.timer >/dev/null 2>&1
      echo "HTTPS attivo: https://$IP/"
    else
      fallito "certificato HTTPS non ottenuto (la porta 80 e' aperta anche nella rete di Oracle?). La pagina funziona comunque in HTTP"
    fi
  fi
fi

stato "6 di 7 - prova dei modelli (puo' durare un paio d'ore: l'avanzamento e' qui sotto)"
if [ -z "${SALTA_PROVA:-}" ]; then
  systemctl stop chiedi-ia 2>/dev/null       # durante la misura il modello non deve servire altre domande
  rm -f "$PROVA/consigliato.json"
  chown -R chiedi:chiedi "$PROVA"
  runuser -u chiedi -- "$NODE" "$SRC/chatbot/ia/prova_ia.mjs" "$SRC" --modelli "$MODELLI" ${EMBEDDING:+--embedding "$EMBEDDING"} --esempi-ridotti 3 --uscita "$PROVA" || fallito "prova dei modelli"
else echo "Saltata su richiesta: uso l'ultimo rapporto."
fi

stato "7 di 7 - servizio IA"
CONS="$PROVA/consigliato.json"
leggi_cons() { "$NODE" -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); process.stdout.write(String((c && c[process.argv[2]]) ?? "")); } catch (e) {}' "$CONS" "$1"; }
MODELLO="$(leggi_cons modello)"
if [ -z "$MODELLO" ]; then
  fallito "nessun modello consigliato dalla prova: il servizio IA non parte e la pagina resta al livello base"
else
  cat > "$ETC/ia.env" <<ENV
# Chiedi al bilancio: impostazioni del servizio IA. Scritto da installa.sh dopo la prova dei modelli.
PORTA=8787
OLLAMA=http://127.0.0.1:11434
MODELLO=$MODELLO
EMBEDDING=$(leggi_cons embedding)
ESEMPI=$(leggi_cons esempi)
ORIGINI=$ORIGINI
DATI=$SRC/chatbot/dati
ENV
  sed -i 's/^ESEMPI=$/ESEMPI=6/' "$ETC/ia.env"
  cat > /etc/systemd/system/chiedi-ia.service <<UNIT
[Unit]
Description=Chiedi al bilancio: lettura delle domande con il modello di linguaggio
After=network-online.target ollama.service
Wants=ollama.service
[Service]
User=chiedi
Group=chiedi
EnvironmentFile=$ETC/ia.env
ExecStart=$NODE $SRC/chatbot/ia/servizio.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable chiedi-ia >/dev/null 2>&1; systemctl restart chiedi-ia
  echo "Servizio avviato con il modello $MODELLO. Attendo che il modello abbia letto le istruzioni (alcuni minuti)..."
  for i in $(seq 1 90); do curl -fsS -m 3 http://127.0.0.1:8787/api/salute 2>/dev/null | grep -q '"pronto":true' && break; sleep 10; done
  SALUTE="$(curl -fsS -m 3 http://127.0.0.1:8787/api/salute 2>/dev/null || echo 'non risponde')"
  echo "Stato del servizio: $SALUTE"
  if echo "$SALUTE" | grep -q '"pronto":true'; then imposta_pagina si "$(leggi_cons politica)" || fallito "pagina non collegata all'IA"
  else fallito "il servizio IA non e' pronto: la pagina resta al livello base"; fi
fi

BASE="http://${IP:-INDIRIZZO}"; [ -n "$HTTPS_OK" ] && BASE="https://$IP"
if [ -z "$PASSI_FALLITI" ]; then stato "FINITO - tutto riuscito. Pagina: $BASE/  Rapporto: $BASE/prova/"
else stato "FINITO CON PROBLEMI${PASSI_FALLITI}. Pagina: $BASE/  Rapporto: $BASE/prova/"; fi
