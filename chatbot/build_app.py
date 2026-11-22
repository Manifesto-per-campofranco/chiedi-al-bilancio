#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chiedi al bilancio - Comune di Campofranco
Fase 4: monta la pagina del cittadino. E' una pagina a se', con solo la domanda e la risposta:
non fa parte dell'app del bilancio e non la modifica.

Uso:   python3 chatbot/build_app.py [cartella_radice] [--unico]
Legge: chatbot/interfaccia/chat.css, chat.html, chat.js
       chatbot/motore/motore.mjs, capisci.mjs
       chatbot/dati/bilancio.json, catalogo.json
Scrive nella cartella pubblica/ (file derivati, non nel progetto):
       pubblica/artifact/chiedi-al-bilancio.html + bilancio.json + catalogo.json
           pagina senza intestazione, per la pubblicazione di prova come pagina di Claude
       pubblica/sito/index.html + bilancio.json + catalogo.json
           pagina completa, per GitHub Pages (Fase 7)
       con --unico: pubblica/unico/chiedi_al_bilancio.html
           un solo file con i dati dentro, che si apre anche dal disco con un doppio clic
Prima vanno lanciati build_dati.py e build_catalogo.py.
"""
import json, os, shutil, sys

args = [a for a in sys.argv[1:] if not a.startswith('--')]
RADICE = args[0] if args else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNICO = '--unico' in sys.argv
TITOLO = 'Chiedi al bilancio'
P = lambda *p: os.path.join(RADICE, *p)
leggi = lambda *p: open(P(*p), encoding='utf-8').read()

def modulo(nome):
    """Un modulo del motore senza la parola export, da copiare dentro la pagina."""
    s = leggi('chatbot', 'motore', nome)
    if s.count('export function ') != 1:
        raise SystemExit(f'ERRORE: {nome} deve esportare una sola funzione')
    return s.replace('export function ', 'function ')

def monta(variante, dati_inclusi=None):
    inclusi = 'null' if dati_inclusi is None else json.dumps(dati_inclusi, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    codice = ('// Chiedi al bilancio: motore, livello base e pagina. Generato da chatbot/build_app.py: non modificare qui.\n'
              '(function () {\n\'use strict\';\nconst DATI_INCLUSI = ' + inclusi + ';\n'
              + modulo('motore.mjs') + '\n' + modulo('capisci.mjs') + '\n' + leggi('chatbot', 'interfaccia', 'chat.js') + '\n})();\n')
    if '</script' in codice:
        raise SystemExit('ERRORE: il codice della pagina contiene una chiusura di script')
    stile = '<style>\n' + leggi('chatbot', 'interfaccia', 'chat.css') + '</style>\n'
    corpo = leggi('chatbot', 'interfaccia', 'chat.html') + '<script>\n' + codice + '</script>\n'
    if variante == 'artifact':
        # la pagina di prova viene avvolta dal servizio che la pubblica: qui va solo il contenuto
        return f'<title>{TITOLO}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n' + stile + corpo
    return ('<!DOCTYPE html>\n<html lang="it">\n<head>\n<meta charset="UTF-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f'<title>{TITOLO}</title>\n<style>\n  :root{{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}}\n</style>\n'
            + stile + '</head>\n<body>\n' + corpo + '</body>\n</html>\n')

def scrivi(cartella, nome, pagina, con_dati=True):
    d = P('pubblica', cartella)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, nome), 'w', encoding='utf-8').write(pagina)
    if con_dati:
        for f in ('bilancio.json', 'catalogo.json'):
            shutil.copyfile(P('chatbot', 'dati', f), os.path.join(d, f))
    print(f'pubblica/{cartella}/{nome}: {len(pagina.encode("utf-8")) / 1024:.0f} KB')

def main():
    scrivi('artifact', 'chiedi-al-bilancio.html', monta('artifact'))
    scrivi('sito', 'index.html', monta('sito'))
    if UNICO:
        dati = {'bilancio': json.load(open(P('chatbot', 'dati', 'bilancio.json'), encoding='utf-8')),
                'catalogo': json.load(open(P('chatbot', 'dati', 'catalogo.json'), encoding='utf-8'))}
        scrivi('unico', 'chiedi_al_bilancio.html', monta('sito', dati), con_dati=False)

if __name__ == '__main__':
    main()
