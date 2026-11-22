// Chiedi al bilancio - Comune di Campofranco
// Fase 5: cliente minimo per Ollama, il programma open source che fa girare il modello di linguaggio sulla macchina virtuale.
// Usa solo l'interfaccia documentata (https://docs.ollama.com/api): /api/chat, /api/embed, /api/pull, /api/show, /api/version.
// Nessuna dipendenza: Node 18 o successivo.

export function creaOllama(url = 'http://127.0.0.1:11434') {
  const base = url.replace(/\/+$/, '');
  async function chiama(percorso, corpo, attesa) {
    const r = await fetch(base + percorso, {
      method: corpo === undefined ? 'GET' : 'POST',
      headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(attesa),
    });
    const testo = await r.text();
    if (!r.ok) throw new Error(`Ollama ${percorso}: ${r.status} ${testo.slice(0, 200)}`);
    return testo;
  }
  const ns = (x) => (typeof x === 'number' ? Math.round(x / 1e6) : null);      // da nanosecondi a millisecondi

  return {
    async versione() { return JSON.parse(await chiama('/api/version', undefined, 5000)).version; },
    async modelli() { return (JSON.parse(await chiama('/api/tags', undefined, 10000)).models || []).map((m) => ({ nome: m.name, byte: m.size })); },
    // Scarica un modello. La risposta arriva a righe: l'ultima dice se e' andata a buon fine.
    async scarica(modello, attesa = 3600000) {
      const righe = (await chiama('/api/pull', { model: modello, stream: true }, attesa)).trim().split('\n');
      const ultima = JSON.parse(righe[righe.length - 1] || '{}');
      if (ultima.error) throw new Error(ultima.error);
      return ultima.status || '';
    },
    // Una domanda al modello. think: false chiede di non "ragionare ad alta voce": serve solo la scheda.
    // format = schema JSON: il modello non puo' scrivere altro. keep_alive -1 tiene il modello in memoria.
    async chat({ modello, messaggi, schema, contesto = 8192, attesa = 60000, massimo = 96 }) {
      const o = JSON.parse(await chiama('/api/chat', {
        model: modello, messages: messaggi, stream: false, think: false, format: schema, keep_alive: -1,
        options: { temperature: 0, seed: 1, num_ctx: contesto, num_predict: massimo },
      }, attesa));
      return { contenuto: (o.message && o.message.content) || '',
        tempi: { totale: ns(o.total_duration), caricamento: ns(o.load_duration), domanda: ns(o.prompt_eval_duration), risposta: ns(o.eval_duration),
          gettoni_domanda: o.prompt_eval_count ?? null, gettoni_risposta: o.eval_count ?? null } };
    },
    // Toglie un modello dalla memoria (richiesta vuota con keep_alive 0, come indica la documentazione).
    async libera(modello) { try { await chiama('/api/generate', { model: modello, keep_alive: 0 }, 60000); } catch (e) { /* non era in memoria */ } },
    // Vettori di somiglianza per un elenco di testi (gia' di lunghezza uno).
    async embed(modello, testi, attesa = 300000) {
      return JSON.parse(await chiama('/api/embed', { model: modello, input: testi, keep_alive: -1 }, attesa)).embeddings;
    },
  };
}
