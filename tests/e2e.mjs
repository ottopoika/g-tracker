// End-to-end-testi: ajaa sovelluksen oikeassa selaimessa muistinvaraista Firebase-korviketta vasten.
// Käyttö: cd tests && npm install && npm test   (CHROMIUM_PATH=/polku/chromium valinnainen)
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// Kopioi sovellus väliaikaiseen kansioon: Firebase korvataan mockilla ja service worker poistetaan käytöstä.
const site = fs.mkdtempSync(path.join(os.tmpdir(), "treeni-e2e-"));
for (const f of ["index.html", "style.css", "app.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"]) fs.copyFileSync(path.join(root, f), path.join(site, f));
fs.copyFileSync(path.join(here, "mock-firebase.js"), path.join(site, "firebase-bundle.js"));
fs.writeFileSync(path.join(site, "app.js"), fs.readFileSync(path.join(site, "app.js"), "utf8").replace('if ("serviceWorker" in navigator)', "if (false)"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const p = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html"));
  if (!p.startsWith(site) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); fs.createReadStream(p).pipe(res);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/index.html`;

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " – " + detail : ""}`); if (!ok) failed++; };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const scheme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, acceptDownloads: true });
    const pg = await ctx.newPage();
    const errors = []; pg.on("pageerror", e => errors.push(e.message));
    pg.on("dialog", d => d.type() === "prompt" ? d.accept("Vyötärö cm") : d.accept());
    const W = ms => pg.waitForTimeout(ms);
    console.log(`--- ${scheme} ---`);
    await pg.goto(url); await W(300);
    await pg.fill("input[name=e]", "testi@example.com"); await pg.fill("input[name=p]", "x"); await pg.click("button[type=submit]"); await W(300);
    await pg.click("[data-tab=vienti]"); await pg.setInputFiles("#imp", path.join(here, "fixture.json")); await W(700);
    await pg.click("[data-tab=tanaan]"); await W(200);
    check("aloita ohjelma -painike", await pg.locator("#start").count() === 1);
    await pg.click("#start"); await W(250);
    check("seuraava treeni korostettu listassa", (await pg.locator(".slot.next h3").textContent()).includes("Treeni 1"));
    await pg.click(".hero [data-slot]"); await W(250);
    await pg.locator(".ex").first().locator(".set").nth(0).locator(".ok").click(); await W(200);
    check("palautusajastin käynnistyy", await pg.locator("#timer").isVisible());
    check("viimeksi-tieto vanhasta historiasta", (await pg.locator(".ex .last").first().textContent()).includes("60×10"));
    await pg.locator(".ex").first().locator(".set").nth(1).locator(".ok").click(); await W(120);
    await pg.click("#finish"); await W(250);
    check("ajastin piiloon treenin jälkeen", !(await pg.locator("#timer").isVisible()));
    check("seuraava siirtyy treeniin 2", (await pg.locator(".slot.next h3").textContent()).includes("Treeni 2"));
    // oma treeni + sumea haku
    await pg.click("#custom"); await W(200); await pg.click("#cempty"); await W(200);
    await pg.click("#addex"); await W(150); await pg.fill("#exq", "penkkipunerus"); await W(150);
    check("sumea haku löytää", (await pg.locator("#exres [data-n]").allTextContents()).includes("Penkkipunnerrus"));
    await pg.locator("#exres [data-n]").first().click(); await W(200);
    await pg.locator(".ex .set .ok").first().click(); await W(150);
    await pg.click("#finish"); await W(250);
    // historia
    await pg.click("[data-tab=historia]"); await W(250);
    check("historiassa oma treeni", (await pg.locator(".badge", { hasText: "Oma" }).count()) >= 1);
    // keho
    await pg.click("[data-tab=paino]"); await W(300);
    check("keho: 4 ruutua", await pg.locator(".tile").count() === 4);
    check("keho: eri laite -merkintä", (await pg.locator(".tile .tl-d").allTextContents()).some(t => t.includes("eri laite")));
    await pg.click("#addm"); await W(200);
    await pg.fill("[data-k=paino]", "103,5"); await pg.fill("#mlaite", "Laite B");
    await pg.selectOption("#madd", "__oma"); await W(200); await pg.fill("[data-k=vyötärö]", "100");
    await pg.click("#msave"); await W(300);
    check("keho: mittaus tallentui", await pg.locator("details.card").count() === 3);
    // vienti
    const downloads = []; pg.on("download", d => downloads.push(d));
    await pg.click("[data-tab=vienti]"); await W(150); await pg.click("#exp"); await W(2800);
    const names = downloads.map(d => d.suggestedFilename());
    check("vienti: 6 tiedostoa", names.length === 6, names.join(", "));
    const sarjat = downloads.find(d => d.suggestedFilename().startsWith("sarjat_"));
    if (sarjat) {
      const csv = fs.readFileSync(await sarjat.path(), "utf8");
      const head = csv.replace(/^﻿/, "").split(/\r\n/)[0];
      check("CSV: sarakkeiden alku ennallaan", head.startsWith("pvm,ohjelma,jakso,viikko,treeni,liike,sarja,tyyppi,tavoite,paino_kg,toistot,aika_s,huomio,kirjattu,id,lahde,alkuperainen,varmuus"), head);
    }
    check("ei JavaScript-virheitä", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
console.log(failed ? `\n${failed} testiä epäonnistui` : "\nKaikki testit läpi");
process.exit(failed ? 1 : 0);
