// Pump Club (ent. Treeni) – kirjaussovellus. Ei ulkoisia riippuvuuksia: Firebase on paketoitu tiedostoon firebase-bundle.js.
import {
  initializeApp, getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch
} from "./firebase-bundle.js";

const VERSION = "0.7.1";
const firebaseConfig = {
  apiKey: "AIzaSyDTOryLjY0VBOa9DIuH02yVlxuy0JOBFKk",
  authDomain: "gym-tracker-e1050.firebaseapp.com",
  projectId: "gym-tracker-e1050",
  storageBucket: "gym-tracker-e1050.firebasestorage.app",
  messagingSenderId: "968446596557",
  appId: "1:968446596557:web:ad30b47771c6f2a57f2084"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });

// ---------- tila ----------
const S = {
  user: null, tab: "tanaan",
  ohjelmat: {}, meta: null, kerrat: [], paino: [], kaynnit: [], mittaukset: [],
  pending: false, loaded: { ohjelmat: false, meta: false, kerrat: false },
  histFilter: "", editId: null
};
const $view = document.getElementById("view");
const $sync = document.getElementById("sync");
const $tabs = document.getElementById("tabs");
let unsub = [];

// ---------- apurit ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = n => String(n).padStart(2, "0");
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowISO = () => { const d = new Date(), o = -d.getTimezoneOffset(), s = o >= 0 ? "+" : "-";
  return `${todayISO()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; };
const fiDate = iso => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${+d}.${+m}.${y}`; };
const num = v => { if (v === "" || v == null) return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const fmtKg = n => n == null ? "" : (Math.round(n * 100) / 100).toString().replace(".", ",");
function toast(msg, ms = 2200) { const t = document.getElementById("toast"); t.onclick = null; t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
const userCol = name => collection(db, "users", S.user.uid, name);
const userDoc = (name, id) => doc(db, "users", S.user.uid, name, id);
function save(name, id, data) { setDoc(userDoc(name, id), data).catch(e => toast("Tallennus epäonnistui: " + e.code)); }
function saveMeta(patch) { S.meta = { ...(S.meta || {}), ...patch }; save("meta", "tila", S.meta); }

// ---------- ohjelma ----------
const prog = () => S.meta?.ohjelmaId ? S.ohjelmat[S.meta.ohjelmaId] : Object.values(S.ohjelmat)[0];
function weekInfo(p, w) {
  for (const j of p.jaksot) for (const v of j.viikot) if (v.viikko === w)
    return { jakso: j, slots: v.treenit.map(id => j.treenit.find(t => t.id === id)) };
  return null;
}
const sessionsOfWeek = (p, w) => S.kerrat.filter(k => k.ohjelmaId === p.id && k.viikko === w && k.lahde === "sovellus");
function sessionForSlot(p, w, i) { return sessionsOfWeek(p, w).find(k => k.slot === i); }
function lastSetsFor(liike, excludeId) {
  // uusin treenikerta, jossa liike esiintyy (päivätyt ensin)
  let best = null;
  for (const k of S.kerrat) {
    if (k.id === excludeId) continue;
    const sets = (k.sarjat || []).filter(s => s.liike === liike && s.tyyppi !== "merkinta" && (s.toistot != null || s.paino_kg != null));
    if (!sets.length) continue;
    const key = (k.pvm || "0000") + (k.alku || "");
    if (!best || key > best.key) best = { key, k, sets };
  }
  return best;
}
// Kaikkien aikojen paras sarja. Vertailu arvioidulla maksimilla (Epley: kg × (1 + toistot/30)), joten 70×8 > 60×10.
// Kehonpainoliikkeissä (ei painoa tai 0) eniten toistoja; avustetuissa (negatiivinen) vähiten apua, sitten toistot.
const setScore = s => { const w = s.paino_kg, r = s.toistot || 0;
  return w > 0 ? [2, w * (1 + r / 30)] : (w == null || w === 0) ? [1, r] : [0, w * 1000 + r]; };
const betterSet = (a, b) => { const x = setScore(a), y = setScore(b); return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1]; };
function bestSetFor(liike, excludeId) {
  let best = null;
  for (const k of S.kerrat) {
    if (k.id === excludeId) continue;
    for (const s of k.sarjat || []) {
      if (s.liike !== liike || s.tyyppi === "merkinta" || (s.toistot == null && s.paino_kg == null)) continue;
      if (!best || betterSet(s, best.s)) best = { s, k };
    }
  }
  return best;
}
// Treenin tulos (v0.7.0). Liike on tehty, kun siitä on kirjattu vähintään yksi sarja tai se on ohitettu.
// Treeni on tehty, kun kaikki ohjelman liikkeet ovat tehtyjä. Täydellinen = ei ohituksia ja jokaisessa liikkeessä kaikki suunnitellut sarjat.
function sessionResult(k) {
  const ls = k.liikkeet || [], sets = k.sarjat || [];
  const cnt = li => sets.filter(s => s.liikeIndex === li && s.tyyppi !== "merkinta").length;
  const planned = ls.map((l, li) => ({ l, li })).filter(x => !x.l.lisatty);
  const tehty = planned.every(({ l, li }) => l.ohitettu || cnt(li) > 0);
  const perfect = planned.length > 0 && planned.every(({ l, li }) => !l.ohitettu && cnt(li) >= (l.sarjoja || 1));
  const tila = k.tyyppi === "oma" ? (sets.length ? "tehty" : "valiin") : !sets.length ? "valiin" : tehty ? "tehty" : "osittain";
  return { tila, perfect: k.tyyppi !== "oma" && tila === "tehty" && perfect };
}
const isPerfect = k => k.lahde === "sovellus" && k.tila === "tehty" && sessionResult(k).perfect;
const statusBadge = (k, withDate) => {
  const perf = isPerfect(k);
  const label = perf ? "Täydellinen" : { tehty: "Tehty", osittain: "Osittain", valiin: "Väliin jätetty", kesken: "Kesken" }[k.tila] || k.tila;
  return `<span class="badge ${perf ? "taydellinen" : k.tila}">${perf ? "★ " : k.tila === "tehty" ? "✓ " : ""}${label}${withDate && k.pvm ? " " + fiDate(k.pvm) : ""}</span>`;
};
function sessionSummary(k) {
  const sets = (k.sarjat || []).filter(s => s.tyyppi !== "merkinta");
  const vol = sets.reduce((a, s) => a + (s.paino_kg > 0 ? s.paino_kg * (s.toistot || 0) : 0), 0);
  const reps = sets.reduce((a, s) => a + (s.toistot || 0), 0);
  const min = k.alku && k.loppu ? Math.max(0, Math.round((Date.parse(k.loppu) - Date.parse(k.alku)) / 6e4)) : null;
  const names = [...new Set(sets.map(s => s.liike))];
  const prs = names.map(n => { const prev = bestSetFor(n, k.id); if (!prev) return null;
    const top = sets.filter(s => s.liike === n).reduce((a, s) => !a || betterSet(s, a) ? s : a, null);
    return top && betterSet(top, prev.s) ? { liike: n, s: top, was: prev.s } : null; }).filter(Boolean);
  return { sets: sets.length, reps, vol, min, exercises: names.length, prs };
}
// Väline päätellään liikkeen nimestä. Koko nimi pysyy tunnisteena; perusliike ja väline ovat johdettuja kenttiä.
const EQUIP = [[" smith-laitteessa", "smith"], [" levytangolla", "tanko"], [" tangolla", "tanko"], [" kp.", "kp"], [" käsipainoilla", "kp"],
  [" jalkaprässissä", "jalkaprässi"], [" scott-penkissä", "scott-penkki"], [" laitteessa", "laite"], [" koneessa", "laite"], [" taljassa", "talja"]];
function splitEquip(name) {
  const n = String(name || "").trim();
  for (const [suf, v] of EQUIP) if (n.toLowerCase().endsWith(suf)) return { perusliike: n.slice(0, n.length - suf.length).trim(), valine: v };
  return { perusliike: n, valine: "" };
}
const normName = s => String(s || "").toLowerCase().replace(/käsipainoilla/g, "kp").replace(/levytangolla/g, "tangolla").replace(/[^a-zåäö0-9]+/g, " ").trim();
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function similarity(q, name) {
  const a = normName(q), b = normName(name); if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || b.includes(" " + a)) return 0.9;
  if (b.includes(a)) return 0.8;
  const ta = a.split(" "), tb = b.split(" ");
  const tokenHit = ta.filter(t => tb.some(u => u.startsWith(t) || (t.length > 3 && lev(t, u) <= 1))).length / ta.length;
  const whole = 1 - lev(a, b) / Math.max(a.length, b.length);
  return Math.max(whole, tokenHit * 0.85);
}
const fuzzy = (q, names, min = 0.55) => names.map(n => ({ n, s: similarity(q, n) })).filter(x => x.s >= min).sort((x, y) => y.s - x.s || x.n.localeCompare(y.n, "fi"));

const setsText = sets => sets.map(s => (s.paino_kg != null ? fmtKg(s.paino_kg) + "×" : "") + (s.toistot ?? "") + (s.aika_s ? s.aika_s + " s" : "") + (s.tyyppi === "dropsetti" ? " (drop)" : "")).join(", ");

// ---------- käynnistys ----------
onAuthStateChanged(auth, user => {
  unsub.forEach(u => u()); unsub = [];
  S.user = user;
  if (!user) { $tabs.hidden = true; renderLogin(); return; }
  $tabs.hidden = false;
  const onErr = e => { console.error(e); toast("Tietokantavirhe: " + e.code, 5000); };
  unsub.push(onSnapshot(userCol("ohjelmat"), snap => { S.ohjelmat = {}; snap.forEach(d => S.ohjelmat[d.id] = d.data()); S.loaded.ohjelmat = true; render(); }, onErr));
  unsub.push(onSnapshot(userDoc("meta", "tila"), snap => { S.meta = snap.exists() ? snap.data() : {}; S.loaded.meta = true; render(); }, onErr));
  unsub.push(onSnapshot(userCol("treenikerrat"), { includeMetadataChanges: true }, snap => {
    S.kerrat = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    S.pending = snap.metadata.hasPendingWrites; S.loaded.kerrat = true;
    // v0.7.0: ohitettu liike lasketaan tehdyksi → aiemmin "osittain" merkityt voivat olla nyt "tehty"
    S.kerrat.forEach(k => { if (k.lahde === "sovellus" && k.tyyppi !== "oma" && k.tila === "osittain" && sessionResult(k).tila === "tehty") { k.tila = "tehty"; persist(k); } });
    updateSync(); render();
  }, onErr));
  unsub.push(onSnapshot(userCol("kehonpaino"), snap => { S.paino = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.pvm.localeCompare(a.pvm)); render(); }, onErr));
  unsub.push(onSnapshot(userCol("mittaukset"), snap => { S.mittaukset = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, onErr));
  unsub.push(onSnapshot(userCol("kaynnit"), snap => { S.kaynnit = snap.docs.map(d => ({ id: d.id, ...d.data() })); }, onErr));
});
function updateSync() {
  if (!navigator.onLine) { $sync.textContent = "Ei yhteyttä · tallennetaan puhelimeen"; $sync.className = "sync off"; }
  else if (S.pending) { $sync.textContent = "Siirretään pilveen…"; $sync.className = "sync pending"; }
  else { $sync.textContent = "Tallennettu"; $sync.className = "sync ok"; }
}
addEventListener("online", updateSync); addEventListener("offline", updateSync);
$tabs.addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (!b) return; S.tab = b.dataset.tab; S.editId = null; if (S.mode === "mittaus") { S.mode = null; S.mform = null; } render(); scrollTo(0, 0); });

// ---------- latausnäyttö ----------
// Poistetaan, kun ensimmäinen oikea näkymä (kirjautuminen tai sovellus) on piirretty. Lyhyt vähimmäisaika estää välähdyksen.
const SPLASH_MIN_MS = 700;
function hideSplash() {
  const el = document.getElementById("splash"); if (!el || el.dataset.out) return;
  el.dataset.out = "1";
  setTimeout(() => { el.classList.add("out"); document.documentElement.classList.remove("splashing"); setTimeout(() => el.remove(), 400); }, Math.max(0, SPLASH_MIN_MS - performance.now()));
}
setTimeout(hideSplash, 8000); // varmistus: ei koskaan jumiin latausnäyttöön

// ---------- juhlanäyttö treenin jälkeen (v0.7.0) ----------
function celebrate(k) {
  const sum = sessionSummary(k), perfect = sessionResult(k).perfect && k.tila === "tehty";
  const title = perfect ? "TÄYDELLINEN!" : k.tila === "tehty" ? "TREENI TEHTY!" : "HYVÄÄ TYÖTÄ!";
  const sub = perfect ? "Kaikki liikkeet ja sarjat tehty" : k.tila === "tehty" ? "Kaikki liikkeet tehty" : "Osa liikkeistä jäi tekemättä";
  const fmtVol = v => v >= 1000 ? (v / 1000).toFixed(1).replace(".", ",") + " t" : Math.round(v) + " kg";
  const el = document.createElement("div");
  el.id = "celeb"; el.className = perfect ? "perfect" : ""; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", title);
  el.innerHTML = `<div class="sp-rays"></div><canvas id="confetti"></canvas>
    <div class="cb-in">
      ${perfect ? `<div class="cb-star" aria-hidden="true">★</div>` : ""}
      <div class="cb-title">${title}</div>
      <div class="cb-sub">${esc(k.treeni || "")}<br><span>${sub}</span></div>
      <div class="cb-card">
        <div class="cb-stats">
          ${sum.min ? `<div><b>${sum.min}</b><span>min</span></div>` : ""}
          <div><b>${sum.sets}</b><span>sarjaa</span></div>
          <div><b>${sum.reps}</b><span>toistoa</span></div>
          ${sum.vol ? `<div><b>${fmtVol(sum.vol)}</b><span>volyymi</span></div>` : ""}
        </div>
        ${sum.prs.length ? `<div class="cb-prs"><div class="cb-h">Uudet ennätykset · ${sum.prs.length}</div>${sum.prs.map(p => `<div class="cb-pr"><span>${esc(p.liike)}</span><b>${esc(setsText([p.s]))}</b><small>ennen ${esc(setsText([p.was]))}</small></div>`).join("")}</div>` : ""}
      </div>
      <button class="cb-ok" id="celeb-ok">Jatka</button>
    </div>`;
  document.body.appendChild(el); S.celebrating = true;
  requestAnimationFrame(() => el.classList.add("in"));
  const stop = confetti(el.querySelector("#confetti"), perfect ? 260 : sum.prs.length ? 160 : 110, perfect);
  document.getElementById("celeb-ok").onclick = () => { stop(); el.classList.remove("in"); el.classList.add("out"); S.celebrating = false; setTimeout(() => el.remove(), 350); };
}
// Kevyt konfetti canvasilla. Ei ulkoisia kirjastoja; prefers-reduced-motion → ei animaatiota.
function confetti(cv, n, gold) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !cv.getContext) return () => {};
  const dpr = Math.min(2, devicePixelRatio || 1), W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr, c = cv.getContext("2d");
  const cols = gold ? ["#ffd166", "#f6f1e5", "#ffb703", "#111111", "#fff3c4"] : ["#f6f1e5", "#111111", "#ffd166", "#ffffff"];
  const ps = Array.from({ length: n }, (_, i) => ({ x: W / 2, y: H * 0.42, vx: (Math.random() - 0.5) * 26 * dpr, vy: (-Math.random() * 22 - 6) * dpr,
    w: (6 + Math.random() * 8) * dpr, h: (8 + Math.random() * 10) * dpr, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, col: cols[i % cols.length], d: Math.random() * 12 }));
  let raf, t = 0;
  const tick = () => { t++; c.clearRect(0, 0, W, H); let alive = 0;
    for (const p of ps) { if (t < p.d) { alive++; continue; } p.vy += 0.55 * dpr; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y < H + 40) { alive++; c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.col; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(t / 8 + p.d))); c.restore(); } }
    if (alive) raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

// ---------- render ----------
function render() {
  if (!S.user) return;
  [...$tabs.children].forEach(b => b.classList.toggle("active", b.dataset.tab === S.tab));
  if (!S.loaded.ohjelmat || !S.loaded.meta || !S.loaded.kerrat) { $view.innerHTML = `<p class="muted center">Ladataan…</p>`; return; }
  // älä piirrä uudelleen kesken numeron kirjoittamisen
  const a = document.activeElement;
  if (a && $view.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && S._typing) return;
  // liikevalitsin auki: piirretään uudelleen vasta kun se suljetaan
  if (document.getElementById("expick-wrap")) { S._deferred = true; return; }
  hideSplash();
  const fn = S.editId && S.tab === "ohjelma" ? renderToday : { tanaan: renderToday, ohjelma: renderProgram, historia: renderHistory, paino: renderBody, vienti: renderData }[S.tab];
  fn();
}
$view.addEventListener("focusin", e => { if (e.target.matches("input,textarea")) S._typing = true; });
$view.addEventListener("focusout", () => { S._typing = false; setTimeout(render, 0); });

function renderLogin() {
  hideSplash();
  $view.innerHTML = `
    <h1>Kirjaudu</h1>
    <p class="muted small">Käytä Firebaseen luomaasi tunnusta. Kirjautuminen muistetaan tässä puhelimessa.</p>
    <form id="lf" class="stack">
      <label>Sähköposti</label><input name="e" type="email" autocomplete="username" required>
      <label>Salasana</label><input name="p" type="password" autocomplete="current-password" required>
      <button class="primary block" type="submit">Kirjaudu</button>
      <p id="lerr" class="small" style="color:var(--danger)"></p>
    </form>`;
  document.getElementById("lf").onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    try { await signInWithEmailAndPassword(auth, f.e.value.trim(), f.p.value); }
    catch (err) { document.getElementById("lerr").textContent = err.code === "auth/network-request-failed" ? "Ei verkkoyhteyttä. Ensimmäinen kirjautuminen vaatii netin." : "Kirjautuminen ei onnistunut (" + err.code + ")."; }
  };
}

// ----- Tänään -----
function renderToday() {
  const p = prog();
  if (!p) { $view.innerHTML = `<h1>Tervetuloa</h1><p>Sovelluksessa ei ole vielä ohjelmaa. Tuo käyttöönottopaketti <b>Data</b>-välilehdellä.</p><button class="primary block" id="go">Siirry Data-välilehdelle</button>`; document.getElementById("go").onclick = () => { S.tab = "vienti"; render(); }; return; }
  const kesken = S.kerrat.find(k => k.tila === "kesken" && k.lahde === "sovellus" && k.id !== S._leave);
  if (S.editId || kesken) return renderWorkout(S.kerrat.find(k => k.id === (S.editId || kesken.id)));
  if (S.mode === "oma") return renderNewCustom();
  const m = S.meta || {};
  const omaBtn = `<button class="block ghost" id="custom" style="margin-top:8px">+ Oma treeni</button><p class="muted center" style="font-size:13px;margin-top:0">Ei siirrä ohjelman etenemistä</p>`;
  const bindOma = () => { const b = document.getElementById("custom"); if (b) b.onclick = () => { S.mode = "oma"; S.pickFilter = ""; render(); scrollTo(0, 0); }; };
  let h = exportBanner();
  if (!m.aloitus) {
    h += `<h1>${esc(p.nimi)}</h1><p class="muted">${p.viikkoja} viikkoa. Ohjelma etenee tehtyjen treenien mukaan, ei kalenterin.</p>
      <button class="primary block" id="start">Aloita ohjelma tänään</button>${omaBtn}`;
    $view.innerHTML = h; bindOma(); document.getElementById("start").onclick = () => saveMeta({ ohjelmaId: p.id, aloitus: todayISO(), viikko: 1, vaihdot: [{ viikko: 1, pvm: todayISO() }] });
    return;
  }
  const w = m.viikko || 1;
  if (w > p.viikkoja) { $view.innerHTML = h + `<h1>Ohjelma suoritettu</h1><p>Hienoa! Muista viedä data iCloudiin Data-välilehdeltä.</p>${omaBtn}`; bindOma(); return; }
  const wi = weekInfo(p, w);
  h += `<div class="eyebrow">${esc(wi.jakso.nimi)}</div><h1>Viikko ${w}<span class="muted" style="font-weight:600"> / ${p.viikkoja}</span></h1><p class="muted small">${esc(wi.jakso.ohje)}</p>`;
  if (!wi.slots.length) {
    h += `<div class="card"><h3>Lepoviikko</h3><p class="muted">Tällä viikolla ei ole treenejä.</p></div><button class="primary block" id="next">Siirry viikkoon ${w + 1}</button>${omaBtn}`;
    $view.innerHTML = h; bindOma(); document.getElementById("next").onclick = () => nextWeek(p, w); return;
  }
  let firstOpen = -1;
  wi.slots.forEach((t, i) => { if (firstOpen < 0 && !sessionForSlot(p, w, i)) firstOpen = i; });
  const slotsHtml = wi.slots.map((t, i) => {
    const k = sessionForSlot(p, w, i);
    const st = k ? statusBadge(k, true) : "";
    const isNext = i === firstOpen;
    return `<div class="card slot ${isNext ? "next" : ""} ${k ? "is-" + k.tila : ""} ${k && isPerfect(k) ? "is-perfect" : ""}"><div><h3>${esc(t.nimi)}</h3><div class="meta">${isNext ? `<span class="badge nextb">Seuraavaksi</span>` : ""}${t.liikkeet.length} liikettä ${st}</div></div>
      ${k ? (k.tila !== "valiin" ? `<button data-open="${k.id}" class="small">Avaa</button>` : "") : `<button data-slot="${i}" class="small ${isNext ? "primary" : ""}">Aloita</button>`}</div>`;
  }).join("");
  if (firstOpen >= 0) {
    const t = wi.slots[firstOpen];
    h += `<div class="hero"><div class="eyebrow">Seuraavaksi · ${firstOpen + 1}/${wi.slots.length}</div><h3>${esc(t.nimi)}</h3>
      <div class="preview">${esc(t.liikkeet.slice(0, 4).map(l => l.nimi).join(" · "))}${t.liikkeet.length > 4 ? ` +${t.liikkeet.length - 4}` : ""}</div>
      <button class="primary" data-slot="${firstOpen}">Aloita treeni</button></div>`;
  } else h += `<div class="card"><h3>Viikon treenit on käyty läpi</h3><p class="muted small">Siirry seuraavaan viikkoon, kun olet valmis.</p></div>`;
  h += (wi.slots.length > 1 ? `<h2>Tämän viikon treenit</h2>` : "") + slotsHtml;
  h += `<button class="block" id="next" style="margin-top:16px">Siirry viikkoon ${w + 1}${firstOpen >= 0 ? " (tekemättömät merkitään väliin jätetyiksi)" : ""}</button>${omaBtn}`;
  $view.innerHTML = h; bindOma();
  $view.querySelectorAll("[data-slot]").forEach(b => b.onclick = () => startWorkout(p, w, +b.dataset.slot));
  $view.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { S.editId = b.dataset.open; S._leave = null; render(); });
  document.getElementById("next").onclick = () => { if (firstOpen < 0 || confirm("Siirrytäänkö seuraavaan viikkoon? Tekemättömät treenit merkitään väliin jätetyiksi.")) nextWeek(p, w); };
}
function exportBanner() {
  const last = S.meta?.viimeVienti; const n = S.kerrat.filter(k => k.lahde === "sovellus" && k.tila !== "valiin").length;
  if (!n) return "";
  const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 864e5) : Infinity;
  return days > 14 ? `<div class="banner">Edellisestä omasta varmuuskopiosta on ${last ? days + " päivää" : "ei vielä yhtään"}. Vie data iCloudiin Data-välilehdeltä.</div>` : "";
}
function nextWeek(p, w) {
  const wi = weekInfo(p, w);
  const b = writeBatch(db);
  wi.slots.forEach((t, i) => {
    if (!sessionForSlot(p, w, i)) {
      const id = uid();
      b.set(userDoc("treenikerrat", id), baseSession(p, w, i, t, "valiin"));
    }
  });
  b.commit().catch(e => toast("Virhe: " + e.code));
  const vaihdot = [...(S.meta.vaihdot || []), { viikko: w + 1, pvm: todayISO() }];
  saveMeta({ viikko: w + 1, vaihdot });
  toast(`Viikko ${w + 1} alkoi`);
}
function baseSession(p, w, i, t, tila) {
  const wi = weekInfo(p, w);
  return { tyyppi: "ohjelma", ohjelmaId: p.id, ohjelma: p.nimi, jakso: wi.jakso.nimi, viikko: w, slot: i, treeniId: t.id, treeni: t.nimi,
    tila, pvm: tila === "valiin" ? "" : todayISO(), alku: tila === "valiin" ? "" : nowISO(), loppu: "", huomio: "", lahde: "sovellus",
    liikkeet: t.liikkeet.map(l => ({ nimi: l.nimi, tavoite: l.tavoite, suunniteltu: l.nimi, sarjoja: l.sarjat.length, toistot: l.sarjat.map(s => s.toistot), tyypit: l.sarjat.map(s => s.tyyppi), ohitettu: false, huomio: "" })),
    sarjat: [] };
}
function startWorkout(p, w, i) {
  const t = weekInfo(p, w).slots[i]; const id = uid();
  const data = baseSession(p, w, i, t, "kesken");
  S.kerrat.push({ id, ...data }); save("treenikerrat", id, data); S.editId = id; render();
}

// ----- oma treeni -----
function renderNewCustom() {
  const f = (S.pickFilter || "").trim().toLowerCase();
  const bases = S.kerrat.filter(k => k.tila !== "kesken" && k.tila !== "valiin" && k.pvm && (k.sarjat || []).some(s => s.tyyppi !== "merkinta" && s.liike))
    .sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)))
    .filter(k => !f || (k.treeni || "").toLowerCase().includes(f) || (k.sarjat || []).some(s => (s.liike || "").toLowerCase().includes(f)) || fiDate(k.pvm).includes(f));
  let h = `<div class="row space"><h1>Oma treeni</h1><button class="ghost" id="cback">Takaisin</button></div>
    <p class="muted small">Oma treeni ei siirrä ohjelman etenemistä. Aloita tyhjästä tai valitse pohjaksi jokin aiempi treeni, jolloin liikkeet ja painot tulevat viime kerran tuloksista.</p>
    <label>Nimi</label><input id="cname" value="${esc(S.customName || "Oma treeni")}">
    <button class="primary block" id="cempty" style="margin-top:10px">Aloita tyhjä treeni</button>
    <h2>Pohjaksi aiempi treeni</h2><input id="cf" placeholder="Hae nimellä, liikkeellä tai päivällä" value="${esc(S.pickFilter || "")}">`;
  h += bases.slice(0, S.pickAll ? 1e9 : 25).map(k => {
    const names = [...new Set((k.sarjat || []).filter(s => s.liike && s.tyyppi !== "merkinta").map(s => s.liike))];
    return `<div class="card slot"><div><b>${fiDate(k.pvm)}</b> · ${esc(k.treeni || "")}<div class="muted small">${esc(names.slice(0, 4).join(", "))}${names.length > 4 ? ` +${names.length - 4}` : ""}</div></div>
      <button data-base="${k.id}">Valitse</button></div>`;
  }).join("") || `<p class="muted">Ei osumia.</p>`;
  if (!S.pickAll && bases.length > 25) h += `<button class="block" id="call">Näytä kaikki (${bases.length})</button>`;
  $view.innerHTML = h;
  const nm = document.getElementById("cname"); nm.oninput = () => S.customName = nm.value;
  document.getElementById("cback").onclick = () => { S.mode = null; render(); };
  document.getElementById("cempty").onclick = () => startCustom(null);
  const cf = document.getElementById("cf");
  cf.oninput = () => { S.pickFilter = cf.value; clearTimeout(S._cf); S._cf = setTimeout(() => { S._typing = false; render(); const el = document.getElementById("cf"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 350); };
  const ca = document.getElementById("call"); if (ca) ca.onclick = () => { S.pickAll = true; render(); };
  $view.querySelectorAll("[data-base]").forEach(b => b.onclick = () => startCustom(S.kerrat.find(k => k.id === b.dataset.base)));
}
function startCustom(base) {
  let liikkeet = [];
  if (base) {
    const order = [];
    (base.sarjat || []).forEach(s => { if (s.liike && s.tyyppi !== "merkinta" && !order.includes(s.liike)) order.push(s.liike); });
    liikkeet = order.map(n => ({ nimi: n, tavoite: "", suunniteltu: n, sarjoja: (base.sarjat || []).filter(s => s.liike === n && s.tyyppi !== "merkinta").length || 3,
      toistot: [], tyypit: [], ohitettu: false, huomio: "" }));
  }
  const nimi = (S.customName || "").trim() || (base ? base.treeni : "") || "Oma treeni";
  const id = uid();
  const data = { tyyppi: "oma", ohjelmaId: null, ohjelma: "Oma", jakso: "", viikko: null, slot: null, treeniId: null, treeni: nimi,
    pohjaId: base ? base.id : null, tila: "kesken", pvm: todayISO(), alku: nowISO(), loppu: "", huomio: "", lahde: "sovellus", liikkeet, sarjat: [] };
  S.kerrat.push({ id, ...data }); save("treenikerrat", id, data);
  S.mode = null; S.customName = ""; S.editId = id; render(); scrollTo(0, 0);
}

// ----- palautusajastin (ei-ohjaava) -----
function restSeconds(k) {
  if (k.tyyppi === "oma" || !k.ohjelmaId) return 90;
  const p = S.ohjelmat[k.ohjelmaId]; const wi = p && weekInfo(p, k.viikko);
  return wi?.jakso?.lepo_s || 90;
}
function startTimer(sec) {
  S.timer = { end: Date.now() + sec * 1000, total: sec };
  clearInterval(S._ti); S._ti = setInterval(drawTimer, 500); drawTimer();
}
function stopTimer() { S.timer = null; clearInterval(S._ti); drawTimer(); }
function drawTimer() {
  let bar = document.getElementById("timer");
  if (!S.timer) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = document.createElement("div"); bar.id = "timer";
    bar.innerHTML = `<span id="tlabel"></span><span class="row" style="gap:6px"><button id="tplus">+30 s</button><button id="tskip">Ohita</button></span>`;
    document.body.appendChild(bar);
    bar.querySelector("#tskip").onclick = stopTimer;
    bar.querySelector("#tplus").onclick = () => { if (S.timer) S.timer.end += 30000; drawTimer(); };
  }
  bar.hidden = false;
  const left = Math.round((S.timer.end - Date.now()) / 1000);
  const lab = bar.querySelector("#tlabel");
  bar.style.setProperty("--p", Math.max(0, Math.min(100, 100 * (1 - left / S.timer.total))) + "%");
  if (left > 0) { lab.textContent = `Palautus ${Math.floor(left / 60)}:${pad(left % 60)}`; bar.classList.remove("over"); }
  else { lab.textContent = "Palautus ohi – seuraava sarja"; bar.classList.add("over"); if (left < -20) stopTimer(); }
}

// ----- treeni-näkymä -----
function allExerciseNames() {
  const set = new Set();
  Object.values(S.ohjelmat).forEach(p => p.jaksot.forEach(j => j.treenit.forEach(t => t.liikkeet.forEach(l => set.add(l.nimi)))));
  S.kerrat.forEach(k => (k.sarjat || []).forEach(s => s.liike && set.add(s.liike)));
  (S.meta?.omatLiikkeet || []).forEach(n => set.add(n));
  return [...set].sort((a, b) => a.localeCompare(b, "fi"));
}
function renderWorkout(k) {
  if (!k) { S.editId = null; return renderToday(); }
  const draft = S.draft && S.draft.id === k.id ? S.draft : (S.draft = { id: k.id, v: {} });
  const planned = (k.liikkeet || []).reduce((a, l, li) => a + (l.ohitettu ? 0 : Math.max(l.sarjoja || 0, k.sarjat.filter(s => s.liikeIndex === li).length)), 0);
  const doneN = k.sarjat.filter(s => !k.liikkeet[s.liikeIndex]?.ohitettu).length;
  const frac = planned ? Math.min(1, doneN / planned) : 0, C = 2 * Math.PI * 27;
  let h = `<div class="row space" style="margin-top:4px"><button class="ghost small" id="back" style="padding-left:0">‹ Takaisin</button><span class="muted" style="font-size:14px">${k.pvm ? fiDate(k.pvm) : ""}</span></div>
    <div class="wo-head"><div><div class="eyebrow">${k.tyyppi === "oma" || !k.ohjelmaId ? "Oma treeni" : `Viikko ${k.viikko} · ${esc(k.jakso || "")}`}</div><h1 style="margin-top:4px">${esc(k.treeni)}</h1></div>
    <div class="ring" aria-label="${doneN}/${planned} sarjaa"><svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="27"/><circle class="fg" cx="32" cy="32" r="27" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg><span>${doneN}/${planned}</span></div></div>`;
  const p = S.ohjelmat[k.ohjelmaId]; const wi = p && weekInfo(p, k.viikko);
  if (wi) h += `<p class="muted small">${esc(wi.jakso.ohje)}</p>`;
  (k.liikkeet || []).forEach((l, li) => {
    const done = k.sarjat.filter(s => s.liikeIndex === li);
    const last = lastSetsFor(l.nimi, k.id), best = bestSetFor(l.nimi, k.id);
    const newPR = best ? done.filter(s => betterSet(s, best.s)).reduce((a, s) => !a || betterSet(s, a) ? s : a, null) : null;
    const rows = Math.max(l.sarjoja || 0, done.length) + (draft.v["extra" + li] || 0);
    h += `<div class="ex ${l.ohitettu ? "skipped" : ""}" data-li="${li}">
      <div class="row space"><h3>${esc(l.nimi)}</h3>${(l.tavoite || !last) ? `<span class="tag">${esc(l.tavoite || "uusi")}</span>` : ""}</div>
      ${l.nimi !== l.suunniteltu ? `<div class="muted small">Korvaa: ${esc(l.suunniteltu)}</div>` : ""}
      <div class="last">${last ? `Viimeksi ${last.k.pvm ? fiDate(last.k.pvm) : "viikko " + (last.k.viikko || "?")} · <b>${esc(setsText(last.sets))}</b>` : "Ei aiempia tuloksia"}</div>
      ${best ? `<div class="best">${newPR ? `<span class="pr">Uusi ennätys</span> <b>${esc(setsText([newPR]))}</b> <span class="was">(ennen ${esc(setsText([best.s]))})</span>` : `Paras ${best.k.pvm ? fiDate(best.k.pvm) : "viikko " + (best.k.viikko || "?")} · <b>${esc(setsText([best.s]))}</b>`}</div>` : ""}`;
    if (!l.ohitettu) {
      h += `<div class="hdr-labels"><span></span><span>kg</span><span>toistot</span><span></span></div>`;
      for (let si = 0; si < rows; si++) {
        const d = done.find(s => s.sarja === si + 1);
        const prevSet = last?.sets[si] || last?.sets[last.sets.length - 1];
        const prevInRow = done.find(s => s.sarja === si);
        const kg = draft.v[`kg${li}_${si}`] ?? (d ? d.paino_kg : (prevInRow?.paino_kg ?? prevSet?.paino_kg ?? null));
        const reps = draft.v[`r${li}_${si}`] ?? (d ? d.toistot : (l.toistot?.[si] ?? prevSet?.toistot ?? null));
        h += `<div class="set ${d ? "done" : ""} ${S._pop === `${k.id}:${li}:${si}` ? "pop" : ""}" data-si="${si}">
          <span class="n">${si + 1}${l.tyypit?.[si] === "restpause" ? "<br><small>RP</small>" : ""}</span>
          <div class="stepper"><button data-step="kg" data-d="-2.5">−</button><input inputmode="decimal" data-f="kg" value="${kg == null ? "" : fmtKg(kg)}"><button data-step="kg" data-d="2.5">+</button></div>
          <div class="stepper"><button data-step="r" data-d="-1">−</button><input inputmode="numeric" data-f="r" value="${reps ?? ""}"><button data-step="r" data-d="1">+</button></div>
          <button class="ok" data-act="${d ? "undo" : "done"}" aria-label="${d ? "Kirjattu, poista" : "Kirjaa sarja"}">✓</button></div>`;
      }
      h += `<div class="ex-actions"><button data-act="addset">+ Sarja</button>
        <button data-act="swap">Vaihda liike</button><button data-act="skip">Ohita</button></div>
        <input data-f="note" placeholder="Huomio (valinnainen)" value="${esc(l.huomio || "")}">`;
    } else h += `<button class="ghost small" data-act="unskip">Palauta liike</button>`;
    h += `</div>`;
  });
  if (!(k.liikkeet || []).length) h += `<p class="muted center" style="margin:24px 0">Lisää ensimmäinen liike alta.</p>`;
  h += `<button class="${(k.liikkeet || []).length ? "ghost" : "primary"} block" id="addex">+ Lisää liike</button>
    <label>Treenin huomio</label><textarea id="knote">${esc(k.huomio || "")}</textarea>
    <div class="row" style="margin-top:12px"><button class="primary block" id="finish">${k.tila === "kesken" ? "Treeni valmis" : "Tallenna muutokset"}</button></div>
    ${k.tila !== "kesken" ? `<button class="danger block" id="del" style="margin-top:8px">Poista treenikerta</button>` : `<button class="ghost block" id="cancel" style="margin-top:8px">Hylkää treeni</button>`}
    <datalist id="exnames">${allExerciseNames().map(n => `<option value="${esc(n)}">`).join("")}</datalist>`;
  $view.innerHTML = h; S._pop = null;
  bindWorkout(k);
}
function persist(k) { const { id, ...data } = k; save("treenikerrat", id, data); }
function bindWorkout(k) {
  const draft = S.draft;
  document.getElementById("back").onclick = () => { S.editId = null; S.draft = null; if (S.tab !== "ohjelma") S.tab = "tanaan"; S._leave = k.id; render(); };
  $view.querySelectorAll(".ex").forEach(ex => {
    const li = +ex.dataset.li; const l = k.liikkeet[li];
    ex.addEventListener("input", e => {
      const f = e.target.dataset.f; const row = e.target.closest(".set");
      if (f === "kg" || f === "r") draft.v[`${f}${li}_${row.dataset.si}`] = f === "kg" ? num(e.target.value) : num(e.target.value);
      if (f === "note") { l.huomio = e.target.value; clearTimeout(draft._nt); draft._nt = setTimeout(() => persist(k), 800); }
    });
    ex.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      const row = b.closest(".set"); const si = row ? +row.dataset.si : null;
      if (b.dataset.step) {
        const input = row.querySelector(`input[data-f="${b.dataset.step}"]`);
        const v = (num(input.value) ?? 0) + Number(b.dataset.d);
        const nv = Math.max(b.dataset.step === "kg" ? -200 : 0, v);
        input.value = b.dataset.step === "kg" ? fmtKg(nv) : nv;
        draft.v[`${b.dataset.step}${li}_${si}`] = nv; return;
      }
      const act = b.dataset.act;
      if (act === "done") {
        const kg = num(row.querySelector('[data-f="kg"]').value), r = num(row.querySelector('[data-f="r"]').value);
        if (r == null && kg == null) { toast("Syötä toistot"); return; }
        k.sarjat = k.sarjat.filter(s => !(s.liikeIndex === li && s.sarja === si + 1));
        // Jälkikirjaus: kuitattu valmiin treenin muokkauksena tai alle 15 s edellisestä kuittauksesta (useampi sarja putkeen).
        const nowMs = Date.now();
        const prev = k.sarjat.filter(s => s.kirjattu).sort((a, b) => Date.parse(b.kirjattu) - Date.parse(a.kirjattu))[0];
        const quick = prev && nowMs - Date.parse(prev.kirjattu) < 15000;
        const late = k.tila !== "kesken";
        if (quick) prev.jalkikirjaus = true;
        const eq = splitEquip(l.nimi);
        k.sarjat.push({ liikeIndex: li, liike: l.nimi, perusliike: eq.perusliike, valine: eq.valine, sarja: si + 1, tyyppi: l.tyypit?.[si] || "tyo", tavoite: l.tavoite || "",
          paino_kg: kg, toistot: r, aika_s: null, kirjattu: nowISO(), jalkikirjaus: !!(quick || late), id: uid() });
        delete draft.v[`kg${li}_${si}`]; delete draft.v[`r${li}_${si}`];
        S._pop = `${k.id}:${li}:${si}`; navigator.vibrate?.(12);
        persist(k); render();
        if (!late) startTimer(restSeconds(k));
      } else if (act === "undo") {
        if (!confirm("Poistetaanko tämä sarja?")) return;
        k.sarjat = k.sarjat.filter(s => !(s.liikeIndex === li && s.sarja === si + 1)); persist(k); render();
      } else if (act === "addset") { draft.v["extra" + li] = (draft.v["extra" + li] || 0) + 1; render(); }
      else if (act === "skip") { l.ohitettu = true; persist(k); render(); }
      else if (act === "unskip") { l.ohitettu = false; persist(k); render(); }
      else if (act === "swap") { askExercise(`Millä liikkeellä korvataan ${l.nimi}?`, name => { l.nimi = name; const eq = splitEquip(name); k.sarjat.forEach(s => { if (s.liikeIndex === li) Object.assign(s, { liike: name, perusliike: eq.perusliike, valine: eq.valine }); }); persist(k); render(); }); }
    });
  });
  document.getElementById("addex").onclick = () => askExercise("Lisättävä liike", name => {
    k.liikkeet.push({ nimi: name, tavoite: "", suunniteltu: name, sarjoja: 3, toistot: [], tyypit: [], ohitettu: false, huomio: "", lisatty: true }); persist(k); render(); });
  document.getElementById("knote").oninput = e => { k.huomio = e.target.value; clearTimeout(draft._kn); draft._kn = setTimeout(() => persist(k), 800); };
  document.getElementById("finish").onclick = () => {
    const wasLive = k.tila === "kesken";
    if (wasLive) { k.tila = sessionResult(k).tila; k.loppu = nowISO(); stopTimer(); }
    else if (k.tila === "tehty" || k.tila === "osittain") k.tila = sessionResult(k).tila; // muokkaus voi muuttaa tuloksen
    persist(k); S.editId = null; S.draft = null; render();
    if (wasLive && k.tila !== "valiin") celebrate(k); else toast("Tallennettu");
  };
  const del = document.getElementById("del"), cancel = document.getElementById("cancel");
  if (del) del.onclick = () => { if (confirm("Poistetaanko koko treenikerta pysyvästi?")) { deleteDoc(userDoc("treenikerrat", k.id)); S.kerrat = S.kerrat.filter(x => x.id !== k.id); S.editId = null; render(); } };
  if (cancel) cancel.onclick = () => { if (!k.sarjat.length || confirm("Hylätäänkö treeni? Kirjatut sarjat poistetaan.")) { deleteDoc(userDoc("treenikerrat", k.id)); S.kerrat = S.kerrat.filter(x => x.id !== k.id); S.editId = null; render(); } };
}
function askExercise(title, cb) {
  document.getElementById("expick-wrap")?.remove();
  const names = allExerciseNames();
  const outer = document.createElement("div"); outer.id = "expick-wrap";
  outer.innerHTML = `<div class="scrim"></div><div class="glass" id="expick"><div class="row space"><h3>${esc(title)}</h3><button class="ghost small" id="exno">Peruuta</button></div>
    <input id="exq" placeholder="Kirjoita liikkeen nimi" autocomplete="off" autocapitalize="sentences" style="margin-top:10px"><div id="exres" class="stack"></div></div>`;
  document.body.appendChild(outer);
  const wrap = outer.querySelector("#expick");
  outer.querySelector(".scrim").onclick = () => { close(); render(); };
  const q = wrap.querySelector("#exq"), res = wrap.querySelector("#exres");
  const close = () => { S._typing = false; outer.remove(); S._deferred = false; };
  const done = name => { close(); if (!names.includes(name)) saveMeta({ omatLiikkeet: [...new Set([...(S.meta?.omatLiikkeet || []), name])] }); cb(name); };
  const draw = () => {
    const v = q.value.trim();
    if (!v) { res.innerHTML = `<p class="muted small">Ohjelman, historian ja omat liikkeet (${names.length}). Kirjoita hakeaksesi.</p>`; return; }
    const exact = names.find(n => normName(n) === normName(v));
    const hits = fuzzy(v, names).slice(0, 8);
    let h = hits.map(x => `<button class="block" style="text-align:left" data-n="${esc(x.n)}">${esc(x.n)}</button>`).join("");
    if (!exact) h += `<button class="ghost block" style="text-align:left" data-new="1">+ Lisää uusi liike "${esc(v)}"</button>`;
    res.innerHTML = h;
    res.querySelectorAll("[data-n]").forEach(b => b.onclick = () => done(b.dataset.n));
    const nb = res.querySelector("[data-new]");
    if (nb) nb.onclick = () => {
      const close = fuzzy(v, names, 0.7).slice(0, 3);
      if (!close.length) return done(v);
      res.innerHTML = `<p><b>Tarkoititko…?</b></p>` + close.map(x => `<button class="block" style="text-align:left" data-n="${esc(x.n)}">${esc(x.n)}</button>`).join("") +
        `<button class="ghost block" id="exforce">Ei, lisää uusi liike "${esc(v)}"</button>`;
      res.querySelectorAll("[data-n]").forEach(b => b.onclick = () => done(b.dataset.n));
      res.querySelector("#exforce").onclick = () => done(v);
    };
  };
  q.oninput = draw; draw(); q.focus();
  wrap.querySelector("#exno").onclick = () => { close(); render(); };
}

// ----- Ohjelma -----
function renderProgram() {
  const p = prog(); if (!p) { $view.innerHTML = `<p>Ei ohjelmaa.</p>`; return; }
  const cur = S.meta?.viikko || 0;
  let h = `<h1>${esc(p.nimi)}</h1><p class="muted small">${S.meta?.aloitus ? "Aloitettu " + fiDate(S.meta.aloitus) : "Ei vielä aloitettu"}</p><div class="week-grid">`;
  for (let w = 1; w <= p.viikkoja; w++) {
    const wi = weekInfo(p, w); const ss = sessionsOfWeek(p, w); const n = wi.slots.length;
    const done = ss.filter(k => k.tila === "tehty" || k.tila === "osittain").length;
    const cls = [w === cur ? "cur" : "", n && done >= n ? "full" : done ? "part" : ""].join(" ");
    h += `<div class="${cls} ${S.weekView === w ? "sel" : ""}" data-week="${w}" role="button" tabindex="0" aria-label="Viikko ${w}">Vk ${w}<br><b>${n ? done + "/" + n : "lepo"}</b></div>`;
  }
  h += `</div>`;
  if (S.weekView && S.weekView <= p.viikkoja) h += weekPanel(p, S.weekView, cur);
  p.jaksot.forEach(j => {
    h += `<h2>${esc(j.nimi)} <span class="muted small">vk ${j.viikot[0].viikko}${j.viikot.length > 1 ? "–" + j.viikot[j.viikot.length - 1].viikko : ""}</span></h2><p class="muted small">${esc(j.ohje)}</p>`;
    j.treenit.forEach(t => h += `<details class="card"><summary><b>${esc(t.nimi)}</b></summary>${t.liikkeet.map(l => `<div class="row space small list-item"><span>${esc(l.nimi)}</span><span class="muted">${esc(l.tavoite)}</span></div>`).join("")}</details>`);
  });
  if (S.meta?.aloitus) h += `<h2>Viikon säätö</h2><p class="muted small">Jos viikko meni väärin, voit asettaa nykyisen viikon käsin.</p>
    <div class="row"><input id="wset" type="number" min="1" max="${p.viikkoja}" value="${cur}"><button id="wbtn">Aseta</button></div>`;
  if (S.meta?.aloitus) h += `<h2>Nollaa aloitus</h2><p class="muted small">Poistaa ohjelman aloituspäivän ja kaikki tämän ohjelman sovelluksella kirjatut treenikerrat. Vanha historia ja punnitukset säilyvät. Käytä esim. testauksen jälkeen.</p>
    <button class="danger block" id="reset">Nollaa ohjelman aloitus</button>`;
  $view.innerHTML = h;
  // v0.7.0: viikon napautus avaa viikon treenit; treenin "Avaa" näyttää treenin (Takaisin palaa Ohjelmaan)
  $view.querySelectorAll("[data-week]").forEach(el => el.onclick = () => { const w = +el.dataset.week; S.weekView = S.weekView === w ? null : w; render();
    if (S.weekView) document.getElementById("weekpanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  const wc = document.getElementById("wclose"); if (wc) wc.onclick = () => { S.weekView = null; render(); };
  $view.querySelectorAll("#weekpanel [data-open]").forEach(b => b.onclick = () => { S.editId = b.dataset.open; S._leave = null; render(); scrollTo(0, 0); });
  const rb = document.getElementById("reset");
  if (rb) rb.onclick = () => {
    const mine = S.kerrat.filter(k => k.lahde === "sovellus" && k.ohjelmaId === p.id);
    if (!confirm(`Nollataanko aloitus? ${mine.length} kirjattua treenikertaa poistetaan pysyvästi.`)) return;
    const b = writeBatch(db); mine.forEach(k => b.delete(userDoc("treenikerrat", k.id))); b.commit().catch(e => toast("Virhe: " + e.code));
    S.kerrat = S.kerrat.filter(k => !mine.includes(k));
    saveMeta({ aloitus: null, viikko: null, vaihdot: [] }); toast("Aloitus nollattu");
  };
  const wb = document.getElementById("wbtn"); if (wb) wb.onclick = () => { const v = +document.getElementById("wset").value; if (v >= 1 && v <= p.viikkoja + 1) { saveMeta({ viikko: v }); toast("Viikko " + v); } };
}

function weekPanel(p, w, cur) {
  const wi = weekInfo(p, w), fmtVol = v => v >= 1000 ? (v / 1000).toFixed(1).replace(".", ",") + " t" : Math.round(v) + " kg";
  let tot = { sets: 0, vol: 0 };
  const rows = wi.slots.map((t, i) => {
    const k = sessionForSlot(p, w, i), sum = k && k.tila !== "valiin" ? sessionSummary(k) : null;
    if (sum) { tot.sets += sum.sets; tot.vol += sum.vol; }
    const st = k ? statusBadge(k, true) : `<span class="badge valiin">${w < cur ? "Ei kirjattu" : w === cur ? "Tekemättä" : "Tulossa"}</span>`;
    const info = sum ? `${sum.sets} sarjaa${sum.vol ? " · " + fmtVol(sum.vol) : ""}${sum.prs.length ? ` · <b class="prc">${sum.prs.length} ennätys${sum.prs.length > 1 ? "tä" : ""}</b>` : ""}` : `${t.liikkeet.length} liikettä`;
    return `<div class="wk-row ${k ? "is-" + k.tila : ""} ${k && isPerfect(k) ? "is-perfect" : ""}"><div><div class="wk-n">${esc(t.nimi)}</div><div class="meta">${st} <span>${info}</span></div></div>
      ${k && k.tila !== "valiin" ? `<button class="small" data-open="${k.id}">Avaa</button>` : ""}</div>`;
  }).join("");
  return `<div class="card" id="weekpanel"><div class="row space"><div><h2 style="margin:0">Viikko ${w}</h2><div class="muted" style="font-size:14px">${esc(wi.jakso?.nimi || "")}${tot.sets ? ` · ${tot.sets} sarjaa${tot.vol ? " · " + fmtVol(tot.vol) : ""}` : ""}</div></div>
    <button class="ghost small" id="wclose">Sulje</button></div>${rows || `<p class="muted small">Lepoviikko.</p>`}</div>`;
}

// ----- Historia -----
function sessionSortKey(k) { return (k.pvm || "") + (k.alku || ""); }
function renderHistory() {
  const f = S.histFilter.trim().toLowerCase();
  let list = S.kerrat.filter(k => k.tila !== "kesken");
  if (f) list = list.filter(k => (k.sarjat || []).some(s => (s.liike || "").toLowerCase().includes(f)) || (k.treeni || "").toLowerCase().includes(f));
  const dated = list.filter(k => k.pvm).sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)));
  const undated = list.filter(k => !k.pvm).sort((a, b) => (b.ohjelma || "").localeCompare(a.ohjelma || "") || (b.viikko || 0) - (a.viikko || 0));
  const nSets = list.reduce((a, k) => a + (k.sarjat || []).filter(s => s.tyyppi !== "merkinta" && (!f || (s.liike || "").toLowerCase().includes(f))).length, 0);
  let h = `<h1>Historia</h1><div class="stat"><span><b>${list.length}</b>treenikertaa</span><span><b>${nSets}</b>sarjaa</span></div>
    <input id="hf" type="search" placeholder="Hae liikkeellä, esim. penkki" value="${esc(S.histFilter)}" style="margin:10px 0 4px"><div id="hl">`;
  const item = k => {
    const byEx = {};
    (k.sarjat || []).forEach(s => { if (!f || (s.liike || "").toLowerCase().includes(f)) (byEx[s.liike] = byEx[s.liike] || []).push(s); });
    const when = k.pvm ? fiDate(k.pvm) : `Viikko ${k.viikko || "?"}`;
    return `<details class="card"><summary><div class="row space" style="flex:1;align-items:flex-start"><div><b>${when}</b> · ${esc(k.treeni || "")}<div class="muted" style="font-size:14px">${esc(k.ohjelma || "")}</div></div>
      ${k.lahde !== "sovellus" ? `<span class="badge vanha">Vanha</span>` : k.tyyppi === "oma" ? `<span class="badge ${k.tila}">Oma</span>` : statusBadge(k, false)}</div></summary>
      ${Object.entries(byEx).map(([n, ss]) => `<div class="sets-line"><b>${esc(n)}</b>: ${esc(setsText(ss.filter(s => s.tyyppi !== "merkinta")))}${ss.filter(s => s.huomio).map(s => ` <span class="muted small">(${esc(s.huomio)})</span>`).slice(0, 2).join("")}</div>`).join("") || `<p class="muted small">Ei sarjoja</p>`}
      ${k.huomio ? `<p class="muted small">${esc(k.huomio)}</p>` : ""}
      ${k.lahde === "sovellus" ? `<button class="ghost small" data-edit="${k.id}">Muokkaa</button>` : ""}</details>`;
  };
  const LIMIT = 60; const shown = [...dated, ...undated].slice(0, S.histAll ? 1e9 : LIMIT);
  h += shown.map(item).join("") + `</div>`;
  if (!S.histAll && dated.length + undated.length > LIMIT) h += `<button class="block" id="more">Näytä kaikki (${dated.length + undated.length})</button>`;
  $view.innerHTML = h;
  const hf = document.getElementById("hf");
  hf.oninput = () => { S.histFilter = hf.value; clearTimeout(S._hf); S._hf = setTimeout(() => { S._typing = false; render(); const el = document.getElementById("hf"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 350); };
  const more = document.getElementById("more"); if (more) more.onclick = () => { S.histAll = true; render(); };
  $view.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => { S.editId = b.dataset.edit; S.tab = "tanaan"; render(); scrollTo(0, 0); });
}

// ----- Keho: punnitukset + kehonkoostumusmittaukset -----
// Mittareiden luettelo. Eri laitteet antavat eri arvoja, joten tallennetaan vain mitatut arvot avain–arvo-pareina.
// "ver": mittari, jota voi verrata eri laitteiden välillä suuntaa-antavasti. "hyva": up = kasvu hyvä, down = lasku hyvä, "" = neutraali.
const METRICS = [
  { k: "paino", n: "Paino", u: "kg", ver: 1, hyva: "", main: 1 },
  { k: "rasvaprosentti", n: "Rasvaprosentti", u: "%", hyva: "down", main: 1 },
  { k: "rasvamassa", n: "Rasvamassa", u: "kg", hyva: "down", main: 1 },
  { k: "lihasmassa", n: "Lihasmassa (Tanita)", u: "kg", hyva: "up", main: 1, info: "Tanita-vaa'an lihasmassa sisältää myös sileän lihaksen ja veden. Ei vertailukelpoinen luurankolihasmassaan." },
  { k: "luurankolihas", n: "Luurankolihasmassa", u: "kg", hyva: "up", main: 1, info: "InBody-tyyppisten laitteiden (esim. Puhti) lihasmassa. Ei vertailukelpoinen Tanitan lihasmassaan." },
  { k: "rasvaton_massa", n: "Rasvaton massa", u: "kg", hyva: "up" },
  { k: "viskeraali_taso", n: "Viskeraalirasva (taso)", u: "", hyva: "down", info: "Tanitan asteikko 1–59." },
  { k: "viskeraali_ala", n: "Viskeraalirasva (VFA)", u: "cm²", hyva: "down", info: "Sisäelinrasvan pinta-ala, InBody-tyyppiset laitteet." },
  { k: "bmi", n: "Painoindeksi", u: "", ver: 1, hyva: "" },
  { k: "rasvamassaindeksi", n: "Rasvamassaindeksi", u: "kg/m²", hyva: "down" },
  { k: "kokonaisvesi", n: "Kehon vesi", u: "kg", hyva: "" },
  { k: "vesiprosentti", n: "Vesiprosentti", u: "%", hyva: "" },
  { k: "luumassa", n: "Luumassa", u: "kg", hyva: "" },
  { k: "perusaineenvaihdunta", n: "Perusaineenvaihdunta", u: "kcal", hyva: "" },
  { k: "metabolinen_ika", n: "Metabolinen ikä", u: "v", hyva: "down" },
  { k: "kehon_ika", n: "Kehon ikä", u: "v", hyva: "down" },
  { k: "kokonaispisteet", n: "Kehon pisteet", u: "", hyva: "up" },
  { k: "suositeltu_paino", n: "Suositeltu paino", u: "kg", ver: 1, hyva: "" },
  { k: "impedanssi", n: "Impedanssi", u: "Ω", hyva: "" }
];
const SEGMENTS = [["oikea_kasi", "Oikea käsi"], ["vasen_kasi", "Vasen käsi"], ["keskivartalo", "Keskivartalo"], ["oikea_jalka", "Oikea jalka"], ["vasen_jalka", "Vasen jalka"]];
const SEGVALS = [["rasvaprosentti", "Rasva %", "%"], ["rasvamassa", "Rasva", "kg"], ["rasvaton_massa", "Rasvaton", "kg"], ["lihasmassa", "Lihas", "kg"], ["suhde_pros", "Suhde", "%"]];
const metricOf = k => METRICS.find(m => m.k === k) || (S.meta?.omatMittarit || []).find(m => m.k === k) || { k, n: k.replace(/_/g, " "), u: "", hyva: "" };
const fmtN = (v, d = 1) => v == null ? "–" : (Math.round(v * 10 ** d) / 10 ** d).toString().replace(".", ",");
// Mittauspisteet yhdelle mittarille: kehonkoostumusmittaukset + painolle myös punnitukset.
function seriesFor(k) {
  const pts = S.mittaukset.filter(m => m.arvot?.[k] != null).map(m => ({ pvm: m.pvm, v: m.arvot[k], laite: m.laite || "", id: m.id, src: "mittaus" }));
  if (k === "paino") S.paino.forEach(p => pts.push({ pvm: p.pvm, v: p.paino_kg, laite: "punnitus", id: p.id, src: "punnitus" }));
  return pts.filter(p => p.pvm).sort((a, b) => a.pvm.localeCompare(b.pvm));
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
function deltaInfo(k) {
  const pts = seriesFor(k); if (pts.length < 2) return null;
  const last = pts[pts.length - 1], prev = pts[pts.length - 2], m = metricOf(k);
  const d = last.v - prev.v, sameDevice = !!m.ver || last.laite === prev.laite || last.src === "punnitus" || prev.src === "punnitus";
  const good = !m.hyva || Math.abs(d) < 1e-9 ? "neutral" : ((d > 0) === (m.hyva === "up") ? "good" : "bad");
  return { d, prev, last, good, sameDevice, days: daysBetween(prev.pvm, last.pvm) };
}
const ago = days => days < 45 ? `${days} pv` : days < 600 ? `${Math.round(days / 30.4)} kk` : `${(days / 365).toFixed(1).replace(".", ",")} v`;
function sparkSVG(pts, w = 120, h = 34) {
  if (pts.length < 2) return "";
  const t0 = Date.parse(pts[0].pvm), t1 = Date.parse(pts[pts.length - 1].pvm) || t0 + 1;
  const vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.15 || 1;
  const X = p => 4 + (w - 8) * ((Date.parse(p.pvm) - t0) / ((t1 - t0) || 1)), Y = v => h - 4 - (h - 8) * ((v - (lo - pad)) / ((hi + pad) - (lo - pad)));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const L = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" class="sl"/><circle cx="${X(L).toFixed(1)}" cy="${Y(L.v).toFixed(1)}" r="3.5" class="sd"/></svg>`;
}
function trendChart(k) {
  const pts = seriesFor(k), m = metricOf(k);
  if (pts.length < 2) return `<p class="muted small">Tarvitaan vähintään kaksi mittausta trendin piirtämiseen.</p>`;
  const W = 340, H = 180, L = 40, R = 12, T = 14, B = 26;
  const t0 = Date.parse(pts[0].pvm), t1 = Date.parse(pts[pts.length - 1].pvm);
  const vs = pts.map(p => p.v); let lo = Math.min(...vs), hi = Math.max(...vs); const pad = (hi - lo) * 0.12 || Math.max(1, hi * 0.02); lo -= pad; hi += pad;
  const X = p => L + (W - L - R) * ((Date.parse(p.pvm) - t0) / ((t1 - t0) || 1)), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const yrs = []; for (let y = new Date(t0).getFullYear() + 1; y <= new Date(t1).getFullYear(); y++) yrs.push(y);
  let g = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.n)} ajan yli">`;
  ticks.forEach(v => g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 6}" y="${Y(v) + 4}" class="ax" text-anchor="end">${fmtN(v, hi - lo < 5 ? 1 : 0)}</text>`);
  yrs.forEach(y => { const x = L + (W - L - R) * ((Date.parse(`${y}-01-01`) - t0) / ((t1 - t0) || 1)); g += `<text x="${x}" y="${H - 8}" class="ax" text-anchor="middle">${y}</text>`; });
  // viiva: katkoviiva kun laite vaihtuu (ei vertailukelpoinen suoraan)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], same = !!m.ver || a.laite === b.laite || a.src === "punnitus" || b.src === "punnitus";
    g += `<line x1="${X(a)}" y1="${Y(a.v)}" x2="${X(b)}" y2="${Y(b.v)}" class="tl ${same ? "" : "dash"}"/>`;
  }
  pts.forEach((p, i) => g += `<circle cx="${X(p)}" cy="${Y(p.v)}" r="${p.src === "punnitus" ? 3 : 5}" class="tp ${p.src}" data-i="${i}"/><circle cx="${X(p)}" cy="${Y(p.v)}" r="16" class="hit" data-i="${i}"/>`);
  const last = pts[pts.length - 1];
  g += `<text x="${Math.min(X(last), W - R)}" y="${Y(last.v) - 10}" class="lbl" text-anchor="end">${fmtN(last.v)} ${esc(m.u)}</text></svg>`;
  return `<div class="chartwrap" data-k="${k}">${g}<div class="tip" hidden></div></div>
    <p class="muted" style="font-size:13px">${!m.ver && pts.some((p, i) => i && p.laite !== pts[i - 1].laite && p.src !== "punnitus" && pts[i - 1].src !== "punnitus") ? "Katkoviiva = eri laite, vertaile suuntaa-antavasti. " : ""}${k === "paino" ? "Pienet pisteet = punnitukset, isot = kehonkoostumusmittaukset." : ""}</p>`;
}
function bindChart(root) {
  root.querySelectorAll(".chartwrap").forEach(w => {
    const pts = seriesFor(w.dataset.k), m = metricOf(w.dataset.k), tip = w.querySelector(".tip");
    w.querySelectorAll(".hit").forEach(c => c.onclick = () => {
      const p = pts[+c.dataset.i]; tip.hidden = false;
      tip.innerHTML = `<b>${fmtN(p.v)} ${esc(m.u)}</b><br>${fiDate(p.pvm)} · ${esc(p.src === "punnitus" ? "punnitus" : p.laite || "mittaus")}`;
      const r = w.getBoundingClientRect(), cr = c.getBoundingClientRect();
      tip.style.left = Math.max(4, Math.min(r.width - 150, cr.left - r.left - 60)) + "px"; tip.style.top = Math.max(0, cr.top - r.top - 54) + "px";
    });
  });
}
function trendCardInner(k) {
  const sm = metricOf(k);
  return `${trendChart(k)}${sm.info ? `<p class="muted" style="font-size:13px">${esc(sm.info)}</p>` : ""}`;
}
function selectMetric(k, fromChip) {
  S.bodyMetric = k;
  $view.querySelectorAll("[data-metric]").forEach(el => { const on = el.dataset.metric === k; el.classList.toggle("sel", on); if (el.classList.contains("chip")) el.setAttribute("aria-pressed", on); });
  const card = document.getElementById("trendcard");
  if (card) { card.innerHTML = trendCardInner(k); bindChart(card); }
  const chip = document.querySelector(`#tchips [data-metric="${k}"]`), row = document.getElementById("tchips");
  if (chip && row) {
    // tuo valittu siru näkyviin vaakasuunnassa ilman, että sivu hyppää pystysuunnassa
    const cr = chip.getBoundingClientRect(), rr = row.getBoundingClientRect();
    if (cr.left < rr.left + 20 || cr.right > rr.right - 20) row.scrollTo({ left: row.scrollLeft + (cr.left - rr.left) - (rr.width - cr.width) / 2, behavior: "smooth" });
  }
  if (!fromChip && card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
const GROUPS = [["koostumus", "Koostumus"], ["terveys", "Terveys ja indeksit"], ["muu", "Muut"]];
const GROUP_OF = { rasvaton_massa: "koostumus", kokonaisvesi: "koostumus", vesiprosentti: "koostumus", luumassa: "koostumus",
  viskeraali_taso: "terveys", viskeraali_ala: "terveys", bmi: "terveys", rasvamassaindeksi: "terveys", perusaineenvaihdunta: "terveys",
  metabolinen_ika: "terveys", kehon_ika: "terveys", kokonaispisteet: "terveys", suositeltu_paino: "terveys", impedanssi: "muu" };
function relAgo(pvm) {
  const d = daysBetween(pvm, todayISO());
  if (d <= 0) return "tänään"; if (d === 1) return "eilen"; if (d < 31) return `${d} pv sitten`;
  const mo = Math.round(d / 30.4); if (mo < 12) return `${mo} kk sitten`;
  const y = Math.floor(mo / 12), r = mo % 12; return `${y} v${r ? " " + r + " kk" : ""} sitten`;
}
function measurementCard(mm, older) {
  const a = mm.arvot || {};
  const muscleK = a.luurankolihas != null ? "luurankolihas" : "lihasmassa";
  const keyCols = [["paino", "Paino"], ["rasvaprosentti", "Rasvaprosentti"], ["rasvamassa", "Rasvamassa"], [muscleK, muscleK === "luurankolihas" ? "Luurankolihas" : "Lihasmassa"]];
  const cell = ([k, label]) => {
    const m = metricOf(k), v = a[k];
    if (v == null) return `<div class="kc none"><div class="kt"><div class="kl">${label}</div><div class="kd">ei mitattu</div></div><div class="kvv">–</div></div>`;
    const prev = older.find(o => o.arvot?.[k] != null);
    let dl = "";
    if (prev) {
      const d = v - prev.arvot[k], other = !m.ver && (prev.laite || "") !== (mm.laite || "");
      const good = !m.hyva || Math.abs(d) < 1e-9 ? "neutral" : ((d > 0) === (m.hyva === "up") ? "good" : "bad");
      const arrow = Math.abs(d) < 1e-9 ? "→" : d > 0 ? "↑" : "↓";
      dl = `<div class="kd ${good}">${other ? `<span class="diffdev" title="eri laite">≈</span>` : ""}${arrow} ${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmtN(Math.abs(d))}</div>`;
    }
    return `<div class="kc"><div class="kt"><div class="kl">${label}</div>${dl}</div><div class="kvv">${fmtN(v)}<span>${esc(m.u)}</span></div></div>`;
  };
  const shown = new Set(["paino", "rasvaprosentti", "rasvamassa", muscleK]);
  const rest = Object.keys(a).filter(k => !shown.has(k));
  const grouped = GROUPS.map(([g, title]) => [title, rest.filter(k => (GROUP_OF[k] || (METRICS.some(x => x.k === k) ? "koostumus" : "muu")) === g)]).filter(([, ks]) => ks.length);
  const segs = mm.segmentit || {};
  const segVal = sg => { const o = segs[sg] || {}; for (const c of ["rasvaton_massa", "lihasmassa", "rasvamassa"]) if (o[c] != null) return [o[c], c]; return null; };
  const pair = (l, r, title) => {
    const L = segVal(l), R = segVal(r); if (!L && !R) return "";
    const mx = Math.max(L?.[0] || 0, R?.[0] || 0) || 1, bal = L && R ? Math.round(100 * Math.min(L[0], R[0]) / Math.max(L[0], R[0])) : null;
    const fatL = segs[l]?.rasvaprosentti, fatR = segs[r]?.rasvaprosentti;
    return `<div class="seg"><div class="seg-h"><b>${title}</b>${bal != null ? `<span class="muted">tasapaino ${bal} %</span>` : ""}</div>
      <div class="seg-bars"><div class="sb l"><span style="width:${((L?.[0] || 0) / mx * 100).toFixed(0)}%"></span></div><div class="sb r"><span style="width:${((R?.[0] || 0) / mx * 100).toFixed(0)}%"></span></div></div>
      <div class="seg-v"><span>O ${L ? fmtN(L[0]) : "–"} kg</span><span>V ${R ? fmtN(R[0]) : "–"} kg</span></div>
      ${fatL != null || fatR != null ? `<div class="seg-v muted"><span>rasva ${fmtN(fatL)} %</span><span>rasva ${fmtN(fatR)} %</span></div>` : ""}</div>`;
  };
  const core = segVal("keskivartalo");
  const segHtml = Object.keys(segs).length ? `<div class="grp"><div class="grp-t">Segmentit · ${esc(segVal("oikea_kasi")?.[1] === "lihasmassa" ? "lihasmassa" : "rasvaton massa")}</div>
      ${pair("oikea_kasi", "vasen_kasi", "Kädet")}${pair("oikea_jalka", "vasen_jalka", "Jalat")}
      ${core ? `<div class="kvrow"><span>Keskivartalo</span><b>${fmtN(core[0])} kg${segs.keskivartalo?.rasvaprosentti != null ? ` · rasva ${fmtN(segs.keskivartalo.rasvaprosentti)} %` : ""}</b></div>` : ""}</div>` : "";
  const nMore = rest.length + (Object.keys(segs).length ? 1 : 0);
  return `<details class="card mcard" data-id="${mm.id}" ${S.openM?.[mm.id] ? "open" : ""}><summary>
      <div class="mhead"><div><b>${fiDate(mm.pvm)}</b> <span class="muted">· ${relAgo(mm.pvm)}</span></div><span class="badge dev">${esc(mm.laite || "Mittaus")}</span></div>
      <div class="kgrid">${keyCols.map(cell).join("")}</div>
      <div class="more"><span class="m-o">${nMore ? `Kaikki arvot (${rest.length}${Object.keys(segs).length ? " + segmentit" : ""})` : "Lisätiedot"}</span><span class="m-c">Piilota</span></div></summary>
    <div class="mbody">
      ${grouped.map(([title, ks]) => `<div class="grp"><div class="grp-t">${title}</div>${ks.map(k => `<div class="kvrow"><span>${esc(metricOf(k).n)}</span><b>${fmtN(a[k])} ${esc(metricOf(k).u)}</b></div>`).join("")}</div>`).join("")}
      ${segHtml}
      ${mm.huomio ? `<div class="grp"><div class="grp-t">Huomio</div><p class="muted small" style="margin:0">${esc(mm.huomio)}</p></div>` : ""}
      <div class="mact"><button class="small" data-editm="${mm.id}">Muokkaa</button><button class="small ghost danger-t" data-delm="${mm.id}">Poista</button></div>
    </div></details>`;
}
function renderBody() {
  if (S.mode === "mittaus") return renderMeasurementForm();
  const latest = [...S.mittaukset].sort((a, b) => b.pvm.localeCompare(a.pvm))[0];
  const muscleKey = latest?.arvot?.luurankolihas != null ? "luurankolihas" : "lihasmassa";
  const tiles = ["paino", "rasvaprosentti", "rasvamassa", muscleKey];
  if (!S.bodyMetric) S.bodyMetric = "rasvaprosentti";
  let h = `<h1>Keho</h1>`;
  h += `<div class="tiles">` + tiles.map(k => {
    const pts = seriesFor(k), m = metricOf(k), last = pts[pts.length - 1], di = deltaInfo(k);
    if (!last) return `<div class="tile"><div class="tl-l">${esc(m.n)}</div><div class="tl-v">–</div></div>`;
    return `<button class="tile ${S.bodyMetric === k ? "sel" : ""}" data-metric="${k}"><div class="tl-l">${esc(m.n.replace(" (Tanita)", ""))}</div>
      <div class="tl-v">${fmtN(last.v)}<span> ${esc(m.u)}</span></div>
      ${di ? `<div class="tl-d ${di.good}">${di.d > 0 ? "+" : di.d < 0 ? "−" : "±"}${fmtN(Math.abs(di.d))} ${esc(m.u)} <span>/ ${ago(di.days)}${di.sameDevice ? "" : " · eri laite"}</span></div>` : `<div class="tl-d"><span>${fiDate(last.pvm)}</span></div>`}
      ${sparkSVG(pts)}</button>`;
  }).join("") + `</div>`;
  // trendi
  const avail = [...METRICS, ...(S.meta?.omatMittarit || [])].filter(m => seriesFor(m.k).length >= 2);
  h += `<h2>Trendi</h2><div class="chips" id="tchips">${avail.map(m => `<button class="chip ${S.bodyMetric === m.k ? "sel" : ""}" data-metric="${m.k}" aria-pressed="${S.bodyMetric === m.k}">${esc(m.n)}</button>`).join("")}</div>`;
  h += `<div class="card" id="trendcard">${trendCardInner(S.bodyMetric)}</div>`;
  // mittaukset: aikajana, aina samat päämittarit samassa järjestyksessä, muutos edelliseen, loput avattavissa
  const ms = [...S.mittaukset].sort((a, b) => b.pvm.localeCompare(a.pvm));
  h += `<div class="row space sec-head"><div><h2>Kehonkoostumus</h2><div class="muted" style="font-size:14px">${ms.length} mittausta${ms.length ? ` · ${fiDate(ms[ms.length - 1].pvm)}–${fiDate(ms[0].pvm)}` : ""}</div></div><button class="small primary" id="addm">+ Mittaus</button></div>`;
  h += ms.length ? `<div class="timeline">${ms.map((mm, i) => measurementCard(mm, ms.slice(i + 1))).join("")}</div>
    <p class="muted foot">Muutos verrattuna edelliseen mittaukseen, jossa sama arvo on mitattu. <span class="diffdev">≈</span> = eri laite, suuntaa-antava.</p>`
    : `<div class="card empty"><p>Ei vielä mittauksia.</p><p class="muted small">Lisää ensimmäinen kehonkoostumusmittaus, niin näet täällä muutokset ja trendit.</p></div>`;
  // punnitukset
  h += `<h2>Punnitukset</h2><div class="card"><div class="row"><input id="wkg" inputmode="decimal" placeholder="kg"><input id="wd" type="date" value="${todayISO()}"></div>
    <button class="primary block" id="wadd" style="margin-top:10px">Tallenna punnitus</button></div>`;
  h += S.paino.slice(0, S.wAll ? 1e9 : 8).map(p => `<div class="list-item row space"><span>${fiDate(p.pvm)}</span><b>${fmtKg(p.paino_kg)} kg</b>${p.lahde === "sovellus" ? `<button class="ghost small" data-del="${p.id}">Poista</button>` : `<span class="badge vanha">Vanha</span>`}</div>`).join("");
  if (!S.wAll && S.paino.length > 8) h += `<button class="ghost block" id="wall">Näytä kaikki (${S.paino.length})</button>`;
  $view.innerHTML = h;
  // Mittarin vaihto päivittää vain trendikortin: valikon vieritys ja sivun paikka säilyvät.
  $view.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => selectMetric(b.dataset.metric, b.classList.contains("chip")));
  const tc = document.getElementById("tchips");
  if (tc) { tc.scrollLeft = S.chipScroll || 0; tc.addEventListener("scroll", () => { S.chipScroll = tc.scrollLeft; }, { passive: true }); }
  bindChart($view);
  $view.querySelectorAll("details.mcard").forEach(d => d.ontoggle = () => { S.openM = S.openM || {}; S.openM[d.dataset.id] = d.open; });
  document.getElementById("addm").onclick = () => { S.mode = "mittaus"; S.editM = null; render(); scrollTo(0, 0); };
  $view.querySelectorAll("[data-editm]").forEach(b => b.onclick = () => { S.mode = "mittaus"; S.editM = b.dataset.editm; render(); scrollTo(0, 0); });
  $view.querySelectorAll("[data-delm]").forEach(b => b.onclick = () => { if (confirm("Poistetaanko mittaus pysyvästi?")) deleteDoc(userDoc("mittaukset", b.dataset.delm)); });
  const wa = document.getElementById("wall"); if (wa) wa.onclick = () => { S.wAll = true; render(); };
  document.getElementById("wadd").onclick = () => {
    const kg = num(document.getElementById("wkg").value), d = document.getElementById("wd").value;
    if (!kg || kg < 30 || kg > 250) { toast("Tarkista paino"); return; }
    const id = uid(); save("kehonpaino", id, { pvm: d, paino_kg: kg, huomio: "", lahde: "sovellus", kirjattu: nowISO() }); S._typing = false; toast("Tallennettu");
  };
  $view.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { if (confirm("Poistetaanko punnitus?")) deleteDoc(userDoc("kehonpaino", b.dataset.del)); });
}
function renderMeasurementForm() {
  const ed = S.editM ? S.mittaukset.find(m => m.id === S.editM) : null;
  const f = S.mform && S.mform.id === (ed?.id || "uusi") ? S.mform : (S.mform = { id: ed?.id || "uusi", pvm: ed?.pvm || todayISO(), laite: ed?.laite || "", huomio: ed?.huomio || "",
    arvot: { ...(ed?.arvot || {}) }, segmentit: JSON.parse(JSON.stringify(ed?.segmentit || {})), extra: Object.keys(ed?.arvot || {}).filter(k => !["paino", "rasvaprosentti", "rasvamassa"].includes(k)) });
  const devices = [...new Set(S.mittaukset.map(m => m.laite).filter(Boolean))];
  const field = k => { const m = metricOf(k); return `<div class="mf"><label>${esc(m.n)}${m.u ? ` (${esc(m.u)})` : ""}</label><input inputmode="decimal" data-k="${k}" value="${f.arvot[k] == null ? "" : fmtN(f.arvot[k], 3)}"></div>`; };
  let h = `<div id="mform"><div class="row space" style="margin-top:4px"><button class="ghost small" id="mback" style="padding-left:0">‹ Takaisin</button></div>
    <h1>${ed ? "Muokkaa mittausta" : "Uusi mittaus"}</h1><p class="muted small">Syötä ne arvot, jotka laite antoi. Tyhjät kentät jätetään pois.</p>
    <div class="row"><div style="flex:1"><label>Päivä</label><input type="date" id="mpvm" value="${f.pvm}"></div>
    <div style="flex:1.3"><label>Laite tai paikka</label><input id="mlaite" list="mlaitteet" placeholder="esim. Tanita, Puhti" value="${esc(f.laite)}"><datalist id="mlaitteet">${devices.map(d => `<option value="${esc(d)}">`).join("")}</datalist></div></div>
    <div class="mgrid">${["paino", "rasvaprosentti", "rasvamassa"].map(field).join("")}${f.extra.map(field).join("")}</div>
    <label>Lisää arvo</label><select id="madd"><option value="">Valitse mittari…</option>${METRICS.filter(m => !["paino", "rasvaprosentti", "rasvamassa"].includes(m.k) && !f.extra.includes(m.k)).map(m => `<option value="${m.k}">${esc(m.n)}</option>`).join("")}<option value="__oma">Muu mittari (oma nimi)…</option></select>
    <details class="card" id="msegs" ${(Object.keys(f.segmentit).length || f.segOpen) ? "open" : ""}><summary><b>Segmentit</b> <span class="muted small">(valinnainen)</span></summary>
      <div class="segt"><table><tr><th></th>${SEGVALS.map(([, n, u]) => `<th>${n}<br><small>${u}</small></th>`).join("")}</tr>
      ${SEGMENTS.map(([s, n]) => `<tr><td>${n}</td>${SEGVALS.map(([c]) => `<td><input inputmode="decimal" data-seg="${s}" data-c="${c}" value="${f.segmentit[s]?.[c] == null ? "" : fmtN(f.segmentit[s][c], 2)}"></td>`).join("")}</tr>`).join("")}</table></div></details>
    <label>Huomio</label><textarea id="mnote" placeholder="esim. aamulla ennen syömistä">${esc(f.huomio)}</textarea>
    <button class="primary block" id="msave" style="margin-top:14px">Tallenna mittaus</button></div>`;
  $view.innerHTML = h;
  const back = () => { S.mode = null; S.mform = null; S.editM = null; S._typing = false; render(); };
  document.getElementById("mback").onclick = back;
  document.getElementById("msegs").ontoggle = e => { f.segOpen = e.target.open; };
  document.getElementById("mform").addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.k) f.arvot[t.dataset.k] = num(t.value);
    else if (t.dataset.seg) { (f.segmentit[t.dataset.seg] ||= {})[t.dataset.c] = num(t.value); }
    else if (t.id === "mpvm") f.pvm = t.value; else if (t.id === "mlaite") f.laite = t.value; else if (t.id === "mnote") f.huomio = t.value;
  });
  document.getElementById("madd").onchange = e => {
    let k = e.target.value; if (!k) return;
    if (k === "__oma") {
      const raw = (prompt("Mittarin nimi ja yksikkö, esim. Vyötärö cm") || "").trim(); if (!raw) { e.target.value = ""; return; }
      const mm = raw.match(/^(.*?)\s*\(?\s*(cm|mm|kg|g|%|kcal|kJ|v|cm²|kg\/m²|l|bpm|Ω)\s*\)?$/i);
      const n = (mm ? mm[1] : raw).trim() || raw, u = mm ? mm[2] : "";
      k = n.toLowerCase().replace(/[^a-zåäö0-9]+/g, "_").replace(/^_|_$/g, "") || "oma";
      if (!metricOf(k).n || !METRICS.some(x => x.k === k)) saveMeta({ omatMittarit: [...(S.meta?.omatMittarit || []).filter(x => x.k !== k), { k, n, u, hyva: "" }] });
    }
    if (!f.extra.includes(k)) f.extra.push(k); S._typing = false; render();
  };
  document.getElementById("msave").onclick = () => {
    const arvot = {}; Object.entries(f.arvot).forEach(([k, v]) => { if (v != null && Number.isFinite(v)) arvot[k] = v; });
    const segmentit = {}; Object.entries(f.segmentit).forEach(([s, o]) => { const c = {}; Object.entries(o || {}).forEach(([k, v]) => { if (v != null && Number.isFinite(v)) c[k] = v; }); if (Object.keys(c).length) segmentit[s] = c; });
    if (!Object.keys(arvot).length) { toast("Syötä vähintään yksi arvo"); return; }
    if (!f.pvm) { toast("Valitse päivä"); return; }
    const id = ed?.id || uid();
    save("mittaukset", id, { pvm: f.pvm, laite: f.laite.trim(), arvot, segmentit, huomio: f.huomio.trim(), lahde: ed?.lahde || "sovellus", kirjattu: ed?.kirjattu || nowISO(), muokattu: nowISO() });
    toast("Mittaus tallennettu"); back();
  };
}

// ----- Data: vienti ja tuonti -----
const CSV_COLS = ["pvm", "ohjelma", "jakso", "viikko", "treeni", "liike", "sarja", "tyyppi", "tavoite", "paino_kg", "toistot", "aika_s", "huomio", "kirjattu", "id", "lahde", "alkuperainen", "varmuus", "perusliike", "valine", "treeni_alku", "treeni_loppu", "jalkikirjaus"];
const csvCell = v => { if (v == null) return ""; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (cols, rows) => "﻿" + [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
function flatRows() {
  const out = [];
  const ks = [...S.kerrat].filter(k => k.tila !== "kesken").sort((a, b) => sessionSortKey(a).localeCompare(sessionSortKey(b)));
  for (const k of ks) for (const s of [...(k.sarjat || [])].sort((a, b) => (a.liikeIndex ?? 0) - (b.liikeIndex ?? 0) || a.sarja - b.sarja)) {
    const l = k.liikkeet?.[s.liikeIndex];
    out.push({ pvm: k.pvm, ohjelma: k.ohjelma, jakso: k.jakso, viikko: k.viikko, treeni: k.treeni, liike: s.liike, sarja: s.sarja, tyyppi: s.tyyppi,
      tavoite: s.tavoite, paino_kg: s.paino_kg, toistot: s.toistot, aika_s: s.aika_s, huomio: [s.huomio, l?.huomio].filter(Boolean).join("; "),
      kirjattu: s.kirjattu || "", id: s.id, lahde: k.lahde === "sovellus" ? "sovellus" : (s.lahde || k.lahde), alkuperainen: s.alkuperainen || "", varmuus: s.varmuus || "varma",
      perusliike: s.perusliike ?? splitEquip(s.liike).perusliike, valine: s.valine ?? splitEquip(s.liike).valine,
      treeni_alku: k.alku || "", treeni_loppu: k.loppu || "", jalkikirjaus: k.lahde === "sovellus" ? (s.jalkikirjaus ? 1 : 0) : "" });
  }
  return out;
}
function sessionRows() {
  return [...S.kerrat].sort((a, b) => sessionSortKey(a).localeCompare(sessionSortKey(b))).map(k => ({
    id: k.id, pvm: k.pvm, ohjelma: k.ohjelma, jakso: k.jakso, viikko: k.viikko, treeni: k.treeni, tila: k.tila, alku: k.alku || "", loppu: k.loppu || "",
    sarjoja: (k.sarjat || []).filter(s => s.tyyppi !== "merkinta").length, korvatut: (k.liikkeet || []).filter(l => l.nimi !== l.suunniteltu).map(l => `${l.suunniteltu} → ${l.nimi}`).join("; "),
    ohitetut: (k.liikkeet || []).filter(l => l.ohitettu).map(l => l.nimi).join("; "), huomio: k.huomio || "", lahde: k.lahde,
    tyyppi: k.lahde === "sovellus" ? (k.tyyppi || "ohjelma") : "", pohja_id: k.pohjaId || "" }));
}
const README = () => `# Treenidata – LUEMINUT

Viety ${fiDate(todayISO())} sovelluksesta Treeni (versio ${VERSION}). Omistaja: Otto.

Tiedostot:
- sarjat.csv – yksi rivi per sarja. Tärkein tiedosto.
- treenikerrat.csv – yksi rivi per treenikerta (tila: tehty, osittain, valiin = väliin jätetty).
- kehonpaino.csv – punnitukset (pvm, paino_kg).
- salikaynnit.csv – vanhat käyntimerkinnät 2023–2024 ilman sarjoja.
- kehonkoostumus.csv – kehonkoostumusmittaukset pitkänä taulukkona: yksi rivi per mitattu arvo (pvm, laite, mittari, nimi, arvo, yksikko, segmentti). Eri laitteet antavat eri mittareita; vertaa saman mittarin arvoja. Tanitan "lihasmassa" ja InBody-tyyppisten laitteiden "luurankolihas" ovat eri suureita. Segmentti: oikea_kasi, vasen_kasi, keskivartalo, oikea_jalka, vasen_jalka (tyhjä = koko keho); suhde_pros = segmentin rasvaton massa suhteessa viitearvoon.

Muoto: CSV (RFC 4180), pilkkuerotin, desimaalipiste, UTF-8 (BOM), päivämäärät VVVV-KK-PP.

sarjat.csv-sarakkeet:
- pvm: treenipäivä. Tyhjä = päivä ei tiedossa (vanhat merkinnät, joissa oli vain viikko); järjestys selviää ohjelma- ja viikko-sarakkeista.
- ohjelma, jakso, viikko (ohjelmaviikko), treeni: mihin ohjelmaan ja treeniin sarja kuuluu.
- liike: liikkeen yhtenäistetty nimi. "kp." = käsipainoilla. "Ylätalja/leuat": negatiivinen paino = avustettu leuanveto.
- sarja: järjestysnumero liikkeen sisällä. tyyppi: tyo, dropsetti, restpause tai merkinta (pelkkä huomio ilman sarjaa).
- tavoite: ohjelman tavoite, esim. 3x10 tai 12,10,8,6 tai 3* (2×10 + rest-pause 15).
- paino_kg: kuorma kg. Tyhjä = kehonpaino. Negatiivinen = avustettu.
- toistot, aika_s: toistot ja pitoaika sekunteina.
- huomio: vapaa kommentti. kirjattu: tallennushetki.
- lahde: sovellus = kirjattu sovelluksella; vanha_excel / vanha_muistio = harmonisoitu vanhoista merkinnöistä.
- alkuperainen: vanhoissa riveissä alkuperäinen merkintä sellaisenaan. varmuus: varma tai tulkittu (vanhan merkinnän tulkinta epävarma).
- perusliike, valine (v0.2.0 alkaen): liikkeen nimestä johdettu perusliike ja väline (tanko, kp, laite, smith, talja, jalkaprässi, scott-penkki; tyhjä = ei mainittu tai kehonpaino). Painot eivät ole vertailukelpoisia eri välineiden välillä (kp = paino per käsi).
- treeni_alku, treeni_loppu: treenikerran alku- ja loppuhetki (tyhjä vanhoissa).
- jalkikirjaus: 1 = sarja kuitattiin jälkikäteen (alle 15 s edellisestä kuittauksesta tai valmiin treenin muokkauksena), 0 = kirjattu reaaliajassa, tyhjä = vanha data.

treenikerrat.csv: tyyppi = ohjelma (ohjelman mukainen) tai oma (vapaa treeni, ei siirrä ohjelman etenemistä; ohjelma = "Oma", jakso ja viikko tyhjät). pohja_id = treeni, jota käytettiin oman treenin pohjana.
Uudet sarakkeet lisätään aina tiedoston loppuun, joten vanhojen vientien sarakkeet säilyvät samoilla paikoilla.
`;
function measurementRows() {
  const out = [];
  [...S.mittaukset].sort((a, b) => a.pvm.localeCompare(b.pvm)).forEach(m => {
    Object.entries(m.arvot || {}).forEach(([k, v]) => out.push({ pvm: m.pvm, laite: m.laite, mittari: k, nimi: metricOf(k).n, arvo: v, yksikko: metricOf(k).u, segmentti: "", huomio: m.huomio, lahde: m.lahde, id: m.id }));
    Object.entries(m.segmentit || {}).forEach(([sg, o]) => Object.entries(o).forEach(([k, v]) => {
      const sv = SEGVALS.find(x => x[0] === k); out.push({ pvm: m.pvm, laite: m.laite, mittari: k, nimi: sv ? sv[1] : k, arvo: v, yksikko: sv ? sv[2] : "", segmentti: sg, huomio: m.huomio, lahde: m.lahde, id: m.id });
    }));
  });
  return out;
}
async function shareFiles(files) {
  const fs = files.map(f => new File([f.data], f.name, { type: f.type }));
  if (navigator.canShare && navigator.canShare({ files: fs })) {
    try { await navigator.share({ files: fs, title: "Treenidata" }); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  for (const f of fs) { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await new Promise(r => setTimeout(r, 400)); }
  return true;
}
function renderData() {
  const nApp = S.kerrat.filter(k => k.lahde === "sovellus").length, nOld = S.kerrat.length - nApp;
  $view.innerHTML = `<h1>Data</h1>
    <div class="card stack"><h3>Vie varmuuskopio</h3>
      <p class="muted small">Tallenna tiedostot iCloud Driveen, esim. kansioon Treenit. Tiedostot aukeavat Excelissä ja Numbersissa, ja tekoäly osaa lukea ne LUEMINUT-tiedoston avulla.</p>
      <p class="small">Edellinen vienti: <b>${S.meta?.viimeVienti ? fiDate(S.meta.viimeVienti.slice(0, 10)) : "ei vielä"}</b></p>
      <button class="primary block" id="exp">Vie kaikki (CSV + LUEMINUT)</button>
      <button class="block" id="expjson">Vie täysi varmuuskopio (JSON)</button></div>
    <div class="card stack"><h3>Tuo</h3>
      <p class="muted small">Käyttöönottopaketti tai JSON-varmuuskopio. Olemassa olevat tiedot säilyvät, samat tunnisteet päivitetään.</p>
      <input type="file" id="imp" accept=".json,application/json"></div>
    <div class="card small"><p>Sovelluksessa: ${nApp} kirjattua treenikertaa, ${nOld} vanhaa, ${S.paino.length} punnitusta, ${S.mittaukset.length} kehonkoostumusmittausta, ${S.kaynnit.length} vanhaa käyntiä.</p>
      <p class="muted">Versio ${VERSION} · ${esc(S.user.email)}</p><button class="ghost" id="logout">Kirjaudu ulos</button></div>`;
  document.getElementById("exp").onclick = async () => {
    const d = todayISO();
    const ok = await shareFiles([
      { name: `sarjat_${d}.csv`, type: "text/csv", data: toCSV(CSV_COLS, flatRows()) },
      { name: `treenikerrat_${d}.csv`, type: "text/csv", data: toCSV(["id", "pvm", "ohjelma", "jakso", "viikko", "treeni", "tila", "alku", "loppu", "sarjoja", "korvatut", "ohitetut", "huomio", "lahde", "tyyppi", "pohja_id"], sessionRows()) },
      { name: `kehonpaino_${d}.csv`, type: "text/csv", data: toCSV(["pvm", "paino_kg", "huomio", "lahde", "id"], [...S.paino].reverse()) },
      { name: `kehonkoostumus_${d}.csv`, type: "text/csv", data: toCSV(["pvm", "laite", "mittari", "nimi", "arvo", "yksikko", "segmentti", "huomio", "lahde", "id"], measurementRows()) },
      { name: `salikaynnit_${d}.csv`, type: "text/csv", data: toCSV(["pvm", "kellonaika", "tila", "huomio", "lahde", "id"], [...S.kaynnit].sort((a, b) => a.pvm.localeCompare(b.pvm))) },
      { name: `LUEMINUT.md`, type: "text/markdown", data: README() }]);
    if (ok) { saveMeta({ viimeVienti: nowISO() }); toast("Vienti tehty"); }
  };
  document.getElementById("expjson").onclick = () => shareFiles([{ name: `treeni_varmuuskopio_${todayISO()}.json`, type: "application/json",
    data: JSON.stringify({ muoto: "treeni-varmuuskopio-1", viety: nowISO(), ohjelmat: Object.values(S.ohjelmat), meta: S.meta, treenikerrat: S.kerrat, kehonpaino: S.paino, kaynnit: S.kaynnit, mittaukset: S.mittaukset }) }]);
  document.getElementById("imp").onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { const n = await importPackage(JSON.parse(await file.text())); toast(`Tuotu ${n} kohdetta`, 4000); }
    catch (err) { console.error(err); toast("Tuonti epäonnistui: " + err.message, 5000); }
  };
  document.getElementById("logout").onclick = () => { if (confirm("Kirjaudutaanko ulos?")) signOut(auth); };
}
async function importPackage(pkg) {
  const ops = [];
  (pkg.ohjelmat || []).forEach(p => ops.push(["ohjelmat", p.id, p]));
  (pkg.treenikerrat || []).forEach(({ id, ...k }) => ops.push(["treenikerrat", id, k]));
  (pkg.kehonpaino || []).forEach(({ id, ...k }) => ops.push(["kehonpaino", id, k]));
  (pkg.kaynnit || []).forEach(({ id, ...k }) => ops.push(["kaynnit", id, k]));
  (pkg.mittaukset || []).forEach(({ id, ...k }) => ops.push(["mittaukset", id, k]));
  if (pkg.meta && Object.keys(pkg.meta).length && !S.meta?.aloitus) ops.push(["meta", "tila", pkg.meta]);
  if (!ops.length) throw new Error("Tiedostossa ei ollut tuotavaa");
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([c, id, data]) => b.set(userDoc(c, id), JSON.parse(JSON.stringify(data))));
    await b.commit();
  }
  if (!S.meta?.ohjelmaId && pkg.ohjelmat?.[0]) saveMeta({ ohjelmaId: pkg.ohjelmat[0].id });
  return ops.length;
}

// ---------- offline-välimuisti ----------
// Päivitykset: sw.js haetaan aina palvelimelta, ja uutta versiota tarkistetaan, kun sovellus palaa taustalta (iOS ei lataa PWA:ta uudelleen).
// Kun uusi versio ottaa ohjat, sivu ladataan uudelleen – paitsi kesken treenin tai lomakkeen, jolloin näytetään ilmoitus.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || S._reloading) return;
    const busy = S.editId || S.mode || S._typing || S.timer || S.celebrating;
    if (!busy) { S._reloading = true; location.reload(); return; }
    toast("Uusi versio saatavilla – napauta päivittääksesi", 15000);
    document.getElementById("toast").onclick = () => location.reload();
  });
}
