// Chiedi al bilancio - Comune di Campofranco
// Fase 4: pagina del cittadino.
// La pagina fa una cosa sola: riceve la domanda e scrive la risposta. Niente menu ne' opzioni.
// La risposta invece deve essere chiara e completa: alla frase si affiancano le barre dell'anno
// (per esempio impegnato e pagato, con la percentuale), l'andamento negli anni quando c'e',
// e una tabella quando serve. Sotto, in piccolo, avvertenze e fonte. In fondo, una o due domande collegate
// ("Vuoi sapere anche"), per invitare il cittadino a continuare.
// Sta nella pagina dentro una funzione chiusa, dopo creaMotore (motore.mjs) e creaInterprete (capisci.mjs),
// che lo script di assemblaggio copia qui sopra. DATI_INCLUSI vale null quando i dati si leggono dai file accanto alla pagina.

const MESI_NOMI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const maiuscola = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const figura = (html) => { const f = document.createElement('figure'); f.className = 'g'; f.innerHTML = html; return f; };

// ---------------------------------------------------------------------------
// Formati
// ---------------------------------------------------------------------------
const migliaia = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const perc = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',') + '%';
function fmt(v, unita) {
  if (v === null || v === undefined) return 'non disponibile';
  if (unita === 'perc') return perc(v);
  if (unita === 'abitanti') return migliaia(Math.round(v));
  if (unita === 'euro_ab') { const r = Math.round(Math.abs(v) * 100); return (v < 0 ? '-' : '') + migliaia(Math.floor(r / 100)) + ',' + String(r % 100).padStart(2, '0') + ' €'; }
  const r = Math.round(v); return (r < 0 ? '-' : '') + migliaia(Math.abs(r)) + ' €';
}
function fmtAsse(v, unita) {
  if (unita === 'perc') return Math.round(v) + '%';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' mln';
  if (a >= 1000) return Math.round(v / 1000) + ' mila';
  return String(Math.round(v));
}
function passoBello(r) { const p = Math.pow(10, Math.floor(Math.log10(r))); const n = r / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
function scala(valori) {
  let min = Math.min(0, ...valori), max = Math.max(0, ...valori);
  if (max === min) max = min + 1;
  const passo = passoBello((max - min) / 3);
  return { y0: Math.floor(min / passo) * passo, y1: Math.ceil(max / passo) * passo, passo };
}
// importi e percentuali in evidenza; il testo arriva dalle frasi tipo del catalogo
const conNumeri = (testo) => esc(testo).replace(/[+-]?\d{1,3}(?:\.\d{3})*(?:,\d+)? euro|[+-]?\d+(?:,\d+)?%/g, (m) => `<b>${m}</b>`);
// Fonte in breve: documento e prospetto, senza il codice della voce ufficiale (che resta nella risposta del motore).
function fonteBreve(fonte) {
  const senza = fonte.replace(/ Voce ufficiale: .*?\.(?=$| (?:BDAP|ISTAT|SIOPE),)/g, '');
  return [...new Set(senza.split(/(?<=\.) (?=(?:BDAP|ISTAT|SIOPE),)/))].join(' ');
}

// ---------------------------------------------------------------------------
// Grafici e tabelle della risposta
// ---------------------------------------------------------------------------
// Un totale e le sue parti: una barra lunga quanto il totale, riempita per la parte pagata o incassata.
function barraTotale(b) {
  const tot = b.totale.valore, colori = ['c1', 'c2'];
  let k = 0;
  const parti = b.parti.map((p) => ({ ...p, quota: p.valore / tot * 100, classe: p.resto ? 'c0' : colori[k++ % 2] }));
  const principale = parti[0];
  return figura(
    `<div class="g-tot"><span>${esc(b.totale.etichetta)}</span><b>${fmt(tot, 'euro')}</b></div>`
    + `<div class="g-bar" role="img" aria-label="${esc(principale.etichetta)}: ${perc(principale.quota)} di ${esc(b.totale.etichetta.toLowerCase())}">`
    + parti.filter((p) => p.valore > 0).map((p) => `<i class="${p.classe}" style="width:${p.quota.toFixed(2)}%">${p.quota >= 14 ? perc(p.quota) : ''}</i>`).join('') + '</div>'
    + '<ul class="g-leg">' + parti.map((p) => `<li><i class="q ${p.classe}"></i><span>${esc(p.etichetta)}</span><b>${fmt(p.valore, 'euro')}</b></li>`).join('') + '</ul>');
}
// Due grandezze sulla stessa scala, per esempio previsto e impegnato.
function barreRighe(b) {
  const max = Math.max(...b.righe.map((x) => x.valore)) || 1;
  return figura(b.righe.map((x, i) => `<div class="g-tot"><span>${esc(x.etichetta)}</span><b>${fmt(x.valore, 'euro')}</b></div>`
    + `<div class="g-bar sottile"><i class="${i ? 'c1' : 'c0'}" style="width:${Math.max(0.5, x.valore / max * 100).toFixed(2)}%"></i></div>`).join(''));
}

// Andamento negli anni, a barre. Con "dentro" ogni barra mostra il totale e, piu' scura, la parte pagata o incassata.
// evid = anni citati nella risposta: restano pieni e portano il valore, gli altri sono attenuati.
function graficoAnni(s1, s2, evid, nomi, conTabella) {
  const anni = s1.anni, n = anni.length;
  const tutti = s1.valori.concat(s2 ? s2.valori : []).filter((v) => v !== null);
  if (n < 2 || tutti.length < 2) return null;
  const dentro = !s2 && s1.dentro ? s1.dentro : null;
  const W = 340, H = 184, pl = 48, pr = 4, pt = 22, pb = 24, iw = W - pl - pr, ih = H - pt - pb;
  const { y0, y1, passo } = scala(tutti);
  const y = (v) => pt + ih - (v - y0) / (y1 - y0) * ih, lw = iw / n, bw = Math.min(26, lw * (s2 ? 0.36 : 0.62));
  const cx = (i) => pl + i * lw + lw / 2;
  const rett = (xc, v, classe, opaco) => { const h = Math.abs(y(v) - y(0)); return `<rect class="${classe}" x="${(xc - bw / 2).toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.8).toFixed(1)}" rx="2"${opaco ? '' : ' opacity=".42"'}/>`; };
  let g = '';
  for (let k = y0; k <= y1 + passo / 2; k += passo) {
    g += `<line class="${Math.abs(k) < passo / 1e6 ? 'g-zero' : 'g-gr'}" x1="${pl}" y1="${y(k)}" x2="${pl + iw}" y2="${y(k)}"/><text class="g-ax" x="${pl - 6}" y="${y(k) + 3.5}" text-anchor="end">${fmtAsse(k, s1.unita)}</text>`;
  }
  anni.forEach((a, i) => {
    const ev = !evid.length || evid.includes(a);
    if (s2) {
      if (s1.valori[i] !== null) g += rett(cx(i) - bw / 2 - 1, s1.valori[i], 'c1', true);
      if (s2.valori[i] !== null) g += rett(cx(i) + bw / 2 + 1, s2.valori[i], 'c3', true);
    } else if (s1.valori[i] !== null) {
      g += rett(cx(i), s1.valori[i], dentro ? 'c0' : 'c1', ev);
      if (dentro && dentro[i] !== null && dentro[i] > 0) g += rett(cx(i), dentro[i], 'c1', ev);
      if (evid.length && ev) g += `<text class="g-val" x="${cx(i)}" y="${Math.min(y(s1.valori[i]), y(0)) - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${fmt(s1.valori[i], s1.unita)}</text>`;
    }
    g += `<text class="g-ax${evid.length && ev ? ' forte' : ''}" x="${cx(i)}" y="${H - 7}" text-anchor="middle">${n > 6 ? "'" + String(a).slice(2) : a}</text>`;
    g += `<rect class="g-hit" x="${pl + i * lw}" y="0" width="${lw}" height="${H}" data-i="${i}"/>`;
  });
  const principale = maiuscola(s1.etichetta);
  let legenda = '';
  if (s2) legenda = `<ul class="g-leg riga"><li><i class="q c1"></i><span>${esc(nomi[0])}</span></li><li><i class="q c3"></i><span>${esc(nomi[1])}</span></li></ul>`;
  else if (dentro) legenda = `<ul class="g-leg riga"><li><i class="q c0"></i><span>${esc(principale)}</span></li><li><i class="q c1"></i><span>${esc(s1.etichetta_dentro)}</span></li></ul>`;
  const titolo = `${s2 || dentro ? 'Negli anni' : principale + ', negli anni'}`;
  let html = `<figcaption>${esc(titolo)}</figcaption>${legenda}`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(principale)} dal ${anni[0]} al ${anni[n - 1]}">${g}</svg>`
    + '<p class="g-tip">Tocca un anno per vedere i valori.</p>';
  if (conTabella) {
    const col2 = s2 ? nomi[1] : (dentro ? s1.etichetta_dentro : null);
    html += `<div class="g-scorri"><table><thead><tr><th>Anno</th><th>${esc(s2 ? nomi[0] : principale)}</th>${col2 ? `<th>${esc(col2)}</th>` : ''}</tr></thead><tbody>`
      + anni.map((a, i) => `<tr><td>${a}</td><td>${fmt(s1.valori[i], s1.unita)}</td>${col2 ? `<td>${fmt((s2 ? s2.valori : dentro)[i], s1.unita)}</td>` : ''}</tr>`).join('') + '</tbody></table></div>';
  }
  const f = figura(html), tip = f.querySelector('.g-tip');
  const mostra = (i) => {
    let t = `<b>${anni[i]}</b> · `;
    if (s2) t += `${esc(nomi[0])} <b>${fmt(s1.valori[i], s1.unita)}</b> · ${esc(nomi[1])} <b>${fmt(s2.valori[i], s2.unita)}</b>`;
    else {
      t += `${esc(s1.etichetta)} <b>${fmt(s1.valori[i], s1.unita)}</b>`;
      if (dentro && dentro[i] !== null && s1.valori[i]) t += ` · ${esc(s1.etichetta_dentro.toLowerCase())} <b>${fmt(dentro[i], s1.unita)}</b> (${perc(dentro[i] / s1.valori[i] * 100)})`;
    }
    tip.innerHTML = t;
  };
  f.querySelectorAll('.g-hit').forEach((r) => { const i = Number(r.dataset.i); r.addEventListener('click', () => mostra(i)); r.addEventListener('mouseenter', () => mostra(i)); });
  return f;
}

// Dodici mesi, a barre: in evidenza il mese chiesto oppure i tre mesi piu' alti.
function graficoMesi(mesi, meseChiesto, titolo) {
  if (!mesi.some((v) => v > 0)) return null;
  const W = 340, H = 160, pl = 48, pr = 4, pt = 12, pb = 24, iw = W - pl - pr, ih = H - pt - pb;
  const { y0, y1, passo } = scala(mesi);
  const y = (v) => pt + ih - (v - y0) / (y1 - y0) * ih, lw = iw / 12;
  const alti = meseChiesto ? [meseChiesto - 1] : mesi.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]);
  let g = '';
  for (let k = y0; k <= y1 + passo / 2; k += passo) g += `<line class="g-gr" x1="${pl}" y1="${y(k)}" x2="${pl + iw}" y2="${y(k)}"/><text class="g-ax" x="${pl - 6}" y="${y(k) + 3.5}" text-anchor="end">${fmtAsse(k, 'euro')}</text>`;
  mesi.forEach((v, i) => {
    const h = Math.abs(y(v) - y(0));
    g += `<rect class="c1" x="${pl + i * lw + 3}" y="${Math.min(y(v), y(0))}" width="${lw - 6}" height="${Math.max(h, 0.8)}" rx="2"${alti.includes(i) ? '' : ' opacity=".42"'}/>`;
    g += `<text class="g-ax${alti.includes(i) ? ' forte' : ''}" x="${pl + i * lw + lw / 2}" y="${H - 7}" text-anchor="middle">${MESI_NOMI[i].charAt(0).toUpperCase()}</text>`;
    g += `<rect class="g-hit" x="${pl + i * lw}" y="0" width="${lw}" height="${H}" data-i="${i}"/>`;
  });
  const f = figura(`<figcaption>${esc(titolo)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titolo)}">${g}</svg><p class="g-tip">Tocca un mese per vedere il valore.</p>`);
  const tip = f.querySelector('.g-tip');
  f.querySelectorAll('.g-hit').forEach((r) => {
    const i = Number(r.dataset.i), mostra = () => { tip.innerHTML = `<b>${maiuscola(MESI_NOMI[i])}</b> · <b>${fmt(mesi[i], 'euro')}</b>`; };
    r.addEventListener('click', mostra); r.addEventListener('mouseenter', mostra);
  });
  return f;
}

// Classifica: le voci piu' grandi con importo e quota; le piu' piccole in una riga sola.
function graficoElenco(elenco) {
  const max = Math.max(...elenco.map((e) => e.valore)), primi = elenco.slice(0, 8), altri = elenco.slice(8);
  let html = primi.map((e, i) => `<div class="g-rk"><p>${i + 1}. ${esc(e.nome)}</p><div><div class="g-bar sottile"><i class="c1" style="width:${Math.max(0.5, e.valore / max * 100).toFixed(2)}%"></i></div>`
    + `<b>${fmt(e.valore, 'euro')} · ${perc(e.quota)}</b></div></div>`).join('');
  if (altri.length) html += `<p class="g-tip">Altre ${altri.length} voci più piccole: <b>${fmt(altri.reduce((t, e) => t + e.valore, 0), 'euro')}</b> in tutto.</p>`;
  return figura(html);
}
// Poche righe di etichetta e valore, per i quadri d'insieme.
const tabellaValori = (righe) => figura('<div class="g-scorri"><table class="voci"><tbody>' + righe.map((x) => `<tr><td>${esc(x.etichetta)}</td><td>${fmt(x.valore, 'euro')}</td></tr>`).join('') + '</tbody></table></div>');

// Sceglie cosa affiancare alla frase, in base a cio' che il motore ha restituito.
function figureDi(r) {
  const req = r.richiesta || {}, out = [];
  const nome = (id) => { const v = motore.voci.find((x) => x.id === id); return v ? v.nome : ''; };
  if (r.barra) out.push(r.barra.righe ? barreRighe(r.barra) : barraTotale(r.barra));
  if (r.tabella) out.push(tabellaValori(r.tabella));
  if (r.elenco && r.elenco.length) out.push(graficoElenco(r.elenco));
  if (r.mesi) {
    const periodo = r.periodo_mesi ? `Media per mese, dal ${r.periodo_mesi[0]} al ${r.periodo_mesi[1]}` : `Per mese, nel ${r.anno_mesi || req.anno}`;
    out.push(graficoMesi(r.mesi, req.mese, periodo));
  }
  if (r.serie) {
    const anni = r.serie.anni, ult = anni[anni.length - 1], andamento = req.intento === 'andamento';
    const evid = andamento ? [] : (req.intento === 'confronto' ? [req.anno, req.anno2 || ult] : [req.anno || ult]);
    out.push(graficoAnni(r.serie, r.serie2 || null, evid, [nome(req.voce), nome(req.voce2)], andamento || req.intento === 'confronto'));
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Conversazione
// ---------------------------------------------------------------------------
const pagina = el('pagina'), thread = el('cbThread'), form = el('cbForm'), campo = el('cbInput'), invia = el('cbInvia');
let motore = null, interprete = null, precedente = null, titoloProposte = 'Vuoi sapere anche:';

function scrivi(classe, html) {
  const n = document.createElement('div');
  n.className = classe; n.innerHTML = html; thread.appendChild(n);
  return n;
}

// Scrive la domanda. La risposta arriva subito dopo, oppure dopo la lettura dell'IA.
function mostraDomanda(testoDomanda) {
  pagina.classList.remove('vuota');
  const domanda = scrivi('d', esc(testoDomanda));
  domanda.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return domanda;
}

// Scrive la risposta: frase, grafici e tabelle, note in piccolo e infine le domande proposte.
function mostraRisposta(domanda, richiesta, prec) {
  let r;
  try { r = motore.rispondi(richiesta, prec); } catch (e) {
    r = { testo: 'Non sono riuscito a calcolare la risposta. Prova a scrivere la domanda in un altro modo.', avvertenze: [], fonte: '' };
  }
  if (r.richiesta && r.richiesta.voce) precedente = r.richiesta;       // contesto per le domande di seguito ("e nel 2022?")
  const risposta = scrivi('r', `<p class="t">${conNumeri(r.testo)}</p>`);
  let figure = [];
  try { figure = figureDi(r); } catch (e) { figure = []; }             // un grafico che non riesce non deve togliere la risposta
  figure.forEach((f) => risposta.appendChild(f));
  if (figure.length) risposta.classList.add('larga');
  let note = '';
  for (const a of r.avvertenze || []) note += `<p class="n">${esc(a)}</p>`;
  if (r.fonte && r.tipo !== 'definizione') note += `<p class="n">Fonte: ${esc(fonteBreve(r.fonte))}</p>`;
  risposta.insertAdjacentHTML('beforeend', note);
  // una o due domande collegate, per continuare: toccandole si riceve subito la risposta
  const proposte = r.suggerimenti || [];
  if (proposte.length) {
    const box = document.createElement('div');
    box.className = 'p';
    box.innerHTML = `<p class="p-t">${esc(titoloProposte)}</p>`;
    proposte.forEach((x) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'p-b'; b.textContent = x.testo;
      b.addEventListener('click', () => { if (!occupato) mostraRisposta(mostraDomanda(x.testo), x.richiesta, null); });
      box.appendChild(b);
    });
    risposta.appendChild(box);
  }
  domanda.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Lettura con l'intelligenza artificiale (Fase 5)
// ---------------------------------------------------------------------------
// Il livello base legge sempre la domanda. Se e' impostato l'indirizzo del servizio, la pagina gli chiede una seconda
// lettura: su tutte le domande oppure solo su quelle che il livello base segnala come dubbie (ia_politica).
// Il servizio restituisce una scheda (tipo di domanda, voce, dato chiesto): la richiesta la ricava la pagina, con le
// stesse regole del livello base per anni e mesi, e i numeri li calcola sempre il motore.
// Se il servizio non risponde in tempo o la scheda non e' utilizzabile, resta la lettura del livello base.
const IA = { url: '', politica: 'dubbi', dubbi: ['non_capita', 'parole_sconosciute', 'voce_generica'], attesa: 12000, messaggio: 'Leggo la domanda…', fermaFino: 0, falliti: 0 };
let occupato = false;

function serveIA(base) {
  if (!IA.url || Date.now() < IA.fermaFino) return false;
  return IA.politica === 'sempre' || IA.dubbi.includes(base.dubbio);
}
async function leggiConIA(testo, prec) {
  const ferma = new AbortController(), orologio = setTimeout(() => ferma.abort(), IA.attesa);
  try {
    const r = await fetch(IA.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ferma.signal,
      body: JSON.stringify({ testo, prec: prec && prec.voce ? { voce: prec.voce, intento: prec.intento } : null }) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    IA.falliti = 0;
    return j && j.scheda ? interprete.daLettura(testo, prec, j.scheda) : null;
  } catch (e) {
    // dopo due tentativi falliti di fila la pagina non riprova per due minuti: senza IA non si deve aspettare a ogni domanda
    IA.falliti += 1;
    if (IA.falliti >= 2) { IA.fermaFino = Date.now() + 120000; IA.falliti = 0; }
    return null;
  } finally { clearTimeout(orologio); }
}

async function chiedi(testo) {
  testo = String(testo).trim();
  if (!testo || !motore || occupato) return;
  const prec = precedente;
  let c = interprete.capisci(testo, prec);
  const domanda = mostraDomanda(testo);
  if (serveIA(c)) {
    occupato = true; campo.disabled = true; invia.disabled = true;
    const attesa = scrivi('r attesa', `<p class="t">${esc(IA.messaggio)}</p>`);
    const ia = await leggiConIA(testo, prec);
    attesa.remove();
    if (ia) c = ia;
    occupato = false; campo.disabled = false; invia.disabled = false;
  }
  mostraRisposta(domanda, c.richiesta, c.seguito ? prec : null);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = campo.value; campo.value = '';
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) campo.blur();     // sul telefono chiude la tastiera, cosi' la risposta si vede
  chiedi(t);
});
document.documentElement.lang = 'it';

function avvia(bilancio, catalogo) {
  motore = creaMotore(bilancio, catalogo, null);
  interprete = creaInterprete(catalogo, motore.info);
  if (catalogo.frasi['sugg.titolo']) titoloProposte = catalogo.frasi['sugg.titolo'];
  const imp = catalogo.impostazioni || {};
  if (imp.ia_attiva === 'si' && imp.ia_url) {
    IA.url = imp.ia_url;
    if (imp.ia_politica === 'sempre') IA.politica = 'sempre';
    if (imp.ia_dubbi) IA.dubbi = imp.ia_dubbi.split(',').map((x) => x.trim()).filter(Boolean);
    if (Number(imp.ia_attesa_ms) >= 1000) IA.attesa = Number(imp.ia_attesa_ms);
    if (catalogo.frasi['ia.attesa']) IA.messaggio = catalogo.frasi['ia.attesa'];
  }
  campo.disabled = false; invia.disabled = false;
}
function datiNonCaricati() {
  pagina.classList.remove('vuota');
  scrivi('r', '<p class="t">Non riesco a caricare i dati. Ricarica la pagina tra qualche istante.</p>');
}
if (DATI_INCLUSI) avvia(DATI_INCLUSI.bilancio, DATI_INCLUSI.catalogo);
else {
  const leggi = (f) => fetch(f).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  Promise.all([leggi('bilancio.json'), leggi('catalogo.json')]).then(([b, c]) => avvia(b, c)).catch(datiNonCaricati);
}
