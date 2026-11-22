// Chiedi al bilancio - Comune di Campofranco
// Fase 3: motore di calcolo e di risposta.
//
// Riceve una richiesta gia' strutturata (intento, voce, misura, anno...) e restituisce
// una risposta fatta di: frase tipo completata con i numeri, fonte, avvertenze,
// serie per il grafico e proposte per la domanda successiva.
// Non interpreta testo libero e non usa intelligenza artificiale: ogni numero e'
// calcolato sul file dei dati, ogni frase viene dalle frasi tipo del catalogo.
// Nessuna dipendenza: funziona nel browser e in Node.

export function creaMotore(bilancio, catalogo, documenti = null, oggi = new Date()) {
  // --------------------------------------------------------------------------
  // Dati
  // --------------------------------------------------------------------------
  const tab = (t) => t.righe.map((r) => { const o = {}; t.colonne.forEach((k, i) => { o[k] = r[i]; }); return o; });
  const ENT = tab(bilancio.entrate_tipologie), CAT = tab(bilancio.entrate_categorie);
  const SPE = tab(bilancio.spese_programmi), MAC = tab(bilancio.spese_macroaggregati), RIS = tab(bilancio.risultato_amministrazione);
  const POP = bilancio.popolazione;
  const ANNI = bilancio.meta.anni_rendiconto.slice().sort((a, b) => a - b);
  const PRIMO = ANNI[0], ULTIMO = ANNI[ANNI.length - 1];
  const TECN_S = new Set([5, 7]), TECN_E = new Set([7, 9]);
  const NOME_UFF = {};
  for (const g of Object.values(bilancio.voci)) for (const v of g) NOME_UFF[v.id] = v.nome || v.nome_semplice || v.id;
  const NOME_SEMPLICE = {};
  for (const v of bilancio.voci.entrate) if (v.nome_semplice) NOME_SEMPLICE[v.id] = v.nome_semplice;
  const SE = bilancio.siope.entrate.righe.map((r) => ({ anno: r[0], mese: r[1], c: bilancio.siope.codici_entrate[r[2]], imp: r[3] }));
  const SU = bilancio.siope.uscite.righe.map((r) => ({ anno: r[0], mese: r[1], c: bilancio.siope.codici_uscite[r[2]], imp: r[3] }));
  const ANNI_SIOPE = [...new Set(SE.concat(SU).map((x) => x.anno))].sort((a, b) => a - b);
  const SIOPE_ULT_ANNO = ANNI_SIOPE[ANNI_SIOPE.length - 1];
  const SIOPE_ULT_MESE = Math.max(...SE.concat(SU).filter((x) => x.anno === SIOPE_ULT_ANNO).map((x) => x.mese));
  const ANNI_SIOPE_COMPLETI = ANNI_SIOPE.filter((a) => a < SIOPE_ULT_ANNO || SIOPE_ULT_MESE === 12);
  const MESI = ['', 'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const SIOPE_A = `${MESI[SIOPE_ULT_MESE]} ${SIOPE_ULT_ANNO}`;

  const VOCI = {}; for (const v of catalogo.voci) VOCI[v.id] = v;
  const GLOSSARIO = {}; for (const g of catalogo.glossario) GLOSSARIO[g.id] = g;
  const FRASI = catalogo.frasi;
  const IMP = catalogo.impostazioni || {};

  class Mancante extends Error { constructor(codice) { super(codice); this.codice = codice; } }

  // --------------------------------------------------------------------------
  // Formati
  // --------------------------------------------------------------------------
  const migliaia = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const intero = (x) => { const r = Math.round(x); return (r < 0 ? '-' : '') + migliaia(Math.abs(r)); };
  const euro = (x) => `${intero(x)} euro`;
  const euro2 = (x) => {
    const r = Math.round(Math.abs(x) * 100); const i = Math.floor(r / 100); const d = String(r % 100).padStart(2, '0');
    return `${x < 0 ? '-' : ''}${migliaia(i)},${d} euro`;
  };
  const perc = (x) => `${(Math.round(x * 10) / 10).toFixed(1).replace('.', ',')}%`;
  const segno = (x, f) => (x > 0 ? '+' : '') + f(x);
  // unita': 'euro' | 'euro_ab' | 'perc' | 'abitanti'
  const fmt = (x, unita) => (unita === 'perc' ? perc(x) : unita === 'euro_ab' ? euro2(x) : unita === 'abitanti' ? intero(x) : euro(x));
  const fmtDiff = (x, unita) => (unita === 'perc' ? `${segno(Math.round(x * 10) / 10, (v) => v.toFixed(1).replace('.', ','))} punti percentuali`
    : unita === 'abitanti' ? `${segno(x, intero)} residenti` : segno(x, unita === 'euro_ab' ? euro2 : euro));

  function frase(id, valori = {}) {
    const t = FRASI[id];
    if (t === undefined) throw new Error(`frase mancante: ${id}`);
    return t.replace(/\{(\w+)\}/g, (m, k) => {
      if (valori[k] === undefined) throw new Error(`frase ${id}: manca il valore {${k}}`);
      return String(valori[k]);
    });
  }

  // --------------------------------------------------------------------------
  // Lettura dei dati
  // --------------------------------------------------------------------------
  const chiave = (id) => id.slice(1).split('.').map(Number);
  function genere(id) {
    if (id === 'POP') return 'POP';
    const k = chiave(id);
    if (id[0] === 'E') return k.length === 3 ? 'Ec' : 'Et';
    if (id[0] === 'M') return 'Sp';
    if (id[0] === 'S') return k.length === 1 ? 'Sp' : 'Sm';
    if (id[0] === 'R') return 'R';
    throw new Error(`identificativo non valido: ${id}`);
  }
  const somma = (righe, campo) => righe.reduce((s, r) => s + (r[campo] || 0), 0);

  // Tutte le misure disponibili per un identificativo e un anno di rendiconto.
  function quadroId(id, anno) {
    const k = chiave(id), g = genere(id);
    if (g === 'Et') {
      const r = ENT.filter((x) => x.anno === anno && x.titolo === k[0] && (k.length === 1 || x.tipologia === k[1]));
      return { acc: somma(r, 'acc'), risc_comp: somma(r, 'risc_comp'), risc_res: somma(r, 'risc_res'), risc_tot: somma(r, 'risc_tot'),
        res_fin: somma(r, 'res_fin'), prev: somma(r, 'prev_comp'), riacc: somma(r, 'riacc_res') };
    }
    if (g === 'Ec') {
      const r = CAT.filter((x) => x.anno === anno && x.titolo === k[0] && x.tipologia === k[1] && x.categoria === k[2]);
      return { acc: somma(r, 'acc'), risc_comp: somma(r, 'risc_comp'), risc_res: r.some((x) => x.risc_res === null) ? null : somma(r, 'risc_res') };
    }
    if (g === 'Sp') {
      const r = id[0] === 'M'
        ? SPE.filter((x) => x.anno === anno && x.missione === k[0] && (k.length === 1 || x.programma === k[1]) && !TECN_S.has(x.titolo))
        : SPE.filter((x) => x.anno === anno && x.titolo === k[0]);
      return { imp: somma(r, 'imp'), pag_comp: somma(r, 'pag_comp'), pag_res: somma(r, 'pag_res'), pag_tot: somma(r, 'pag_tot'),
        res_fin: somma(r, 'res_fin'), prev: somma(r, 'prev_comp'), riacc: somma(r, 'riacc_res') };
    }
    if (g === 'Sm') {
      const r = MAC.filter((x) => x.anno === anno && x.titolo === k[0] && x.macro === k[1]);
      return { imp: somma(r, 'imp') };
    }
    if (g === 'R') {
      const r = RIS.filter((x) => x.anno === anno && x.voce === k[0]);
      return { valore: r.length ? r[0].totale : 0 };
    }
    return { valore: POP[String(anno)] };
  }
  function quadro(ids, anno) {
    const q = {};
    for (const id of ids) {
      const p = quadroId(id, anno);
      for (const [c, v] of Object.entries(p)) q[c] = (v === null || q[c] === null) ? null : (q[c] || 0) + v;
    }
    return q;
  }

  // Valore di una misura per un insieme di identificativi dello stesso genere.
  function misuraIds(ids, misura, anno) {
    const g = genere(ids[0]), q = quadro(ids, anno);
    if (g === 'POP') { if (q.valore === undefined) throw new Mancante('anno'); return { v: q.valore }; }
    if (g === 'R') return { v: q.valore };
    if (g === 'Et') {
      const m = { base: q.acc, cassa: q.risc_tot, residui: q.res_fin, previsto: q.prev, recuperato: q.risc_res, cancellato: q.riacc, non_riscosso: q.acc - q.risc_comp };
      if (misura in m) return { v: m[misura] };
      if (misura === 'percentuale') { if (!q.acc) throw new Mancante('zero'); return { v: q.risc_comp / q.acc * 100 }; }
      throw new Mancante('misura');
    }
    if (g === 'Ec') {
      if (misura === 'base') return { v: q.acc };
      if (misura === 'non_riscosso') return { v: q.acc - q.risc_comp };
      if (misura === 'percentuale') { if (!q.acc) throw new Mancante('zero'); return { v: q.risc_comp / q.acc * 100 }; }
      if (misura === 'cassa') return q.risc_res === null ? { v: q.risc_comp, parziale: true } : { v: q.risc_comp + q.risc_res };
      if (misura === 'recuperato') { if (q.risc_res === null) throw new Mancante('padre'); return { v: q.risc_res }; }
      throw new Mancante('padre');
    }
    if (g === 'Sp') {
      const m = { base: q.imp, cassa: q.pag_tot, residui: q.res_fin, previsto: q.prev, cancellato: q.riacc };
      if (misura in m) return { v: m[misura] };
      if (misura === 'percentuale') { if (!q.imp) throw new Mancante('zero'); return { v: q.pag_comp / q.imp * 100 }; }
      throw new Mancante('misura');
    }
    if (misura === 'base') return { v: q.imp };          // Sm
    throw new Mancante('solo_impegnato');
  }

  const MOVIMENTI = { crediti: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E9'] };
  const TOT_E = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'], TOT_S = ['S1', 'S2', 'S4'];

  function idsSiope(voce) {
    const ids = voce.dati_siope && voce.dati_siope.length ? voce.dati_siope : voce.dati;
    if (!ids.every((i) => i[0] === 'E' || i[0] === 'S')) throw new Mancante('siope');
    return ids;
  }
  function righeSiope(id) {
    const k = chiave(id);
    return id[0] === 'E'
      ? SE.filter((x) => x.c[2] === k[0] && (k.length < 2 || x.c[3] === k[1]) && (k.length < 3 || x.c[4] === k[2]))
      : SU.filter((x) => x.c[2] === k[0] && (k.length < 2 || x.c[3] === k[1]));
  }
  function siopeAnno(voce, anno) {
    let s = 0;
    for (const id of idsSiope(voce)) s += somma(righeSiope(id).filter((x) => x.anno === anno), 'imp');
    return s;
  }
  function siopeMesi(voce, anno) {
    const tot = new Array(13).fill(0);
    const anni = anno ? [anno] : ANNI_SIOPE_COMPLETI;
    for (const id of idsSiope(voce)) for (const x of righeSiope(id)) if (anni.includes(x.anno)) tot[x.mese] += x.imp;
    return { tot, anni };
  }

  // Valore di una voce del dizionario. Restituisce { v, parziale?, padre?, siope? }.
  function valoreVoce(voce, misura, anno) {
    if (anno > ULTIMO) {
      if (misura !== 'cassa') throw new Mancante('dopo_rendiconto');
      return { v: siopeAnno(voce, anno), siope: true };
    }
    let ids = voce.dati;
    if (MOVIMENTI[voce.id] && (misura === 'recuperato' || misura === 'cancellato')) ids = MOVIMENTI[voce.id];
    if (misura === 'quota') {
      const v = misuraIds(ids, 'base', anno).v;
      const den = ids[0][0] === 'E' ? TOT_E : (ids[0][0] === 'S' && ids[0].includes('.')) ? [ids[0].split('.')[0]] : TOT_S;
      const t = misuraIds(den, 'base', anno).v;
      if (!t) throw new Mancante('zero');
      return { v: v / t * 100, parte: v, totale: t, den };
    }
    try {
      return misuraIds(ids, misura, anno);
    } catch (e) {
      if (!(e instanceof Mancante) || e.codice !== 'padre') throw e;
      const p = ids[0].split('.').slice(0, 2).join('.');
      return { v: misuraIds([p], misura, anno).v, padre: p };
    }
  }

  // --------------------------------------------------------------------------
  // Nomi, unita', fonti
  // --------------------------------------------------------------------------
  function ufficiale(id) {
    if (id === 'POP') return 'popolazione residente';
    const k = id.slice(1), n = NOME_UFF[id] || '';
    if (id[0] === 'M') return `${k.includes('.') ? 'programma' : 'missione'} ${k}, ${n}`;
    if (id[0] === 'E') return `entrate, ${['titolo', 'tipologia', 'categoria'][k.split('.').length - 1]} ${k}, ${n}`;
    if (id[0] === 'S') return `spese, ${k.includes('.') ? 'macroaggregato' : 'titolo'} ${k}, ${n}`;
    return n;
  }
  const PROSPETTO = { Et: 'rendiconto delle entrate', Ec: 'entrate per categorie', Sm: 'spese per macroaggregati', R: 'prospetto del risultato di amministrazione' };
  function prospetto(ids) {
    const g = genere(ids[0]);
    if (g === 'Sp') return ids[0][0] === 'M' ? 'rendiconto delle spese per missioni e programmi' : 'rendiconto delle spese';
    return PROSPETTO[g];
  }
  function fonteBdap(ids, anno, anno2) {
    if (genere(ids[0]) === 'POP') return frase('fonte.istat');
    const u = ids.map(ufficiale).join('; ');
    return anno2 ? frase('fonte.bdap_serie', { a1: anno, a2: anno2, prospetto: prospetto(ids), ufficiale: u })
      : frase('fonte.bdap', { anno, prospetto: prospetto(ids), ufficiale: u });
  }
  const fonteSiope = (voce) => frase('fonte.siope', { movimento: latoSiope(voce) === 'E' ? 'incassi' : 'pagamenti', siope_a: SIOPE_A });
  const latoSiope = (voce) => idsSiope(voce)[0][0];
  const lato = (voce) => (voce.lato === 'conti' && voce.dati[0][0] === 'E' ? 'entrata' : voce.lato);

  function unita(voce, misura, perAb) {
    if (voce.id === 'popolazione') return 'abitanti';
    if (misura === 'percentuale' || misura === 'quota') return 'perc';
    return perAb ? 'euro_ab' : 'euro';
  }
  function nomeMisura(voce, misura, perAb) {
    const l = lato(voce);
    let n = misura === 'quota' ? FRASI['misura.quota'] : (FRASI[`misura.${l}.${misura}`] || FRASI['misura.conti.base']);
    if (voce.lato === 'conti' && !(voce.id === 'crediti' && ['recuperato', 'cancellato'].includes(misura))) n = FRASI['misura.conti.base'];
    if (voce.id === 'crediti' && ['recuperato', 'cancellato'].includes(misura)) n = FRASI[`misura.conti.${misura}`];
    if (voce.id === 'anticipazioni') n = FRASI['misura.anticipazioni'];
    if (['incassi_totali', 'pagamenti_totali'].includes(voce.id)) n = FRASI['misura.flusso'];
    if (voce.id === 'popolazione') n = 'residenti';
    return perAb ? `${n} ${FRASI['misura.per_abitante']}` : n;
  }
  const popolazione = (anno) => { const p = POP[String(anno)]; if (!p) throw new Mancante('anno'); return p; };

  // Serie per il piccolo grafico dell'andamento: un valore per ogni anno di rendiconto.
  // "disomogenea" = in qualche anno il dato e' parziale o esiste solo per la voce piu' ampia:
  // i valori non sono confrontabili tra loro e la serie non va mostrata.
  function serie(voce, misura, perAb, a1 = PRIMO, a2 = ULTIMO) {
    const anni = ANNI.filter((a) => a >= a1 && a <= a2);
    let disomogenea = false;
    const valori = anni.map((a) => {
      try {
        const r = valoreVoce(voce, misura, a);
        if (r.parziale || r.padre) disomogenea = true;
        return perAb ? r.v / popolazione(a) : r.v;
      } catch (e) { if (e instanceof Mancante) return null; throw e; }
    });
    // per il dato di base di entrate e spese: la parte pagata o incassata nello stesso anno, da disegnare dentro la barra
    let dentro = null, etichetta_dentro = '';
    if (misura === 'base' && ['spesa', 'entrata'].includes(voce.lato) && voce.dati.length && ['Sp', 'Et', 'Ec'].includes(genere(voce.dati[0]))) {
      const campo = voce.lato === 'spesa' ? 'pag_comp' : 'risc_comp';
      dentro = anni.map((a) => { const x = quadro(voce.dati, a)[campo]; return x === null || x === undefined ? null : (perAb ? x / popolazione(a) : x); });
      etichetta_dentro = FRASI[`graf.${voce.lato}.parte`];
    }
    return { anni, valori, dentro, unita: unita(voce, misura, perAb), etichetta: nomeMisura(voce, misura, perAb), etichetta_dentro, disomogenea };
  }

  // Dati per le barre che accompagnano la risposta su un anno.
  // { totale, parti }: un totale e le parti che lo compongono; "resto" segna la parte non pagata o non incassata.
  // { righe }: due grandezze sulla stessa scala (previsto e impegnato).
  const G = (k) => FRASI[`graf.${k}`];
  const parte = (k, valore, resto = false) => ({ etichetta: G(k), valore, resto });
  function barraDi(l, g, misura, q, r) {
    let b = null;
    if (l === 'spesa') {
      if (['base', 'percentuale'].includes(misura) && g !== 'Sm' && q.imp > 0) b = { totale: parte('spesa.totale', q.imp), parti: [parte('spesa.parte', q.pag_comp), parte('spesa.resto', q.imp - q.pag_comp, true)] };
      else if (misura === 'cassa' && q.pag_tot > 0) b = { totale: parte('spesa.cassa', q.pag_tot), parti: [parte('spesa.cassa_comp', q.pag_comp), parte('spesa.cassa_res', q.pag_res)] };
      else if (misura === 'previsto' && q.prev > 0) b = { righe: [parte('previsto', q.prev), parte('spesa.totale', q.imp)] };
    } else if (l === 'entrata') {
      if (['base', 'percentuale', 'non_riscosso'].includes(misura) && q.acc > 0) b = { totale: parte('entrata.totale', q.acc), parti: [parte('entrata.parte', q.risc_comp), parte('entrata.resto', q.acc - q.risc_comp, true)] };
      else if (misura === 'cassa' && !r.parziale && r.v > 0) b = { totale: parte('entrata.cassa', r.v), parti: [parte('entrata.cassa_comp', q.risc_comp), parte('entrata.cassa_res', q.risc_res)] };
      else if (misura === 'previsto' && q.prev > 0) b = { righe: [parte('previsto', q.prev), parte('entrata.totale', q.acc)] };
    }
    if (b && (b.parti || b.righe).some((x) => !(x.valore >= 0))) return null;      // valori negativi o mancanti: niente barra
    return b;
  }
  const tabellaDi = (id, valori) => FRASI[`tab.${id}`].split('|').map((etichetta, i) => ({ etichetta, valore: valori[i] }));

  // --------------------------------------------------------------------------
  // Risposte
  // --------------------------------------------------------------------------
  const base = (tipo, testo, altro = {}) => Object.assign({ tipo, testo, avvertenze: [], fonte: '', suggerimenti: [], controllo: null, serie: null, barra: null, tabella: null, capito: '' }, altro);
  const limite = (codice, extra = '') => base('limite', frase(`limite.${codice}`, { primo: PRIMO, ultimo: ULTIMO, siope_a: SIOPE_A }) + extra, { codice });
  const nonCapito = () => base('non_capito', frase('non_capito'));

  function capito(req, voce, anno, misura) {
    const p = [`«${voce.nome}»`];
    if (req.voce2 && VOCI[req.voce2]) p.push(`«${VOCI[req.voce2].nome}»`);
    if (req.intento === 'andamento') p.push(`dal ${anno} al ${req.anno2 || ULTIMO}`);
    else if (req.intento === 'confronto') p.push(`${anno} e ${req.anno2 || ULTIMO}`);
    else if (req.intento === 'mesi') p.push(req.mese ? `${MESI[req.mese]} ${anno}` : (req.anno ? String(req.anno) : 'mesi dell\'anno'));
    else p.push(String(anno));
    if (voce.lato !== 'insieme' && req.intento !== 'mesi') p.push(nomeMisura(voce, misura, req.per_abitante));
    return `Ho capito: ${p.join(', ')}.`;
  }

  // --------------------------------------------------------------------------
  // Domande proposte dopo la risposta: due, legate a quello che e' stato appena chiesto
  // --------------------------------------------------------------------------
  const GLOSSA = { crediti: 'residuo_attivo', debiti_da_pagare: 'residuo_passivo', risultato: 'risultato_amministrazione', accantonamenti: 'parte_accantonata',
    vincoli: 'parte_vincolata', anticipazioni: 'anticipazione_tesoreria' };
  const termineDi = (id) => { const t = GLOSSA[id] || id; return GLOSSARIO[t] ? t : null; };
  const QUADRI = { quadro_cassa: 'cassa', quadro_conti: 'disavanzo', debiti: 'debiti_da_pagare' };      // voce da seguire negli anni
  const proposta = (id, richiesta, valori) => ({ id, testo: frase(`sugg.${id}`, valori), richiesta });
  const pSpese = (anno) => proposta('classifica_spese', { intento: 'classifica', voce: 'spese_per_finalita', anno });
  const pEntrate = (anno) => proposta('classifica_entrate', { intento: 'classifica', voce: 'entrate_singole', anno });
  const pSignificato = (id) => proposta('significato', { intento: 'definizione', termine: termineDi(id) }, { termine: GLOSSARIO[termineDi(id)].termine });
  const pNegliAnni = (id) => proposta('voce_negli_anni', { intento: 'andamento', voce: id }, { voce: VOCI[id].nome });
  const iniziali = () => [pSpese(), pEntrate()];
  // tiene le prime due proposte diverse tra loro; se mancano, completa con quelle generali
  const due = (lista) => {
    const out = [];
    for (const x of lista.concat(iniziali())) if (x && out.length < 2 && !out.some((y) => y.id === x.id)) out.push(x);
    return out.map((x) => ({ testo: x.testo, richiesta: x.richiesta }));
  };

  function suggerimenti(req, voce, anno, misura) {
    const r = (o) => Object.assign({ voce: voce.id }, o);
    const tipo = req.intento, perAb = !!req.per_abitante, l = voce.lato, s = [];
    const contabile = ['spesa', 'entrata'].includes(l) && !['percentuale', 'quota'].includes(misura);
    if (anno > ULTIMO) {                                   // dati di cassa dopo l'ultimo rendiconto
      s.push(proposta('ultimo_rendiconto', r({ intento: 'valore', anno: ULTIMO }), { anno: ULTIMO }), proposta('andamento', r({ intento: 'andamento' })));
    } else if (tipo === 'mesi') {
      s.push(proposta('valore', r({ intento: 'valore' })), proposta('andamento', r({ intento: 'andamento' })));
    } else if (tipo === 'andamento' || tipo === 'confronto') {
      s.push(proposta('anno', r({ intento: 'valore', misura, anno, per_abitante: perAb }), { anno }));
      if (contabile && !perAb) s.push(proposta('abitante', r({ intento: 'andamento', misura, per_abitante: true })));
      else if (termineDi(voce.id)) s.push(pSignificato(voce.id));
    } else if (QUADRI[voce.id]) {
      s.push(pNegliAnni(QUADRI[voce.id]));
      if (termineDi(QUADRI[voce.id])) s.push(pSignificato(QUADRI[voce.id]));
    } else {
      const totale = ['spese_totali', 'entrate_totali'].includes(voce.id);
      if (totale) s.push(l === 'spesa' ? pSpese(anno) : pEntrate(anno));
      if (l === 'entrata') s.push(proposta('mesi', r({ intento: 'mesi' })));
      if (contabile && !perAb) s.push(proposta('abitante', r({ intento: 'valore', misura, anno, per_abitante: true })));
      if (['spesa', 'entrata'].includes(l) && misura !== 'quota' && !totale) s.push(proposta('quota', r({ intento: 'valore', misura: 'quota', anno })));
      if (l === 'conti' && termineDi(voce.id)) s.push(pSignificato(voce.id));
      s.push(proposta('andamento', r({ intento: 'andamento', misura, per_abitante: perAb })));
    }
    return due(s);
  }

  function aggiungiAbitante(risp, valore, anno) {
    const pop = popolazione(anno);
    risp.testo += ' ' + frase('abitante', { per_ab: euro2(valore / pop), pop: intero(pop), anno });
    risp.controllo = [valore / pop];
    risp.fonte += ' ' + frase('fonte.istat');
  }

  // Risposta su una voce dei conti (cassa, crediti, risultato...).
  function rispConti(req, voce, anno, misura) {
    const E = (id) => quadroId(id, anno);
    const R = (cod) => E(`R${cod}`).valore;
    let testo, controllo, ids = voce.dati, tabella = null;
    if (voce.id === 'quadro_cassa') {
      const v = [R(494), R(506), R(498), R(495)];
      testo = frase('conti.quadro_cassa', { anno, iniziale: euro(v[0]), incassi: euro(v[1]), pagamenti: euro(v[2]), finale: euro(v[3]) }); controllo = v;
      tabella = tabellaDi('quadro_cassa', v);
    } else if (voce.id === 'quadro_conti') {
      const v = [R(507), R(502), R(495), R(504), R(505)];
      testo = frase('conti.quadro_conti', { anno, risultato: euro(v[0]), disponibile: euro(v[1]), cassa: euro(v[2]), crediti: euro(v[3]), debiti: euro(v[4]) }); controllo = v;
      tabella = tabellaDi('quadro_conti', v);
    } else if (voce.id === 'debiti') {
      const v = [R(505), E('M50').imp, E('E7').acc, R(489)];
      testo = frase('conti.debiti', { anno, residui_passivi: euro(v[0]), mutui: euro(v[1]), anticipazioni: euro(v[2]), fal: euro(v[3]) }); controllo = v;
      tabella = tabellaDi('debiti', v);
    } else if (voce.id === 'anticipazioni') {
      const ric = E('E7').acc, rest = E('S5').pag_tot;
      testo = ric || rest ? frase('conti.anticipazioni', { anno, ricevute: euro(ric), restituite: euro(rest) }) : frase('conti.anticipazioni_zero', { anno });
      controllo = [ric]; ids = ['E7', 'S5'];
    } else if (voce.id === 'popolazione') {
      const p = popolazione(anno);
      testo = frase('conti.popolazione', { anno, valore: intero(p) }); controllo = [p];
    } else if (voce.id === 'crediti' && (misura === 'recuperato' || misura === 'cancellato')) {
      const x = valoreVoce(voce, misura, anno).v; ids = MOVIMENTI.crediti;
      testo = misura === 'recuperato' ? frase('conti.crediti_recuperato', { anno, valore: euro(x) })
        : frase(x <= 0 ? 'conti.crediti_cancellato_meno' : 'conti.crediti_cancellato_piu', { anno, valore: euro(Math.abs(x)) });
      controllo = [x];
    } else {
      const x = valoreVoce(voce, 'base', anno).v;
      let id = `conti.${voce.id}`;
      if (voce.id === 'disavanzo') id = x < 0 ? 'conti.disavanzo_neg' : 'conti.disavanzo_pos';
      testo = frase(id, { anno, valore: euro(x) }); controllo = [x];
    }
    const risp = base('dato', testo, { controllo, fonte: fonteBdap(ids, anno), tabella });
    if (req.per_abitante && controllo.length === 1 && voce.id !== 'popolazione') aggiungiAbitante(risp, controllo[0], anno);
    return risp;
  }

  // Risposta su una voce di entrata o di spesa in un anno di rendiconto.
  function rispEntrataSpesa(req, voce, anno, misura) {
    const l = voce.lato, ids = voce.dati, g = genere(ids[0]);
    const avvertenze = [];
    if (misura === 'quota') {
      const r = valoreVoce(voce, 'quota', anno);
      const nomeTot = r.den.length > 1 ? (l === 'entrata' ? VOCI.entrate_totali.nome : VOCI.spese_totali.nome) : NOME_UFF[r.den[0]];
      return base('dato', frase('quota', { anno, voce: voce.nome, perc: perc(r.v), totale: nomeTot, valore: euro(r.parte), tot: euro(r.totale) }),
        { controllo: [r.v], fonte: fonteBdap(ids, anno),
          barra: { totale: { etichetta: nomeTot, valore: r.totale }, parti: [{ etichetta: voce.nome, valore: r.parte, resto: false }, { etichetta: G('quota.resto'), valore: r.totale - r.parte, resto: true }] } });
    }
    if (l === 'spesa' && !['base', 'cassa', 'residui', 'previsto', 'percentuale'].includes(misura)) misura = 'base';
    let r;
    try { r = valoreVoce(voce, misura, anno); } catch (e) {
      if (!(e instanceof Mancante)) throw e;
      if (e.codice === 'solo_impegnato') { r = valoreVoce(voce, 'base', anno); misura = 'base'; avvertenze.push(frase('avv.solo_impegnato')); }
      else if (e.codice === 'zero') return base('dato', frase(l === 'entrata' ? 'entrata.base_zero' : 'spesa.base_zero', { anno, voce: voce.nome }), { controllo: [0], fonte: fonteBdap(ids, anno) });
      else if (e.codice === 'misura') { r = valoreVoce(voce, 'base', anno); misura = 'base'; }
      else throw e;
    }
    // quando il dato esiste solo per la voce piu' ampia, la risposta riguarda quella
    let v = voce, prefisso = '', tipo = 'dato', idsF = ids;
    if (r.padre) {
      v = { nome: NOME_UFF[r.padre], dati: [r.padre], lato: l };
      prefisso = frase('padre.prefisso', { voce: voce.nome, padre: v.nome }) + ' '; tipo = 'dato_contenuto'; idsF = [r.padre];
    }
    const q = quadro(idsF, anno), n = { anno, voce: v.nome };
    let testo;
    if (l === 'spesa') {
      if (misura === 'base') {
        if (g === 'Sm') { testo = frase('spesa.solo_impegnato', { ...n, imp: euro(q.imp) }); if (!avvertenze.length) avvertenze.push(frase('avv.solo_impegnato')); }
        else testo = q.imp ? frase('spesa.base', { ...n, imp: euro(q.imp), pag_comp: euro(q.pag_comp) }) : frase('spesa.base_zero', n);
      } else if (misura === 'cassa') testo = frase('spesa.cassa', { ...n, pag_tot: euro(q.pag_tot), pag_comp: euro(q.pag_comp), pag_res: euro(q.pag_res) });
      else if (misura === 'residui') testo = frase('spesa.residui', { ...n, res_fin: euro(q.res_fin) });
      else if (misura === 'previsto') testo = frase('spesa.previsto', { ...n, prev: euro(q.prev), imp: euro(q.imp) });
      else if (misura === 'percentuale') testo = frase('spesa.percentuale', { ...n, perc: perc(r.v), pag_comp: euro(q.pag_comp), imp: euro(q.imp) });
    } else {
      if (misura === 'base') testo = q.acc ? frase('entrata.base', { ...n, acc: euro(q.acc), risc_comp: euro(q.risc_comp), perc: perc(q.risc_comp / q.acc * 100) }) : frase('entrata.base_zero', n);
      else if (misura === 'cassa') {
        testo = r.parziale ? frase('entrata.cassa_parziale', { ...n, risc_comp: euro(q.risc_comp) })
          : frase('entrata.cassa', { ...n, risc_tot: euro(r.v), risc_comp: euro(q.risc_comp), risc_res: euro(q.risc_res) });
      } else if (misura === 'residui') testo = frase('entrata.residui', { ...n, res_fin: euro(q.res_fin) });
      else if (misura === 'previsto') testo = frase('entrata.previsto', { ...n, prev: euro(q.prev), acc: euro(q.acc) });
      else if (misura === 'percentuale') testo = frase('entrata.percentuale', { ...n, perc: perc(r.v), risc_comp: euro(q.risc_comp), acc: euro(q.acc) });
      else if (misura === 'non_riscosso') testo = frase('entrata.non_riscosso', { ...n, acc: euro(q.acc), non_risc: euro(r.v) });
      else if (misura === 'recuperato') testo = frase('entrata.recuperato', { ...n, risc_res: euro(r.v) });
      else if (misura === 'cancellato') testo = frase(r.v < 0 ? 'entrata.cancellato_meno' : r.v > 0 ? 'entrata.cancellato_piu' : 'entrata.cancellato_zero', { ...n, riacc: euro(Math.abs(r.v)) });
    }
    const risp = base(tipo, prefisso + testo, { controllo: [r.v], fonte: fonteBdap(idsF, anno), avvertenze, parziale: !!r.parziale, misura, barra: barraDi(l, g, misura, q, r) });
    if (voce.dati.length > 1) risp.avvertenze.push(frase('avv.totale'));
    if (req.per_abitante && !['percentuale'].includes(misura)) aggiungiAbitante(risp, r.v, anno);
    return risp;
  }

  // Dopo l'ultimo rendiconto: solo dati di cassa SIOPE.
  function rispDopoRendiconto(req, voce, anno) {
    let x;
    try { x = siopeAnno(voce, anno); } catch (e) {
      if (e instanceof Mancante) return base('limite', frase('siope.non_disponibile', { voce: voce.nome, ultimo: ULTIMO }), { codice: 'siope' });
      throw e;
    }
    const parziale = anno === SIOPE_ULT_ANNO && SIOPE_ULT_MESE < 12;
    const periodo = parziale ? `Da gennaio a ${MESI[SIOPE_ULT_MESE]} ${anno}` : `Nel ${anno}`;
    const risp = base('dato', frase(latoSiope(voce) === 'E' ? 'siope.entrata' : 'siope.spesa', { periodo, valore: euro(x), voce: voce.nome, anno }),
      { controllo: [x], fonte: fonteSiope(voce), avvertenze: [frase('avv.siope')], siope: true });
    if (parziale) risp.avvertenze.push(frase('avv.parziale', { anno, siope_a: SIOPE_A }));
    if (voce.dati.length > 1) risp.avvertenze.push(frase('avv.totale'));
    risp.mesi = siopeMesi(voce, anno).tot.slice(1);
    risp.anno_mesi = anno;
    return risp;
  }

  // Per i due totali la frase dice "in totale" invece di ripetere il nome della voce.
  const rifinisci = (testo, voce) => (['spese_totali', 'entrate_totali'].includes(voce.id) ? testo.split(` per «${voce.nome}»`).join(' in totale') : testo);

  function rispValore(req) {
    const voce = VOCI[req.voce];
    if (!voce) return nonCapito();
    if (voce.lato === 'assente') return base('voce_assente', frase('voce_assente', { nota: voce.nota }));
    if (voce.lato === 'insieme') return rispClassifica(req);
    const implicito = req.anno === undefined || req.anno === null;
    const anno = implicito ? ULTIMO : req.anno;
    if (anno < PRIMO || anno > SIOPE_ULT_ANNO) return limite('anno_fuori_periodo');
    let misura = req.misura || (req.intento === 'riscossione' ? 'percentuale' : 'base');
    let risp;
    if (anno > ULTIMO) risp = rispDopoRendiconto(req, voce, anno);
    else if (voce.lato === 'conti') risp = rispConti(req, voce, anno, misura);
    else risp = rispEntrataSpesa(req, voce, anno, misura);
    if (risp.tipo === 'limite') return risp;
    risp.testo = rifinisci(risp.testo, voce);
    misura = risp.misura || misura;
    if (req.dettaglio) { risp.testo = frase('contenuto.prefisso', { dettaglio: req.dettaglio, voce: voce.nome }) + ' ' + risp.testo + ' ' + frase('contenuto.uffici'); risp.tipo = 'dato_contenuto'; }
    if (implicito) risp.avvertenze.push(frase('avv.ultimo_anno', { anno }));
    if (voce.nota && !['spese_totali', 'entrate_totali'].includes(voce.id)) risp.avvertenze.push(voce.nota + '.');
    risp.capito = capito(req, voce, anno, misura);
    if (anno <= ULTIMO && voce.dati.length && !['quadro_cassa', 'quadro_conti', 'debiti'].includes(voce.id)) {
      const mS = voce.lato === 'conti' && !(voce.id === 'crediti' && ['recuperato', 'cancellato'].includes(misura)) ? 'base' : misura;
      risp.serie = serie(voce, mS, !!req.per_abitante && voce.id !== 'popolazione');
      if (risp.serie.disomogenea) risp.serie = null;
    }
    risp.suggerimenti = suggerimenti(req, voce, anno, misura);
    return risp;
  }

  function descriviSerie(voce, misura, perAb, a1, a2) {
    const s = serie(voce, misura, perAb, a1, a2);
    if (s.disomogenea) throw new Mancante('serie');
    const disp = s.anni.map((a, i) => [a, s.valori[i]]).filter((x) => x[1] !== null);
    if (disp.length < 2) throw new Mancante('serie');
    const [p, u] = [disp[0], disp[disp.length - 1]];
    const max = disp.reduce((m, x) => (x[1] > m[1] ? x : m)), min = disp.reduce((m, x) => (x[1] < m[1] ? x : m));
    const un = s.unita, diff = u[1] - p[1];
    const val = { voce: voce.nome, misura: s.etichetta, v1: fmt(p[1], un), a1: p[0], v2: fmt(u[1], un), a2: u[0], diff: fmtDiff(diff, un),
      a_max: max[0], v_max: fmt(max[1], un), a_min: min[0], v_min: fmt(min[1], un) };
    const conPerc = un !== 'perc' && p[1] !== 0;
    if (conPerc) val.perc_diff = segno(diff / Math.abs(p[1]) * 100, perc);
    return { testo: frase(conPerc ? 'andamento' : 'andamento.senza_perc', val), serie: s, estremi: [p[1], u[1]], a1: p[0], a2: u[0] };
  }

  function rispAndamento(req) {
    const voce = VOCI[req.voce];
    if (!voce) return nonCapito();
    if (voce.lato === 'assente') return base('voce_assente', frase('voce_assente', { nota: voce.nota }));
    if (voce.lato === 'insieme' || ['quadro_cassa', 'quadro_conti', 'debiti'].includes(voce.id)) return rispValore({ ...req, intento: 'valore' });
    const a1 = req.anno || PRIMO, a2 = req.anno2 || ULTIMO;
    if (a1 < PRIMO || a2 > ULTIMO || a1 >= a2) return limite('anno_fuori_periodo');
    let misura = req.misura || 'base';
    const perAb = !!req.per_abitante && voce.id !== 'popolazione';
    const voci = [voce].concat(req.voce2 && VOCI[req.voce2] && VOCI[req.voce2].dati.length ? [VOCI[req.voce2]] : []);
    let parti, sostituita = false;
    try { parti = voci.map((v) => descriviSerie(v, misura, perAb, a1, a2)); } catch (e) {
      if (!(e instanceof Mancante)) throw e;
      sostituita = misura !== 'base';
      misura = 'base'; parti = voci.map((v) => descriviSerie(v, misura, perAb, a1, a2));
    }
    const ids = voci.flatMap((v) => (MOVIMENTI[v.id] && ['recuperato', 'cancellato'].includes(misura) ? MOVIMENTI[v.id] : v.dati));
    const risp = base('dato', parti.map((p) => p.testo).join(' '), {
      controllo: parti.flatMap((p) => p.estremi), serie: parti[0].serie, serie2: parti[1] ? parti[1].serie : null,
      fonte: voci.map((v) => fonteBdap(v.dati, parti[0].a1, parti[0].a2)).join(' ') + (perAb ? ' ' + frase('fonte.istat') : '') });
    if (sostituita) risp.avvertenze.push(frase('avv.misura_base', { misura: nomeMisura(voce, 'base', perAb) }));
    if (voce.nota && !['spese_totali', 'entrate_totali'].includes(voce.id)) risp.avvertenze.push(voce.nota + '.');
    if (voci.some((v) => v.dati.length > 1 && ['spese_totali', 'entrate_totali'].includes(v.id))) risp.avvertenze.push(frase('avv.totale'));
    risp.capito = capito({ ...req, intento: 'andamento', anno2: parti[0].a2 }, voce, parti[0].a1, misura);
    risp.suggerimenti = suggerimenti({ ...req, intento: 'andamento' }, voce, a2, misura);
    return risp;
  }

  function rispConfronto(req) {
    const voce = VOCI[req.voce];
    if (!voce) return nonCapito();
    if (voce.lato === 'assente') return base('voce_assente', frase('voce_assente', { nota: voce.nota }));
    if (voce.lato === 'insieme') return rispClassifica(req);
    const a1 = req.anno, a2 = req.anno2 || ULTIMO;
    if (!a1 || a1 < PRIMO || a1 > ULTIMO || a2 < PRIMO || a2 > ULTIMO) return limite('anno_fuori_periodo');
    let misura = req.misura || 'base', sostituita = false;
    const perAb = !!req.per_abitante && voce.id !== 'popolazione';
    // i due anni devono essere confrontabili: se in uno il dato e' parziale si passa alla misura di base
    const lordo = (a) => valoreVoce(voce, misura, a);
    if (misura !== 'base' && [a1, a2].some((a) => { const r = lordo(a); return r.parziale || r.padre; })) { misura = 'base'; sostituita = true; }
    const un = unita(voce, misura, perAb);
    const val = (a) => { const x = lordo(a).v; return perAb ? x / popolazione(a) : x; };
    const v1 = val(a1), v2 = val(a2), diff = v2 - v1;
    const p = { voce: voce.nome, misura: nomeMisura(voce, misura, perAb), v1: fmt(v1, un), a1, v2: fmt(v2, un), a2, diff: fmtDiff(diff, un) };
    const conPerc = un !== 'perc' && v1 !== 0;
    if (conPerc) p.perc_diff = segno(diff / Math.abs(v1) * 100, perc);
    const risp = base('dato', frase(conPerc ? 'confronto' : 'confronto.senza_perc', p), { controllo: [v1, v2], fonte: fonteBdap(voce.dati, a1) + ' ' + fonteBdap(voce.dati, a2) });
    risp.serie = serie(voce, misura, perAb);
    if (risp.serie.disomogenea) risp.serie = null;
    if (sostituita) risp.avvertenze.push(frase('avv.misura_base', { misura: nomeMisura(voce, 'base', perAb) }));
    risp.capito = capito({ ...req, anno2: a2 }, voce, a1, misura);
    risp.suggerimenti = suggerimenti(req, voce, a2, misura);
    return risp;
  }

  // Voce del dizionario che rappresenta da sola un identificativo ufficiale: nelle classifiche si usa il suo nome,
  // lo stesso che compare nelle altre risposte.
  const VOCE_DI = {};
  for (const v of catalogo.voci) if (v.dati.length === 1 && ['spesa', 'entrata'].includes(v.lato) && !VOCE_DI[v.dati[0]]) VOCE_DI[v.dati[0]] = v;
  const riga = (id, ripiego, valore) => [VOCE_DI[id] ? VOCE_DI[id].nome : ripiego, valore, VOCE_DI[id] ? VOCE_DI[id].id : null];
  // nome semplice di una voce ufficiale; se nei dati e' solo il nome ufficiale troncato, vale quello ufficiale intero
  const nomeSemplice = (id) => { const n = NOME_SEMPLICE[id], u = NOME_UFF[id] || id; return n && !(n.length >= 40 && u.startsWith(n)) ? n : u; };

  // Elenco [nome, valore, voce del dizionario] ordinato dal piu' grande, senza le voci a zero.
  function insieme(voce, anno) {
    const b = (id) => misuraIds([id], 'base', anno).v;
    const d = voce.dati[0];
    let el, nome;
    if (d === 'missioni') { el = bilancio.voci.missioni.filter((v) => v.livello === 'missione').map((v) => riga(v.id, v.nome, b(v.id))); nome = 'finalità della spesa'; }
    else if (d === 'macroaggregati') { el = bilancio.voci.spese_natura.filter((v) => v.id.startsWith('S1.')).map((v) => riga(v.id, v.nome, b(v.id))); nome = 'natura della spesa corrente'; }
    else if (d === 'fonti_entrata') {
      el = [['Imposte e tasse comunali', 'E1.101'], ['Fondo di solidarietà', 'E1.301'], ['Stato', 'E2.101.1'], ['Regione e altri enti locali', 'E2.101.2'],
        ['Servizi, multe e altre attività', 'E3'], ['Entrate per investimenti', 'E4']].map(([n, i]) => [n, b(i), null]); nome = 'provenienza delle entrate';
    } else if (d === 'categorie_tributi') { el = bilancio.voci.entrate.filter((v) => v.id.startsWith('E1.101.')).map((v) => riga(v.id, nomeSemplice(v.id), b(v.id))); nome = 'imposte e tasse comunali'; }
    else if (d === 'singole_entrate') {
      // tutte le entrate, una per una: la singola categoria quando il dizionario la conosce (IMU, TARI, Regione...),
      // l'intera tipologia quando il dizionario conosce solo quella (multe), altrimenti la categoria con il nome ufficiale
      const righe = CAT.filter((x) => x.anno === anno && !TECN_E.has(x.titolo));
      const idc = (x) => `E${x.titolo}.${x.tipologia}.${x.categoria}`, idt = (x) => `E${x.titolo}.${x.tipologia}`;
      const conCategorie = new Set(righe.filter((x) => VOCE_DI[idc(x)]).map(idt));
      const gruppi = {};
      for (const x of righe) {
        const k = VOCE_DI[idc(x)] ? idc(x) : (VOCE_DI[idt(x)] && !conCategorie.has(idt(x)) ? idt(x) : idc(x));
        if (!gruppi[k]) gruppi[k] = riga(k, nomeSemplice(k), 0);
        gruppi[k][1] += x.acc || 0;
      }
      el = Object.values(gruppi); nome = 'singole entrate';
    } else throw new Mancante('insieme');
    return { elenco: el.filter((e) => e[1]).sort((x, y) => y[1] - x[1]), nome };
  }
  // req.termine = 'minore' chiede la voce piu' piccola invece della piu' grande
  function rispClassifica(req) {
    const voce = VOCI[req.voce];
    if (!voce || voce.lato !== 'insieme') return nonCapito();
    const implicito = req.anno === undefined || req.anno === null;
    const anno = implicito ? ULTIMO : req.anno;
    if (anno < PRIMO || anno > ULTIMO) return limite('anno_fuori_periodo');
    const d = voce.dati[0], minore = req.termine === 'minore';
    const { elenco, nome } = insieme(voce, anno);
    if (!elenco.length) return limite('non_nei_dati');
    const tot = elenco.reduce((s, e) => s + e[1], 0);
    const ord = minore ? elenco.slice().reverse() : elenco;
    const p = { anno, soggetto: frase(`classifica.${minore ? 'min' : 'max'}.${d}`), prima: ord[0][0], valore: euro(ord[0][1]), perc: perc(ord[0][1] / tot * 100),
      elenco: ord.slice(1, 5).map((e, i) => `${i + 2}) ${e[0]}, ${euro(e[1])} (${perc(e[1] / tot * 100)})`).join(', ') };
    const testo = frase(ord.length < 2 ? 'classifica.sola' : (minore ? 'classifica.minore' : 'classifica'), p);
    const prosp = { missioni: 'rendiconto delle spese per missioni e programmi', macroaggregati: 'spese per macroaggregati', fonti_entrata: 'rendiconto delle entrate ed entrate per categorie',
      categorie_tributi: 'entrate per categorie', singole_entrate: 'entrate per categorie' }[d];
    const risp = base('dato', testo, { controllo: ord.slice(0, 3).map((e) => e[1]), elenco: ord.map((e) => ({ nome: e[0], valore: e[1], quota: e[1] / tot * 100 })),
      fonte: `BDAP, rendiconto ${anno}, ${prosp}.` });
    risp.avvertenze.push(frase(['missioni', 'macroaggregati'].includes(d) ? 'avv.classifica_spese' : 'avv.classifica_entrate'));
    if (minore) risp.avvertenze.push(frase('avv.classifica_minore'));
    if (implicito) risp.avvertenze.push(frase('avv.ultimo_anno', { anno }));
    if (d === 'missioni') risp.avvertenze.push(frase('avv.totale'));
    risp.capito = `Ho capito: classifica per ${nome}, ${anno}.`;
    // proposte: la prima voce negli anni, poi un altro modo di guardare o l'altro lato del bilancio
    const s = [];
    if (ord[0][2]) s.push(pNegliAnni(ord[0][2]));
    if (d === 'missioni') s.push(proposta('natura', { intento: 'classifica', voce: 'spese_per_natura', anno }), pEntrate(anno));
    else if (d === 'macroaggregati') s.push(proposta('finalita', { intento: 'classifica', voce: 'spese_per_finalita', anno }), pEntrate(anno));
    else s.push(pSpese(anno));
    risp.suggerimenti = due(s);
    return risp;
  }

  function rispMesi(req) {
    const voce = VOCI[req.voce];
    if (!voce) return nonCapito();
    if (voce.lato === 'assente') return base('voce_assente', frase('voce_assente', { nota: voce.nota }));
    if (req.mese && !req.anno) req.anno = req.mese <= SIOPE_ULT_MESE ? SIOPE_ULT_ANNO : SIOPE_ULT_ANNO - 1;
    let dati;
    try { dati = siopeMesi(voce, req.anno || null); } catch (e) {
      if (e instanceof Mancante) return base('limite', frase('mesi.non_disponibile', { voce: voce.nome }), { codice: 'siope' });
      throw e;
    }
    if (req.anno && !ANNI_SIOPE.includes(req.anno)) return limite('anno_fuori_periodo');
    const E = latoSiope(voce) === 'E', totale = dati.tot.reduce((s, x) => s + x, 0);
    if (!totale) return base('limite', frase('mesi.non_disponibile', { voce: voce.nome }), { codice: 'siope' });
    const risp = base('dato', '', { fonte: fonteSiope(voce), avvertenze: [frase('avv.siope')] });
    // senza un anno il grafico mostra la media di un anno, non la somma di tutti gli anni
    risp.mesi = dati.tot.slice(1).map((x) => (req.anno ? x : x / dati.anni.length));
    if (!req.anno) risp.periodo_mesi = [dati.anni[0], dati.anni[dati.anni.length - 1]];
    if (req.mese) {
      risp.testo = frase('mesi.mese', { mese: MESI[req.mese], anno: req.anno, verbo: E ? 'incassato' : 'pagato', valore: euro(dati.tot[req.mese]), voce: voce.nome });
      risp.controllo = [dati.tot[req.mese]];
    } else {
      const ord = dati.tot.map((x, m) => [m, x]).slice(1).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const el = ord.map(([m, x]) => `${MESI[m]} (${perc(x / totale * 100)})`);
      const elenco = `${el[0]}, ${el[1]} e ${el[2]}`;
      const mov = E ? 'incassi' : 'pagamenti';
      risp.testo = req.anno ? frase('mesi.anno', { voce: voce.nome, anno: req.anno, movimento: mov, elenco })
        : frase('mesi.profilo', { voce: voce.nome, a1: dati.anni[0], a2: dati.anni[dati.anni.length - 1], movimento: mov, elenco });
      risp.controllo = ord.map((x) => x[0]);
      if (!req.anno) risp.avvertenze.push(frase('avv.periodo_mesi', { a1: dati.anni[0], a2: dati.anni[dati.anni.length - 1] }));
      if (req.anno === SIOPE_ULT_ANNO && SIOPE_ULT_MESE < 12) risp.avvertenze.push(frase('avv.parziale', { anno: req.anno, siope_a: SIOPE_A }));
    }
    risp.testo = rifinisci(risp.testo, voce);
    if (voce.dati_siope && voce.dati_siope.length) risp.avvertenze.push(frase('avv.mesi_siope', { ufficiale: voce.dati_siope.map(ufficiale).join('; ') }));
    risp.capito = capito(req, voce, req.anno || '', 'cassa');
    risp.suggerimenti = suggerimenti({ ...req, intento: 'mesi' }, voce, ULTIMO, 'base');
    return risp;
  }

  // Aggiunge a una risposta "di principio" i numeri della voce piu' vicina.
  function conFatti(risp, req, introduzione) {
    const voce = VOCI[req.voce];
    if (!voce || !voce.dati.length || voce.lato === 'insieme') return risp;
    const f = rispValore({ intento: 'valore', voce: req.voce, anno: req.anno });
    if (!['dato', 'dato_contenuto'].includes(f.tipo)) return risp;
    risp.testo += ' ' + introduzione + ' ' + f.testo;
    risp.fonte = f.fonte; risp.serie = f.serie; risp.barra = f.barra; risp.tabella = f.tabella; risp.controllo = f.controllo; risp.suggerimenti = f.suggerimenti;
    risp.avvertenze = risp.avvertenze.concat(f.avvertenze);
    return risp;
  }

  // --------------------------------------------------------------------------
  // Ricerca nei documenti
  // --------------------------------------------------------------------------
  const SENZA_ACCENTI = { à: 'a', á: 'a', è: 'e', é: 'e', ì: 'i', í: 'i', ò: 'o', ó: 'o', ù: 'u', ú: 'u', '’': "'" };
  const piatto = (s) => s.toLowerCase().replace(/[àáèéìíòóùú’]/g, (c) => SENZA_ACCENTI[c]);     // stessa lunghezza del testo
  const VUOTE = new Set(['del', 'dei', 'della', 'delle', 'dello', 'degli', 'dal', 'dai', 'dalla', 'che', 'con', 'per', 'tra', 'fra', 'sul', 'sui', 'sulla', 'sulle',
    'nel', 'nei', 'nella', 'nelle', 'una', 'uno', 'gli', 'cosa', 'dice', 'come', 'sono', 'alla', 'alle', 'allo', 'agli', 'non', 'piu', 'anno']);
  let PAGINE = null;
  // posizione di una parola nel testo, solo se e' all'inizio di una parola
  function trova(t, w, da = 0) {
    let i = t.indexOf(w, da);
    while (i > 0 && /[a-z0-9]/.test(t[i - 1])) i = t.indexOf(w, i + 1);
    return i;
  }
  function cerca(testoRicerca, anno) {
    if (!documenti) return null;
    if (!PAGINE) PAGINE = documenti.pagine.map((p) => ({ p, t: piatto(p.testo), cifre: (p.testo.match(/\d/g) || []).length / p.testo.length }));
    const q = piatto(testoRicerca).replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
    const parole = q.split(' ').filter((w) => w.length >= 3 && !VUOTE.has(w));
    if (!parole.length) return [];
    const ris = [];
    for (const { p, t, cifre } of PAGINE) {
      if (anno && p.anno !== anno) continue;
      let punti = 0, trovate = 0, pos = -1;
      const iq = trova(t, q);
      if (iq >= 0) { punti += 6; pos = iq; }
      for (const w of parole) {
        let n = 0, i = trova(t, w);
        if (i >= 0 && pos < 0) pos = i;
        while (i >= 0 && n < 20) { n += 1; i = trova(t, w, i + w.length); }
        if (n) { trovate += 1; punti += 1 + Math.log(n); }
      }
      if (trovate < Math.min(parole.length, 2) && iq < 0) continue;
      punti *= trovate / parole.length;
      if (cifre > 0.12) punti *= 0.35;                       // pagina fatta quasi solo di numeri
      if (/^\s*indice\b/.test(t.slice(0, 200)) || /\nindice\n/.test(t.slice(0, 300))) punti *= 0.3;   // pagina dell'indice
      if (iq >= 0) {                                         // la frase cercata sta in un titolo
        const riga = p.testo.slice(p.testo.lastIndexOf('\n', iq) + 1, (p.testo.indexOf('\n', iq) + 1 || p.testo.length + 1) - 1).trim();
        if (riga.length <= 90 && riga === riga.toUpperCase()) punti += 5;
      }
      const da = Math.max(0, pos - 120), a = Math.min(p.testo.length, pos + 260);
      ris.push({ punti, documento: p.titolo, anno: p.anno, pagina: p.pagina, estratto: (da > 0 ? '…' : '') + p.testo.slice(da, a).replace(/\s+/g, ' ').trim() + (a < p.testo.length ? '…' : '') });
    }
    return ris.sort((x, y) => y.punti - x.punti || (y.anno || 0) - (x.anno || 0)).slice(0, 3);
  }
  function rispDocumento(req) {
    const passi = cerca(req.ricerca || '', req.anno);
    if (passi === null) return base('limite', frase('documento.non_attivo'), { passi: [], codice: 'documenti' });
    return base('documento', frase(passi.length ? 'documento.trovati' : 'documento.nessuno'), { passi, fonte: frase('fonte.documenti') });
  }

  // --------------------------------------------------------------------------
  // Ingresso
  // --------------------------------------------------------------------------
  // Anno relativo a oggi: 'r-1' = l'anno scorso.
  function annoDa(x) {
    if (x === undefined || x === null || x === '') return undefined;
    if (typeof x === 'string' && x[0] === 'r') return oggi.getFullYear() + Number(x.slice(1));
    return Number(x);
  }

  // Domanda di seguito: riprende dalla richiesta precedente quello che manca.
  function completa(req, prec) {
    if (!prec) return req;
    const r = { ...req };
    if (!r.voce && prec.voce) { r.voce = prec.voce; if (!r.voce2 && prec.voce2 && r.intento === prec.intento) r.voce2 = prec.voce2; }
    if (!r.misura && prec.misura && !['definizione', 'documento'].includes(r.intento)) r.misura = prec.misura;
    if (r.anno === undefined && prec.anno !== undefined && r.intento !== 'andamento' && prec.intento !== 'andamento') r.anno = prec.anno;
    if (r.per_abitante === undefined && prec.per_abitante) r.per_abitante = prec.per_abitante;
    return r;
  }

  function rispondi(richiesta, precedente = null) {
    const req = completa({ ...richiesta }, precedente);
    req.anno = annoDa(req.anno); req.anno2 = annoDa(req.anno2);
    if (req.mese) req.mese = Number(req.mese);
    let risp;
    try {
      switch (req.intento) {
        case 'valore': case 'riscossione': risp = rispValore(req); break;
        case 'andamento': risp = rispAndamento(req); break;
        case 'confronto': risp = rispConfronto(req); break;
        case 'classifica': risp = rispClassifica(req); break;
        case 'mesi': risp = rispMesi(req); break;
        case 'definizione': {
          const g = GLOSSARIO[req.termine];
          risp = g ? base('definizione', frase('definizione', { termine: g.termine, definizione: g.definizione }), { fonte: frase('fonte.glossario') }) : nonCapito();
          if (g) {                                         // se il termine corrisponde a una voce, si propone il suo valore
            const id = VOCI[g.id] ? g.id : Object.keys(GLOSSA).find((k) => GLOSSA[k] === g.id);
            if (id && VOCI[id].dati.length) risp.suggerimenti = due([proposta('quanto_vale', { intento: 'valore', voce: id }, { voce: VOCI[id].nome })]);
          }
          break;
        }
        case 'documento': risp = rispDocumento(req); break;
        case 'giudizio': risp = conFatti(base('neutra', frase('giudizio')), req, frase('giudizio.con_voce')); break;
        case 'aiuto': {
          const ed = [IMP.editore_descrizione ? `Lo ha realizzato ${IMP.editore_descrizione}.` : '',
            IMP.editore_nome ? `Riferimento: ${IMP.editore_nome}${IMP.editore_contatto ? `, ${IMP.editore_contatto}` : ''}.` : ''].filter(Boolean).join(' ')
            || 'Chi lo ha realizzato è indicato nella pagina «Come funziona».';
          let id = `aiuto.${req.termine || 'cosa_fai'}`;
          if (IMP.ia_attiva !== 'si' && FRASI[`${id}_base`]) id = `${id}_base`;      // versione senza intelligenza artificiale
          risp = FRASI[id] ? base('servizio', frase(id, { primo: PRIMO, ultimo: ULTIMO, siope_a: SIOPE_A, generato: bilancio.meta.generato_il.split('-').reverse().join('/'), editore: ed })) : nonCapito();
          break;
        }
        case 'fuori_ambito': {
          const cod = FRASI[`limite.${req.termine}`] ? req.termine : 'altro';
          risp = limite(cod);
          if (['persone', 'cause', 'non_nei_dati', 'dettaglio'].includes(cod) && VOCI[req.voce]) risp = conFatti(risp, req, frase('limite.voce_vicina', { voce: VOCI[req.voce].nome }));
          break;
        }
        default: risp = nonCapito();
      }
    } catch (e) {
      if (e instanceof Mancante) risp = e.codice === 'anno' ? limite('anno_fuori_periodo') : limite('non_nei_dati');
      else throw e;
    }
    if (!risp.suggerimenti.length) risp.suggerimenti = due([]);          // sempre almeno due domande da cui ripartire
    risp.richiesta = req;
    return risp;
  }

  return { rispondi, completa, annoDa, cerca, voci: catalogo.voci, glossario: catalogo.glossario,
    info: { primo: PRIMO, ultimo: ULTIMO, siope_a: SIOPE_A, anni: ANNI, anni_siope: ANNI_SIOPE, siope_ult_anno: SIOPE_ULT_ANNO, siope_ult_mese: SIOPE_ULT_MESE } };
}
