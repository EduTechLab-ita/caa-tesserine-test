// ══════════════════════════════════════════════════════════════════
//  drive.js — Google Drive OAuth (backup personale) + Firebase RTDB
//  (condivisione vocabolario tra colleghe) per CAArtella
//  Adattato da Valutazione Primaria (Drive) e da EduBoard (Firebase auth anonimo)
// ══════════════════════════════════════════════════════════════════

const DRIVE_CLIENT_ID   = '374342529488-c123a5j5v8hnfs241udbl55fos5thfq6.apps.googleusercontent.com';
const DRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file email profile';
const DRIVE_FOLDER_NAME  = 'CAArtella';
const SHARED_INDEX_FILE  = 'indice-condivisi.json';

// Firebase (progetto eduboard-connect, riusato — stesso auth anonimo di EduBoard,
// nodo /caartella-shared/ isolato con regole proprie)
const FIREBASE_DB_URL   = 'https://eduboard-connect-default-rtdb.europe-west1.firebasedatabase.app';
const FIREBASE_API_KEY  = 'AIzaSyAQqLPBBFXUKACLrChHrJljQfnlWA_tGg8';

// Versione dello scope OAuth corrente. Chi si è connesso prima con lo scope
// "drive" completo deve ridare il consenso per passare a "drive.file".
const SCOPE_VERSION = 2;

// ── Stato Drive (persiste in localStorage) ────────────────────────
let driveState = {
  enabled:          false,
  accessToken:      null,
  tokenExpiry:      0,
  folderId:         null,   // cartella CAArtella/ personale
  userEmail:        '',
  userPhotoUrl:     null,   // foto profilo Google (scope "profile")
  ownFileIds:       {},     // { 'EMMA': 'fileId...' }  — file propri (cache)
  sharedShareCodes: {},     // { 'LUCA': 'shareCode...' } — condivisi da colleghe (via Firebase)
  scopeVersion:     0,
};

export function isDriveConnected() {
  return driveState.enabled && !!driveState.accessToken && Date.now() < driveState.tokenExpiry - 30000;
}

// Privacy PC condiviso (18/07/2026): ownFileIds e sharedShareCodes sono mappe
// nome-alunno → identificativo Drive/Firebase — utili solo DURANTE la sessione
// corrente (evitano una ricerca API ad ogni click), ma NON devono sopravvivere a
// un ricaricamento pagina: una cache persistita, se resta indietro rispetto allo
// stato reale su Drive (rinomina, cancellazione, condivisione rimossa), ha causato
// più bug reali in questa sessione di lavoro (vocabolario sbagliato mostrato,
// rinomina che agiva sul file sbagliato, alunni "fantasma" mai spariti). Restano
// quindi SOLO in memoria, mai scritte su localStorage.
function saveDriveState() {
  const { ownFileIds, sharedShareCodes, ...persisted } = driveState;
  localStorage.setItem('caa_driveState_v1', JSON.stringify(persisted));
}

// ── Carica stato all'avvio ────────────────────────────────────────
export function loadDriveConfig(onConnected) {
  try {
    const saved = localStorage.getItem('caa_driveState_v1');
    if (saved) driveState = Object.assign(driveState, JSON.parse(saved));
  } catch(e) {}
  // Sempre azzerate ad ogni caricamento pagina (mai persistite, vedi saveDriveState) —
  // anche per ripulire eventuali residui salvati da versioni precedenti dell'app.
  driveState.ownFileIds       = {};
  driveState.sharedShareCodes = {};

  if (driveState.enabled && driveState.scopeVersion !== SCOPE_VERSION) {
    // Connessione precedente con scope "drive" completo: serve un nuovo consenso
    // per passare a "drive.file". Puliamo solo lo stato di connessione, non i dati locali.
    driveState.enabled     = false;
    driveState.accessToken = null;
    driveState.tokenExpiry = 0;
    saveDriveState();
  }

  updateDriveButton();

  if (driveState.enabled && driveState.accessToken && Date.now() < driveState.tokenExpiry - 30000) {
    onConnected && onConnected();
  } else if (driveState.enabled) {
    trySilentAuth(onConnected);
  }
}

// ── Aggiorna aspetto pulsante Drive (tondo, foto profilo + anello) ──
let _savedFlashTimer = null;

export function updateDriveButton(state) {
  const btn    = document.getElementById('drive-btn');
  const icon   = document.getElementById('drive-fab-icon');
  const photo  = document.getElementById('drive-fab-photo');
  const badge  = document.getElementById('drive-fab-badge');
  const check  = document.getElementById('drive-fab-check');
  if (!btn) return;

  const connected = driveState.enabled && !!driveState.accessToken;

  btn.className = 'drive-fab no-print';
  if (connected) btn.classList.add('drive-fab--connected');

  // Foto profilo (se disponibile) o icona omino
  if (connected && driveState.userPhotoUrl && photo) {
    icon.style.display  = 'none';
    photo.src            = driveState.userPhotoUrl;
    photo.style.display = 'block';
  } else {
    if (icon)  icon.style.display  = 'block';
    if (photo) photo.style.display = 'none';
  }
  if (badge) badge.style.display = connected ? 'block' : 'none';

  if (state === 'syncing') {
    btn.classList.add('drive-fab--syncing');
    btn.title = 'Drive — salvataggio in corso…';
  } else if (state === 'error') {
    btn.classList.add('drive-fab--error');
    btn.title = 'Drive — errore. Clicca per riprovare.';
  } else if (connected) {
    btn.title = driveState.userEmail || 'Drive connesso';
  } else {
    btn.title = 'Collega Google Drive';
  }
}

// ── Spunta verde temporanea dopo un salvataggio riuscito ──────────
function flashSaved() {
  const check = document.getElementById('drive-fab-check');
  if (!check) return;
  check.style.display = 'flex';
  clearTimeout(_savedFlashTimer);
  _savedFlashTimer = setTimeout(() => { check.style.display = 'none'; }, 2200);
}

// ── Click su "Collega a Google Drive" ────────────────────────────
export function connectToDrive() {
  if (typeof google === 'undefined' || !google.accounts) {
    alert('Le librerie Google non sono ancora caricate. Riprova tra qualche secondo.');
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    callback:  async (tokenResponse) => {
      if (tokenResponse.error) {
        showDrivePanel('error', 'Autorizzazione negata: ' + tokenResponse.error);
        return;
      }
      driveState.accessToken = tokenResponse.access_token;
      driveState.tokenExpiry = Date.now() + (tokenResponse.expires_in * 1000);
      driveState.enabled     = true;
      driveState.scopeVersion = SCOPE_VERSION;
      saveDriveState();
      updateDriveButton('syncing');
      try {
        await initDriveConnection();
      } catch(err) {
        updateDriveButton('error');
        showDrivePanel('error', 'Errore: ' + err.message);
      }
    }
  });
  client.requestAccessToken({ prompt: 'consent' });
}

// ── Rinnovo silenzioso del token ──────────────────────────────────
function trySilentAuth(onReady, retries = 6) {
  if (typeof google === 'undefined' || !google.accounts) {
    if (retries > 0) setTimeout(() => trySilentAuth(onReady, retries - 1), 1500);
    else updateDriveButton('error');
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    prompt:    '',
    callback:  (tokenResponse) => {
      if (tokenResponse.access_token) {
        driveState.accessToken = tokenResponse.access_token;
        driveState.tokenExpiry = Date.now() + (tokenResponse.expires_in * 1000);
        driveState.scopeVersion = SCOPE_VERSION;
        saveDriveState();
        updateDriveButton('connected');
        // Ripristina indice condivisi (se abbiamo già il folderId), poi chiama onReady
        const proceed = () => { onReady && onReady(); };
        if (driveState.folderId) {
          restoreSharedIndex().then(proceed).catch(proceed);
        } else {
          proceed();
        }
      } else {
        updateDriveButton('error');
      }
    }
  });
  client.requestAccessToken({ prompt: '' });
}

// ── Prima connessione: recupera info utente + trova/crea cartella ─
async function initDriveConnection() {
  const info = await driveApiFetch('https://www.googleapis.com/oauth2/v2/userinfo');
  driveState.userEmail    = info.email   || '';
  driveState.userPhotoUrl = info.picture || null;

  if (!driveState.sharedMode) {
    driveState.folderId = await findOrCreateDriveFolder();
  }
  saveDriveState();

  // Ripristina vocabolari condivisi dall'indice su Drive
  await restoreSharedIndex();

  updateDriveButton('connected');
  _refreshConnectedPanel();
  showDrivePanel('connected');

  // Notifica app.js che la connessione è completa (incluso il ripristino dell'indice)
  document.dispatchEvent(new CustomEvent('caa-drive-connected'));
}

// ── Indice vocabolari condivisi (indice-condivisi.json) ───────────
// Struttura: [ { name: 'EMMA', code: 'xxxx-xxxx-...' }, ... ]

async function loadSharedIndex() {
  if (!driveState.folderId) return [];
  try {
    const q = encodeURIComponent(
      `name='${SHARED_INDEX_FILE}' and '${driveState.folderId}' in parents and trashed=false`
    );
    const resp = await driveApiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    if (!resp.files || resp.files.length === 0) return [];
    const data = await loadFileContent(resp.files[0].id);
    return Array.isArray(data) ? data : [];
  } catch(e) {
    console.warn('[Drive] Errore lettura indice condivisi:', e.message);
    return [];
  }
}

async function saveSharedIndex(entries) {
  if (!driveState.folderId) return;
  // Nessun try/catch qui: gli errori emergono al chiamante (connectSharedFile)
  const payload = JSON.stringify(entries);
  const q = encodeURIComponent(
    `name='${SHARED_INDEX_FILE}' and '${driveState.folderId}' in parents and trashed=false`
  );
  const resp = await driveApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
  );
  if (resp.files && resp.files.length > 0) {
    await updateDriveFile(resp.files[0].id, payload);
  } else {
    await createDriveFile(SHARED_INDEX_FILE, payload);
  }
}

async function restoreSharedIndex() {
  const entries = await loadSharedIndex();
  if (entries.length === 0) return;
  driveState.sharedShareCodes = driveState.sharedShareCodes || {};
  entries.forEach(({ name, code }) => {
    if (name && code) driveState.sharedShareCodes[name] = code;
  });
  saveDriveState();
}

// ── Trova o crea la cartella CAArtella/ ──────────────────────────
async function findOrCreateDriveFolder() {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const resp = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  if (resp.files && resp.files.length > 0) return resp.files[0].id;
  const created = await driveApiFetch(
    'https://www.googleapis.com/drive/v3/files',
    'POST',
    { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }
  );
  return created.id;
}

// ── Login anonimo Firebase (richiesto dalle regole sicure del DB: auth != null) ──
// Invisibile per l'utente: nessuna schermata, nessun click. Token cache 1h con buffer 5min.
// Stesso meccanismo già in produzione su EduBoard (drive.js: _fbAuthToken).
async function _fbAuthToken() {
  const cached = localStorage.getItem('caa_fb_idtoken');
  const expiry = parseInt(localStorage.getItem('caa_fb_expiry') || '0', 10);
  if (cached && Date.now() < expiry - 300000) return cached;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true })
  });
  if (!res.ok) throw new Error('Autenticazione condivisione fallita: ' + res.status);
  const data = await res.json();
  const newExpiry = Date.now() + (parseInt(data.expiresIn, 10) || 3600) * 1000;
  localStorage.setItem('caa_fb_idtoken', data.idToken);
  localStorage.setItem('caa_fb_expiry', String(newExpiry));
  return data.idToken;
}

// ── Pubblica lo snapshot corrente su Firebase, pronto per la condivisione ──
export async function makeShareReady(code, studentName, dict, custom, labels) {
  if (!isDriveConnected() || !code) return;
  const token = await _fbAuthToken();
  const payload = JSON.stringify({
    dict:      dict   || {},
    custom:    custom || {},
    labels:    labels || {},
    student:   studentName || '',
    updatedAt: new Date().toISOString(),
  });
  const resp = await fetch(
    `${FIREBASE_DB_URL}/caartella-shared/${code}.json?auth=${token}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload }
  );
  if (!resp.ok) throw new Error('Pubblicazione condivisione fallita (' + resp.status + ')');
}

// ── Usa vocabolario condiviso tramite codice ─────────────────────
export async function connectSharedFile(code) {
  if (!isDriveConnected()) {
    throw new Error('Prima collega il tuo account Google Drive, poi inserisci il codice.');
  }
  let data;
  try {
    let token = await _fbAuthToken();
    let resp = await fetch(`${FIREBASE_DB_URL}/caartella-shared/${code}.json?auth=${token}`);
    if (resp.status === 401 || resp.status === 403) {
      // Token anonimo in cache non più valido (raro ma capita) — lo scartiamo e
      // ne richiediamo uno nuovo, un solo retry automatico prima di arrendersi.
      localStorage.removeItem('caa_fb_idtoken');
      localStorage.removeItem('caa_fb_expiry');
      token = await _fbAuthToken();
      resp = await fetch(`${FIREBASE_DB_URL}/caartella-shared/${code}.json?auth=${token}`);
    }
    if (!resp.ok) throw new Error('HTTP_' + resp.status);
    data = await resp.json();
  } catch(e) {
    const httpCode = e.message.startsWith('HTTP_') ? e.message.replace('HTTP_', '') : null;
    if (httpCode === '401' || httpCode === '403') {
      throw new Error(
        'Accesso negato. Chiedi alla collega di aprire il pannello Drive, selezionare l\'alunno ' +
        'e cliccare di nuovo "Copia messaggio", poi reinviarti il link aggiornato.'
      );
    }
    throw new Error(
      'Impossibile caricare il vocabolario. Verifica il codice o chiedi alla collega di ricondividere.'
    );
  }
  if (!data) {
    throw new Error('Codice non valido: vocabolario non trovato. Verifica che il codice sia corretto.');
  }

  const studentName = data.student || 'Alunno condiviso';

  // Aggiorna l'indice su Drive (sopravvive alla pulizia cache)
  try {
    const entries = await loadSharedIndex();
    if (!entries.find(e => e.code === code)) {
      entries.push({ name: studentName, code });
      await saveSharedIndex(entries);
      console.log('[Drive] ✅ Indice condivisi salvato su Drive:', entries);
    } else {
      console.log('[Drive] Indice già aggiornato per:', studentName);
    }
  } catch(e) {
    console.error('[Drive] ❌ ERRORE indice condivisi:', e.message);
    showDriveToast('⚠️ Errore salvataggio indice Drive: ' + e.message);
  }

  // Nota: NON registriamo qui sharedShareCodes[studentName] — il nome suggerito da
  // Firebase può collidere con un alunno già presente in locale (es. due colleghe
  // hanno entrambe un'alunna "Emma", persone diverse). La scelta del nome finale
  // (con eventuale disambiguazione) spetta al chiamante — vedi recordSharedCode().
  return { studentName, dict: data.dict || {}, custom: data.custom || {}, labels: data.labels || {} };
}

// Registra sotto quale nome locale è stato salvato un vocabolario condiviso
// (il chiamante decide il nome finale, dopo l'eventuale disambiguazione da collisione).
export function recordSharedCode(name, code) {
  driveState.sharedShareCodes = driveState.sharedShareCodes || {};
  driveState.sharedShareCodes[name] = code;
  saveDriveState();
}

// Se questo codice è già stato sincronizzato in passato, ritorna il nome locale
// usato allora (per restare stabili sync dopo sync, anche se il nome originale
// era in collisione ed è stato rinominato la prima volta).
export function findStudentNameForCode(code) {
  const map = driveState.sharedShareCodes || {};
  for (const name in map) {
    if (map[name] === code) return name;
  }
  return null;
}

// ── Ottieni codice da condividere per un alunno (stabile, generato una volta) ──
export async function getStudentShareCode(studentName) {
  if (!isDriveConnected() || !driveState.folderId) return null;
  const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
  const fileId = driveState.ownFileIds?.[studentName] || await findStudentFile(fileName);
  if (!fileId) return null; // nessun vocabolario salvato ancora per questo alunno

  driveState.ownFileIds = driveState.ownFileIds || {};
  driveState.ownFileIds[studentName] = fileId;
  saveDriveState();

  let content;
  try {
    content = await loadFileContent(fileId);
  } catch(e) {
    return null;
  }
  if (content.shareCode) return content.shareCode;

  // Prima condivisione per questo alunno: genera un codice stabile e lo salva nel file personale
  const shareCode = crypto.randomUUID();
  content.shareCode = shareCode;
  await updateDriveFile(fileId, JSON.stringify(content));
  return shareCode;
}

// ── Controlla se un alunno è condiviso da una collega ────────────
export function isSharedStudent(studentName) {
  return !!(driveState.sharedShareCodes?.[studentName]);
}

// Trova il fileId Drive di un alunno proprio, verificando che la cache ownFileIds
// sia ancora corretta (il file trovato deve avere content.student coerente) prima
// di fidarsene — altrimenti ricerca per nome, aggiornando la cache. Una cache
// corrotta da test precedenti ha già causato più bug reali (18/07/2026): vocabolario
// sbagliato mostrato alla selezione, rinomina che agiva sul file sbagliato lasciando
// quello vero intatto. Usata da tutte le funzioni che leggono/scrivono un alunno
// proprio, invece di ripetere la stessa logica di cache in 4 punti diversi.
async function _findVerifiedOwnFile(studentName) {
  const cached = driveState.ownFileIds?.[studentName];
  if (cached) {
    try {
      const content = await loadFileContent(cached);
      if ((content.student || '') === (studentName || '')) return { fileId: cached, content };
    } catch(e) { /* file non trovato/inaccessibile — ricerca da capo sotto */ }
  }
  const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
  const fileId = await findStudentFile(fileName);
  if (!fileId) return { fileId: null, content: null };
  driveState.ownFileIds = driveState.ownFileIds || {};
  driveState.ownFileIds[studentName] = fileId;
  saveDriveState();
  const content = await loadFileContent(fileId);
  return { fileId, content };
}

// Shar Code "effettivo" per questo alunno: sia che sia stato ricevuto da una collega
// (sharedShareCodes) sia che sia un proprio alunno già condiviso in passato (shareCode
// salvato dentro il file Drive personale, vedi getStudentShareCode). In entrambi i casi
// Firebase diventa la fonte di verità unica — altrimenti proprietario e destinatari
// avrebbero due copie scollegate che non si aggiornano mai a vicenda (bug reale
// segnalato da Fabio 18/07/2026: le colleghe aggiungevano tessere che il coordinatore
// non vedeva mai, e le cancellazioni non si propagavano).
async function _getEffectiveShareCode(studentName) {
  const received = driveState.sharedShareCodes?.[studentName];
  if (received) return received;
  if (!driveState.folderId) return null;
  try {
    const { content } = await _findVerifiedOwnFile(studentName);
    return content?.shareCode || null;
  } catch(e) { return null; }
}

// ── Rinomina un alunno (proprio o condiviso), propagando la modifica ─────
// Alunno condiviso (proprio già condiviso, o ricevuto): riscrive il campo
// "student" su Firebase — chiunque altro veda questo shareCode lo scoprirà al
// prossimo refresh (vedi _refreshCurrentStudentFromDrive in app.js).
// Alunno proprio (condiviso o no): rinomina SEMPRE anche il file su Drive, se esiste.
// FIX (19/07/2026): prima, se l'alunno era condiviso, la funzione si fermava dopo
// Firebase e usciva — il file Drive personale restava col nome vecchio per sempre
// (bug reale: EMMA rinominata in EMMA ROSSINI mostrava "✅ rinominato" ma su Drive
// restava "EMMA", e il refresh periodico riaggiungeva "EMMA" in lista → doppione).
// Ora i due aggiornamenti (Firebase + Drive) sono indipendenti ed entrambi eseguiti
// quando applicabili, così Drive resta sempre la copia coerente col nome corrente.
export async function renameStudentOnDrive(oldName, newName, dict, custom, labels) {
  if (!isDriveConnected()) return;

  const received = driveState.sharedShareCodes?.[oldName] || null;
  let fileId = null, content = null;
  if (driveState.folderId) {
    try { ({ fileId, content } = await _findVerifiedOwnFile(oldName)); } catch(e) { /* nessun file proprio */ }
  }
  const shareCode = received || content?.shareCode || null;

  if (shareCode) {
    const token = await _fbAuthToken();
    const payload = JSON.stringify({
      dict: dict || {}, custom: custom || {}, labels: labels || {},
      student: newName, updatedAt: new Date().toISOString(),
    });
    const putResp = await fetch(`${FIREBASE_DB_URL}/caartella-shared/${shareCode}.json?auth=${token}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload
    });
    if (!putResp.ok) throw new Error('Rinomina condivisa fallita (' + putResp.status + ')');
    if (driveState.sharedShareCodes?.[oldName]) {
      delete driveState.sharedShareCodes[oldName];
      driveState.sharedShareCodes[newName] = shareCode;
      saveDriveState();
    }
  }

  // Alunno proprio (file Drive personale trovato): rinomina anche lì, indipendentemente
  // dal ramo Firebase sopra — un alunno condiviso ha comunque un file Drive personale.
  if (fileId) {
    const newFileName = `vocabolario-${sanitizeName(newName || '_anonimo')}.json`;
    await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, 'PATCH', { name: newFileName });
    try {
      const freshContent = await loadFileContent(fileId);
      freshContent.student = newName;
      await updateDriveFile(fileId, JSON.stringify(freshContent));
    } catch(e) { /* non bloccante */ }

    if (driveState.ownFileIds?.[oldName]) {
      delete driveState.ownFileIds[oldName];
      driveState.ownFileIds[newName] = fileId;
      saveDriveState();
    }
  }
}

// ── Controlla se l'alunno è "proprio" (esiste un file Drive personale) ───
// Usato per decidere se mostrare l'eliminazione definitiva: un vocabolario
// ricevuto da una collega (solo riferimento Firebase, nessun file Drive
// personale) non è eliminabile da chi lo riceve — solo dal proprietario
// (richiesta esplicita di Fabio 19/07/2026).
export async function isOwnStudent(studentName) {
  if (!isDriveConnected() || !driveState.folderId) return false;
  try {
    const { fileId } = await _findVerifiedOwnFile(studentName);
    return !!fileId;
  } catch(e) { return false; }
}

// ── Elimina DEFINITIVAMENTE il vocabolario di un alunno proprio ──────────
// Cancella il file Drive personale e, se l'alunno era condiviso, anche il nodo
// Firebase corrispondente — le colleghe con cui era condiviso perdono l'accesso
// (comportamento voluto: l'eliminazione deve essere totale, non lasciare copie
// residue in giro). Azione distruttiva e irreversibile: la doppia conferma va
// fatta lato UI PRIMA di chiamare questa funzione (vedi app.js). Non fa nulla se
// l'alunno non è proprio (isOwnStudent false) — non tocca mai il file di altri.
export async function deleteStudentFromDrive(studentName) {
  if (!isDriveConnected() || !driveState.folderId) return;
  const { fileId, content } = await _findVerifiedOwnFile(studentName);
  if (!fileId) return;

  if (content?.shareCode) {
    try {
      const token = await _fbAuthToken();
      await fetch(`${FIREBASE_DB_URL}/caartella-shared/${content.shareCode}.json?auth=${token}`, { method: 'DELETE' });
    } catch(e) { /* non bloccante: procede comunque con l'eliminazione del file Drive */ }
  }

  await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, 'DELETE');

  if (driveState.ownFileIds?.[studentName]) {
    delete driveState.ownFileIds[studentName];
    saveDriveState();
  }
}

// ── URL cartella CAArtella su Drive (null se non connesso) ────────
export function getDriveFolderUrl() {
  if (!driveState.folderId) return null;
  return `https://drive.google.com/drive/folders/${driveState.folderId}`;
}

// ── Salva dizionario alunno (Drive personale, o Firebase se condiviso) ──
// NOTA (18/07/2026): niente più merge additivo con la versione remota. Un merge
// {...remoto, ...locale} può solo AGGIUNGERE/sovrascrivere chiavi, mai rimuoverle —
// quindi una tessera cancellata dall'utente riappariva sempre al salvataggio
// successivo (bug reale segnalato da Fabio). Lo stato locale, caricato fresco alla
// selezione dell'alunno (vedi loadStudentFromDrive), è l'unica versione autorevole:
// si scrive quello così com'è (last-write-wins), niente merge.
export async function saveStudentToDrive(studentName, dict, custom, labels = {}) {
  if (!isDriveConnected()) return;

  updateDriveButton('syncing');

  try {
    const shareCode = await _getEffectiveShareCode(studentName);

    if (shareCode) {
      // Alunno condiviso (proprio, condiviso in passato, o ricevuto da una collega):
      // Firebase è la fonte di verità unica per tutti.
      const token = await _fbAuthToken();
      const payload = JSON.stringify({
        dict: dict || {}, custom: custom || {}, labels: labels || {},
        student: studentName, updatedAt: new Date().toISOString(),
      });
      const putResp = await fetch(`${FIREBASE_DB_URL}/caartella-shared/${shareCode}.json?auth=${token}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload
      });
      if (!putResp.ok) throw new Error('Salvataggio condiviso fallito (' + putResp.status + ')');

      updateDriveButton('connected');
      flashSaved();
      showDriveToast(`✅ Vocabolario di "${studentName || 'Anonimo'}" salvato (condiviso)`);
      return dict;
    }

    // Alunno proprio, mai condiviso: backup personale su Drive (drive.file, file creato da questa app)
    if (!driveState.folderId) return;
    const fileName = `vocabolario-${sanitizeName(studentName || '_anonimo')}.json`;
    let { fileId } = await _findVerifiedOwnFile(studentName);

    const payload = JSON.stringify({
      dict:    dict   || {},
      custom:  custom || {},
      labels:  labels || {},
      student: studentName,
      savedAt: new Date().toISOString(),
    });

    if (!fileId) {
      const result = await createDriveFile(fileName, payload);
      fileId = result.id;
    } else {
      await updateDriveFile(fileId, payload);
    }
    driveState.ownFileIds = driveState.ownFileIds || {};
    driveState.ownFileIds[studentName] = fileId;
    saveDriveState();

    updateDriveButton('connected');
    flashSaved();
    showDriveToast(`✅ Vocabolario di "${studentName || 'Anonimo'}" salvato su Drive`);
    return dict;
  } catch(err) {
    updateDriveButton('error');
    console.error('[Drive] Errore salvataggio:', err);
  }
}

// ── Carica dizionario alunno (Drive personale, o Firebase se condiviso) ──
export async function loadStudentFromDrive(studentName) {
  if (!isDriveConnected()) return null;

  try {
    const shareCode = await _getEffectiveShareCode(studentName);
    if (shareCode) {
      const token = await _fbAuthToken();
      const resp = await fetch(`${FIREBASE_DB_URL}/caartella-shared/${shareCode}.json?auth=${token}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return data || null;
    }

    // Altrimenti cerca nel folder personale (con autoverifica della cache)
    if (!driveState.folderId) return null;
    const { content } = await _findVerifiedOwnFile(studentName);
    return content;
  } catch(err) {
    console.error('[Drive] Errore caricamento:', err);
    return null;
  }
}

// ── Elenca alunni presenti su Drive ──────────────────────────────
export async function listStudentsOnDrive() {
  if (!isDriveConnected() || !driveState.folderId) return [];

  let ownStudents = [];
  try {
    const q = encodeURIComponent(
      `'${driveState.folderId}' in parents and name contains 'vocabolario-' and trashed=false`
    );
    const resp = await driveApiFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    ownStudents = (resp.files || []).map(f => {
      const name = f.name
        .replace(/^vocabolario-/, '')
        .replace(/\.json$/, '')
        .replace(/^_anonimo$/, '');
      return { name, fileName: f.name };
    });
  } catch(e) {}

  // Aggiunge anche gli studenti condivisi (ripristinati dall'indice)
  const sharedStudents = Object.keys(driveState.sharedShareCodes || {})
    .filter(name => name && name !== '')
    .map(name => ({ name, fileName: `vocabolario-${name}.json`, shared: true }));

  // Unifica evitando duplicati
  const seen = new Set(ownStudents.map(s => s.name));
  sharedStudents.forEach(s => { if (!seen.has(s.name)) ownStudents.push(s); });

  return ownStudents;
}

// ── Restituisce il codice da condividere (= folder ID) ────────────
export function getShareCode() {
  return driveState.folderId || '';
}

// ── Disconnetti Drive ─────────────────────────────────────────────
export function disconnectDrive(onDisconnect) {
  if (!confirm(
    'Disconnetto Drive e rimuovo i dati di accesso da questo browser.\n' +
    'Il dizionario sul Drive rimane al sicuro. Confermi?'
  )) return;
  if (driveState.accessToken && typeof google !== 'undefined' && google.accounts) {
    google.accounts.oauth2.revoke(driveState.accessToken);
  }
  // Privacy PC condiviso (18/07/2026): sharedShareCodes NON viene più preservato alla
  // disconnessione — su un PC condiviso non deve restare nessuna traccia locale, nemmeno
  // quale codice corrisponde a quale nome. Le condivisioni ricevute si recuperano comunque
  // alla riconnessione tramite indice-condivisi.json su Drive (restoreSharedIndex), quindi
  // non si perde nulla di reale — si perde solo la cache locale, che è proprio l'obiettivo.
  // scopeVersion invece resta: non è un dato dell'alunno, serve solo a evitare di richiedere
  // di nuovo il consenso OAuth pieno se lo scope era già stato aggiornato.
  const savedScopeVersion = driveState.scopeVersion;
  driveState = {
    enabled: false, accessToken: null, tokenExpiry: 0,
    folderId: null, userEmail: '', sharedMode: false,
    sharedShareCodes: {}, ownFileIds: {},
    scopeVersion: savedScopeVersion,
  };
  saveDriveState();
  updateDriveButton();
  showDrivePanel('connect');
  onDisconnect && onDisconnect();
}

// ── Helper: chiamate Drive API ────────────────────────────────────
async function driveApiFetch(url, method, body) {
  const opts = {
    method: method || 'GET',
    headers: { Authorization: 'Bearer ' + driveState.accessToken }
  };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error('Drive API error ' + resp.status);
  // Una DELETE riuscita risponde 204 senza corpo — .json() andrebbe in errore
  // anche se l'operazione è riuscita (usato da deleteStudentFromDrive).
  if (resp.status === 204) return null;
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function findStudentFile(fileName) {
  const q = encodeURIComponent(
    `name='${fileName}' and '${driveState.folderId}' in parents and trashed=false`
  );
  const resp = await driveApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
  );
  return (resp.files && resp.files.length > 0) ? resp.files[0].id : null;
}

async function loadFileContent(fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: 'Bearer ' + driveState.accessToken } }
  );
  if (!resp.ok) throw new Error('Lettura Drive fallita (' + resp.status + ')');
  return resp.json();
}

async function createDriveFile(fileName, content) {
  const boundary = 'caa_' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify({ name: fileName, parents: [driveState.folderId] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + driveState.accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body
    }
  );
  if (!resp.ok) throw new Error('Creazione file Drive fallita (' + resp.status + ')');
  return resp.json();
}

async function updateDriveFile(fileId, content) {
  const boundary = 'caa_' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + driveState.accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body
    }
  );
  if (!resp.ok) throw new Error('Aggiornamento Drive fallito (' + resp.status + ')');
  return resp.json();
}

// ── UI: Modal Drive ───────────────────────────────────────────────
export function openDriveModal() {
  const panel = isDriveConnected() ? 'connected' : 'connect';
  if (panel === 'connected') _refreshConnectedPanel();
  showDrivePanel(panel);
  document.getElementById('drive-modal').style.display = 'flex';
}

export function closeDriveModal() {
  document.getElementById('drive-modal').style.display = 'none';
}

export function showDrivePanel(panel, errorMsg) {
  ['drive-panel-connect', 'drive-panel-connected', 'drive-panel-error', 'drive-panel-code']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  const target = {
    connect:   'drive-panel-connect',
    connected: 'drive-panel-connected',
    error:     'drive-panel-error',
    code:      'drive-panel-code',
  }[panel];
  if (target) document.getElementById(target).style.display = 'block';
  if (errorMsg) {
    const el = document.getElementById('drive-error-text');
    if (el) el.textContent = errorMsg;
  }
}

function _refreshConnectedPanel() {
  const emailEl = document.getElementById('drive-user-email');
  if (emailEl) emailEl.textContent = driveState.userEmail;
  const modeEl  = document.getElementById('drive-mode-label');
  if (modeEl)  modeEl.textContent = driveState.sharedMode ? '📂 Cartella condivisa' : '📁 Cartella personale';
  // NOTA: drive-share-code NON viene impostato qui — solo _refreshDriveSharePanel (app.js)
  // lo imposta con il codice corretto. Impostarlo qui con folderId causava il bug "404".
  // Bottone "Apri CAArtella su Drive" — visibile sempre quando c'è il folderId
  const folderBtn = document.getElementById('drive-open-folder-btn');
  if (folderBtn) folderBtn.style.display = driveState.folderId ? 'inline-flex' : 'none';
}

// ── UI: Toast salvataggio ─────────────────────────────────────────
export function showDriveToast(msg) {
  const toast = document.getElementById('drive-toast');
  if (!toast) return;
  const msgEl = toast.querySelector('.drive-toast-msg');
  if (msgEl) msgEl.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── Utility ───────────────────────────────────────────────────────
function sanitizeName(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim() || '_anonimo';
}
