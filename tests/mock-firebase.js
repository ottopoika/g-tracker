// Muistinvarainen testikorvike Firebase-rajapinnalle (vain testeihin, ei tuotantoon).
const store = new Map(); const listeners = [];
const key = p => p.join("/");
export const initializeApp = () => ({});
let authCb = null; const user = { uid: "test-uid", email: "otto@test" };
export const getAuth = () => ({});
export const onAuthStateChanged = (a, cb) => { authCb = cb; setTimeout(() => cb(window.__loggedIn ? user : null), 0); };
export const signInWithEmailAndPassword = async () => { window.__loggedIn = true; authCb(user); };
export const signOut = async () => { authCb(null); };
export const initializeFirestore = () => ({}); export const persistentLocalCache = () => ({}); export const persistentSingleTabManager = () => ({});
export const collection = (db, ...p) => ({ type: "col", path: p });
export const doc = (db, ...p) => ({ type: "doc", path: p, id: p[p.length - 1] });
function notify() { listeners.forEach(l => l.fire()); }
export const setDoc = async (ref, data) => { store.set(key(ref.path), structuredClone(data)); setTimeout(notify, 0); };
export const deleteDoc = async ref => { store.delete(key(ref.path)); setTimeout(notify, 0); };
export const writeBatch = () => { const ops = []; return { set: (r, d) => ops.push([r, d]), delete: r => ops.push([r, null]), commit: async () => { ops.forEach(([r, d]) => d === null ? store.delete(key(r.path)) : store.set(key(r.path), structuredClone(d))); setTimeout(notify, 0); } }; };
export const onSnapshot = (ref, a, b) => {
  const cb = typeof a === "function" ? a : b;
  const l = { fire() {
    if (ref.type === "doc") { const k = key(ref.path); cb({ exists: () => store.has(k), data: () => structuredClone(store.get(k)) }); }
    else { const pre = key(ref.path) + "/"; const docs = [...store.entries()].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map(([k, v]) => ({ id: k.slice(pre.length), data: () => structuredClone(v) }));
      cb({ docs, forEach: f => docs.forEach(f), metadata: { hasPendingWrites: false } }); } } };
  listeners.push(l); setTimeout(() => l.fire(), 0); return () => {};
};
window.__store = store;
