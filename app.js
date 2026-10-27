// Treeni – kirjaussovellus. Ei ulkoisia riippuvuuksia: Firebase on paketoitu tiedostoon firebase-bundle.js.
import {
  initializeApp, getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch
} from "./firebase-bundle.js";

const VERSION = "0.2.0";
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
  ohjelmat: {}, meta: null, kerrat: [], paino: [], kaynnit: [],
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
function toast(msg, ms = 2200) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
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
    S.pending = snap.metadata.hasPendingWrites; S.loaded.kerrat = true; updateSync(); render();
  }, onErr));
  unsub.push(onSnapshot(userCol("kehonpaino"), snap => { S.paino = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.pvm.localeCompare(a.pvm)); render(); }, onErr));
  unsub.push(onSnapshot(userCol("kaynnit"), snap => { S.kaynnit = snap.docs.map(d => ({ id: d.id, ...d.data() })); }, onErr));
});
function updateSync() {
  if (!navigator.onLine) { $sync.textContent = "Ei yhteyttä · tallennetaan puhelimeen"; $sync.className = "sync off"; }
  else if (S.pending) { $sync.textContent = "Siirretään pilveen…"; $sync.className = "sync pending"; }
  else { $sync.textContent = "Tallennettu"; $sync.className = "sync ok"; }
}
addEventListener("online", updateSync); addEventListener("offline", updateSync);
$tabs.addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (!b) return; S.tab = b.dataset.tab; S.editId = null; render(); scrollTo(0, 0); });

// ---------- render ----------
function render() {
  if (!S.user) return;
  [...$tabs.children].forEach(b => b.classList.toggle("active", b.dataset.tab === S.tab));
  if (!S.loaded.ohjelmat || !S.loaded.meta || !S.loaded.kerrat) { $view.innerHTML = `<p class="muted center">Ladataan…</p>`; return; }
  // älä piirrä uudelleen kesken numeron kirjoittamisen
  const a = document.activeElement;
  if (a && $view.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && S._typing) return;
  // liikevalitsin auki: piirretään uudelleen vasta kun se suljetaan
  if (document.getElementById("expick")) { S._deferred = true; return; }
  const fn = { tanaan: renderToday, ohjelma: renderProgram, historia: renderHistory, paino: renderWeight, vienti: renderData }[S.tab];
  fn();
}
$view.addEventListener("focusin", e => { if (e.target.matches("input,textarea")) S._typing = true; });
$view.addEventListener("focusout", () => { S._typing = false; setTimeout(render, 0); });

function renderLogin() {
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
  const omaBtn = `<button class="block" id="custom" style="margin-top:16px">+ Oma treeni</button><p class="muted small center">Ei siirrä ohjelman etenemistä.</p>`;
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
  h += `<h1>Viikko ${w} / ${p.viikkoja}</h1><p class="muted small">${esc(wi.jakso.nimi)} · ${esc(wi.jakso.ohje)}</p>`;
  if (!wi.slots.length) {
    h += `<div class="card"><h3>Lepoviikko</h3><p class="muted">Tällä viikolla ei ole treenejä.</p></div><button class="primary block" id="next">Siirry viikkoon ${w + 1}</button>${omaBtn}`;
    $view.innerHTML = h; bindOma(); document.getElementById("next").onclick = () => nextWeek(p, w); return;
  }
  let firstOpen = -1;
  const slotsHtml = wi.slots.map((t, i) => {
    const k = sessionForSlot(p, w, i);
    if (!k && firstOpen < 0) firstOpen = i;
    const st = k ? `<span class="badge ${k.tila}">${{ tehty: "Tehty", osittain: "Osittain", valiin: "Väliin jätetty", kesken: "Kesken" }[k.tila]}${k.pvm ? " " + fiDate(k.pvm) : ""}</span>` : "";
    return `<div class="card slot"><div><h3>${esc(t.nimi)}</h3><div class="muted small">${t.liikkeet.length} liikettä ${st}</div></div>
      ${k ? (k.tila !== "valiin" ? `<button data-open="${k.id}" class="ghost">Avaa</button>` : "") : `<button data-slot="${i}" class="${i === firstOpen ? "primary" : ""}">Aloita</button>`}</div>`;
  }).join("");
  h += (firstOpen >= 0 ? `<p class="small">Seuraavaksi: <b>${esc(wi.slots[firstOpen].nimi)}</b></p>` : `<p class="small">Viikon treenit on käyty läpi.</p>`) + slotsHtml;
  h += `<button class="block" id="next" style="margin-top:12px">Siirry viikkoon ${w + 1}${firstOpen >= 0 ? " (tekemättömät merkitään väliin jätetyiksi)" : ""}</button>${omaBtn}`;
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
    bar.innerHTML = `<span id="tlabel"></span><span class="row"><button id="tplus" class="ghost small">+30 s</button><button id="tskip" class="ghost small">Ohita</button></span>`;
    document.body.appendChild(bar);
    bar.querySelector("#tskip").onclick = stopTimer;
    bar.querySelector("#tplus").onclick = () => { if (S.timer) S.timer.end += 30000; drawTimer(); };
  }
  bar.hidden = false;
  const left = Math.round((S.timer.end - Date.now()) / 1000);
  const lab = bar.querySelector("#tlabel");
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
  let h = `<div class="row space"><div><h1 style="margin-bottom:0">${esc(k.treeni)}</h1><div class="muted small">${k.tyyppi === "oma" || !k.ohjelmaId ? "Oma treeni" : `Viikko ${k.viikko} · ${esc(k.jakso || "")}`} ${k.pvm ? "· " + fiDate(k.pvm) : ""}</div></div>
    <button class="ghost" id="back">Takaisin</button></div>`;
  const p = S.ohjelmat[k.ohjelmaId]; const wi = p && weekInfo(p, k.viikko);
  if (wi) h += `<p class="muted small">${esc(wi.jakso.ohje)}</p>`;
  (k.liikkeet || []).forEach((l, li) => {
    const done = k.sarjat.filter(s => s.liikeIndex === li);
    const last = lastSetsFor(l.nimi, k.id);
    const rows = Math.max(l.sarjoja || 0, done.length) + (draft.v["extra" + li] || 0);
    h += `<div class="ex ${l.ohitettu ? "skipped" : ""}" data-li="${li}">
      <div class="row space"><h3>${esc(l.nimi)}</h3><span class="muted small">${esc(l.tavoite || (last ? "" : "uusi"))}</span></div>
      ${l.nimi !== l.suunniteltu ? `<div class="muted small">Korvaa: ${esc(l.suunniteltu)}</div>` : ""}
      <div class="last">${last ? `Viimeksi ${last.k.pvm ? fiDate(last.k.pvm) : "viikko " + (last.k.viikko || "?")}: ${esc(setsText(last.sets))}` : "Ei aiempia tuloksia"}</div>`;
    if (!l.ohitettu) {
      h += `<div class="hdr-labels"><span></span><span>kg</span><span>toistot</span><span></span></div>`;
      for (let si = 0; si < rows; si++) {
        const d = done.find(s => s.sarja === si + 1);
        const prevSet = last?.sets[si] || last?.sets[last.sets.length - 1];
        const prevInRow = done.find(s => s.sarja === si);
        const kg = draft.v[`kg${li}_${si}`] ?? (d ? d.paino_kg : (prevInRow?.paino_kg ?? prevSet?.paino_kg ?? null));
        const reps = draft.v[`r${li}_${si}`] ?? (d ? d.toistot : (l.toistot?.[si] ?? prevSet?.toistot ?? null));
        h += `<div class="set ${d ? "done" : ""}" data-si="${si}">
          <span class="n">${si + 1}${l.tyypit?.[si] === "restpause" ? "<br><small>RP</small>" : ""}</span>
          <div class="stepper"><button data-step="kg" data-d="-2.5">−</button><input inputmode="decimal" data-f="kg" value="${kg == null ? "" : fmtKg(kg)}"><button data-step="kg" data-d="2.5">+</button></div>
          <div class="stepper"><button data-step="r" data-d="-1">−</button><input inputmode="numeric" data-f="r" value="${reps ?? ""}"><button data-step="r" data-d="1">+</button></div>
          <button class="ok" data-act="${d ? "undo" : "done"}" aria-label="${d ? "Kirjattu, poista" : "Kirjaa sarja"}">✓</button></div>`;
      }
      h += `<div class="row" style="margin-top:6px"><button class="ghost small" data-act="addset">+ sarja</button>
        <button class="ghost small" data-act="swap">Vaihda liike</button><button class="ghost small" data-act="skip">Ohita</button></div>
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
  $view.innerHTML = h;
  bindWorkout(k);
}
function persist(k) { const { id, ...data } = k; save("treenikerrat", id, data); }
function bindWorkout(k) {
  const draft = S.draft;
  document.getElementById("back").onclick = () => { S.editId = null; S.draft = null; S.tab = "tanaan"; S._leave = k.id; render(); };
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
    const planned = k.liikkeet.filter(l => !l.lisatty);
    const all = planned.every((l, i) => !l.ohitettu && k.sarjat.some(s => s.liikeIndex === k.liikkeet.indexOf(l)));
    if (k.tila === "kesken") {
      k.tila = k.tyyppi === "oma" ? (k.sarjat.length ? "tehty" : "valiin") : (all ? "tehty" : (k.sarjat.length ? "osittain" : "valiin"));
      k.loppu = nowISO(); stopTimer();
    }
    persist(k); S.editId = null; S.draft = null; toast(k.tila === "tehty" ? "Treeni tallennettu" : "Tallennettu"); render();
  };
  const del = document.getElementById("del"), cancel = document.getElementById("cancel");
  if (del) del.onclick = () => { if (confirm("Poistetaanko koko treenikerta pysyvästi?")) { deleteDoc(userDoc("treenikerrat", k.id)); S.kerrat = S.kerrat.filter(x => x.id !== k.id); S.editId = null; render(); } };
  if (cancel) cancel.onclick = () => { if (!k.sarjat.length || confirm("Hylätäänkö treeni? Kirjatut sarjat poistetaan.")) { deleteDoc(userDoc("treenikerrat", k.id)); S.kerrat = S.kerrat.filter(x => x.id !== k.id); S.editId = null; render(); } };
}
function askExercise(title, cb) {
  document.getElementById("expick")?.remove();
  const names = allExerciseNames();
  const wrap = document.createElement("div"); wrap.className = "card"; wrap.id = "expick";
  wrap.innerHTML = `<div class="row space"><h3>${esc(title)}</h3><button class="ghost small" id="exno">Peruuta</button></div>
    <input id="exq" placeholder="Kirjoita liikkeen nimi" autocomplete="off" autocapitalize="sentences"><div id="exres" class="stack" style="margin-top:8px"></div>`;
  $view.prepend(wrap); scrollTo(0, 0);
  const q = wrap.querySelector("#exq"), res = wrap.querySelector("#exres");
  const close = () => { S._typing = false; wrap.remove(); if (S._deferred) { S._deferred = false; } };
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
    h += `<div class="${cls}">Vk ${w}<br><b>${n ? done + "/" + n : "lepo"}</b></div>`;
  }
  h += `</div>`;
  p.jaksot.forEach(j => {
    h += `<h2>${esc(j.nimi)} <span class="muted small">vk ${j.viikot[0].viikko}${j.viikot.length > 1 ? "–" + j.viikot[j.viikot.length - 1].viikko : ""}</span></h2><p class="muted small">${esc(j.ohje)}</p>`;
    j.treenit.forEach(t => h += `<details class="card"><summary><b>${esc(t.nimi)}</b></summary>${t.liikkeet.map(l => `<div class="row space small list-item"><span>${esc(l.nimi)}</span><span class="muted">${esc(l.tavoite)}</span></div>`).join("")}</details>`);
  });
  if (S.meta?.aloitus) h += `<h2>Viikon säätö</h2><p class="muted small">Jos viikko meni väärin, voit asettaa nykyisen viikon käsin.</p>
    <div class="row"><input id="wset" type="number" min="1" max="${p.viikkoja}" value="${cur}"><button id="wbtn">Aseta</button></div>`;
  if (S.meta?.aloitus) h += `<h2>Nollaa aloitus</h2><p class="muted small">Poistaa ohjelman aloituspäivän ja kaikki tämän ohjelman sovelluksella kirjatut treenikerrat. Vanha historia ja punnitukset säilyvät. Käytä esim. testauksen jälkeen.</p>
    <button class="danger block" id="reset">Nollaa ohjelman aloitus</button>`;
  $view.innerHTML = h;
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

// ----- Historia -----
function sessionSortKey(k) { return (k.pvm || "") + (k.alku || ""); }
function renderHistory() {
  const f = S.histFilter.trim().toLowerCase();
  let list = S.kerrat.filter(k => k.tila !== "kesken");
  if (f) list = list.filter(k => (k.sarjat || []).some(s => (s.liike || "").toLowerCase().includes(f)) || (k.treeni || "").toLowerCase().includes(f));
  const dated = list.filter(k => k.pvm).sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)));
  const undated = list.filter(k => !k.pvm).sort((a, b) => (b.ohjelma || "").localeCompare(a.ohjelma || "") || (b.viikko || 0) - (a.viikko || 0));
  let h = `<h1>Historia</h1><input id="hf" placeholder="Hae liikkeellä, esim. penkki" value="${esc(S.histFilter)}">
    <p class="muted small">${list.length} treenikertaa · ${list.reduce((a, k) => a + (k.sarjat || []).filter(s => s.tyyppi !== "merkinta" && (!f || (s.liike || "").toLowerCase().includes(f))).length, 0)} sarjaa</p><div id="hl">`;
  const item = k => {
    const byEx = {};
    (k.sarjat || []).forEach(s => { if (!f || (s.liike || "").toLowerCase().includes(f)) (byEx[s.liike] = byEx[s.liike] || []).push(s); });
    const when = k.pvm ? fiDate(k.pvm) : `Viikko ${k.viikko || "?"}`;
    return `<details class="card"><summary><div class="row space"><div><b>${when}</b> · ${esc(k.treeni || "")}<div class="muted small">${esc(k.ohjelma || "")}</div></div>
      <span class="badge ${k.lahde === "sovellus" ? k.tila : "vanha"}">${k.lahde === "sovellus" ? (k.tyyppi === "oma" ? "Oma" : ({ tehty: "Tehty", osittain: "Osittain", valiin: "Väliin" }[k.tila] || k.tila)) : "Vanha"}</span></div></summary>
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

// ----- Paino -----
function renderWeight() {
  let h = `<h1>Kehonpaino</h1><div class="card"><div class="row"><input id="wkg" inputmode="decimal" placeholder="kg"><input id="wd" type="date" value="${todayISO()}"></div>
    <button class="primary block" id="wadd" style="margin-top:8px">Tallenna</button></div>`;
  h += S.paino.map(p => `<div class="list-item row space"><span>${fiDate(p.pvm)}</span><b>${fmtKg(p.paino_kg)} kg</b>${p.lahde === "sovellus" ? `<button class="ghost small" data-del="${p.id}">Poista</button>` : `<span class="badge vanha">Vanha</span>`}</div>`).join("");
  $view.innerHTML = h;
  document.getElementById("wadd").onclick = () => {
    const kg = num(document.getElementById("wkg").value), d = document.getElementById("wd").value;
    if (!kg || kg < 30 || kg > 250) { toast("Tarkista paino"); return; }
    const id = uid(); save("kehonpaino", id, { pvm: d, paino_kg: kg, huomio: "", lahde: "sovellus", kirjattu: nowISO() }); S._typing = false; toast("Tallennettu");
  };
  $view.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { if (confirm("Poistetaanko punnitus?")) deleteDoc(userDoc("kehonpaino", b.dataset.del)); });
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
    <div class="card small"><p>Sovelluksessa: ${nApp} kirjattua treenikertaa, ${nOld} vanhaa, ${S.paino.length} punnitusta, ${S.kaynnit.length} vanhaa käyntiä.</p>
      <p class="muted">Versio ${VERSION} · ${esc(S.user.email)}</p><button class="ghost" id="logout">Kirjaudu ulos</button></div>`;
  document.getElementById("exp").onclick = async () => {
    const d = todayISO();
    const ok = await shareFiles([
      { name: `sarjat_${d}.csv`, type: "text/csv", data: toCSV(CSV_COLS, flatRows()) },
      { name: `treenikerrat_${d}.csv`, type: "text/csv", data: toCSV(["id", "pvm", "ohjelma", "jakso", "viikko", "treeni", "tila", "alku", "loppu", "sarjoja", "korvatut", "ohitetut", "huomio", "lahde", "tyyppi", "pohja_id"], sessionRows()) },
      { name: `kehonpaino_${d}.csv`, type: "text/csv", data: toCSV(["pvm", "paino_kg", "huomio", "lahde", "id"], [...S.paino].reverse()) },
      { name: `salikaynnit_${d}.csv`, type: "text/csv", data: toCSV(["pvm", "kellonaika", "tila", "huomio", "lahde", "id"], [...S.kaynnit].sort((a, b) => a.pvm.localeCompare(b.pvm))) },
      { name: `LUEMINUT.md`, type: "text/markdown", data: README() }]);
    if (ok) { saveMeta({ viimeVienti: nowISO() }); toast("Vienti tehty"); }
  };
  document.getElementById("expjson").onclick = () => shareFiles([{ name: `treeni_varmuuskopio_${todayISO()}.json`, type: "application/json",
    data: JSON.stringify({ muoto: "treeni-varmuuskopio-1", viety: nowISO(), ohjelmat: Object.values(S.ohjelmat), meta: S.meta, treenikerrat: S.kerrat, kehonpaino: S.paino, kaynnit: S.kaynnit }) }]);
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
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
