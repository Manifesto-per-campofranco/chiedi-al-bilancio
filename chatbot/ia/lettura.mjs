// Chiedi al bilancio - Comune di Campofranco
// Fase 5: far leggere la domanda a un modello di linguaggio open source.
//
// Il modello non risponde alla domanda e non vede i numeri del bilancio: compila soltanto una scheda
// con il tipo di domanda e la voce di cui si parla. Dalla scheda la pagina ricava la richiesta
// (capisci.mjs, funzione daLettura) e il motore calcola la risposta, come per il livello base.
//
// Qui ci sono solo funzioni senza rete e senza file: istruzioni per il modello, scelta degli esempi
// piu' simili alla domanda, controllo della scheda restituita. Nessuna dipendenza: Node 18 o successivo.

const INTENTI = ['valore', 'andamento', 'confronto', 'mesi', 'classifica', 'riscossione', 'definizione', 'documento', 'giudizio', 'aiuto', 'fuori_ambito'];
const MISURE = ['base', 'cassa', 'residui', 'previsto', 'percentuale', 'non_riscosso', 'recuperato', 'cancellato', 'quota'];

// Dalla lettura attesa di una domanda del catalogo (riga del file CSV) alla scheda compatta che il modello deve scrivere.
// prec = riga della domanda precedente, per le domande di seguito.
export function schedaDa(d, prec = null) {
  const L = { i: d.intento };
  if (d.voce && !(prec && prec.voce === d.voce)) L.v = d.voce;
  if (d.voce2) L.v2 = d.voce2;
  if (d.misura && d.misura !== 'base') L.m = d.misura;
  if (d.termine) L.t = d.termine;
  if (d.per_abitante) L.ab = true;
  if (prec) L.s = true;
  return L;
}

// catalogo = catalogo.json; esempi = [{ d: domanda, r: scheda, p: nome della voce della domanda precedente }];
// norm = funzione di normalizzazione del livello base (interprete.norm); primo = primo anno dei dati.
export function creaLettore(catalogo, esempi, norm, { primo = 2017 } = {}) {
  const VOCI = Object.fromEntries(catalogo.voci.map((v) => [v.id, v]));
  const GLOSS = Object.fromEntries(catalogo.glossario.map((g) => [g.id, g]));
  const tipi = (pref) => Object.keys(catalogo.frasi).filter((k) => k.startsWith(pref) && !k.endsWith('_base')).map((k) => k.slice(pref.length));
  const AIUTI = tipi('aiuto.'), LIMITI = tipi('limite.').filter((x) => x !== 'voce_vicina');
  const TERMINI = [...new Set([...Object.keys(GLOSS), ...AIUTI, ...LIMITI, 'minore'])];

  // --------------------------------------------------------------------------
  // Istruzioni: sempre uguali, cosi' il modello le elabora una volta sola e poi le tiene in memoria
  // --------------------------------------------------------------------------
  const riga = (v) => {
    const altri = [...v.sinonimi, ...v.contiene].filter((x) => norm(x) !== norm(v.nome)).slice(0, 12);
    return `${v.id}: ${v.nome}${altri.length ? ` (${altri.join(', ')})` : ''}`;
  };
  const gruppo = (titolo, lato) => `${titolo}\n${catalogo.voci.filter((v) => v.lato === lato).map(riga).join('\n')}`;
  const sistema = [
    'Sei il lettore delle domande di "Chiedi al bilancio", uno strumento sul bilancio del Comune di Campofranco.',
    'Non devi rispondere alla domanda. Devi solo indicare di cosa parla, compilando una scheda in formato JSON.',
    'Non scrivere mai anni, importi o spiegazioni: di quelli si occupa un altro programma.',
    '',
    'Campi della scheda. Scrivi solo quelli che servono.',
    '"i": il tipo di domanda. Uno tra:',
    '  valore = quanto vale una voce, quanto si spende o si incassa',
    '  andamento = come è cambiata negli anni, se è aumentata o diminuita',
    '  confronto = due anni messi a confronto',
    '  mesi = in quali mesi si incassa o si paga, oppure quanto in un certo mese',
    '  classifica = quali sono le voci più grandi o più piccole, dove vanno o da dove arrivano i soldi',
    '  riscossione = quanta parte di un\'entrata viene incassata, quanta resta non pagata, quanti arretrati si recuperano',
    '  definizione = chiede cosa significa un termine del bilancio',
    '  documento = chiede cosa c\'è scritto nelle relazioni o nel parere del revisore',
    '  giudizio = chiede un\'opinione o una valutazione: se è troppo, giusto, colpa o merito di qualcuno, chi votare',
    '  aiuto = saluti e domande sullo strumento stesso',
    '  fuori_ambito = domanda a cui lo strumento non può rispondere',
    '"v": la voce del bilancio di cui parla la domanda, scelta dall\'elenco qui sotto con il suo identificativo.',
    '"v2": una seconda voce, solo quando la domanda mette a confronto due voci.',
    '"m": il dato chiesto, solo se diverso dal caso normale. Uno tra:',
    '  cassa = quanto è stato incassato o pagato davvero, entrato o uscito dalla cassa',
    '  residui = quanto resta ancora da incassare o da pagare, gli arretrati',
    '  previsto = quanto era previsto',
    '  percentuale = che percentuale viene incassata o pagata',
    '  non_riscosso = quanto non è stato incassato o pagato dai cittadini',
    '  recuperato = quanti arretrati o vecchi crediti sono stati incassati',
    '  cancellato = quanti crediti sono stati cancellati',
    '  quota = quanto pesa una voce sul totale',
    '"t": un termine, solo in questi casi:',
    '  con definizione: l\'identificativo del termine, dall\'elenco dei termini qui sotto',
    '  con aiuto: saluto, cosa_fai (cosa sa fare, come si usa), chi_sei (se è una persona o un programma), fonti (da dove vengono i dati, se sono affidabili), aggiornamento (a che data arrivano i dati), chi_pubblica (chi lo ha fatto, se è del Comune), privacy (cosa succede alle domande scritte)',
    '  con fuori_ambito: persone (singole persone, dipendenti, ditte, nomi, stipendio di qualcuno), pratiche (come, dove o quando pagare, scadenze, moduli, a chi rivolgersi), previsioni (cosa succederà in futuro), altri_comuni (confronti con altri Comuni), servizi (lamentele o giudizi su come funziona un servizio), non_nei_dati (numero di persone, dipendenti o contribuenti, aliquote, debito residuo, dissesto), cause (chiede il perché di qualcosa), dettaglio (una singola opera, un acquisto, una fornitura, un evento preciso), '
      + `anno_fuori_periodo (anni prima del ${primo}), altro (la domanda non riguarda il bilancio)`,
    '  con classifica: minore, se chiede la voce più piccola',
    '"ab": true se chiede il valore per abitante, a testa, per ogni cittadino.',
    '"s": true se la domanda continua quella precedente senza dire di nuovo di quale voce parla.',
    '',
    'Con giudizio, fuori_ambito persone, cause, non_nei_dati e dettaglio indica comunque in "v" la voce di cui si parla, se c\'è.',
    'Per una classifica usa in "v" una delle voci del gruppo CLASSIFICHE.',
    '',
    'VOCI DEL BILANCIO (identificativo: nome, e tra parentesi altri modi di dirlo o cose che contiene)',
    gruppo('SPESE', 'spesa'), gruppo('ENTRATE', 'entrata'), gruppo('CONTI DEL COMUNE', 'conti'), gruppo('CLASSIFICHE', 'insieme'),
    gruppo('VOCI CHE NEI RENDICONTI NON CI SONO (si possono comunque indicare)', 'assente'),
    '',
    'TERMINI DEL GLOSSARIO (identificativo: termine)',
    catalogo.glossario.map((g) => `${g.id}: ${g.termine}`).join('\n'),
    '',
    'Rispondi solo con la scheda JSON, senza altro testo.',
  ].join('\n');

  // forma della scheda: il programma che fa girare il modello gli impedisce di scrivere altro
  const schema = { type: 'object', properties: {
    i: { type: 'string', enum: INTENTI },
    v: { type: 'string', enum: catalogo.voci.map((v) => v.id) },
    v2: { type: 'string', enum: catalogo.voci.map((v) => v.id) },
    m: { type: 'string', enum: MISURE },
    t: { type: 'string', enum: TERMINI },
    ab: { type: 'boolean' },
    s: { type: 'boolean' },
  }, required: ['i'] };

  // --------------------------------------------------------------------------
  // Esempi piu' simili alla domanda, presi dalle domande gia' lette a mano
  // --------------------------------------------------------------------------
  // Somiglianza sui gruppi di tre e quattro lettere: regge gli errori di battitura e non ha bisogno di altri programmi.
  const grammi = (s) => {
    const x = `_${norm(s).trim().replace(/\b(?:19|20)\d\d\b/g, '0000').replace(/ +/g, '_')}_`, m = new Map();
    for (const n of [3, 4]) for (let i = 0; i + n <= x.length; i += 1) { const g = x.slice(i, i + n); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const DOC = esempi.map((e) => grammi(e.d)), DF = new Map();
  for (const m of DOC) for (const g of m.keys()) DF.set(g, (DF.get(g) || 0) + 1);
  const idf = (g) => Math.log(1 + esempi.length / (DF.get(g) || 0.5));
  const pesi = (m) => { let n = 0; const o = new Map(); for (const [g, c] of m) { const w = c * idf(g); o.set(g, w); n += w * w; } return { o, n: Math.sqrt(n) || 1 }; };
  const VET = DOC.map(pesi);
  function lessicale(testo) {
    const q = pesi(grammi(testo));
    return VET.map((d) => { let p = 0; for (const [g, w] of q.o) { const x = d.o.get(g); if (x) p += w * x; } return p / (q.n * d.n); });
  }
  // k esempi, il piu' simile per ultimo. conPrec = la domanda segue un'altra domanda: servono anche esempi di domande di seguito.
  // altri = punteggi di somiglianza calcolati in altro modo (per esempio con un modello di embedding), uno per esempio, oppure null.
  function vicini(testo, conPrec, k = 6, altri = null) {
    const lex = lessicale(testo);
    const punti = lex.map((p, i) => p + (altri ? altri[i] : 0));
    const ordine = punti.map((p, i) => i).sort((a, b) => punti[b] - punti[a]);
    const scelti = [], perScheda = new Map();
    const prendi = (filtro, quanti) => {
      for (const i of ordine) {
        if (scelti.length >= quanti) break;
        if (scelti.includes(i) || !filtro(esempi[i])) continue;
        const chiave = JSON.stringify(esempi[i].r);
        if ((perScheda.get(chiave) || 0) >= 2) continue;          // non piu' di due esempi con la stessa scheda: servono esempi vari
        perScheda.set(chiave, (perScheda.get(chiave) || 0) + 1); scelti.push(i);
      }
    };
    if (conPrec) prendi((e) => !!e.p, Math.min(2, k));
    prendi((e) => (conPrec ? true : !e.p), k);
    return scelti.sort((a, b) => punti[a] - punti[b]).map((i) => esempi[i]);
  }

  // --------------------------------------------------------------------------
  // Messaggi per il modello e controllo della scheda
  // --------------------------------------------------------------------------
  const pulito = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const rigaD = (testo, nomePrec) => (nomePrec ? `D (dopo una domanda su «${nomePrec}»): ${testo}` : `D: ${testo}`);
  function messaggi(testo, prec, scelti) {
    const nomePrec = prec && VOCI[prec.voce] ? VOCI[prec.voce].nome : '';
    const righe = ['Esempi di domande già lette:'];
    for (const e of scelti) righe.push(rigaD(e.d, e.p), `R: ${JSON.stringify(e.r)}`);
    righe.push('', 'Ora leggi questa domanda.', rigaD(pulito(testo), nomePrec), 'R:');
    return [{ role: 'system', content: sistema }, { role: 'user', content: righe.join('\n') }];
  }
  // Dalla risposta del modello alla scheda, tenendo solo i valori ammessi. null se non e' una scheda.
  function valida(contenuto) {
    let o;
    try { o = typeof contenuto === 'string' ? JSON.parse(contenuto) : contenuto; } catch (e) { return null; }
    if (!o || typeof o !== 'object' || !INTENTI.includes(o.i)) return null;
    const L = { i: o.i };
    if (VOCI[o.v]) L.v = o.v;
    if (VOCI[o.v2] && o.v2 !== o.v) L.v2 = o.v2;
    if (MISURE.includes(o.m) && o.m !== 'base') L.m = o.m;
    if (TERMINI.includes(o.t)) L.t = o.t;
    if (o.ab === true) L.ab = true;
    if (o.s === true) L.s = true;
    return L;
  }

  return { sistema, schema, vicini, messaggi, valida, pulito, esempi };
}

// Lettura completa di una domanda: esempi, chiamata al modello, controllo della scheda.
// ollama = cliente creato da ollama.mjs. Con embedding = nome di un modello di embedding gli esempi si scelgono anche per significato.
export function creaLetturaIA({ lettore, ollama, modello, embedding = '', k = 6, contesto = 8192 }) {
  let vettori = null;      // embedding degli esempi, calcolati alla prima domanda
  const prodotto = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };
  async function somiglianze(testo) {
    if (!embedding) return null;
    if (!vettori) {
      vettori = [];
      for (let i = 0; i < lettore.esempi.length; i += 64) vettori.push(...await ollama.embed(embedding, lettore.esempi.slice(i, i + 64).map((e) => e.d)));
    }
    const [q] = await ollama.embed(embedding, [testo]);
    return vettori.map((v) => prodotto(v, q));
  }
  // Restituisce { scheda, ms, grezzo, tempi }. scheda e' null quando il modello non ha prodotto una scheda valida.
  async function leggi(testo, prec = null, { attesa = 60000 } = {}) {
    const t0 = Date.now();
    const pulita = lettore.pulito(testo);
    let altri = null;
    try { altri = await somiglianze(pulita); } catch (e) { altri = null; }          // senza embedding si usa la sola somiglianza di lettere
    const scelti = lettore.vicini(pulita, !!(prec && prec.voce), k, altri);
    const r = await ollama.chat({ modello, messaggi: lettore.messaggi(pulita, prec, scelti), schema: lettore.schema, contesto, attesa });
    return { scheda: lettore.valida(r.contenuto), ms: Date.now() - t0, grezzo: r.contenuto, tempi: r.tempi, esempi: scelti.length };
  }
  // Fa elaborare al modello le istruzioni una prima volta, cosi' le domande successive sono veloci.
  const scalda = () => leggi('quanto si spende per la scuola', null, { attesa: 900000 });
  return { leggi, scalda };
}
