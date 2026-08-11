# Bestandverdelen — Précon

Webapp die geüploade bestanden automatisch sorteert naar artikelmappen op basis van de artikelcode in de bestandsnaam. Vervangt het oude `Bestanden_Verdelen_V7.ps1` / `.bat`-script.

## Hoe het werkt

De app gebruikt de File System Access API van de browser om rechtstreeks te schrijven naar een gekozen doelmap (ook op gekoppelde netwerkschijven, bv. `P:\`). Er is geen server of installatie nodig — alleen deze statische site.

1. **Bestanden toevoegen** — sleep bestanden (of een hele map) in het uploadvak, of kies ze handmatig. De bestanden blijven lokaal in de browser staan tot je op "Start verdelen" drukt; er wordt niets verwijderd bij de bron.
2. **Doelmap** — de map waarin artikelmappen worden aangemaakt/aangevuld.
3. **Start verdelen** — verwerkt alle toegevoegde bestanden:
   - Bestandsnaam begint met een artikelcode → weggeschreven naar `<doelmap>/<artikelcode>/`.
   - Bestand met dezelfde naam bestaat al in die artikelmap en is identiek → overgeslagen (duplicaat).
   - Bestand met dezelfde naam bestaat al maar is anders (conflict), of er is geen artikelcode herkend → blijft **in de app** staan met een downloadknop, zodat je het zelf ergens kunt opslaan. Er wordt geen `NIET_VERWERKT`-map op de schijf aangemaakt.

De gekozen doelmap wordt onthouden (via IndexedDB) zodat je de volgende keer niet opnieuw hoeft te bladeren.

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
