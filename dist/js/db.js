const DB_NAME = "budget-lens-db";
const DB_VERSION = 2;
const STORE = "app-state";
const BACKUP_STORE = "recovery-backups";
const KEY = "primary";
const MIRROR_KEY = "budget-lens-state-mirror-v1";
const SAFETY_META_KEY = "budget-lens-safety-meta-v1";
const MAX_BACKUPS = 30;

let lastLoadInfo = { source: "none", recovered: false };

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      if (!request.result.objectStoreNames.contains(BACKUP_STORE)) request.result.createObjectStore(BACKUP_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function validState(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.accounts) && Array.isArray(value.channels) && Array.isArray(value.cycles) && Array.isArray(value.transactions));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

function readMirror() {
  const value = readJson(MIRROR_KEY);
  return validState(value) ? value : null;
}

function writeMirror(state) {
  const meta = getSafetyStatus();
  meta.mirrorHealthy = writeJson(MIRROR_KEY, state);
  meta.lastChangeAt = new Date().toISOString();
  meta.changesSinceExport = Number(meta.changesSinceExport || 0) + 1;
  writeJson(SAFETY_META_KEY, meta);
}

function refreshMirror(state) {
  const meta = readJson(SAFETY_META_KEY, { lastExportAt: null, changesSinceExport: 0 });
  meta.mirrorHealthy = writeJson(MIRROR_KEY, state);
  writeJson(SAFETY_META_KEY, meta);
}

function revisionOf(state) {
  return Number(state?.revision || 0);
}

function staleError() {
  const error = new Error("A newer local version already exists");
  error.code = "STALE_STATE";
  return error;
}

function recoveryPoint(state, reason) {
  return {
    id: `backup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    reason,
    state: clone(state)
  };
}

function readPrimaryAndBackups() {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, BACKUP_STORE], "readonly");
    const primaryRequest = tx.objectStore(STORE).get(KEY);
    const backupsRequest = tx.objectStore(BACKUP_STORE).getAll();
    tx.oncomplete = () => {
      db.close();
      resolve({ primary: primaryRequest.result || null, backups: backupsRequest.result || [] });
    };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

function repairPrimary(state) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(clone(state), KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

export async function loadState() {
  const { primary, backups } = await readPrimaryAndBackups();
  const mirror = readMirror();
  if (validState(primary)) {
    if (mirror && revisionOf(mirror) > revisionOf(primary)) {
      await repairPrimary(mirror);
      lastLoadInfo = { source: "mirror", recovered: true };
      return clone(mirror);
    }
    if (!mirror || revisionOf(primary) >= revisionOf(mirror)) refreshMirror(primary);
    lastLoadInfo = { source: "primary", recovered: false };
    return clone(primary);
  }
  if (mirror) {
    await repairPrimary(mirror);
    lastLoadInfo = { source: "mirror", recovered: true };
    return clone(mirror);
  }
  const latest = backups.filter(item => validState(item.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest) {
    await repairPrimary(latest.state);
    refreshMirror(latest.state);
    lastLoadInfo = { source: "backup", recovered: true };
    return clone(latest.state);
  }
  lastLoadInfo = { source: "none", recovered: false };
  return null;
}

export function getLastLoadInfo() {
  return { ...lastLoadInfo };
}

function commitState(candidate, expectedState, reason) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, BACKUP_STORE], "readwrite");
    const stateStore = tx.objectStore(STORE);
    const backupStore = tx.objectStore(BACKUP_STORE);
    const currentRequest = stateStore.get(KEY);
    let abortError = null;
    let savedState = null;
    currentRequest.onsuccess = () => {
      const current = currentRequest.result || null;
      if (current && revisionOf(current) !== revisionOf(expectedState)) {
        abortError = staleError();
        tx.abort();
        return;
      }
      savedState = clone(candidate);
      savedState.revision = revisionOf(current) + 1;
      savedState.updatedAt = new Date().toISOString();
      if (validState(current)) backupStore.put(recoveryPoint(current, reason));
      stateStore.put(savedState, KEY);
      const allBackups = backupStore.getAll();
      allBackups.onsuccess = () => {
        allBackups.result
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(MAX_BACKUPS)
          .forEach(item => backupStore.delete(item.id));
      };
    };
    tx.oncomplete = () => {
      db.close();
      Object.assign(candidate, savedState);
      writeMirror(savedState);
      resolve(savedState);
    };
    tx.onerror = () => { db.close(); reject(abortError || tx.error); };
    tx.onabort = () => { db.close(); reject(abortError || tx.error || new Error("Save aborted")); };
  }));
}

export async function saveState(state, reason = "日常修改前自动备份") {
  return commitState(state, state, reason);
}

export async function replaceStateWithRecovery(nextState, currentState, reason) {
  return commitState(nextState, currentState, reason);
}

export async function loadRecoveryBackups() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, "readonly");
    const request = tx.objectStore(BACKUP_STORE).getAll();
    request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export function getSafetyStatus() {
  return readJson(SAFETY_META_KEY, { lastExportAt: null, changesSinceExport: 0, mirrorHealthy: Boolean(readMirror()) });
}

export function markDataExported() {
  const meta = getSafetyStatus();
  meta.lastExportAt = new Date().toISOString();
  meta.changesSinceExport = 0;
  writeJson(SAFETY_META_KEY, meta);
}

export async function resetState() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => {
      db.close();
      try { localStorage.removeItem(MIRROR_KEY); } catch { /* ignored */ }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}
