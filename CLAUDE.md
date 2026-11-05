# Treeni – ohjeet Claudelle

Henkilökohtainen salitreenien kirjaussovellus (PWA) Oton iPhonelle. Käyttökieli on **suomi** (UI, commit-viestit, dokumentaatio). Sovellus: https://ottopoika.github.io/g-tracker/

## Tärkeimmät periaatteet
1. **Data säilyy vuosia ja tekoäly osaa lukea sen.** CSV-viennin muoto on sopimus: sarakkeiden järjestystä ei muuteta, uudet sarakkeet lisätään AINA loppuun. Päivitä LUEMINUT-teksti (`README()` app.js:ssä), kun lisäät sarakkeita tai tiedostoja.
2. **Repo on julkinen.** Ei henkilödataa, treenihistoriaa, mittauksia, ohjelman sisältöä eikä salaisuuksia repoon. Ohjelma ja historia ovat Firestoressa; testit käyttävät keksittyä dataa (`tests/fixture.json`). Firebasen web-config saa olla julkinen – suojaus on Firestoren säännöissä (vain Oton UID).
3. **Ei ulkoisia riippuvuuksia ajonaikana.** Ei CDN:iä, frameworkeja eikä build-vaihetta. Vanilla JS (ES-moduuli) + yksi CSS-tiedosto. Firebase JS SDK 12.19.0 on paketoitu tiedostoon `firebase-bundle.js` (älä muokkaa käsin; ks. alla).
4. **Toimii salilla ilman nettiä.** Firestoren persistentLocalCache + service worker (`sw.js`, verkko ensin, välimuisti varalla).

## Tiedostot
| Tiedosto | Sisältö |
|---|---|
| `index.html` | Runko, välilehtipalkki (SVG-ikonit) |
| `app.js` | Koko sovellus: tila `S`, Firestore-kuuntelijat, näkymät (`renderToday`, `renderWorkout`, `renderProgram`, `renderHistory`, `renderBody`, `renderData`), vienti/tuonti |
| `style.css` | Ulkoasu ja design-tokenit (`:root`, vaalea teema `prefers-color-scheme`) |
| `sw.js` | Offline-välimuisti. Päivitä `VERSIO` jokaisessa julkaisussa |
| `firebase-bundle.js` | Paketoitu Firebase SDK (`npm i firebase@12.19.0 esbuild`; vientilista RAKENNUS-ohjeessa alla) |
| `tests/` | `e2e.mjs` (Playwright), `mock-firebase.js` (muistinvarainen Firebase), `fixture.json` (keksitty data) |
| `.github/workflows/` | `ci.yml` (claude/**: testit → yhdistys mainiin → julkaisu), `deploy.yml` (main: testit → GitHub Pages) |

## Firestore-tietomalli (`users/{uid}/…`)
- `ohjelmat/{id}`: ohjelma `{id, nimi, viikkoja, jaksot[{id, nimi, tyyppi, ohje, lepo_s, treenit[{id, nimi, liikkeet[{nimi, tavoite, sarjat[{toistot, tyyppi, kuorma?}]}]}], viikot[{viikko, treenit[treeniId]}]}]}`
- `meta/tila`: `{ohjelmaId, aloitus, viikko, vaihdot[], viimeVienti, omatLiikkeet[], omatMittarit[{k,n,u}]}`
- `treenikerrat/{id}`: **yksi dokumentti per treenikerta sarjoineen** (säästää lukukertoja Sparkin ilmaiskiintiössä). `{tyyppi: ohjelma|oma, ohjelmaId, ohjelma, jakso, viikko, slot, treeniId, treeni, pohjaId, tila: kesken|tehty|osittain|valiin, pvm, alku, loppu, huomio, lahde: sovellus|vanha_excel|vanha_muistio, liikkeet[{nimi, suunniteltu, tavoite, sarjoja, toistot[], tyypit[], ohitettu, huomio, lisatty?}], sarjat[{liikeIndex, liike, perusliike, valine, sarja, tyyppi, tavoite, paino_kg, toistot, aika_s, kirjattu, jalkikirjaus, id, (alkuperainen, varmuus)}]}`
- `kehonpaino/{id}`: `{pvm, paino_kg, huomio, lahde, kirjattu}`
- `mittaukset/{id}`: kehonkoostumus `{pvm, aika?, laite, arvot{mittari: luku}, segmentit{oikea_kasi|vasen_kasi|keskivartalo|oikea_jalka|vasen_jalka: {rasvaprosentti, rasvamassa, rasvaton_massa, lihasmassa, suhde_pros}}, huomio, lahde}`
- `kaynnit/{id}`: vanhat salikäynnit 2023–2024 ilman sarjoja.
Uudet kentät lisätään olemassa oleviin dokumentteihin; rakennetta ei muuteta niin, että vanha data rikkoutuu.

## Sovitut toimintasäännöt
- Ohjelma etenee **tehtyjen treenien** mukaan, ei kalenterin. Väliin jättäminen ja viikon venyminen sallittu; viikon vaihto merkitsee tekemättömät `valiin`.
- Korvattu liike kirjataan kokonaan korvaavan liikkeen nimellä. Liikkeen koko nimi on tunniste (esim. "Vinopenkki kp."); `perusliike` ja `valine` johdetaan nimestä (`splitEquip`). levytanko = tanko.
- Oma treeni (`tyyppi: "oma"`, `ohjelma: "Oma"`) ei siirrä ohjelman etenemistä.
- Jälkikirjaus-lippu: sarja kuitattu < 15 s edellisestä tai valmiin treenin muokkauksena. Ei näytetä käyttäjälle.
- Palautusajastin ei ohjaa: ohitettava, ei estä kirjaamista.
- Kehonkoostumus: eri laitteet mittaavat eri suureita. Tanitan `lihasmassa` ≠ InBody/Puhtin `luurankolihas`; `viskeraali_taso` ≠ `viskeraali_ala`. Vertailukelpoisiksi laitteiden välillä merkitään vain `ver: 1` -mittarit (paino, BMI, suositeltu paino); muut piirretään katkoviivalla laitteen vaihtuessa.
- Ei salin nimeä, ei lämmittelymerkintöjä.

## iPhone-erityispiirteet (älä riko)
- Kenttien fontti ≥ 16 px (muuten Safari zoomaa). `touch-action: manipulation` estää tuplanapautuszoomin.
- Turva-alueet `env(safe-area-inset-*)`, kelluva välilehtipalkki ja ajastin.
- Lasipinta (`backdrop-filter`) vain navigointikerroksessa, ajastimessa, ilmoituksissa ja paneeleissa – ei sisällössä.
- Kirjautuminen sähköposti+salasana (Google-popup toimii huonosti kotinäyttö-PWA:ssa).
- Värinä ei toimi iOS-PWA:ssa (`navigator.vibrate` vain Androidilla).

## Versiointi ja julkaisu
1. Nosta `VERSION` (app.js) ja `VERSIO` (sw.js) samaan arvoon (semver: uusi ominaisuus = minor).
2. Aja testit: `cd tests && npm install && npx playwright install chromium && npm test`. Lisää testi jokaiselle uudelle ominaisuudelle `e2e.mjs`:ään ja tarvittaessa dataa `fixture.json`:iin (keksittyä!).
3. Pushaa `claude/…`-haaraan. `ci.yml` ajaa testit, yhdistää mainiin ja käynnistää `deploy.yml`:n. Jos yhdistys epäonnistuu (ristiriita), rebasea haara mainin päälle ja pushaa uudelleen.
4. Kerro Otolle lopuksi: avaa sovellus uudelleen iPhonella ja tarkista versio Data-välilehdeltä.

## Ulkoasu (v0.3.0+)
iOS 26 -henkinen: tumma ensisijainen teema, 4 pintatasoa (`--s1..--s3`) sävyeroilla, korostusväri volt `--accent: #c8f43a` (vaaleassa teemassa tekstinä `--accent-text`, kaavioissa `--chart`), 34 px otsikot, tabulaariset numerot, `prefers-reduced-motion` kunnioitetaan.

## Ideoita, ei päätetty
PR-merkintä, RIR/RPE per sarja, levylaskin, fiilismerkintä (uni/energia 1–5), jaksoyhteenveto, CSV-tuonti, .xlsx-vienti, automaattinen viikkovarmuuskopio, liikekohtaiset kehityskäyrät. Kysy Otolta ennen toteutusta.
