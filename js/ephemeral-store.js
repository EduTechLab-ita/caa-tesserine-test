// ══════════════════════════════════════════════════════════════════
//  ephemeral-store.js — I vocabolari RICEVUTI non toccano il disco
//  (28/07/2026)
// ══════════════════════════════════════════════════════════════════
//
// PERCHÉ ESISTE QUESTO MODULO
// Un vocabolario "ricevuto" contiene i dati di un alunno che NON appartiene alla
// docente che lo riceve: è di un'altra collega, spesso di un'altra classe. Sono
// dati di un minore e, trattandosi di CAA, il solo fatto che esistano rivela una
// condizione di disabilità (art. 9 GDPR). Non c'è nessuna ragione legittima per
// cui debbano restare nel browser di chi li riceve quando l'app è chiusa —
// tanto più su un PC condiviso in sala professori, dove chiunque può aprirli
// senza autenticarsi.
//
// Fino alla v5.38 restavano in localStorage come qualsiasi altro alunno, con tre
// conseguenze: (1) se il proprietario eliminava il vocabolario mentre la collega
// non lo teneva selezionato, la copia sopravviveva a tempo indeterminato (TODO
// del 27/07, chiuso solo in parte dalla verifica al boot: quella richiede Drive
// connesso, e su un browser che non si collega più non arriva mai); (2) i dati
// restavano leggibili e stampabili anche mentre il vocabolario era perfettamente
// valido, da chiunque avesse accesso a quel browser; (3) la privacy policy non
// poteva dichiarare con verità che l'eliminazione rimuove i dati.
//
// Da qui in avanti: i vocabolari ricevuti vivono SOLO in memoria di sessione.
// Si caricano da Firebase all'apertura (che è già la fonte di verità dal 17/07) e
// spariscono quando si chiude la scheda. Gli alunni PROPRI non cambiano di una
// virgola: restano in locale + Drive come sempre.
//
// Costo d'uso praticamente nullo, verificato nel codice prima di scegliere questa
// strada: il dizionario salva solo l'ID del pittogramma, non l'immagine, e le
// immagini arrivano sempre da static.arasaac.org (il Service Worker le manda in
// rete e non le cacha) — quindi senza connessione un vocabolario condiviso non
// era comunque stampabile. Non stiamo togliendo un uso offline che esisteva.
//
// L'unico dato persistito qui è l'ELENCO DEI NOMI ricevuti: serve a riconoscerli
// anche prima che Drive si connetta (altrimenti una modifica fatta nei primi
// secondi finirebbe su disco). Non aggiunge esposizione: quegli stessi nomi sono
// già in `caa_students_v1` perché compaiono nel menù a tendina, e sono per policy
// iniziali o pseudonimi, mai nomi per esteso.

const SHARED_NAMES_KEY = 'caa_shared_names_v1';

// Dati dei vocabolari ricevuti: chiave (la stessa che si userebbe in
// localStorage) → valore serializzato. Vive quanto la scheda del browser.
const _mem = new Map();

function _loadNames() {
  try {
    const raw = localStorage.getItem(SHARED_NAMES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter(n => typeof n === 'string' && n !== '') : []);
  } catch(e) { return new Set(); }
}

function _saveNames(set) {
  try { localStorage.setItem(SHARED_NAMES_KEY, JSON.stringify([...set])); } catch(e) {}
}

/** Questo alunno è un vocabolario RICEVUTO da una collega? '' (uso generico) mai. */
export function isEphemeralStudent(studentName) {
  if (!studentName) return false;
  return _loadNames().has(studentName);
}

/** Segna un alunno come ricevuto e ripulisce subito ciò che avesse già su disco.
 *  La pulizia vale anche da migrazione una tantum per i browser che hanno usato
 *  le versioni precedenti: i dati veri stanno su Firebase, qui non si perde nulla. */
export function markEphemeralStudent(studentName) {
  if (!studentName) return;
  const names = _loadNames();
  if (!names.has(studentName)) {
    names.add(studentName);
    _saveNames(names);
  }
  purgePersistedStudentData(studentName);
}

/** Non è più un ricevuto (eliminato dal proprietario, o dimenticato): toglie il
 *  nome dall'elenco e svuota la copia in memoria. */
export function unmarkEphemeralStudent(studentName) {
  if (!studentName) return;
  const names = _loadNames();
  if (names.delete(studentName)) _saveNames(names);
  forgetEphemeralData(studentName);
}

/** Segue una rinomina decisa dal proprietario, spostando anche i dati in memoria. */
export function renameEphemeralStudent(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const names = _loadNames();
  if (!names.has(oldName)) return;
  names.delete(oldName);
  names.add(newName);
  _saveNames(names);
  for (const key of [..._mem.keys()]) {
    if (key.endsWith(oldName)) {
      _mem.set(key.slice(0, key.length - oldName.length) + newName, _mem.get(key));
      _mem.delete(key);
    }
  }
  purgePersistedStudentData(newName);
}

/** Rimuove dal disco ogni dato di questo alunno (le tre famiglie di chiavi:
 *  dizionario, etichette, immagini custom). Usata dal marcamento e dalla pulizia. */
export function purgePersistedStudentData(studentName) {
  if (!studentName) return;
  [
    `caa_dict_v2_${studentName}`,
    `caa_labels_v1_${studentName}`,
    `caa_custom_v2_${studentName}`,
  ].forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });
}

/** Svuota la copia in memoria di un alunno ricevuto. */
export function forgetEphemeralData(studentName) {
  if (!studentName) return;
  for (const key of [..._mem.keys()]) {
    if (key.endsWith(studentName)) _mem.delete(key);
  }
  purgePersistedStudentData(studentName);
}

// ── Instradamento lettura/scrittura ──────────────────────────────────────
// Le funzioni di dictionary.js e app.js passano tutte di qui invece di chiamare
// localStorage direttamente: unico punto in cui si decide dove finisce un dato.

export function studentStoreGet(studentName, key) {
  if (isEphemeralStudent(studentName)) return _mem.has(key) ? _mem.get(key) : null;
  try { return localStorage.getItem(key); } catch(e) { return null; }
}

export function studentStoreSet(studentName, key, value) {
  if (isEphemeralStudent(studentName)) { _mem.set(key, value); return; }
  try { localStorage.setItem(key, value); } catch(e) {}
}

// Rimuove da entrambi i lati di proposito: se un nome ha smesso di essere
// ricevuto (o lo è diventato da poco) non deve restare una copia dall'altra parte.
export function studentStoreRemove(studentName, key) {
  _mem.delete(key);
  try { localStorage.removeItem(key); } catch(e) {}
}

/** Elenco dei nomi ricevuti conosciuti — usato dalla pulizia alla disconnessione. */
export function getEphemeralStudentNames() {
  return [..._loadNames()];
}

/** Azzera tutto (disconnessione da Drive / pulizia dati locali). */
export function clearAllEphemeral() {
  for (const name of _loadNames()) purgePersistedStudentData(name);
  _mem.clear();
  try { localStorage.removeItem(SHARED_NAMES_KEY); } catch(e) {}
}
