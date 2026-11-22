// Chiedi al bilancio - Comune di Campofranco
// Fase 4: livello base. Traduce il testo di una domanda in una richiesta strutturata
// (intento, voce, misura, anno...) usando solo il dizionario del catalogo:
// voci con i loro sinonimi, glossario e parole chiave.
// Non usa intelligenza artificiale e non calcola numeri: la richiesta va passata al motore.
// In fondo c'e' daLettura, che dalla lettura dell'IA (Fase 5) ricava la richiesta con le stesse regole su anni e mesi.
// Nessuna dipendenza: funziona nel browser e in Node.

export function creaInterprete(catalogo, info, oggi = new Date()) {
  const PRIMO = info.primo, ULTIMO = info.ultimo;

  // testo senza maiuscole, accenti e punteggiatura, con uno spazio ai lati
  const norm = (s) => ' ' + String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

  // --------------------------------------------------------------------------
  // Dizionario
  // --------------------------------------------------------------------------
  const VOCI = {}, FRASI_VOCI = [];
  for (const v of catalogo.voci) {
    VOCI[v.id] = v;
    // una voce specifica batte i totali e le voci dei conti; tra due specifiche vince la piu' dettagliata
    const classe = ['spese_totali', 'entrate_totali'].includes(v.id) ? 0 : (['conti', 'insieme'].includes(v.lato) ? 1 : 2);
    const dettaglio = v.dati.length === 1 ? v.dati[0].split('.').length - 1 : 0;
    for (const tipo of ['sinonimi', 'contiene']) for (const s of v[tipo]) FRASI_VOCI.push({ id: v.id, classe, dettaglio, tipo, f: norm(s), orig: s });
  }
  const TERMINI = [];
  for (const g of catalogo.glossario) for (const s of [g.termine, ...g.sinonimi]) TERMINI.push({ id: g.id, f: norm(s) });
  const PAROLE = catalogo.parole.map((p) => ({ tipo: p.tipo, valore: p.valore, frasi: p.parole.map(norm) }));
  const regola = (nome) => new Set(catalogo.parole.filter((p) => p.tipo === 'regola' && p.valore === nome).flatMap((p) => p.parole));
  const SENZA_NUMERI = regola('giudizio_senza_numeri');     // voci che non si affiancano a una domanda di giudizio
  // coppie spesa -> entrata: "quanto si incassa per i rifiuti" riguarda la TARI, non il servizio rifiuti
  const coppie = (tipo) => Object.fromEntries(catalogo.parole.filter((p) => p.tipo === tipo).map((p) => [p.valore, p.parole[0]]));
  const COPPIE = coppie('coppia');
  // nelle domande sui mesi "pagamenti" e "incassi" sono le spese e le entrate
  const COPPIE_MESI = coppie('coppia_mesi');
  // voci che riguardano persone: si risponde con i numeri solo se la domanda chiede una quantita'
  const SERVE_QUANTITA = regola('serve_quantita');

  // posizioni di una frase nel testo: [inizio, fine] senza gli spazi ai lati
  function occorrenze(t, f) {
    const out = [];
    for (let i = t.indexOf(f); i >= 0; i = t.indexOf(f, i + 1)) out.push([i + 1, i + f.length - 1]);
    return out;
  }
  const piuLungo = (ms) => ms.reduce((m, x) => (!m || x.len > m.len ? x : m), null);   // a parita' vale l'ordine del file

  // Voci nominate nella domanda, la piu' probabile per prima.
  // Prima si assegnano le parole al sinonimo piu' lungo che le copre ("tassa sui rifiuti" e' la TARI, non i rifiuti),
  // poi tra le voci rimaste valgono le regole di precedenza.
  function cercaVoci(t) {
    const tutte = [];
    for (const x of FRASI_VOCI) for (const [da, a] of occorrenze(t, x.f)) tutte.push({ ...x, da, a, len: a - da });
    // prima il sinonimo piu' lungo; i due totali per ultimi ("maggiore spesa del comune" e' la classifica, non il totale)
    tutte.sort((x, y) => (x.classe === 0) - (y.classe === 0) || y.len - x.len || y.classe - x.classe || y.dettaglio - x.dettaglio || x.da - y.da);
    const prese = [];
    for (const m of tutte) if (!prese.some((p) => m.da < p.a && p.da < m.a)) prese.push(m);
    const per = {};
    for (const m of prese) {
      const c = per[m.id] || (per[m.id] = { id: m.id, classe: m.classe, dettaglio: m.dettaglio, len: 0, pos: Infinity, sinonimo: false, contiene: [], spans: [] });
      c.len = Math.max(c.len, m.len); c.pos = Math.min(c.pos, m.da); c.spans.push([m.da, m.a]);
      if (m.tipo === 'sinonimi') c.sinonimo = true; else c.contiene.push(m.orig);
    }
    return Object.values(per).sort((x, y) => y.classe - x.classe || y.dettaglio - x.dettaglio || y.len - x.len || x.pos - y.pos);
  }
  function cercaTermine(t) {
    const ms = [];
    for (const x of TERMINI) for (const [da, a] of occorrenze(t, x.f)) ms.push({ id: x.id, da, a, len: a - da });
    return piuLungo(ms);
  }
  // Parole chiave trovate. Non contano quelle che stanno dentro il nome della voce scelta
  // ("crediti che non incassera'" e' il fondo crediti, non una domanda sul futuro).
  function cercaParole(t, spans) {
    const out = [];
    for (const p of PAROLE) for (const f of p.frasi) for (const [da, a] of occorrenze(t, f)) {
      if (spans.some(([sa, sb]) => da >= sa && a <= sb)) continue;
      out.push({ tipo: p.tipo, valore: p.valore, da, a, len: a - da });
    }
    return out;
  }

  // Parole comuni: quelle delle domande gia' note che non fanno parte del nome di una voce, di un termine o di una
  // parola chiave. Una parola che non e' tra queste e non e' nel dizionario e' "sconosciuta": di solito indica
  // che la domanda scende in un dettaglio che i dati non hanno ("tettoia", "pulmino", "luminarie").
  const COMUNI = new Set(), PREFISSI = new Set();
  function fuoriDaiNomi(t) {
    const coperti = [];
    for (const c of cercaVoci(t)) coperti.push(...c.spans);
    const term = cercaTermine(t); if (term) coperti.push([term.da, term.a]);
    for (const p of cercaParole(t, [])) coperti.push([p.da, p.a]);
    const out = []; let i = 1;
    for (const w of t.trim().split(' ')) { const da = i, a = i + w.length; i = a + 1; if (!coperti.some(([x, y]) => da >= x && a <= y)) out.push(w); }
    return out;
  }
  for (const q of catalogo.domande_note || []) for (const w of fuoriDaiNomi(norm(q))) if (w.length >= 4) { COMUNI.add(w); if (w.length >= 5) PREFISSI.add(w.slice(0, 5)); }
  // parole che compaiono nel dizionario, anche solo come parte di un nome ("servizio" in "servizio rifiuti")
  const DIZIONARIO = new Set(), PREFISSI_DIZ = new Set();
  for (const f of [...FRASI_VOCI.map((x) => x.f), ...TERMINI.map((x) => x.f), ...PAROLE.flatMap((p) => p.frasi)]) {
    for (const w of f.trim().split(' ')) if (w.length >= 4) { DIZIONARIO.add(w); if (w.length >= 5) PREFISSI_DIZ.add(w.slice(0, 5)); }
  }
  // Una parola conta come nota anche se ha in comune le prime cinque lettere con una parola nota ("spendiamo", "spende").
  // ancheDizionario: quando una voce e' gia' stata riconosciuta, le parole del dizionario non sono un dettaglio in piu'.
  const sconosciute = (t, ancheDizionario) => fuoriDaiNomi(t).filter((w) => w.length >= 4 && !/^\d+$/.test(w)
    && !COMUNI.has(w) && !(w.length >= 5 && PREFISSI.has(w.slice(0, 5)))
    && !(ancheDizionario && (DIZIONARIO.has(w) || (w.length >= 5 && PREFISSI_DIZ.has(w.slice(0, 5))))));

  // parole che chiedono la voce piu' piccola di una classifica
  const ORDINE_MINORE = PAROLE.filter((p) => p.tipo === 'ordine' && p.valore === 'minore').flatMap((p) => p.frasi);
  const NUMERI = { due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, dieci: 10 };
  const VUOTE_RICERCA = new Set(('cosa dice dicono scrive scritto relazione relazioni revisore revisori parere documento documenti rendiconto si parla nella nel nei nelle '
    + 'del dello della dei degli delle sul sullo sulla sui sugli sulle al allo alla ai agli alle il lo la i gli le un uno una di da in su per con che c e dove trovo '
    + 'sono quali quale a come viene vengono comune').split(' '));
  const DATI = ['valore', 'riscossione', 'andamento', 'confronto', 'mesi', 'classifica'];

  // Anni, mesi e tempi relativi scritti nella domanda. Regole comuni al livello base e alla lettura dell'IA.
  function tempi(t, di, prec, haPrec) {
    const anni = [...new Set((t.match(/(?<= )(?:19|20)\d\d(?= )/g) || []).map(Number))];
    const annoUnico = anni.length === 1 ? anni[0] : undefined;
    const tm = piuLungo(di('tempo')), fa = t.match(/ (\d+) anni fa /);
    const annoRel = fa ? `r-${fa[1]}` : (tm ? `r${tm.valore}` : undefined);
    const sa = piuLungo(di('seguito_anno'));
    const annoSeguito = sa && haPrec ? (typeof prec.anno === 'number' ? prec.anno : ULTIMO) + Number(sa.valore) : undefined;
    const mu = t.match(/ ultimi (\d+|due|tre|quattro|cinque|sei|sette|otto|dieci) anni /);
    const ultimiN = mu ? (NUMERI[mu[1]] || Number(mu[1])) : 0;
    const dalAl = t.match(/ dal ((?:19|20)\d\d) (?:al|a|fino al) ((?:19|20)\d\d) /);
    const dal = t.match(/ dal ((?:19|20)\d\d) /);
    const ms = piuLungo(di('mese')), mese = ms ? Number(ms.valore) : undefined;
    return { anni, annoUnico, annoRel, annoSeguito, ultimiN, dalAl, dal, mese };
  }

  // Tipo di domanda sui dati (un anno, andamento, confronto, mesi) e anni a cui si riferisce.
  function taglio({ haMesi, haAnd, haConf }, { anni, annoUnico, annoRel, annoSeguito, ultimiN, dalAl, dal }, prec, seguito) {
    let intento, anno, anno2;
    const proprio = haMesi || ultimiN > 0 || !!dal || anni.length >= 2 || haAnd || haConf;
    if (haMesi) { intento = 'mesi'; anno = annoUnico !== undefined ? annoUnico : annoRel; }
    else if (ultimiN > 0) { intento = 'andamento'; anno = ULTIMO - ultimiN + 1; anno2 = ULTIMO; }
    else if (dalAl) { intento = 'andamento'; anno = Number(dalAl[1]); anno2 = Number(dalAl[2]); }
    else if (anni.length >= 2) { intento = 'confronto'; anno = Math.min(...anni); anno2 = Math.max(...anni); }
    else if (dal) { intento = 'andamento'; anno = Number(dal[1]); }
    else if (annoUnico !== undefined && haConf) { intento = 'confronto'; anno = annoUnico; }                 // "rispetto al 2019"
    else if (annoUnico !== undefined && haAnd && annoUnico > PRIMO && annoUnico <= ULTIMO) { intento = 'confronto'; anno = annoUnico - 1; anno2 = annoUnico; }
    else if ((haAnd || haConf) && annoUnico === undefined) intento = 'andamento';
    else { intento = 'valore'; anno = annoUnico !== undefined ? annoUnico : (annoRel !== undefined ? annoRel : annoSeguito); }

    if (seguito && !proprio) {
      // senza indicazioni proprie la domanda di seguito conserva il taglio della precedente
      if (anno !== undefined) intento = prec.intento === 'mesi' ? 'mesi' : 'valore';
      else if (DATI.includes(prec.intento)) { intento = prec.intento; if (['andamento', 'confronto'].includes(intento)) { anno = prec.anno; anno2 = prec.anno2; } }
    }
    return { intento, anno, anno2 };
  }

  // --------------------------------------------------------------------------
  // Dal testo alla richiesta
  // --------------------------------------------------------------------------
  // prec = richiesta della risposta precedente (quella restituita dal motore), oppure null.
  // Restituisce { richiesta, seguito, dubbio }: se seguito e' vero la richiesta va passata al motore
  // insieme alla precedente, che completa quello che manca.
  // dubbio dice se la lettura e' incerta e perche': 'non_capita', 'parole_sconosciute' (la domanda contiene parole
  // che il dizionario non conosce) o 'voce_generica' (nessuna voce nominata, solo un verbo). Vuoto = lettura sicura.
  // Sulle domande dubbie la pagina puo' chiedere aiuto all'intelligenza artificiale (Fase 5).
  function capisci(testo, prec = null) {
    const t = norm(testo);
    const esito = (richiesta, seguito = false, dubbio = '') => ({ richiesta, seguito, dubbio });
    if (t.trim().length < 2) return esito({});

    const cand = cercaVoci(t);
    // una classifica non si fa per mese: "in che mese si incassa di piu'" riguarda i mesi, non la voce piu' grande
    const chiedeMesi = cercaParole(t, []).some((p) => p.tipo === 'mese' || (p.tipo === 'intento' && p.valore === 'mesi'));
    const princ = (chiedeMesi ? cand.find((c) => VOCI[c.id].lato !== 'insieme') : cand[0]) || null;
    const parole = cercaParole(t, princ ? princ.spans : []);
    const di = (tipo, valore) => parole.filter((p) => p.tipo === tipo && (valore === undefined || p.valore === valore));
    const ha = (tipo, valore) => di(tipo, valore).length > 0;
    const termine = cercaTermine(t);
    const haPrec = !!(prec && prec.voce && VOCI[prec.voce]);

    const { anni, annoUnico, annoRel, annoSeguito, ultimiN, dalAl, dal, mese } = tempi(t, di, prec, haPrec);

    // 1. Domande che chiedono un giudizio: nessuna valutazione, al piu' i numeri della voce nominata.
    //    Il confronto con altri Comuni ha una sua risposta, anche quando la domanda contiene un giudizio.
    if (ha('limite', 'altri_comuni')) return esito({ intento: 'fuori_ambito', termine: 'altri_comuni' });
    if (ha('intento', 'giudizio')) {
      const r = { intento: 'giudizio' };
      if (princ && princ.sinonimo && !SENZA_NUMERI.has(princ.id)) { r.voce = princ.id; if (annoUnico) r.anno = annoUnico; }
      return esito(r);
    }
    // 2. Spiegazione di un termine
    if (ha('intento', 'definizione') && termine) return esito({ intento: 'definizione', termine: termine.id });
    // 3. Domande a cui lo strumento non risponde
    const lim = piuLungo(di('limite'));
    const futuro = anni.some((a) => a > oggi.getFullYear());
    if (lim || futuro) {
      const r = { intento: 'fuori_ambito', termine: lim ? lim.valore : 'previsioni' };
      if (['persone', 'cause', 'non_nei_dati'].includes(r.termine) && princ) { r.voce = princ.id; if (annoUnico) r.anno = annoUnico; }
      return esito(r);
    }
    // 4. Domande sullo strumento, solo se non e' nominata una voce del bilancio
    if (!princ) {
      const a = piuLungo(di('aiuto'));
      if (a && !(a.valore === 'saluto' && t.trim().split(' ').length > 3)) return esito({ intento: 'aiuto', termine: a.valore });
    }
    // 5. Ricerca nei documenti
    const ric = piuLungo(di('ricerca'));
    if (ha('intento', 'documento') || (ric && !princ)) {
      const r = { intento: 'documento' };
      r.ricerca = ric ? ric.valore : t.trim().split(' ').filter((w) => !VUOTE_RICERCA.has(w) && !/^(?:19|20)\d\d$/.test(w)).join(' ');
      if (annoUnico) r.anno = annoUnico;
      return esito(r);
    }

    // 6. Domande sui dati
    const haConf = ha('intento', 'confronto');
    const haAnd = ha('intento', 'andamento') || ultimiN > 0 || !!dal;
    const haMesi = ha('intento', 'mesi') || mese !== undefined;
    const mis = piuLungo(di('misura'));
    const perAb = ha('abitante');
    const verbo = di('totale')[0];
    const segnali = haConf || haAnd || haMesi || !!mis || perAb || anni.length > 0 || annoRel !== undefined || annoSeguito !== undefined;
    const iniziaConE = /^\s*e\s/i.test(testo);                          // "E nel 2022?", non "È aumentata?"
    const conUnAltra = / confront\w* (?:con|rispetto) /.test(t) || ha('intento', 'seguito');

    let voce, voce2, dettaglio, seguito = false, generica = false;
    if (princ && SERVE_QUANTITA.has(princ.id) && !ha('quantita') && !anni.length) return esito({}, false, 'non_capita');
    if (princ) {
      voce = princ.id;
      if (COPPIE[voce] && ha('verbo', 'entrata') && !cand.some((c) => c.id === COPPIE[voce])) voce = COPPIE[voce];
      if (!princ.sinonimo && princ.contiene.length) dettaglio = princ.contiene.reduce((m, x) => (x.length > m.length ? x : m), '');
      if (haPrec && iniziaConE) seguito = true;                         // "E le uscite?", "E la TARI?"
    } else if (haPrec && ((segnali && (iniziaConE || !verbo)) || ha('intento', 'seguito'))) {
      seguito = true;                                                   // la voce e' quella della domanda precedente
    } else if (verbo || ha('quantita')) {
      // nessuna voce nominata. Se la domanda contiene parole sconosciute chiede un dettaglio che i dati non hanno;
      // altrimenti il verbo dice se si parla di entrate o di spese in generale
      if (sconosciute(t, false).length) return esito({ intento: 'fuori_ambito', termine: 'dettaglio' }, false, 'parole_sconosciute');
      if (!verbo) return esito({}, false, 'non_capita');
      voce = verbo.valore; generica = true;
    } else if (termine && !anni.length) {
      return esito({ intento: 'definizione', termine: termine.id });    // solo un termine del glossario
    } else {
      return esito({}, false, 'non_capita');                            // non capita: il motore chiede di scriverla meglio
    }
    // voce nominata insieme a parole sconosciute ("il pulmino della scuola"): il dettaglio non c'e',
    // la risposta lo dice, rimanda agli uffici e riporta i numeri della voce piu' vicina
    if (princ && VOCI[princ.id].lato !== 'insieme' && sconosciute(t, true).length) {
      const r = { intento: 'fuori_ambito', termine: 'dettaglio' };
      if (princ.classe > 0) { r.voce = voce; if (annoUnico !== undefined) r.anno = annoUnico; }
      return esito(r, false, 'parole_sconosciute');
    }

    let { intento, anno, anno2 } = taglio({ haMesi, haAnd, haConf }, { anni, annoUnico, annoRel, annoSeguito, ultimiN, dalAl, dal }, prec, seguito);
    // "Fammi il confronto con la TARI" dopo una domanda sull'IMU
    if (princ && haPrec && haConf && conUnAltra && !anni.length && prec.voce !== princ.id) {
      voce = prec.voce; voce2 = princ.id; intento = 'andamento'; dettaglio = undefined; seguito = true;
    }
    // due voci a confronto negli anni: "piu' IMU o piu' TARI?"
    if (!voce2 && princ && ['andamento', 'confronto'].includes(intento) && (haConf || / o /.test(t))) {
      const due = cand.filter((c) => c.classe === 2 && c.sinonimo).slice(0, 2).sort((x, y) => x.pos - y.pos);
      if (due.length === 2) { voce = due[0].id; voce2 = due[1].id; dettaglio = undefined; if (anni.length < 2) intento = 'andamento'; }
    }
    if (voce && VOCI[voce].lato === 'insieme') intento = 'classifica';
    if (intento === 'mesi' && COPPIE_MESI[voce]) voce = COPPIE_MESI[voce];

    const r = { intento };
    if (voce) r.voce = voce;
    if (voce2) r.voce2 = voce2;
    if (mis && intento !== 'mesi' && intento !== 'classifica') r.misura = mis.valore;
    if (anno !== undefined) r.anno = anno;
    if (anno2 !== undefined) r.anno2 = anno2;
    if (perAb) r.per_abitante = true;
    if (intento === 'mesi' && mese !== undefined) r.mese = mese;
    if (dettaglio) r.dettaglio = dettaglio;
    if (intento === 'classifica' && ORDINE_MINORE.some((f) => t.includes(f))) r.termine = 'minore';      // "su cosa si spende meno?"
    if (r.intento === 'valore' && ['percentuale', 'non_riscosso', 'recuperato', 'cancellato'].includes(r.misura)) r.intento = 'riscossione';
    return esito(r, seguito, generica ? 'voce_generica' : '');
  }

  // --------------------------------------------------------------------------
  // Dalla lettura dell'intelligenza artificiale alla richiesta (Fase 5)
  // --------------------------------------------------------------------------
  // L'IA indica solo di cosa parla la domanda:
  //   { i: tipo di domanda, v: voce, v2: seconda voce, m: dato chiesto, t: termine, ab: per abitante, s: continua la precedente }
  // Anni, mesi e tempi relativi si leggono dal testo con le stesse regole del livello base: l'IA non puo' inventare un anno.
  // Restituisce { richiesta, seguito } oppure null quando la lettura non e' utilizzabile: la pagina usa allora il livello base.
  const GLOSS = new Set(catalogo.glossario.map((g) => g.id));
  const tipiDi = (pref) => new Set(Object.keys(catalogo.frasi).filter((k) => k.startsWith(pref) && !k.endsWith('_base')).map((k) => k.slice(pref.length)));
  const AIUTI = tipiDi('aiuto.'), LIMITI = tipiDi('limite.'); LIMITI.delete('voce_vicina');
  const MISURE = new Set(['cassa', 'residui', 'previsto', 'percentuale', 'non_riscosso', 'recuperato', 'cancellato', 'quota']);   // "base" e' il caso normale e non si scrive
  const INTENTI_IA = new Set([...DATI, 'definizione', 'documento', 'giudizio', 'aiuto', 'fuori_ambito']);
  const TOTALI = { spese_totali: 'spese_per_finalita', entrate_totali: 'entrate_singole' };      // una classifica chiesta sul totale riguarda le sue voci

  function daLettura(testo, prec, L) {
    if (!L || !INTENTI_IA.has(L.i)) return null;
    const t = norm(testo);
    if (t.trim().length < 2) return null;
    const esito = (richiesta, seguito = false) => ({ richiesta, seguito });
    let voce = VOCI[L.v] ? L.v : undefined;
    const voce2L = VOCI[L.v2] && L.v2 !== L.v ? L.v2 : undefined;
    const trovata = voce ? cercaVoci(t).find((x) => x.id === voce) : null;         // la voce scelta dall'IA, se e' anche nominata con le parole del dizionario
    const parole = cercaParole(t, trovata ? trovata.spans : []);
    const di = (tipo, valore) => parole.filter((p) => p.tipo === tipo && (valore === undefined || p.valore === valore));
    const ha = (tipo, valore) => di(tipo, valore).length > 0;
    const haPrec = !!(prec && prec.voce && VOCI[prec.voce]);
    const T = tempi(t, di, prec, haPrec);
    const { anni, annoUnico } = T;

    if (L.i === 'definizione') return GLOSS.has(L.t) ? esito({ intento: 'definizione', termine: L.t }) : null;
    if (L.i === 'aiuto') return AIUTI.has(L.t) ? esito({ intento: 'aiuto', termine: L.t }) : null;
    if (L.i === 'giudizio') {
      const r = { intento: 'giudizio' };
      if (voce && !SENZA_NUMERI.has(voce)) { r.voce = voce; if (annoUnico) r.anno = annoUnico; }
      return esito(r);
    }
    if (L.i === 'documento') {
      const ric = piuLungo(di('ricerca'));
      const r = { intento: 'documento', ricerca: ric ? ric.valore : t.trim().split(' ').filter((w) => !VUOTE_RICERCA.has(w) && !/^(?:19|20)\d\d$/.test(w)).join(' ') };
      if (annoUnico) r.anno = annoUnico;
      return esito(r);
    }
    if (L.i === 'fuori_ambito') {
      if (!LIMITI.has(L.t)) return null;
      const r = { intento: 'fuori_ambito', termine: L.t };
      const conVoce = ['persone', 'cause', 'non_nei_dati'].includes(L.t) || (L.t === 'dettaglio' && !TOTALI[voce]);
      if (voce && conVoce && VOCI[voce].lato !== 'insieme') { r.voce = voce; if (annoUnico !== undefined) r.anno = annoUnico; }
      return esito(r);
    }

    // domande sui dati
    if (anni.some((a) => a > oggi.getFullYear())) return esito({ intento: 'fuori_ambito', termine: 'previsioni' });
    const iniziaConE = /^\s*e\s/i.test(testo);
    let seguito = false, voce2, dettaglio;
    if (voce) { if (haPrec && L.s && (iniziaConE || ha('intento', 'seguito'))) seguito = true; }
    else if (haPrec && L.s) seguito = true;                                // la voce e' quella della domanda precedente
    else return null;
    if (voce && SERVE_QUANTITA.has(voce) && !ha('quantita') && !anni.length) return null;
    const haConf = ha('intento', 'confronto') || L.i === 'confronto';
    const haAnd = ha('intento', 'andamento') || T.ultimiN > 0 || !!T.dal || L.i === 'andamento';
    const haMesi = ha('intento', 'mesi') || T.mese !== undefined || L.i === 'mesi';
    if (haMesi && voce && VOCI[voce].lato === 'insieme') return null;      // una classifica non si fa per mese
    let { intento, anno, anno2 } = taglio({ haMesi, haAnd, haConf }, T, prec, seguito);

    // due voci a confronto
    if (seguito && !voce && voce2L) { voce = prec.voce; voce2 = voce2L; intento = 'andamento'; }             // "fammi il confronto con la TARI"
    else if (seguito && voce && !voce2L && voce !== prec.voce && haConf && !anni.length) { voce2 = voce; voce = prec.voce; intento = 'andamento'; }
    else if (voce && voce2L && !haMesi) { voce2 = voce2L; if (anni.length < 2) intento = 'andamento'; }
    if (voce2 === voce) voce2 = undefined;

    if (L.i === 'classifica' && TOTALI[voce]) voce = TOTALI[voce];
    if (voce && VOCI[voce].lato === 'insieme') intento = 'classifica';
    if (intento === 'mesi' && COPPIE_MESI[voce]) voce = COPPIE_MESI[voce];
    let mis = MISURE.has(L.m) ? L.m : (piuLungo(di('misura')) || {}).valore;
    if (!mis && L.i === 'riscossione') mis = 'percentuale';
    if (trovata && voce === trovata.id && !trovata.sinonimo && trovata.contiene.length && !voce2) dettaglio = trovata.contiene.reduce((m, x) => (x.length > m.length ? x : m), '');

    const r = { intento };
    if (voce) r.voce = voce;
    if (voce2) r.voce2 = voce2;
    if (mis && intento !== 'mesi' && intento !== 'classifica') r.misura = mis;
    if (anno !== undefined) r.anno = anno;
    if (anno2 !== undefined) r.anno2 = anno2;
    if (ha('abitante') || L.ab === true) r.per_abitante = true;
    if (intento === 'mesi' && T.mese !== undefined) r.mese = T.mese;
    if (dettaglio) r.dettaglio = dettaglio;
    if (intento === 'classifica' && (L.t === 'minore' || ORDINE_MINORE.some((f) => t.includes(f)))) r.termine = 'minore';
    if (r.intento === 'valore' && ['percentuale', 'non_riscosso', 'recuperato', 'cancellato'].includes(r.misura)) r.intento = 'riscossione';
    return esito(r, seguito);
  }
  return { capisci, daLettura, norm };
}
