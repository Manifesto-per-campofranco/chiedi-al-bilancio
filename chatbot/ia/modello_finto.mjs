// Chiedi al bilancio - Comune di Campofranco
// Fase 5: modello finto, per provare servizio, pagina e misura senza un vero modello di linguaggio.
//
// Si comporta come Ollama per le sole chiamate usate da ollama.mjs e rifiuta le richieste che non rispettano
// la forma documentata, cosi' un errore nel modo di chiamare Ollama si vede subito.
// La "lettura" e' quella del livello base, riscritta come scheda: serve a provare il percorso, non la qualita'.
// Nomi di modello speciali: finto-rotto (risposte che non sono una scheda), finto-lento (4 secondi per risposta).
// Con la variabile SCHEDA_FISSA risponde sempre con quella scheda: serve a provare nella pagina una lettura diversa da quella del livello base.
//
// Uso:  node chatbot/ia/modello_finto.mjs [porta]        (11435 se non indicata)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creaInterprete } from '../motore/capisci.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const json = (f) => JSON.parse(fs.readFileSync(path.resolve(QUI, '..', 'dati', f), 'utf-8'));
const catalogo = json('catalogo.json'), anni = json('bilancio.json').meta.anni_rendiconto;
const interprete = creaInterprete(catalogo, { primo: Math.min(...anni), ultimo: Math.max(...anni) });
const PER_NOME = Object.fromEntries(catalogo.voci.map((v) => [v.nome, v.id]));
const PORTA = Number(process.argv[2] || 11435);
const MODELLI = ['finto', 'finto-rotto', 'finto-lento', 'finto-embedding'];
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

function scheda(testo, nomePrec) {
  const prec = PER_NOME[nomePrec] ? { voce: PER_NOME[nomePrec], intento: 'valore' } : null;
  const c = interprete.capisci(testo, prec), r = c.richiesta;
  if (!r.intento) return { i: 'fuori_ambito', t: 'altro' };
  const L = { i: r.intento };
  if (r.voce) L.v = r.voce; if (r.voce2) L.v2 = r.voce2; if (r.misura) L.m = r.misura; if (r.termine) L.t = r.termine;
  if (r.per_abitante) L.ab = true; if (c.seguito) L.s = true;
  return L;
}
function vettore(testo) {
  const v = new Array(64).fill(0), t = ` ${String(testo).toLowerCase()} `;
  for (let i = 0; i + 3 <= t.length; i += 1) { let h = 0; for (const c of t.slice(i, i + 3)) h = (h * 31 + c.charCodeAt(0)) % 64; v[h] += 1; }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
const errore = (res, msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };

http.createServer(async (req, res) => {
  let corpo = '';
  for await (const p of req) corpo += p;
  const invia = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  const u = req.url;
  if (req.method === 'GET' && u === '/api/version') return invia({ version: '0.0.0-finto' });
  if (req.method === 'GET' && u === '/api/tags') return invia({ models: MODELLI.map((name) => ({ name, size: 1000 })) });
  let d;
  try { d = JSON.parse(corpo); } catch (e) { return errore(res, 'corpo non JSON'); }
  if (!MODELLI.includes(d.model)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: `model '${d.model}' not found` })); }
  if (u === '/api/generate') return (d.keep_alive === 0 ? invia({ model: d.model, done: true, done_reason: 'unload' }) : errore(res, 'generate: usato solo per liberare la memoria'));
  if (u === '/api/pull') return invia('{"status":"pulling manifest"}\n{"status":"success"}\n');
  if (u === '/api/embed') {
    if (!Array.isArray(d.input)) return errore(res, 'input deve essere un elenco');
    return invia({ model: d.model, embeddings: d.input.map(vettore) });
  }
  if (u === '/api/chat') {
    const m = d.messages;
    if (!Array.isArray(m) || m.length !== 2 || m[0].role !== 'system' || m[1].role !== 'user') return errore(res, 'messages: attesi system e user');
    if (d.stream !== false || d.think !== false) return errore(res, 'attesi stream false e think false');
    if (!d.format || d.format.type !== 'object' || !d.format.properties || !Array.isArray(d.format.required)) return errore(res, 'format deve essere uno schema JSON');
    if (!d.options || d.options.temperature !== 0 || !(d.options.num_ctx >= 4096) || !(d.options.num_predict > 0)) return errore(res, 'options: attesi temperature 0, num_ctx e num_predict');
    const righe = m[1].content.split('\n'), ultima = righe[righe.length - 2] || '';
    if (righe[righe.length - 1] !== 'R:' || !/^D[ :(]/.test(ultima)) return errore(res, 'il messaggio deve finire con la domanda e con R:');
    const x = ultima.match(/^D(?: \(dopo una domanda su «(.*?)»\))?: (.*)$/);
    if (d.model === 'finto-lento') await pausa(4000); else await pausa(Number(process.env.RITARDO || 5));
    const contenuto = d.model === 'finto-rotto' ? 'la risposta è quarantadue' : (process.env.SCHEDA_FISSA || JSON.stringify(scheda(x[2], x[1] || '')));
    return invia({ model: d.model, message: { role: 'assistant', content: contenuto }, done: true,
      total_duration: 5e6, load_duration: 0, prompt_eval_count: 180, prompt_eval_duration: 3e6, eval_count: 14, eval_duration: 2e6 });
  }
  res.writeHead(404); res.end();
}).listen(PORTA, '127.0.0.1', () => console.log(`modello finto in ascolto sulla porta ${PORTA}`));
