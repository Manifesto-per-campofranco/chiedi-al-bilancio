// Chiedi al bilancio - Comune di Campofranco
// Confronto tra la risposta ottenuta e quella attesa, usato da tutte le misure:
// prova_capisci.mjs (livello base) e chatbot/ia/prova_ia.mjs (intelligenza artificiale).
// Il criterio e' lo stesso per tutti, cosi' i risultati si possono mettere a confronto.
import fs from 'node:fs';

export const FAMIGLIE = ['Quanto si spende', 'Quanto si incassa', 'Andamento', 'Per abitante', 'Riscossione', 'Cassa e calendario', 'Conti del Comune',
  'Domande di seguito', 'Spiegazioni', 'Documenti', 'Giudizi', 'Aiuto e trasparenza', 'Fuori ambito'];
export const ESITI = ['giusta', 'taglio diverso', 'non capita', 'sbagliata'];
const DATO = ['dato', 'dato_contenuto', 'voce_assente'];

export function leggiCsv(p) {
  const r = fs.readFileSync(p, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
  const h = r[0].split(';');
  return r.slice(1).map((l) => { const c = l.split(';'); const o = {}; h.forEach((k, i) => { o[k] = (c[i] || '').trim(); }); return o; });
}

export function creaConfronto(motore, interprete, catalogo) {
  const VOCI = Object.fromEntries(catalogo.voci.map((v) => [v.id, v]));
  const ULTIMO = motore.info.ultimo;

  // la lettura attesa, scritta a mano nel file delle domande, come richiesta per il motore
  function richiestaDa(d) {
    const r = { intento: d.intento };
    for (const k of ['voce', 'voce2', 'misura', 'termine', 'ricerca']) if (d[k]) r[k] = d[k];
    if (d.anno) r.anno = /^r/.test(d.anno) ? d.anno : Number(d.anno);
    if (d.anno2) r.anno2 = /^r/.test(d.anno2) ? d.anno2 : Number(d.anno2);
    if (d.per_abitante) r.per_abitante = true;
    if (d.mese) r.mese = Number(d.mese);
    if (d.risposta_attesa === 'dato_contenuto' && VOCI[d.voce]) {
      const t = interprete.norm(d.domanda);
      const trov = VOCI[d.voce].contiene.filter((w) => t.includes(interprete.norm(w))).sort((a, b) => b.length - a.length);
      if (trov.length) r.dettaglio = trov[0];
    }
    return r;
  }
  function famiglia(d) {
    const i = d.intento, v = VOCI[d.voce] || {};
    if (d.dopo) return 'Domande di seguito';
    if (i === 'definizione') return 'Spiegazioni';
    if (i === 'documento') return 'Documenti';
    if (i === 'giudizio') return 'Giudizi';
    if (i === 'aiuto') return 'Aiuto e trasparenza';
    if (i === 'fuori_ambito') return 'Fuori ambito';
    if (d.per_abitante || d.voce === 'popolazione') return 'Per abitante';
    if (i === 'riscossione' || ['percentuale', 'non_riscosso', 'recuperato', 'cancellato'].includes(d.misura)) return 'Riscossione';
    if (i === 'mesi' || (['cassa', 'quadro_cassa', 'anticipazioni'].includes(d.voce) && i === 'valore')) return 'Cassa e calendario';
    if (d.anno && motore.annoDa(/^r/.test(d.anno) ? d.anno : Number(d.anno)) > ULTIMO) return 'Cassa e calendario';
    if (i === 'andamento' || i === 'confronto') return 'Andamento';
    if (i === 'classifica' || v.lato === 'conti' || d.misura === 'quota') return 'Conti del Comune';
    return ['spesa', 'assente'].includes(v.lato) ? 'Quanto si spende' : 'Quanto si incassa';
  }
  // risposta del motore a una richiesta letta dal testo; un errore conta come risposta sbagliata
  function risposta(richiesta, seguito, prec) {
    try { return motore.rispondi(richiesta || {}, seguito ? prec : null); } catch (e) { return { tipo: 'errore', testo: e.message, richiesta: richiesta || {} }; }
  }
  function esitoDi(d, ott, attesa) {
    if (ott.tipo === 'errore') return 'sbagliata';
    if (d.intento === 'documento') {
      return ott.richiesta.intento === 'documento' && (!attesa.passi || !attesa.passi.length || (ott.passi && ott.passi.length)) ? 'giusta' : (ott.tipo === 'non_capito' ? 'non capita' : 'sbagliata');
    }
    if (ott.tipo === attesa.tipo && ott.testo === attesa.testo) return 'giusta';
    if (ott.tipo === 'non_capito') return 'non capita';
    if (DATO.includes(ott.tipo) && DATO.includes(attesa.tipo) && ott.richiesta.voce === attesa.richiesta.voce) return 'taglio diverso';
    return 'sbagliata';
  }
  // Prepara le domande di un insieme: per ognuna la risposta attesa e la richiesta precedente (per le domande di seguito).
  function prepara(domande) {
    const perId = Object.fromEntries(domande.map((d) => [d.id, d]));
    return domande.map((d) => ({ d, famiglia: famiglia(d), attesa: motore.rispondi(richiestaDa(d)),
      prec: d.dopo ? motore.rispondi(richiestaDa(perId[d.dopo])).richiesta : null }));
  }
  const conta = (righe, f) => Object.fromEntries(ESITI.map((e) => [e, righe.filter((r) => r.esito === e && (!f || r.famiglia === f)).length]));
  const pc = (n, t) => (t ? `${Math.round(n / t * 100)}%` : '-');
  function tabella(righe) {
    const out = ['| Famiglia | Domande | Giuste | Taglio diverso | Non capite | Sbagliate |', '|---|---:|---:|---:|---:|---:|'];
    for (const f of FAMIGLIE) {
      const n = righe.filter((r) => r.famiglia === f).length; if (!n) continue;
      const c = conta(righe, f);
      out.push(`| ${f} | ${n} | ${c.giusta} (${pc(c.giusta, n)}) | ${c['taglio diverso']} | ${c['non capita']} | ${c.sbagliata} |`);
    }
    const c = conta(righe), n = righe.length;
    out.push(`| **Totale** | **${n}** | **${c.giusta} (${pc(c.giusta, n)})** | **${c['taglio diverso']}** | **${c['non capita']}** | **${c.sbagliata}** |`);
    return out.join('\n');
  }
  const breve = (r) => Object.entries(r || {}).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => `${k}=${v}`).join(', ') || 'niente';
  function elenco(righe) {
    const out = [];
    for (const r of righe.filter((x) => x.esito !== 'giusta')) {
      out.push(`- ${r.d.id} «${r.d.domanda}» – ${r.esito}. Attesa: ${breve(richiestaDa(r.d))}. Letta: ${breve(r.letta)}${r.seguito ? ' (di seguito)' : ''}.`);
    }
    return out.join('\n') || 'Nessuna.';
  }
  return { richiestaDa, famiglia, risposta, esitoDi, prepara, conta, pc, tabella, breve, elenco };
}
