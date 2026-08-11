# Bestandverdelen — Précon

Webapp die bestanden in een INBOX-map automatisch sorteert naar artikelmappen op basis van de artikelcode in de bestandsnaam. Vervangt het oude `Bestanden_Verdelen_V7.ps1` / `.bat`-script.

## Hoe het werkt

De app gebruikt de File System Access API van de browser om rechtstreeks te lezen/schrijven op een gekozen map (ook op gekoppelde netwerkschijven, bv. `P:\`). Er is geen server of installatie nodig — alleen deze statische site.

1. **Bronmap** — de map waarin `01_INBOX` en `02_NIET_VERWERKT` staan (worden automatisch aangemaakt als ze nog niet bestaan).
2. **Doelmap** — de map waarin artikelmappen worden aangemaakt/aangevuld.
3. **Start verdelen** — verwerkt alle bestanden in `01_INBOX` en `02_NIET_VERWERKT`:
   - Bestandsnaam begint met een artikelcode → verplaatst naar `<doelmap>/<artikelcode>/`.
   - Bestand met dezelfde naam bestaat al en is identiek → duplicaat wordt verwijderd.
   - Bestand met dezelfde naam bestaat al maar is anders → naar `02_NIET_VERWERKT` als `... - CONFLICT`.
   - Geen artikelcode herkend → naar `02_NIET_VERWERKT`.

De gekozen mappen worden onthouden (via IndexedDB) zodat je de volgende keer niet opnieuw hoeft te bladeren.

## Vereisten

- Google Chrome of Microsoft Edge (desktop). Firefox en Safari ondersteunen de File System Access API niet.
- De site moet via **https** of **localhost** geladen worden — niet als lokaal `file://`-bestand.

## Lokaal testen

```
cd site
python3 -m http.server 8080
```

Open daarna `http://localhost:8080` in Chrome of Edge.

## Live zetten

Net als bij [Zoekhulp Précon](https://github.com/Kmhlammers/precon-zoekhulp): maak een GitHub-repo aan, push deze `site/`-map en zet GitHub Pages aan. Kopieer daarna de link naar de collega's die het nodig hebben.
