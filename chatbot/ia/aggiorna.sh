#!/bin/bash
# Chiedi al bilancio - Fase 5: aggiorna la macchina virtuale con gli ultimi file caricati su GitHub.
#
# Uso, collegati alla macchina:   sudo bash /opt/chiedi/src/chatbot/ia/aggiorna.sh
# Scarica di nuovo i file e rilancia l'installazione. La prova dei modelli non viene rifatta:
# per rifarla   sudo PROVA=1 bash /opt/chiedi/src/chatbot/ia/aggiorna.sh
# Gli altri parametri di installa.sh (MODELLI, EMBEDDING, ORIGINI) si possono mettere davanti allo stesso modo.
set -uo pipefail
if [ "$(id -u)" != "0" ]; then echo "Va lanciato come amministratore: sudo bash $0"; exit 1; fi
REPO="$(cat /etc/chiedi/repo 2>/dev/null || true)"
if [ -z "$REPO" ]; then echo "Non so da quale archivio GitHub scaricare: manca /etc/chiedi/repo"; exit 1; fi
rm -rf /opt/chiedi/src.nuovo && mkdir -p /opt/chiedi/src.nuovo
if ! curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C /opt/chiedi/src.nuovo --strip-components=1 || [ ! -f /opt/chiedi/src.nuovo/chatbot/ia/installa.sh ]; then
  echo "Scaricamento non riuscito: i file sulla macchina non sono stati toccati."; rm -rf /opt/chiedi/src.nuovo; exit 1
fi
# i file nuovi prendono il posto dei vecchi nella stessa cartella, cosi' il servizio continua a trovarli
rm -rf /opt/chiedi/src.vecchio && cp -a /opt/chiedi/src /opt/chiedi/src.vecchio
cp -a /opt/chiedi/src.nuovo/. /opt/chiedi/src/ && rm -rf /opt/chiedi/src.nuovo
[ -n "${PROVA:-}" ] || export SALTA_PROVA=1
exec bash /opt/chiedi/src/chatbot/ia/installa.sh
