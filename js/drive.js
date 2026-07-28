// ══════════════════════════════════════════════════════════════════
//  drive.js — Google Drive OAuth (backup personale) + Firebase RTDB
//  (condivisione vocabolario tra colleghe) per CAArtella
//  Adattato da Valutazione Primaria (Drive) e da EduBoard (Firebase auth anonimo)
// ══════════════════════════════════════════════════════════════════

import {
  markEphemeralStudent, unmarkEphemeralStudent, renameEphemeralStudent,
} from './ephemeral-store.js';

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
    // FIX (20/07/2026 — BUG RADICE trovato con Opus dopo 3 giorni): questo ramo
    // "token ancora valido" chiamava onConnected() DIRETTAMENTE, saltando
    // restoreSharedIndex(). Conseguenza: dopo un reload con token ancora fresco
    // (< ~1h), l'account che aveva RICEVUTO una condivisione non ripristinava
    // sharedShareCodes dall'indice su Drive → _getEffectiveShareCode ritornava
    // null → l'alunno condiviso veniva trattato come alunno PROPRIO → le modifiche
    // finivano in un file Drive personale scollegato invece che su Firebase, e le
    // due copie (proprietario via Firebase, destinatario via file personale) non
    // si sincronizzavano mai. Bug intermittente perché dipendeva dalla validità
    // del token OAuth: reload entro l'ora = si scollega, dopo l'ora (silent auth) =
    // funzionava. restoreSharedIndex() era infatti già chiamato nel ramo
    // trySilentAuth e in initDriveConnection, ma non qui. Ora allineato.
    const proceed = () => { onConnected && onConnected(); };
    if (driveState.folderId) {
      restoreSharedIndex().then(proceed).catch(proceed);
    } else {
      proceed();
    }
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

// ── Google Identity Services caricato solo quando serve (28/07/2026) ─────
// Prima stava in un <script> nell'<head>: Google veniva contattato all'apertura
// dell'app da CHIUNQUE, anche da chi non avrebbe mai collegato Drive, prima di
// qualsiasi scelta dell'utente. Ora lo script si carica solo quando si manifesta
// l'intenzione di usare Drive — cioè aprendo il pannello Drive.
//
// ⚠️ Il precaricamento all'apertura del PANNELLO non è un dettaglio: GIS apre un
// popup OAuth, e i browser lo bloccano se non parte a ridosso del click. Se lo
// caricassimo solo al click su "Collega", l'attesa dello script consumerebbe il
// gesto dell'utente e il popup verrebbe bloccato (stessa trappola di mailto e
// clipboard, lezione 18/07/2026). Caricandolo all'apertura del pannello, quando
// si clicca "Collega" la libreria è già pronta e la chiamata resta sincrona.
let _gisPromise = null;
export function ensureGisLoaded() {
  if (typeof google !== 'undefined' && google.accounts) return Promise.resolve();
  if (_gisPromise) return _gisPromise;
  _gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src   = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload  = () => resolve();
    s.onerror = () => { _gisPromise = null; reject(new Error('GIS non raggiungibile')); };
    document.head.appendChild(s);
  });
  return _gisPromise;
}

// Il permesso su Drive è stato davvero concesso? Google offre hasGrantedAllScopes,
// ma la risposta contiene comunque l'elenco degli scope accordati: si controlla
// quello come riserva, così la verifica regge anche se l'API cambia forma.
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
function _hasDriveScope(tokenResponse) {
  try {
    if (google?.accounts?.oauth2?.hasGrantedAllScopes) {
      return google.accounts.oauth2.hasGrantedAllScopes(tokenResponse, DRIVE_FILE_SCOPE);
    }
  } catch(e) { /* si passa al controllo diretto qui sotto */ }
  return typeof tokenResponse?.scope === 'string' && tokenResponse.scope.includes(DRIVE_FILE_SCOPE);
}

// ── Click su "Collega a Google Drive" ────────────────────────────
export async function connectToDrive() {
  try {
    await ensureGisLoaded(); // di norma già risolta: precaricata all'apertura del pannello
  } catch(e) {
    showDrivePanel('error',
      'Impossibile contattare Google per il collegamento. Controlla la connessione ' +
      '(o il filtro di rete della scuola) e riprova.');
    return;
  }
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
      // Permessi granulari di Google (visto dal vivo nel test del 28/07/2026): nella
      // schermata di consenso il permesso su Drive ha una CASELLA DA SPUNTARE, e si
      // può cliccare "Continua" senza selezionarla. In quel caso Google restituisce
      // comunque un token valido, ma SENZA l'accesso a Drive: l'app si crederebbe
      // collegata e fallirebbe ogni salvataggio, lasciando la collega davanti a
      // un'app che "non funziona" senza spiegazione. Meglio accorgersene subito e
      // dirle esattamente cosa fare.
      if (!_hasDriveScope(tokenResponse)) {
        driveState.enabled     = false;
        driveState.accessToken = null;
        driveState.tokenExpiry = 0;
        saveDriveState();
        updateDriveButton();
        showDrivePanel('error',
          'Manca il permesso di accesso a Google Drive. Nella schermata di Google, ' +
          'accanto alla riga "…file di Google Drive specifici che usi con questa app", ' +
          'c\'è una CASELLA da spuntare: va selezionata prima di premere Continua. ' +
          'Senza quel permesso l\'app non può salvare i vocabolari. Clicca "Riprova".');
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
    // Qui l'utente ha già collegato Drive in passato (loadDriveConfig arriva in questo
    // ramo solo se driveState.enabled), quindi caricare GIS è legittimo e atteso: non
    // stiamo contattando Google per chi non l'ha mai usato. Nessun popup di mezzo —
    // il rinnovo è silenzioso (prompt:'') — quindi qui l'attesa non blocca nulla.
    ensureGisLoaded().catch(() => {});
    if (retries > 0) setTimeout(() => trySilentAuth(onReady, retries - 1), 1500);
    else updateDriveButton('error');
    return;
  }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    prompt:    '',
    callback:  (tokenResponse) => {
      // Stesso controllo del collegamento manuale: un token senza il permesso su
      // Drive non vale come connessione (può capitare se il consenso è stato dato
      // a metà, o revocato in parte dalle impostazioni dell'account Google).
      if (tokenResponse.access_token && !_hasDriveScope(tokenResponse)) {
        driveState.enabled     = false;
        driveState.accessToken = null;
        driveState.tokenExpiry = 0;
        saveDriveState();
        updateDriveButton();
        return;
      }
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
    if (name && code) {
      driveState.sharedShareCodes[name] = code;
      // Anche da migrazione: se un browser aveva ancora su disco i dati di un
      // vocabolario ricevuto (versioni fino alla v5.38), qui vengono cancellati.
      // Nessuna perdita: per i condivisi la fonte di verità è Firebase.
      markEphemeralStudent(name);
    }
  });
  saveDriveState();
}

// ── Dimentica un vocabolario condiviso il cui nodo Firebase non esiste più ──
// Chiamata quando il proprietario ha eliminato definitivamente il vocabolario —
// dal lato collega tramite l'evento push (subscribeSharedStudent → onDelete →
// forgetSharedStudent) e dal lato proprietario stesso in deleteStudentFromDrive.
// Pulisce sia lo stato in memoria (sharedShareCodes) sia l'indice persistito su
// Drive (indice-condivisi.json) di QUESTO account — altrimenti al prossimo reload
// restoreSharedIndex() lo ripristinerebbe, e una modifica locale successiva
// (saveStudentToDrive) ricreerebbe silenziosamente il nodo Firebase già eliminato
// dal proprietario (PUT su un path Firebase inesistente lo crea).
async function _forgetSharedStudent(studentName, code) {
  if (driveState.sharedShareCodes?.[studentName] === code) {
    delete driveState.sharedShareCodes[studentName];
    saveDriveState();
  }
  unmarkEphemeralStudent(studentName); // svuota la copia in memoria e l'elenco nomi
  try {
    const entries = await loadSharedIndex();
    const filtered = entries.filter(e => e.code !== code);
    if (filtered.length !== entries.length) await saveSharedIndex(filtered);
  } catch(e) { /* non bloccante: il prossimo tentativo di refresh riproverà */ }
}

// Versione pubblica: app.js la chiama dalla callback onDelete della sottoscrizione
// push quando scopre che un vocabolario condiviso è stato eliminato dal proprietario.
// Ricava lo shareCode dallo stato in memoria (l'alunno è per forza fra i condivisi).
export async function forgetSharedStudent(studentName) {
  const code = driveState.sharedShareCodes?.[studentName];
  if (code) await _forgetSharedStudent(studentName, code);
}

// ── Sposta la mappatura nome→shareCode dopo una rinomina ─────────────────
// Vale SOLO per un vocabolario RICEVUTO da una collega (presente in
// sharedShareCodes): aggiorna sia la memoria di sessione sia l'indice persistito
// su Drive (indice-condivisi.json), che è l'unica traccia che sopravvive a un reload.
// FIX (27/07/2026): questa logica esisteva solo dentro renameStudentOnDrive (rinomina
// manuale), mentre il percorso di ADOZIONE di una rinomina remota (_adoptRemoteRename
// in app.js) la saltava del tutto. Conseguenze reali osservate nel test incrociato del
// 26/07: dopo un'adozione lo shareCode restava archiviato sotto il nome VECCHIO →
// _getEffectiveShareCode(nuovoNome) tornava null → nessuna sottoscrizione push (il lato
// ricevente diventava sordo agli aggiornamenti successivi) e, al reload, l'indice mai
// aggiornato reintroduceva il nome vecchio accanto a quello nuovo → due alunni in elenco
// con lo stesso vocabolario. Unico punto di verità, chiamato da entrambi i percorsi.
export async function remapSharedStudentName(oldName, newName) {
  const code = driveState.sharedShareCodes?.[oldName];
  if (!code) return; // non è un vocabolario ricevuto: niente da rimappare
  delete driveState.sharedShareCodes[oldName];
  driveState.sharedShareCodes[newName] = code;
  saveDriveState(); // parte sincrona: vale anche se il chiamante non attende
  renameEphemeralStudent(oldName, newName); // segue anche la copia in memoria
  try {
    const entries = await loadSharedIndex();
    const entry = entries.find(e => e.code === code);
    if (entry) entry.name = newName; else entries.push({ name: newName, code });
    await saveSharedIndex(entries);
  } catch(e) { /* non bloccante: il nome resta comunque aggiornato per questa sessione */ }
}

// ── Posso rinominare / ricondividere questo vocabolario? ─────────────────
// Regola decisa da Fabio il 26/07/2026: rinomina e ri-condivisione sono riservate
// al PROPRIETARIO. Chi riceve un vocabolario condiviso lo usa e lo modifica, ma non
// può rinominarlo né ricondividerlo — così il campo `student` su Firebase ha una sola
// sorgente di scrittura e il conflitto che generava i doppioni non può più nascere.
// Ritorna: true = proprietario certo · false = ricevuto da una collega ·
// null = NON DETERMINABILE (rete/Drive non raggiungibili). Il chiamante deve trattare
// null come divieto (fail-safe voluto: nel dubbio si VIETA, meglio un'operazione
// rimandata che un doppione da bonificare a mano).
// Distinta da isOwnStudent() più sotto, che risponde a una domanda diversa ("esiste un
// file Drive personale?", usata per l'eliminazione definitiva) e in caso di dubbio
// risponde false senza distinguere l'alunno solo locale: qui invece un alunno creato
// offline o non ancora salvato su Drive è a tutti gli effetti proprio, e va rinominabile.
export async function canManageStudent(studentName) {
  if (!studentName) return true;                       // "uso generico": nessuna condivisione in gioco
  if (!isDriveConnected()) return true;                // alunno solo locale: è suo
  if (driveState.sharedShareCodes?.[studentName]) return false; // ricevuto, certo
  if (!driveState.folderId) return null;               // Drive connesso ma cartella ignota: dubbio
  try {
    const { fileId } = await _findVerifiedOwnFile(studentName);
    if (fileId) return true;                           // file personale trovato: proprietario certo
  } catch(e) {
    return null;                                       // Drive non raggiungibile: dubbio
  }
  // Nessun file personale: può essere un alunno creato in locale e non ancora salvato
  // su Drive (proprio) OPPURE un ricevuto la cui mappa in memoria non è ancora stata
  // ripristinata dopo un reload (sharedShareCodes vive solo in sessione). Si rilegge
  // l'indice condivisi su Drive, che è la fonte persistente, invece di indovinare.
  try {
    const entries = await loadSharedIndex();
    return !entries.some(e => e.name === studentName);
  } catch(e) {
    return null;                                       // indice illeggibile: dubbio
  }
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
  markEphemeralStudent(name); // da qui in poi i suoi dati non toccano più il disco
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

// Versione pubblica di _getEffectiveShareCode — usata da app.js per decidere se
// (e a cosa) aprire una sottoscrizione push in tempo reale (vedi subscribeSharedStudent).
export async function getShareCodeForStudent(studentName) {
  return _getEffectiveShareCode(studentName);
}

// ── Sottoscrizione push in tempo reale a un vocabolario condiviso ────────
// FIX (19/07/2026, ripensamento architetturale su richiesta di Fabio): sostituisce
// il polling ogni 25s con una connessione persistente a Firebase via Server-Sent
// Events sulla REST API (nessun SDK Firebase necessario — stesso pattern "token
// nella query string" già usato per le chiamate REST esistenti). Consumo quasi
// zero quando nessuno modifica nulla: Firebase manda un evento SOLO quando il
// nodo cambia davvero, non c'è alcuna richiesta periodica di fondo.
// Ad ogni evento ricarica l'intero nodo con una GET normale invece di provare a
// interpretare il payload `put`/`patch` dell'evento stesso — più semplice e
// robusto, non serve reimplementare la logica di merge-patch di Firebase lato
// client. Ritorna una funzione di annullamento sottoscrizione.
export function subscribeSharedStudent(shareCode, onChange, onDelete) {
  let es = null;
  let closed = false;
  let retryTimer = null;

  async function connect() {
    if (closed) return;
    let token;
    try { token = await _fbAuthToken(); } catch(e) { retry(); return; }
    if (closed) return;
    es = new EventSource(`${FIREBASE_DB_URL}/caartella-shared/${shareCode}.json?auth=${token}`);
    // Un evento SSE arriva SOLO quando il nodo cambia davvero (notifica push reale),
    // quindi qui un `data:null` sulla radice è una cancellazione GENUINA — non è
    // ambiguo come un GET separato (vedi nota in loadStudentFromDrive). Firebase
    // manda esattamente {"path":"/","data":null} quando il nodo viene eliminato
    // con DELETE: in quel caso avvisa onDelete invece di onChange.
    const onPut = (e) => {
      if (closed) return;
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.path === '/' && payload.data === null) {
          if (onDelete) onDelete();
          return;
        }
      } catch(err) { /* payload non interpretabile: tratta come cambiamento generico */ }
      onChange();
    };
    es.addEventListener('put', onPut);
    es.addEventListener('patch', () => { if (!closed) onChange(); });
    es.onerror = () => {
      // Token scaduto o connessione caduta (es. rete assente per un attimo) —
      // richiude e riprova con un token fresco dopo una breve pausa fissa
      // (nessun backoff aggressivo: non è un caso critico, solo pochi utenti alla volta).
      if (es) es.close();
      retry();
    };
  }

  function retry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 5000);
  }

  connect();

  return function unsubscribe() {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (es) es.close();
  };
}

// ── Elenco dei vocabolari RICEVUTI da colleghe (nomi locali) ─────────────
// Serve alla verifica al boot in app.js: sharedShareCodes vive solo in memoria di
// sessione, ma viene ripopolato da restoreSharedIndex() (indice-condivisi.json su
// Drive) prima che l'app riceva il segnale di Drive pronto — quindi al boot è già
// completo. Gli alunni propri non compaiono qui: non c'è nessun proprietario
// esterno che possa eliminarli alle spalle di questo browser.
export function getSharedStudentNames() {
  return Object.keys(driveState.sharedShareCodes || {});
}

// ── Questo vocabolario condiviso esiste ancora? ──────────────────────────
// Aggiunta 28/07/2026 — chiude il buco descritto nel TODO 1 del 27/07: la
// sottoscrizione push è aperta SOLO sull'alunno in vista, quindi se il proprietario
// elimina un vocabolario che la collega non sta guardando, lei non lo scopre mai e
// i dati (dizionario, etichette, immagini — spesso foto scattate in classe) restano
// nel suo browser a tempo indeterminato. Su PC condivisi in sala professori, con
// dati di alunni con disabilità, è il punto che va chiuso.
//
// ⚠️ NON implementata con una GET: Firebase risponde 200 + `null` anche quando le
// REGOLE NEGANO la lettura (lezione 22/07/2026), quindi un GET vuoto è ambiguo e
// cancellerebbe dati validi al primo intoppo di token. Qui si usa invece il **primo
// evento `put` della connessione SSE**, che Firebase manda sempre all'apertura con
// lo stato corrente del nodo: `data:null` su un nodo davvero inesistente è un
// segnale genuino di cancellazione (è esattamente il meccanismo che il 27/07 ha
// ripulito TEST-3 nel momento in cui la collega ha selezionato quel nome). Se
// invece il permesso è negato o l'auth non è valida, Firebase chiude lo stream con
// `cancel`/`auth_revoked` o un errore HTTP: non arriva nessun `put`, e la funzione
// risponde 'unknown'.
//
// Ritorna: 'alive' = il nodo c'è · 'deleted' = eliminato (unico caso che autorizza
// una pulizia) · 'unknown' = non determinabile (token, rete, regole, timeout).
// Il chiamante DEVE trattare 'unknown' come "non toccare nulla": è lo stesso
// fail-safe di canManageStudent (nel dubbio non si distrugge).
export async function checkSharedAlive(shareCode, timeoutMs = 12000) {
  if (!shareCode) return 'unknown';
  let token;
  try { token = await _fbAuthToken(); } catch(e) { return 'unknown'; }

  return new Promise((resolve) => {
    let es = null, timer = null, done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (es) es.close();          // connessione usa-e-getta: si chiude sempre
      resolve(result);
    };
    try {
      es = new EventSource(`${FIREBASE_DB_URL}/caartella-shared/${shareCode}.json?auth=${token}`);
    } catch(e) { return finish('unknown'); }

    es.addEventListener('put', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.path === '/') finish(payload.data === null ? 'deleted' : 'alive');
      } catch(err) { finish('unknown'); }
    });
    // Regole che negano la lettura o token invalidato: mai una cancellazione.
    es.addEventListener('cancel',       () => finish('unknown'));
    es.addEventListener('auth_revoked', () => finish('unknown'));
    es.onerror = () => finish('unknown');
    timer = setTimeout(() => finish('unknown'), timeoutMs);
  });
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
    // Sposta la mappatura nome→codice in memoria E nell'indice su Drive. Senza
    // l'aggiornamento dell'indice, al prossimo reconnect restoreSharedIndex()
    // ripristinerebbe il nome vecchio — bug reale (19/07/2026): una collega rinominava
    // "EMMA ROSSINI" in "EMMA", disconnetteva e riconnetteva, e ricompariva "EMMA
    // ROSSINI". Logica unica in remapSharedStudentName (no-op se non è un ricevuto),
    // condivisa con _adoptRemoteRename in app.js — vedi la nota lì sopra.
    await remapSharedStudentName(oldName, newName);
  }

  // Alunno proprio (file Drive personale trovato): rinomina anche lì, indipendentemente
  // dal ramo Firebase sopra — un alunno condiviso ha comunque un file Drive personale.
  if (fileId) await _renameOwnFile(fileId, oldName, newName);
}

// ── Rinomina il file Drive proprio (nome file + campo "student" interno) ──
// Helper condiviso da renameStudentOnDrive (rinomina diretta) e da
// syncOwnFileNameToDrive (auto-allineamento, vedi sotto).
async function _renameOwnFile(fileId, oldName, newName) {
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

// ── Allinea il nome del file Drive proprio dopo una rinomina fatta da una
// collega (o dal proprietario da un altro dispositivo) ────────────────────
// Un vocabolario condiviso può essere rinominato via Firebase da CHIUNQUE
// abbia accesso (proprietario o collega) — ma solo la sessione del
// PROPRIETARIO può fisicamente rinominare il file sul proprio Drive (Google
// non permette a un altro account di farlo). Bug reale (19/07/2026): quando
// una collega rinominava un alunno condiviso, Firebase si aggiornava subito,
// ma il file Drive del proprietario restava col nome vecchio per sempre — al
// refresh successivo il proprietario vedeva un doppione (nome vecchio dal file
// Drive mai rinominato + nome nuovo adottato in locale da Firebase). Questa
// funzione va chiamata dal lato proprietario ogni volta che si scopre — tramite
// il refresh periodico — che Firebase ha un nome diverso da quello del proprio
// file: se questa sessione è davvero la proprietaria, allinea anche Drive: il
// doppione si autorisolve al giro di sync successivo. Non fa nulla (nessun
// errore) se questa sessione non possiede un file proprio per oldName — cioè
// se a chiamarla è la sessione di una collega, non del proprietario.
export async function syncOwnFileNameToDrive(oldName, newName) {
  if (!isDriveConnected() || !driveState.folderId) return;
  try {
    const { fileId } = await _findVerifiedOwnFile(oldName);
    if (fileId) await _renameOwnFile(fileId, oldName, newName);
  } catch(e) { /* non bloccante: il prossimo refresh riproverà */ }
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
    // Rimuove anche l'eventuale voce residua nel proprio indice-condivisi.json
    // (aggiunta da una rinomina passata, vedi renameStudentOnDrive) — altrimenti
    // resterebbe un riferimento a uno shareCode ormai morto in questo indice.
    await _forgetSharedStudent(studentName, content.shareCode);
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

// Email dell'account Drive attualmente connesso ('' se non connesso) — usata da
// app.js per non attribuire a una collega una modifica fatta da noi stessi.
export function getDriveUserEmail() {
  return driveState.userEmail || '';
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
      // IMPORTANTE (22/07/2026): un corpo `null` NON è interpretato come
      // "vocabolario eliminato" — Firebase RTDB risponde 200 + null anche quando
      // le regole di sicurezza negano la lettura (es. token anonimo scaduto o in
      // rinnovo), caso indistinguibile da una GET. Trattarlo come cancellazione
      // qui rompeva la sincronizzazione a ogni intoppo temporaneo del token
      // (regressione trovata da Fabio 22/07). La cancellazione VERA viene rilevata
      // solo dall'evento push (subscribeSharedStudent → onDelete), che riflette una
      // scrittura reale sul nodo e non è ambiguo. Qui, come prima, un null si
      // ignora in silenzio e si riprova al giro successivo.
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
  // Aprire questo pannello è il momento in cui l'utente manifesta l'intenzione di
  // usare Drive: da qui in poi contattare Google è legittimo e atteso. Caricare la
  // libreria ADESSO, e non al click su "Collega", è ciò che evita che il popup OAuth
  // venga bloccato dal browser (vedi la nota su ensureGisLoaded).
  ensureGisLoaded().catch(() => {}); // l'errore è già gestito da connectToDrive
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
