// Chiedi al bilancio - Comune di Campofranco
// Fase 5: servizio che gira sulla macchina virtuale e fa leggere la domanda al modello di linguaggio.
//
// Riceve il testo della domanda e restituisce la scheda compilata dal modello (tipo di domanda, voce, dato chiesto).
// Non calcola numeri e non scrive risposte: la pagina ricava la richiesta dalla scheda e il motore, nel browser, calcola la risposta.
// Se il servizio non risponde, risponde tardi o la scheda non e' valida, la pagina usa il livello base.
//
// Riservatezza: il testo della domanda non viene scritto in nessun file e in nessun registro. Si registrano solo
// l'ora, la durata e l'esito di ogni richiesta, senza indirizzo di rete.
//
// Uso:  node chatbot/ia/servizio.mjs
// Impostazioni (variabili d'ambiente):
//   PORTA      porta di ascolto, solo sulla macchina stessa (8787)
//   OLLAMA     indirizzo di Ollama (http://127.0.0.1:11434)
//   MODELLO    modello di linguaggio, per esempio qwen3:4b
//   EMBEDDING  modello di embedding per scegliere gli esempi anche per significato (vuoto = non usato)
//   ESEMPI     quanti esempi dare al modello (6)
//   ORIGINI    indirizzi delle pagine che possono chiamare il servizio da un altro sito, separati da virgola
//   ATTESA_MS  tempo massimo per una lettura (20000)
//   DATI       cartella con catalogo.json, esempi_ia.json e bilancio.json (chatbot/dati)
// Nessuna dipendenza: Node 18 o successivo.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creaInterprete } from '../motore/capisci.mjs';
import { creaLettore, creaLetturaIA } from './lettura.mjs';
import { creaOllama } from './ollama.mjs';

const E = process.env;
const QUI = path.dirname(fileURLToPath(import.meta.url));
const DATI = E.DATI || path.resolve(QUI, '..', 'dati');
const PORTA = Number(E.PORTA || 8787), ATTESA = Number(E.ATTESA_MS || 20000), IN_CODA = Number(E.IN_CODA || 3);
const MODELLO = E.MODELLO || 'qwen3:4b', EMBEDDING = E.EMBEDDING || '';
const ORIGINI = new Set((E.ORIGINI || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean));
const json = (f) => JSON.parse(fs.readFileSync(path.join(DATI, f), 'utf-8'));

const catalogo = json('catalogo.json'), anni = json('bilancio.json').meta.anni_rendiconto;
const info = { primo: Math.min(...anni), ultimo: Math.max(...anni) };
const interprete = creaInterprete(catalogo, info);
const lettore = creaLettore(catalogo, json('esempi_ia.json').esempi, interprete.norm, { primo: info.primo });
const VOCI = new Set(catalogo.voci.map((v) => v.id));
const ollama = creaOllama(E.OLLAMA || 'http://127.0.0.1:11434');
const ia = creaLetturaIA({ lettore, ollama, modello: MODELLO, embedding: EMBEDDING, k: Number(E.ESEMPI || 6) });

const stato = { pronto: false, avvio: new Date().toISOString(), letture: 0, valide: 0, errori: 0, rifiutate: 0, ultimo_ms: null, errore_avvio: '' };
const registra = (testo) => console.log(`${new Date().toISOString()} ${testo}`);

// Il modello elabora una domanda alla volta: le altre aspettano in fila, e se la fila e' lunga la pagina usa subito il livello base.
let fila = Promise.resolve(), inAttesa = 0;
function inFila(lavoro) {
  inAttesa += 1;
  const esito = fila.then(lavoro, lavoro);
  fila = esito.then(() => { inAttesa -= 1; }, () => { inAttesa -= 1; });
  return esito;
}

async function scalda() {
  for (;;) {
    try {
      const t0 = Date.now();
      await ollama.versione();
      const r = await ia.scalda();
      stato.pronto = true; stato.errore_avvio = '';
      registra(`pronto modello=${MODELLO} embedding=${EMBEDDING || '-'} primo_avvio_ms=${Date.now() - t0} scheda=${r.scheda ? 'valida' : 'non valida'}`);
      return;
    } catch (e) {
      stato.errore_avvio = String(e.message || e).slice(0, 200);
      registra(`in attesa del modello: ${stato.errore_avvio}`);
      await new Promise((ok) => setTimeout(ok, 15000));
    }
  }
}

function rispondi(res, codice, corpo, origine) {
  const testate = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origine) { testate['Access-Control-Allow-Origin'] = origine; testate.Vary = 'Origin'; }
  res.writeHead(codice, testate);
  res.end(JSON.stringify(corpo));
}
function corpoDi(req, massimo = 2048) {
  return new Promise((ok, ko) => {
    let n = 0; const pezzi = [];
    req.on('data', (p) => { n += p.length; if (n > massimo) { ko(new Error('troppo lungo')); req.destroy(); } else pezzi.push(p); });
    req.on('end', () => ok(Buffer.concat(pezzi).toString('utf-8')));
    req.on('error', ko);
  });
}

const server = http.createServer(async (req, res) => {
  const origine = ORIGINI.has((req.headers.origin || '').replace(/\/+$/, '')) ? req.headers.origin : '';
  const percorso = (req.url || '').split('?')[0];
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, origine ? { 'Access-Control-Allow-Origin': origine, 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : {});
      return res.end();
    }
    if (req.method === 'GET' && percorso === '/api/salute') {
      return rispondi(res, 200, { ok: true, pronto: stato.pronto, modello: MODELLO, embedding: EMBEDDING, avvio: stato.avvio, letture: stato.letture, valide: stato.valide,
        errori: stato.errori, rifiutate: stato.rifiutate, ultimo_ms: stato.ultimo_ms, in_attesa: inAttesa, errore_avvio: stato.errore_avvio }, origine);
    }
    if (req.method !== 'POST' || percorso !== '/api/leggi') return rispondi(res, 404, { errore: 'non trovato' }, origine);
    if (!stato.pronto) return rispondi(res, 503, { errore: 'il modello non è ancora pronto' }, origine);
    if (inAttesa > IN_CODA) { stato.rifiutate += 1; return rispondi(res, 429, { errore: 'troppe domande insieme' }, origine); }
    let dati;
    try { dati = JSON.parse(await corpoDi(req)); } catch (e) { return rispondi(res, 400, { errore: 'richiesta non valida' }, origine); }
    const testo = typeof dati.testo === 'string' ? lettore.pulito(dati.testo) : '';
    if (testo.length < 2) return rispondi(res, 400, { errore: 'domanda mancante' }, origine);
    const prec = dati.prec && typeof dati.prec === 'object' && VOCI.has(dati.prec.voce) ? { voce: dati.prec.voce } : null;
    const t0 = Date.now();
    let esito;
    try {
      const r = await inFila(() => ia.leggi(testo, prec, { attesa: ATTESA }));
      stato.letture += 1; if (r.scheda) stato.valide += 1;
      esito = r.scheda ? 'scheda' : 'non_valida';
      rispondi(res, 200, { scheda: r.scheda, ms: Date.now() - t0, modello: MODELLO }, origine);
    } catch (e) {
      stato.errori += 1; esito = /timeout|aborted/i.test(String(e && (e.name + e.message))) ? 'tempo_scaduto' : 'errore';
      rispondi(res, esito === 'tempo_scaduto' ? 504 : 502, { errore: esito }, origine);
    }
    stato.ultimo_ms = Date.now() - t0;
    registra(`leggi ms=${stato.ultimo_ms} esito=${esito} in_attesa=${inAttesa}`);       // mai il testo della domanda
  } catch (e) {
    try { rispondi(res, 500, { errore: 'errore interno' }, origine); } catch (e2) { /* risposta gia' inviata */ }
  }
});
server.requestTimeout = 60000; server.headersTimeout = 15000;
server.listen(PORTA, E.ASCOLTO || '127.0.0.1', () => { registra(`servizio in ascolto sulla porta ${PORTA}, modello ${MODELLO}`); scalda(); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
