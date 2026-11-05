# Treeni

Henkilökohtainen salitreenien kirjaussovellus (PWA) iPhonelle. Julkaistu GitHub Pagesissa, data Firebase Firestoressa.
Repossa ei ole treenidataa eikä salaisuuksia: Firebasen verkkoasetukset ovat julkisia, ja pääsy dataan on rajattu tietokannan säännöillä yhteen käyttäjätunnukseen.

- Kehitysohjeet ja päätökset: [CLAUDE.md](CLAUDE.md)
- Speksit: [docs/speksit](docs/speksit)
- Testit: `cd tests && npm install && npx playwright install chromium && npm test`
- Julkaisu: push `claude/**`-haaraan → testit → yhdistys mainiin → GitHub Pages (`.github/workflows/`). Suora muutos mainiin julkaistaan myös testien jälkeen.
