// Chiedi al bilancio - Comune di Campofranco
// Fase 5: misura quanto capiscono i modelli di linguaggio e quanto ci mettono, sulla macchina dove gireranno.
//
// Uso:  node chatbot/ia/prova_ia.mjs [cartella_radice] --modelli qwen3:1.7b,qwen3:4b [--ollama http://127.0.0.1:11434]
//         [--embedding embeddinggemma] [--esempi 6] [--esempi-ridotti 3] [--uscita cartella] [--limite N] [--soglia-ms 10000]
// Per ogni modello fa leggere le domande di controllo e le domande difficili (mai usate per mettere a punto il dizionario
// e mai date come esempio al modello) e confronta la risposta con quella attesa, con lo stesso criterio usato per il livello base.
// Confronta tre modi di usare l'IA: sempre; solo sulle domande che il livello base segnala come dubbie; mai (solo livello base).
// Con --embedding ripete la prova del modello migliore scegliendo gli esempi anche per significato.
// Con --esempi-ridotti ripete la prova del modello migliore con meno esempi: e' piu' veloce, si vede quanto perde.
// Scrive nella cartella di uscita: rapporto_ia.md, rapporto_ia.json, consigliato.json e avanzamento.txt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creaMotore } from '../motore/motore.mjs';
import { creaInterprete } from '../motore/capisci.mjs';
import { creaConfronto, leggiCsv } from '../motore/confronta.mjs';
import { creaLettore, creaLetturaIA } from './lettura.mjs';
import { creaOllama } from './ollama.mjs';

const args = process.argv.slice(2);
const opz = (nome, pred) => { const i = args.indexOf(`--${nome}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : pred; };
const conValore = new Set(['modelli', 'ollama', 'embedding', 'esempi', 'esempi-ridotti', 'uscita', 'limite', 'soglia-ms']);
const RADICE = args.find((a, i) => !a.startsWith('--') && !(i > 0 && conValore.has(args[i - 1].slice(2)))) || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const D = (...p) => path.join(RADICE, 'chatbot', ...p);
const USCITA = opz('uscita', D('ia'));
const MODELLI = opz('modelli', 'qwen3:4b').split(',').map((x) => x.trim()).filter(Boolean);
const EMBEDDING = opz('embedding', ''), K_ESEMPI = Number(opz('esempi', 6)), K_RIDOTTI = Number(opz('esempi-ridotti', 0)), LIMITE = Number(opz('limite', 0)), SOGLIA = Number(opz('soglia-ms', 10000));
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

const catalogo = json(D('dati', 'catalogo.json'));
const motore = creaMotore(json(D('dati', 'bilancio.json')), catalogo, null);
const interprete = creaInterprete(catalogo, motore.info);
const K = creaConfronto(motore, interprete, catalogo);
const lettore = creaLettore(catalogo, json(D('dati', 'esempi_ia.json')).esempi, interprete.norm, { primo: motore.info.primo });
const ollama = creaOllama(opz('ollama', 'http://127.0.0.1:11434'));
fs.mkdirSync(USCITA, { recursive: true });
const avanzamento = (t) => { fs.writeFileSync(path.join(USCITA, 'avanzamento.txt'), `${new Date().toISOString().slice(11, 19)} ${t}\n`); console.log(t); };

// domande di misura, con la risposta del livello base
const INSIEMI = [['controllo', 'domande_di_controllo.csv'], ['difficili', 'domande_ia.csv']];
const domande = [];
for (const [insieme, file] of INSIEMI) {
  let righe = K.prepara(leggiCsv(D('catalogo', file)));
  if (LIMITE) righe = righe.slice(0, LIMITE);
  for (const x of righe) {
    const c = interprete.capisci(x.d.domanda, x.prec);
    domande.push({ ...x, insieme, base: { esito: K.esitoDi(x.d, K.risposta(c.richiesta, c.seguito, x.prec), x.attesa), letta: c.richiesta, seguito: c.seguito, dubbio: c.dubbio || '' } });
  }
}

const POLITICHE = [
  ['sempre', 'IA su tutte le domande', null],
  ['dubbi', 'IA solo sulle domande dubbie', ['non_capita', 'parole_sconosciute', 'voce_generica']],
  ['dubbi_stretti', 'IA solo su non capite e parole sconosciute', ['non_capita', 'parole_sconosciute']],
];
const mediana = (v, q = 0.5) => { if (!v.length) return null; const s = v.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const sec = (ms) => (ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
const pc = (n, t) => (t ? `${Math.round(n / t * 100)}%` : '–');

async function provaModello(modello, embedding, k = K_ESEMPI) {
  const nome = `${modello}${embedding ? ` + ${embedding}` : ''}${k !== K_ESEMPI ? `, ${k} esempi` : ''}`;
  const ia = creaLetturaIA({ lettore, ollama, modello, embedding, k });
  const out = { modello, embedding, esempi: k, nome, freddo_ms: null, errori: 0, non_valide: 0, domande: [] };
  avanzamento(`${nome}: primo avvio (il modello legge le istruzioni per la prima volta)`);
  const t0 = Date.now();
  try { await ia.scalda(); out.freddo_ms = Date.now() - t0; } catch (e) { out.saltato = `primo avvio non riuscito: ${String(e.message || e).slice(0, 160)}`; return out; }
  let n = 0;
  for (const x of domande) {
    n += 1;
    if (n % 5 === 1) avanzamento(`${nome}: domanda ${n} di ${domande.length}`);
    const r = { id: x.d.id, insieme: x.insieme, ms: null, scheda: null, esito: 'non capita', valida: false };
    try {
      const l = await ia.leggi(x.d.domanda, x.prec ? { voce: x.prec.voce } : null, { attesa: 180000 });
      r.ms = l.ms; r.tempi = l.tempi; r.scheda = l.scheda;
      if (!l.scheda) { out.non_valide += 1; r.grezzo = String(l.grezzo).slice(0, 200); }
      const c = l.scheda ? interprete.daLettura(x.d.domanda, x.prec, l.scheda) : null;
      if (c) { r.valida = true; r.letta = c.richiesta; r.seguito = c.seguito; r.esito = K.esitoDi(x.d, K.risposta(c.richiesta, c.seguito, x.prec), x.attesa); }
    } catch (e) { out.errori += 1; r.errore = String(e.message || e).slice(0, 160); }
    out.domande.push(r);
  }
  return out;
}

// Esito finale di ogni domanda con una certa politica: dove l'IA non viene usata o non da' una scheda valida vale il livello base.
function conPolitica(prova, motivi) {
  return domande.map((x, i) => {
    const r = prova.domande[i];
    const usaIA = motivi === null || motivi.includes(x.base.dubbio);
    const daIA = usaIA && r.valida;
    return { d: x.d, famiglia: x.famiglia, insieme: x.insieme, usaIA, esito: daIA ? r.esito : x.base.esito, letta: daIA ? r.letta : x.base.letta, seguito: daIA ? r.seguito : x.base.seguito, ms: usaIA ? r.ms : 0 };
  });
}
const giuste = (righe, insieme) => righe.filter((r) => (!insieme || r.insieme === insieme) && r.esito === 'giusta').length;
const quante = (insieme) => domande.filter((x) => x.insieme === insieme).length;

async function main() {
  const versione = await ollama.versione();
  const presenti = new Set((await ollama.modelli()).map((m) => m.nome.replace(/:latest$/, '')));
  const prove = [];
  for (const m of MODELLI) {
    if (!presenti.has(m) && !presenti.has(`${m}:latest`)) {
      avanzamento(`${m}: scarico il modello`);
      try { await ollama.scarica(m); } catch (e) { prove.push({ modello: m, embedding: '', nome: m, saltato: `non scaricato: ${String(e.message || e).slice(0, 160)}`, domande: [] }); continue; }
    }
    prove.push(await provaModello(m, ''));
    await ollama.libera(m);             // un modello alla volta in memoria
  }
  const riuscite = () => prove.filter((p) => !p.saltato);
  const tempi = (p) => p.domande.map((r) => r.ms).filter((x) => x !== null);
  const punteggio = (p, motivi) => giuste(conPolitica(p, motivi));
  // modello consigliato: il piu' preciso tra quelli abbastanza veloci; a parita' il piu' veloce
  const scegli = () => {
    const c = riuscite().map((p) => ({ p, med: mediana(tempi(p)), punti: punteggio(p, POLITICHE[1][2]) }));
    const veloci = c.filter((x) => x.med !== null && x.med <= SOGLIA);
    const lista = (veloci.length ? veloci : c).sort((a, b) => (veloci.length ? b.punti - a.punti || a.med - b.med : a.med - b.med));
    return lista.length ? lista[0].p : null;
  };
  let migliore = scegli();
  // varianti del modello migliore
  const primo = migliore;
  if (primo && K_RIDOTTI && K_RIDOTTI !== K_ESEMPI) prove.push(await provaModello(primo.modello, '', K_RIDOTTI));
  if (primo && EMBEDDING) {
    try {
      if (!presenti.has(EMBEDDING) && !presenti.has(`${EMBEDDING}:latest`)) { avanzamento(`${EMBEDDING}: scarico il modello di embedding`); await ollama.scarica(EMBEDDING); }
      prove.push(await provaModello(primo.modello, EMBEDDING));
      await ollama.libera(EMBEDDING);
    } catch (e) { prove.push({ modello: primo.modello, embedding: EMBEDDING, nome: `${primo.modello} + ${EMBEDDING}`, saltato: String(e.message || e).slice(0, 160), domande: [] }); }
  }
  if (primo) { await ollama.libera(primo.modello); migliore = scegli(); }

  // politica consigliata: "sempre" solo se guadagna almeno tre domande rispetto a "solo dubbie", perche' fa aspettare su ogni domanda
  let consigliato = null;
  if (migliore) {
    const sempre = punteggio(migliore, null), dubbi = punteggio(migliore, POLITICHE[1][2]);
    consigliato = { modello: migliore.modello, embedding: migliore.embedding, esempi: migliore.esempi, politica: sempre >= dubbi + 3 ? 'sempre' : 'dubbi',
      giuste_sempre: sempre, giuste_dubbi: dubbi, giuste_base: domande.filter((x) => x.base.esito === 'giusta').length, domande: domande.length,
      tempo_mediano_ms: mediana(tempi(migliore)), entro_soglia: mediana(tempi(migliore)) <= SOGLIA };
  }

  // rapporto
  const nC = quante('controllo'), nD = quante('difficili'), tot = domande.length;
  const baseR = domande.map((x) => ({ d: x.d, famiglia: x.famiglia, insieme: x.insieme, esito: x.base.esito, letta: x.base.letta, seguito: x.base.seguito }));
  const md = ['# Prova dei modelli di linguaggio', '',
    `Generato il ${new Date().toISOString().slice(0, 16).replace('T', ' alle ')} (ora UTC) da \`chatbot/ia/prova_ia.mjs\`.`, '',
    `Macchina: ${os.cpus().length} processori ${os.arch()}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB di memoria. Ollama ${versione}. Esempi dati al modello per ogni domanda: ${K_ESEMPI}.`, '',
    `Domande: ${nC} di controllo e ${nD} difficili, mai usate per mettere a punto il dizionario e mai date come esempio al modello.`, '',
    '## Riepilogo', '',
    `| Configurazione | Controllo (${nC}) | Difficili (${nD}) | Totale (${tot}) | Domande mandate all'IA | Tempo tipico dell'IA | Tempo in 9 casi su 10 |`, '|---|---:|---:|---:|---:|---:|---:|',
    `| Livello base, senza IA | ${giuste(baseR, 'controllo')} | ${giuste(baseR, 'difficili')} | ${giuste(baseR)} (${pc(giuste(baseR), tot)}) | 0 | – | – |`];
  for (const p of prove) {
    if (p.saltato) { md.push(`| ${p.nome} | – | – | non provato | – | – | – |`); continue; }
    for (const [, etichetta, motivi] of POLITICHE) {
      const r = conPolitica(p, motivi), ia = r.filter((x) => x.usaIA), t = ia.map((x) => x.ms).filter((x) => x !== null);
      md.push(`| ${p.nome}: ${etichetta} | ${giuste(r, 'controllo')} | ${giuste(r, 'difficili')} | ${giuste(r)} (${pc(giuste(r), tot)}) | ${ia.length} (${pc(ia.length, tot)}) | ${sec(mediana(t))} | ${sec(mediana(t, 0.9))} |`);
    }
  }
  md.push('', 'Giuste = la risposta è identica a quella attesa. Dove l\'IA non viene usata, o non compila una scheda valida, vale la lettura del livello base.', '');
  if (consigliato) {
    md.push('## Configurazione consigliata dalla prova', '',
      `Modello **${consigliato.modello}**${consigliato.embedding ? ` con esempi scelti anche per significato (${consigliato.embedding})` : ''}, con ${consigliato.esempi} esempi per domanda, usato **${consigliato.politica === 'sempre' ? 'su tutte le domande' : 'solo sulle domande dubbie'}**: `
      + `${consigliato.politica === 'sempre' ? consigliato.giuste_sempre : consigliato.giuste_dubbi} giuste su ${tot}, contro ${consigliato.giuste_base} del livello base. Tempo tipico di una lettura: ${sec(consigliato.tempo_mediano_ms)}`
      + `${consigliato.entro_soglia ? '' : `, sopra la soglia di ${sec(SOGLIA)}: nessun modello provato è abbastanza veloce`}.`, '',
      'È una scelta automatica, da confermare leggendo il rapporto.', '');
  }
  md.push('## Dettaglio per modello', '');
  for (const p of prove) {
    md.push(`### ${p.nome}`, '');
    if (p.saltato) { md.push(`Non provato: ${p.saltato}`, ''); continue; }
    const t = tempi(p), gen = p.domande.map((r) => (r.tempi && r.tempi.risposta && r.tempi.gettoni_risposta ? r.tempi.gettoni_risposta / (r.tempi.risposta / 1000) : null)).filter(Boolean);
    const dom = p.domande.map((r) => (r.tempi ? r.tempi.domanda : null)).filter((x) => x !== null);
    md.push(`- Primo avvio, con le istruzioni da leggere per la prima volta: ${sec(p.freddo_ms)}.`,
      `- Tempo per domanda: tipico ${sec(mediana(t))}, in 9 casi su 10 entro ${sec(mediana(t, 0.9))}, massimo ${sec(t.length ? Math.max(...t) : null)}.`,
      `- Di cui lettura della domanda e degli esempi: tipico ${sec(mediana(dom))}. Velocità di scrittura: ${gen.length ? mediana(gen).toFixed(1).replace('.', ',') : '–'} gettoni al secondo.`,
      `- Schede non valide: ${p.non_valide}. Errori o tempi scaduti: ${p.errori}.`, '');
    const soloIA = domande.map((x, i) => ({ d: x.d, famiglia: x.famiglia, insieme: x.insieme, esito: p.domande[i].esito, letta: p.domande[i].letta || p.domande[i].scheda, seguito: p.domande[i].seguito }));
    for (const [insieme] of INSIEMI) {
      const righe = soloIA.filter((r) => r.insieme === insieme);
      md.push(`Domande ${insieme === 'controllo' ? 'di controllo' : 'difficili'}, lette solo dall'IA:`, '', K.tabella(righe), '', 'Non giuste:', '', K.elenco(righe), '');
    }
  }
  md.push('## Livello base sulle stesse domande', '');
  for (const [insieme] of INSIEMI) md.push(`Domande ${insieme === 'controllo' ? 'di controllo' : 'difficili'}:`, '', K.tabella(baseR.filter((r) => r.insieme === insieme)), '');
  const perMotivo = ['non_capita', 'parole_sconosciute', 'voce_generica', ''].map((m) => { const q = domande.filter((x) => x.base.dubbio === m); return `${m || 'nessun dubbio'}: ${q.length} domande, ${q.filter((x) => x.base.esito === 'giusta').length} giuste`; });
  md.push(`Domande per segnale di dubbio del livello base: ${perMotivo.join('; ')}.`, '');

  fs.writeFileSync(path.join(USCITA, 'rapporto_ia.md'), md.join('\n'));
  fs.writeFileSync(path.join(USCITA, 'rapporto_ia.json'), JSON.stringify({ generato: new Date().toISOString(), ollama: versione, esempi: K_ESEMPI, soglia_ms: SOGLIA,
    macchina: { processori: os.cpus().length, architettura: os.arch(), memoria_gb: Number((os.totalmem() / 2 ** 30).toFixed(1)), modello_cpu: (os.cpus()[0] || {}).model || '' },
    domande: domande.map((x) => ({ id: x.d.id, insieme: x.insieme, domanda: x.d.domanda, famiglia: x.famiglia, base: x.base.esito, dubbio: x.base.dubbio })), prove, consigliato }));
  fs.writeFileSync(path.join(USCITA, 'consigliato.json'), JSON.stringify(consigliato));
  avanzamento(`prova finita: ${riuscite().length} modelli provati${consigliato ? `, consigliato ${consigliato.modello} (${consigliato.politica})` : ''}`);
  console.log(md.slice(0, md.indexOf('## Dettaglio per modello')).join('\n'));
}
main().catch((e) => { avanzamento(`prova interrotta: ${String(e.message || e).slice(0, 200)}`); process.exit(1); });
