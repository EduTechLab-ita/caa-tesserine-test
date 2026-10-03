// ══════════════════════════════════════════════════════════════════
//  app.js — Orchestrazione principale: UI, generazione tessere, PDF
// ══════════════════════════════════════════════════════════════════

import {
  loadDictionary, saveDictionary, saveDictionaryForStudent, lookupWord, rememberWord,
  exportDictionary, importDictionaryFromFile,
  getStudentsList, getCurrentStudent, setCurrentStudent, addStudent, removeStudent,
  getLegacyDictionaryCount, loadDictionaryForStudent,
  loadLabelsForStudent, saveLabelsForStudent, purgeAllLocalData,
  renameStudentInList, deleteStudentData,
} from './dictionary.js';

import {
  loadDriveConfig, isDriveConnected, connectToDrive, disconnectDrive,
  saveStudentToDrive, loadStudentFromDrive, listStudentsOnDrive,
  connectSharedFile, isSharedStudent, getStudentShareCode, getDriveFolderUrl,
  openDriveModal, closeDriveModal, showDrivePanel, updateDriveButton, showDriveToast,
  makeShareReady, recordSharedCode, findStudentNameForCode, renameStudentOnDrive,
  isOwnStudent, deleteStudentFromDrive, syncOwnFileNameToDrive,
  getShareCodeForStudent, subscribeSharedStudent, forgetSharedStudent,
  getDriveUserEmail, remapSharedStudentName, canManageStudent,
  getSharedStudentNames, checkSharedAlive,
} from './drive.js';

// I vocabolari RICEVUTI non toccano il disco: dizionario, etichette e immagini
// passano da qui (memoria di sessione) invece che da localStorage — vedi il
// perché in cima a ephemeral-store.js.
import {
  studentStoreGet, studentStoreSet, studentStoreRemove, isEphemeralStudent,
  purgeAllStudentDataFromDisk,
} from './ephemeral-store.js';

// Sceglie il nome locale definitivo per un vocabolario ricevuto via condivisione,
// evitando di sovrascrivere un alunno già esistente con lo stesso nome (es. due
// colleghe hanno entrambe un'alunna "Emma", persone diverse). Se questo stesso
// codice era già stato sincronizzato prima, riusa sempre lo stesso nome scelto
// allora (stabile sync dopo sync).
function _resolveIncomingStudentName(suggestedName, code) {
  const already = findStudentNameForCode(code);
  if (already) return already;
  if (!getStudentsList().includes(suggestedName)) return suggestedName;
  let n = 2, candidate = `${suggestedName} (${n})`;
  while (getStudentsList().includes(candidate)) { n++; candidate = `${suggestedName} (${n})`; }
  return candidate;
}

import { parseText, parseTextToPhrases }                from './parser.js';
import { searchPictograms, getPictogramUrl,
         fetchImageAsDataURL, getMarkedPictogramUrl,
         isPluralForm }                                 from './arasaac.js';
import { getCandidates, contextParticiple }             from './lemmatizer.js';
import { initGuida }                                    from './guida.js';
import { createBook }                                   from './libretto.js';
import {
  addCustomImage, removeCustomImage,
  fileToDataURL, exportAll, importAll, CUSTOM_PREFIX,
} from './custom-images.js';

// ── Nessun dato di vocabolario resta su questo computer (28/07/2026) ──────
// Prima riga eseguita dall'app, prima di qualsiasi lettura: toglie dal disco ogni
// residuo delle versioni fino alla v5.39 (dizionari, etichette, foto, elenco
// alunni). Da qui in poi nulla viene più scritto — i dati vivono su Drive/Firebase
// se si è collegati, altrimenti solo finché la scheda resta aperta.
purgeAllStudentDataFromDisk();

// ── Stato globale ──────────────────────────────────────────────
let dictionary     = loadDictionary();
let _driveSaveTimer = null; // debounce per sync Drive
// Sottoscrizione push attiva (vedi _resubscribeLive più sotto) — dichiarata qui
// in cima, non vicino al suo primo uso: loadDriveConfig() poco sotto può chiamare
// _resubscribeLive SINCRONAMENTE (token già in cache) durante il caricamento
// iniziale del modulo, prima che l'esecuzione arrivi alla riga di dichiarazione
// se questa restasse più in basso — un `let` non è accessibile prima della sua
// riga (temporal dead zone), a differenza delle function declaration che sono
// hoistate. Bug reale trovato da Fabio in test dal vivo (19/07/2026).
let _liveUnsubscribe = null;
// Incrementato ad ogni cambio alunno: se l'utente cambia di nuovo selezione mentre
// un caricamento Drive precedente è ancora in corso, la risposta "vecchia" arriva
// comunque ma va scartata — altrimenti può sovrascrivere il dizionario dell'alunno
// SBAGLIATO (quello nel frattempo selezionato), contaminandolo. Causa reale di un
// caso di dati mescolati tra due alunni segnalato da Fabio il 18/07/2026.
// Stessa ragione di _liveUnsubscribe sopra per la posizione in cima al file: da
// quando _refreshCurrentStudentFromDrive viene chiamata anche sincronamente al
// boot (20/07/2026), una dichiarazione più in basso causava un ReferenceError
// da temporal dead zone ("Cannot access before initialization") a ogni avvio.
let _selectorLoadToken = 0;
// Elenco notifiche della SOLA sessione corrente (nessuna persistenza tra sessioni,
// richiesta esplicita di Fabio 20/07/2026). Ogni voce: {text, time, read}. La
// campanella mostra il numero di non lette; al clic si apre il pannello e si
// marcano tutte come lette.
let _notifications = [];
/**
 * @type {Array<{
 *   word:string, id:number|null, imageUrl:string|null, dataURL:string|null,
 *   alts:Array, lemma:string|null  // lemma: forma base usata per la ricerca (null = stessa parola)
 * }>}
 */
let tiles          = [];
/** Parole che sono state lemmatizzate: {ORIGINALE → lemma} */
let lemmaLog       = {};
let customImages  = loadCustomImagesForStudent(getCurrentStudent());
let customLabels  = loadLabelsForStudent(getCurrentStudent());
let currentOptions = { cols: 4, rows: 5, tileSize: 45, orientation: 'portrait' };

// ── Riferimenti DOM ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const openInfo  = initGuida($('app-version')?.textContent || '');
const closeInfo = () => $('info-overlay').classList.add('hidden');

const txtInput       = $('txt-input');
const selCols        = $('sel-cols');
const selRows        = $('sel-rows');
const selSize        = $('sel-size');
const selOrient      = $('sel-orient');
const chkStop        = $('chk-stopwords');
const chkMarkPlural  = $('chk-mark-plural');
const chkMarkTense   = $('chk-mark-tense');
const btnGenerate    = $('btn-generate');
const btnPrintVocab  = $('btn-print-vocab');
const statusDiv      = $('status');
const statusBanner   = $('status-banner');
const secPreview     = $('sec-preview');
const lblCount       = $('lbl-count');
const lblPages       = $('lbl-pages');
const btnPdf         = $('btn-pdf');
const btnExportDict  = $('btn-export-dict');
const fileImportDict = $('file-import-dict');
const modalOverlay   = $('modal-overlay');
const modalWord      = $('modal-word');
const modalAlts      = $('modal-alternatives');
const modalClose     = $('modal-close');

// ── Event listeners ────────────────────────────────────────────
btnGenerate.addEventListener('click',    handleGenerate);
btnPrintVocab.addEventListener('click',  handlePrintVocab);
btnPdf.addEventListener('click',         handleExportPDF);
btnExportDict.addEventListener('click',  () => exportAll(dictionary, customImages, customLabels));
fileImportDict.addEventListener('change', handleImportDict);
modalClose.addEventListener('click',     closeModal);
modalOverlay.addEventListener('click',   e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown',     e => { if (e.key === 'Escape') { closeModal(); closeInfo(); } });

// Info panel
$('btn-info').addEventListener('click',   () => openInfo());
$('info-close').addEventListener('click', closeInfo);
$('info-overlay').addEventListener('click', e => { if (e.target === $('info-overlay')) closeInfo(); });

// ══════════════════════════════════════════════════════════════════
//  MARCATORI GRAMMATICALI (v5.49)
//  Segno disegnato da ARASAAC sul pittogramma: + plurale, ← passato, → futuro.
//  tile.autoMarker = segno riconosciuto in automatico · _markerOverrides = scelta
//  fatta a mano dalla maestra per una parola, valida finché la pagina resta aperta.
// ══════════════════════════════════════════════════════════════════
const _markerOverrides = new Map();   // PAROLA → 'plurale' | 'passato' | 'futuro' | null
const _markerCache     = new Map();   // PAROLA → segno automatico già calcolato
const MARKER_LABEL = { plurale: 'plurale (+)', passato: 'passato (←)', futuro: 'futuro (→)' };

// Le tre caselle della frase ripartono SPENTE a ogni apertura (deciso con Fabio,
// v5.50): su un PC condiviso la scelta di una collega non deve restare accesa per la
// successiva. Esplicito perché il browser, ricaricando, può ripristinare le spunte.
chkStop.checked = chkMarkPlural.checked = chkMarkTense.checked = false;
try { localStorage.removeItem('caa_marker_prefs_v1'); } catch { /* residuo della v5.49 */ }

function effectiveMarker(tile) {
  if (_markerOverrides.has(tile.word)) return _markerOverrides.get(tile.word);
  const m = tile.autoMarker;
  if (m === 'plurale') return chkMarkPlural.checked ? m : null;
  if (m === 'passato' || m === 'futuro') return chkMarkTense.checked ? m : null;
  return null;
}

function tileImageUrl(tile) {
  const custom = customImages[tile.word];
  if (custom) return custom;
  return tile.id ? getMarkedPictogramUrl(tile.id, effectiveMarker(tile)) : null;
}

// Se l'immagine col segno non arriva, meglio la tessera senza segno che il ❓.
async function fetchTileDataURL(tile) {
  const d = await fetchImageAsDataURL(tile.imageUrl);
  if (d || !tile.id || customImages[tile.word]) return d;
  return fetchImageAsDataURL(getPictogramUrl(tile.id));
}

// Per le parole già nel vocabolario (nessuna ricerca fatta in questa generazione).
// Prima il plurale, che lo dice ARASAAC con certezza; poi il tempo del verbo.
async function _detectMarker(word) {
  if (_markerCache.has(word)) return _markerCache.get(word);
  let marker = null;
  const own = await searchPictograms(word).catch(() => []);
  if (isPluralForm(word, own)) {
    marker = 'plurale';
  } else {
    for (const { candidate, tense } of getCandidates(word)) {
      const found = await searchPictograms(candidate).catch(() => []);
      if (found.length > 0) { marker = tense; break; }
    }
  }
  _markerCache.set(word, marker);
  return marker;
}

// Passato prossimo: "sono andate", "hanno finito". Da sola "andate" può essere anche
// "voi andate", ma dopo un ausiliare è sicuramente un participio.
const AUSILIARI = new Set(['HO', 'HAI', 'HA', 'ABBIAMO', 'AVETE', 'HANNO', 'SONO', 'SEI', 'È',
  'SIAMO', 'SIETE', 'ERO', 'ERI', 'ERA', 'ERAVAMO', 'ERAVATE', 'ERANO', 'AVEVO', 'AVEVA', 'AVEVANO']);
const PARTICIPIO = /(AT|UT|IT)[OAIE]$/;
function _applyAuxPast(tilesArr) {
  for (const t of tilesArr) {
    if (t.autoMarker == null && t.afterAux && PARTICIPIO.test(t.word)) t.autoMarker = 'passato';
  }
}

async function ensureAutoMarkers(tilesArr) {
  const todo = [...new Set(tilesArr.filter(t => t.id && !t._markerDone).map(t => t.word))];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const w = todo[next++];
      const m = await _detectMarker(w);
      // Solo le tessere ancora da decidere: "ha letto" ha già il segno dal contesto.
      tilesArr.forEach(t => { if (t.word === w && !t._markerDone) { t.autoMarker = m; t._markerDone = true; } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  _applyAuxPast(tilesArr);
}

function _prefetchTileImages() {
  return Promise.all(tiles.filter(t => t.imageUrl && !t.dataURL).map(async t => {
    const url = t.imageUrl;
    const d = await fetchTileDataURL(t);
    if (t.imageUrl === url) t.dataURL = d;   // nel frattempo l'interruttore può aver cambiato immagine
  }));
}

function refreshTileImages() {
  for (const t of tiles) {
    const url = tileImageUrl(t);
    if (url !== t.imageUrl) { t.imageUrl = url; t.dataURL = customImages[t.word] || null; }
  }
  renderPages();
  _prefetchTileImages();
}

function _markerSummary() {
  const seen = new Set(), parts = [];
  for (const t of tiles) {
    const m = effectiveMarker(t);
    if (m && !seen.has(t.word)) { seen.add(t.word); parts.push(`${t.word.toLowerCase()} ${MARKER_LABEL[m].slice(-3)}`); }
  }
  return parts;
}

async function _onMarkerToggle() {
  if (tiles.length === 0) return;
  if ((chkMarkPlural.checked || chkMarkTense.checked) && tiles.some(t => t.id && !t._markerDone)) {
    showStatus('⏳ Cerco plurali e tempi dei verbi…');
    await ensureAutoMarkers(tiles);
  }
  refreshTileImages();
  const parts = _markerSummary();
  showStatus(parts.length
    ? `🔤 Segni grammaticali: ${parts.join(', ')}`
    : '🔤 Nessun segno grammaticale sulle tessere.', 'success');
}
chkMarkPlural.addEventListener('change', _onMarkerToggle);
chkMarkTense.addEventListener('change', _onMarkerToggle);

// "Rimuovi articoli…" cambia QUALI tessere ci sono: dopo una generazione dal testo si
// rigenera da sola (le parole già cercate tornano dal vocabolario, quindi è rapido).
// Non vale per il vocabolario completo, che non nasce da una frase.
let _lastSource = null;   // 'text' | 'vocab'
let _autoRegen  = false;
chkStop.addEventListener('change', () => {
  if (tiles.length === 0 || _lastSource !== 'text' || btnGenerate.disabled) return;
  _autoRegen = true;
  handleGenerate();
});

// ── Inizializza selettore alunno ────────────────────────────────
initStudentSelector();

// ── Inizializza Drive ───────────────────────────────────────────
// FIX (20/07/2026, bug reale trovato in test dal vivo): prima si contava solo
// sulla sottoscrizione push per scoprire novità — se l'alunno corrente era già
// selezionato da una sessione precedente, il suo vocabolario restava quello
// della cache locale finché non si cambiava esplicitamente alunno dal menu,
// anche dopo un reload completo della pagina. Ora si fa sempre anche un fetch
// immediato "one-shot" (_refreshCurrentStudentFromDrive) appena Drive è pronto,
// così l'alunno già in vista si allinea subito all'ultima versione remota
// invece di aspettare passivamente il prossimo evento push.
_refreshLocalWarning(); // stato iniziale: mostrato finché Drive non risponde

loadDriveConfig(() => {
  // Drive connesso al caricamento pagina (token già valido o silent auth)
  // La verifica dei condivisi parte quando l'elenco alunni è stato ricostruito da
  // Drive, non in parallelo: le voci che risultano eliminate devono poter sparire
  // da un elenco già popolato, altrimenti il sync successivo le rimetterebbe.
  syncStudentListFromDrive().finally(() => _verifySharedStudentsAtBoot());
  _resubscribeLive(getCurrentStudent());
  _refreshCurrentStudentFromDrive();
  _refreshLocalWarning();
});

// Drive connesso dopo login manuale (click sul pulsante) — es. Chromebook pulito
document.addEventListener('caa-drive-connected', () => {
  syncStudentListFromDrive().finally(() => _verifySharedStudentsAtBoot());
  _resubscribeLive(getCurrentStudent());
  _refreshCurrentStudentFromDrive();
  _refreshLocalWarning();
});

// ── Aggiornamento in tempo reale per vocabolari condivisi ──────────
// Prima bisognava deselezionare e riselezionare l'alunno per vedere le tessere
// aggiunte da una collega — non accettabile in classe (segnalato da Fabio
// 18/07/2026). Fix iniziale (18/07/2026): refresh al ritorno in primo piano +
// controllo periodico ogni 25s. RIPENSATO (19/07/2026, richiesta di Fabio): il
// polling ogni 25s consuma banda anche quando nessuno modifica nulla — sostituito
// con una sottoscrizione push (subscribeSharedStudent, vedi drive.js): Firebase
// avvisa l'app SOLO quando il vocabolario condiviso selezionato cambia davvero,
// consumo pressoché zero se nessuno tocca nulla. Il refresh al ritorno in primo
// piano resta come rete di sicurezza (i browser possono sospendere le connessioni
// EventSource in background, specie su tablet/mobile).
// Adotta in locale una rinomina fatta altrove (proprietario o una collega hanno
// cliccato "rinomina" sul loro lato) — il nuovo nome è già la fonte di verità
// remota (Firebase), qui si allinea la copia locale.
// FIX (19/07/2026): quando a rinominare è una COLLEGA (non proprietaria), può
// aggiornare solo Firebase — non può rinominare il file sul Drive del
// proprietario (Google non lo permette). Bug reale osservato da Fabio: il file
// Drive restava con il vecchio nome per sempre, e al refresh successivo
// ricompariva un doppione. Ora, se QUESTA sessione è quella del proprietario
// (syncOwnFileNameToDrive controlla da sola ed esce senza fare nulla se non lo
// è), allinea anche il file Drive — il doppione si autorisolve al giro di sync
// successivo perché il nome sul Drive torna a coincidere con quello adottato qui.
async function _adoptRemoteRename(oldName, newName) {
  const dictToMove   = loadDictionaryForStudent(oldName);
  const labelsToMove = loadLabelsForStudent(oldName);
  const imagesToMove = loadCustomImagesForStudent(oldName);
  saveDictionaryForStudent(newName, dictToMove);
  saveLabelsForStudent(newName, labelsToMove);
  saveCustomImagesForStudent(newName, imagesToMove);
  deleteStudentData(oldName);
  studentStoreRemove(oldName, _customKey(oldName));
  renameStudentInList(oldName, newName);
  setCurrentStudent(newName);
  updateStudentSelector(newName);
  // FIX (27/07/2026): senza questo, lo shareCode restava archiviato sotto il nome
  // VECCHIO (in memoria e nell'indice su Drive) mentre l'alunno in elenco aveva già
  // quello nuovo. Due conseguenze osservate nel test incrociato del 26/07: (1)
  // getShareCodeForStudent(nuovoNome) tornava null → nessuna sottoscrizione push →
  // questo lato non riceveva più NESSUN aggiornamento successivo; (2) al reload
  // restoreSharedIndex() rileggeva l'indice mai aggiornato e reintroduceva il nome
  // vecchio accanto al nuovo → due alunni in elenco con lo stesso vocabolario.
  // La rinomina manuale faceva già questo lavoro (renameStudentOnDrive): ora la
  // logica è una sola, condivisa. No-op se l'alunno non è un condiviso ricevuto.
  await remapSharedStudentName(oldName, newName);
  syncOwnFileNameToDrive(oldName, newName); // no-op se questa sessione non è la proprietaria
}

// FIX (20/07/2026): il controllo document.hidden aveva senso quando questa
// funzione veniva chiamata SOLO da visibilitychange (già garantiva hidden=false)
// e dal listener push (dove aveva lo scopo di rimandare il refresh a quando la
// scheda torna visibile). Da quando viene chiamata anche una volta sola al boot/
// riconnessione Drive (vedi loadDriveConfig in fondo al file), bloccare qui il
// refresh se la scheda è in background impediva proprio il caso che doveva
// risolvere: l'alunno già selezionato restava con la cache vecchia finché non si
// portava la scheda in primo piano o si riselezionava manualmente dal menu.
async function _refreshCurrentStudentFromDrive() {
  let name = getCurrentStudent();
  if (!name || !isDriveConnected()) return;
  const token = ++_selectorLoadToken;
  const driveData = await loadStudentFromDrive(name);
  if (token !== _selectorLoadToken) return; // alunno cambiato nel frattempo
  // null = nessuna novità, oppure intoppo temporaneo del token (vedi la nota in
  // loadStudentFromDrive: un GET vuoto NON è una cancellazione). La cancellazione
  // vera arriva solo dall'evento push, gestita da _handleSharedDeleted. Qui, come
  // prima del 22/07, un null si ignora in silenzio e si riprova al giro dopo.
  if (!driveData) return;

  // Chi ha fatto la modifica (email), solo se diverso da noi — per la notifica.
  const editor = (driveData.updatedBy && driveData.updatedBy !== getDriveUserEmail())
    ? driveData.updatedBy : '';

  // Qualcun altro ha rinominato questo alunno (proprietario o collega) — adotta
  // il nuovo nome in locale così la modifica si propaga anche senza intervento.
  const remoteName = driveData.student;
  const prevName = name;
  let wasRenamed = false;
  if (remoteName && remoteName !== name && !getStudentsList().includes(remoteName)) {
    _adoptRemoteRename(name, remoteName);
    name = remoteName;
    wasRenamed = true;
  }

  const newDict = driveData.dict || {};
  const dictChanged = JSON.stringify(newDict) !== JSON.stringify(dictionary);
  // FIX (19/07/2026, bug trovato da Fabio): prima si usciva qui se il dizionario
  // non era cambiato — ma una rinomina PURA (nessuna parola aggiunta/tolta, solo
  // il nome) non cambia mai il dizionario, quindi la campanella non scattava mai
  // per una semplice rinomina, anche se _adoptRemoteRename sopra aveva già
  // funzionato. Ora l'uscita anticipata vale solo se non è cambiato NULLA.
  if (!dictChanged && !wasRenamed) return;

  // Calcola parole aggiunte/rimosse PRIMA di sovrascrivere `dictionary` (24/07 →
  // richiesta di Fabio: notifiche descrittive, non un generico "aggiornato").
  const added = [], removed = [];
  if (dictChanged) {
    const oldSet = new Set(Object.keys(dictionary));
    const newSet = new Set(Object.keys(newDict));
    for (const k of newSet) if (!oldSet.has(k)) added.push(k);
    for (const k of oldSet) if (!newSet.has(k)) removed.push(k);

    dictionary   = newDict;
    customImages = driveData.custom || {};
    customLabels = driveData.labels || {};
    saveDictionary(dictionary);
    saveCustomImages(customImages);
    saveLabelsForStudent(name, customLabels);
    if (tiles.length > 0) renderPages();
  }

  // ── Notifica descrittiva: cosa è cambiato, e da chi ──
  const changes = [];
  if (wasRenamed)     changes.push(`rinominato "${prevName}" → "${name}"`);
  if (added.length)   changes.push(`➕ ${_fmtWordList(added)}`);
  if (removed.length) changes.push(`➖ ${_fmtWordList(removed)}`);
  const detail = changes.length ? changes.join(' · ') : 'aggiornato';
  const who = editor ? ` — da ${editor}` : '';
  const msg = `🔄 "${name}": ${detail}${who}`;
  showStatus(msg, 'success');
  addNotification(msg);
}

// Elenca fino a `max` parole, poi riassume il resto ("+N altre") — evita notifiche
// chilometriche su un import massiccio o una prima condivisione da 100 parole.
function _fmtWordList(words, max = 6) {
  const clean = words.map(w => w.toLowerCase());
  if (clean.length <= max) return clean.join(', ');
  return clean.slice(0, max).join(', ') + ` +${clean.length - max} altre`;
}

// ── Vocabolario condiviso eliminato dal proprietario (rilevato via push) ──────
// Chiamata dalla callback onDelete della sottoscrizione Firebase (evento push con
// nodo → null): a differenza di un GET vuoto, è un segnale genuino di cancellazione.
// Rimuove l'alunno fantasma e ripulisce lo stato condiviso (memoria + indice Drive).
async function _handleSharedDeleted(name) {
  await forgetSharedStudent(name);
  const wasCurrent = getCurrentStudent() === name;
  // FIX (27/07/2026): prima, se in vista c'era un altro alunno, la funzione usciva
  // qui dopo aver solo "dimenticato" il codice — l'alunno restava in elenco e il suo
  // vocabolario (parole, etichette, immagini) restava nel browser senza più nulla che
  // lo mostrasse o potesse cancellarlo. Dati di alunni con disabilità che sopravvivono
  // a un'eliminazione: inaccettabile lato privacy. Ora la pulizia avviene sempre; solo
  // il ripristino della vista (svuotare l'anteprima, azzerare la selezione) resta
  // condizionato al fatto che fosse davvero l'alunno aperto.
  if (wasCurrent && _liveUnsubscribe) { _liveUnsubscribe(); _liveUnsubscribe = null; }
  removeStudent(name);
  deleteStudentData(name);
  studentStoreRemove(name, _customKey(name));
  if (!wasCurrent) {
    updateStudentSelector(); // mantiene selezionato l'alunno che si stava già guardando
    const bgMsg = `🗑️ Il vocabolario di "${name}" è stato eliminato dal proprietario.`;
    showStatus(bgMsg, 'error');
    addNotification(bgMsg);
    return;
  }
  updateStudentSelector('');
  setCurrentStudent('');
  dictionary   = loadDictionary();
  customImages = loadCustomImagesForStudent('');
  clearPreview();
  const delMsg = `🗑️ Il vocabolario di "${name}" è stato eliminato dal proprietario.`;
  showStatus(delMsg, 'error');
  addNotification(delMsg);
}

// ── Avviso fisso: senza Drive nulla viene salvato (28/07/2026) ───────────
// Va aggiornato ad ogni cambio di stato della connessione, non solo all'avvio:
// chi collega Drive a metà lavoro deve vederlo sparire, e chi si disconnette
// deve vederlo comparire. Il pulsante apre lo stesso pannello del FAB in basso.
function _refreshLocalWarning() {
  const box = document.getElementById('local-warning');
  if (!box) return;
  box.classList.toggle('hidden', isDriveConnected());
}

document.getElementById('local-warning-connect')?.addEventListener('click', () => {
  openDriveModal();
});

// ── Verifica al boot: i vocabolari ricevuti esistono ancora? ─────────────
// Aggiunta 28/07/2026. La sottoscrizione push (_resubscribeLive) copre SOLO
// l'alunno in vista: se il proprietario elimina un vocabolario che questa collega
// non sta guardando, nessun evento arriva mai e voce in elenco + dati locali
// restano nel browser a tempo indeterminato — verificato dal vivo il 27/07 (TEST-3
// è rimasto con dizionario ed etichette finché non è stato selezionato a mano).
// Qui, ad ogni avvio con Drive connesso, si controllano UNO ALLA VOLTA tutti i
// vocabolari ricevuti e si ripulisce quello che il proprietario ha eliminato,
// riusando lo stesso percorso dell'evento push (_handleSharedDeleted): stessa
// pulizia, stessa notifica, nessuna logica duplicata.
// Sequenziale e non in parallelo di proposito: gira in sottofondo subito dopo
// l'avvio, non c'è nessuna fretta e si evita di aprire N connessioni insieme.
// Solo 'deleted' cancella: 'unknown' (token, rete, regole, timeout) non tocca
// niente e si riproverà al prossimo avvio — vedi la nota in checkSharedAlive.
let _bootVerifyRunning = false; // i due percorsi di avvio (token in cache / login manuale) possono sovrapporsi
async function _verifySharedStudentsAtBoot() {
  if (!isDriveConnected() || _bootVerifyRunning) return;
  _bootVerifyRunning = true;
  try {
    await _verifySharedStudents();
  } finally {
    _bootVerifyRunning = false;
  }
}

// FIX (28/07/2026, trovato nel test a due account — regressione da interazione tra
// due modifiche di oggi, entrambe corrette prese da sole): qui c'era un filtro
// `if (!getStudentsList().includes(name)) continue`, sensato finché l'elenco alunni
// stava su disco ed era già pronto all'avvio. Dalla v5.40 l'elenco vive in memoria e
// all'avvio è VUOTO — si popola da Drive subito dopo, in parallelo — quindi la
// verifica girava su una lista vuota, saltava ogni nome e non controllava nulla.
// Sintomo osservato: il vocabolario eliminato dal proprietario restava in elenco
// nel browser della collega, esattamente il caso che questa funzione doveva chiudere.
// Il filtro era solo un'ottimizzazione: _handleSharedDeleted è idempotente (rimuovere
// un alunno che non c'è, o dati che non ci sono, non fa danno), quindi si toglie.
async function _verifySharedStudents() {
  const current = getCurrentStudent();
  for (const name of getSharedStudentNames()) {
    if (name === current) continue;                    // già coperto dalla sottoscrizione live
    const code = await getShareCodeForStudent(name);
    if (!code) continue;
    const state = await checkSharedAlive(code);
    if (state !== 'deleted') continue;
    await _handleSharedDeleted(name);
  }
}

// ── Campanella avvisi + elenco notifiche di sessione (19/07 → 20/07/2026) ──
// FIX (19/07): il messaggio "🔄 Vocabolario aggiornato" scriveva dentro alla pagina
// (#status) — se l'utente era scrollato in alto non lo vedeva mai. La campanella
// nell'header resta sempre in vista. AGGIUNTA (20/07, richiesta di Fabio): il clic
// non si limita più a spegnere il pallino, ma apre un pannello con l'ELENCO delle
// notifiche della sessione (cosa è successo: salvataggi, aggiornamenti da colleghe),
// così restano consultabili anche dopo che il banner in sovraimpressione è sparito.
// Il badge ora è un contatore delle non lette.
function addNotification(text) {
  _notifications.unshift({ text, time: new Date(), read: false });
  if (_notifications.length > 50) _notifications.length = 50; // solo sessione, tetto di sicurezza
  _refreshUpdatesBadge();
  // se il pannello è aperto, riflette subito la nuova voce
  const panel = document.getElementById('updates-panel');
  if (panel && !panel.classList.contains('hidden')) _renderUpdatesPanel();
}

function _refreshUpdatesBadge() {
  const badge = document.getElementById('btn-updates-badge');
  const btn   = document.getElementById('btn-updates');
  const unread = _notifications.filter(n => !n.read).length;
  if (badge) {
    badge.style.display = unread > 0 ? 'block' : 'none';
    badge.textContent   = unread > 0 ? String(unread) : '';
  }
  if (btn) btn.title = unread > 0 ? `${unread} nuova/e notifica/e — clicca per leggere` : 'Notifiche';
}

function _fmtTime(d) {
  try { return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); }
  catch(e) { return ''; }
}

function _renderUpdatesPanel() {
  const list = document.getElementById('updates-list');
  if (!list) return;
  if (_notifications.length === 0) {
    list.innerHTML = '<div class="updates-empty">Nessuna notifica in questa sessione.</div>';
    return;
  }
  list.innerHTML = _notifications.map(n =>
    `<div class="updates-item ${n.read ? '' : 'unread'}">
       <span class="dot"></span>
       <span class="txt">${n.text.replace(/</g,'&lt;')}<span class="time">${_fmtTime(n.time)}</span></span>
     </div>`
  ).join('');
}

document.getElementById('btn-updates')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('updates-panel');
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  if (willOpen) {
    _renderUpdatesPanel();
    panel.classList.remove('hidden');
    // aprire = leggere: marca tutte come lette e spegni il badge
    _notifications.forEach(n => n.read = true);
    _refreshUpdatesBadge();
  } else {
    panel.classList.add('hidden');
  }
});

// Svuota l'elenco notifiche della sessione
document.getElementById('updates-clear')?.addEventListener('click', (e) => {
  e.stopPropagation();
  _notifications = [];
  _refreshUpdatesBadge();
  _renderUpdatesPanel();
});

// Chiudi il pannello notifiche cliccando fuori
document.addEventListener('click', (e) => {
  const panel = document.getElementById('updates-panel');
  const btn   = document.getElementById('btn-updates');
  if (!panel || panel.classList.contains('hidden')) return;
  if (!panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
    panel.classList.add('hidden');
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _refreshCurrentStudentFromDrive();
});

// ── Sottoscrizione push all'alunno condiviso attualmente selezionato ─────
// Una sola sottoscrizione attiva alla volta (quella dell'alunno in vista) — non
// serve ascoltare tutti i vocabolari condivisi contemporaneamente, solo quello
// che l'utente sta guardando in questo momento. getShareCodeForStudent ritorna
// null per un alunno non condiviso: in quel caso non si apre nessuna connessione.
// (_liveUnsubscribe dichiarata in cima al file, vedi nota lì)
// FIX (28/07/2026, trovato nel test a due account): va richiamata ANCHE dopo la
// pubblicazione di una condivisione (makeShareReady). Chi crea un alunno e lo
// condivide nella stessa sessione lo aveva selezionato quando ancora non esisteva
// nessun codice: getShareCodeForStudent tornava null, la sottoscrizione non si
// apriva, e il proprietario restava sordo agli aggiornamenti della collega fino al
// primo cambio di alunno o reload. È lo stesso difetto chiuso il 27/07 dal lato del
// ricevente (v5.36), qui dal lato di chi condivide.
//
// ⚠️ La callback di CANCELLAZIONE si passa SOLO per i vocabolari RICEVUTI. Su un
// nodo Firebase che non esiste (ancora, o più) il primo evento è `data:null`: per
// un ricevuto significa "il proprietario ha eliminato" ed è giusto ripulire, ma per
// un alunno PROPRIO significherebbe solo "la condivisione non è attiva" — e
// cancellargli l'alunno sarebbe un disastro. Il file su Drive resterebbe, quindi il
// dato non si perde, ma l'alunno sparirebbe dall'elenco sotto gli occhi di chi lo ha
// creato. Nel dubbio non si cancella (stesso fail-safe di canManageStudent).
async function _resubscribeLive(name) {
  if (_liveUnsubscribe) { _liveUnsubscribe(); _liveUnsubscribe = null; }
  if (!name || !isDriveConnected()) return;
  const shareCode = await getShareCodeForStudent(name);
  if (!shareCode) return;
  const ricevuto = isEphemeralStudent(name) || isSharedStudent(name);
  _liveUnsubscribe = subscribeSharedStudent(
    shareCode,
    _refreshCurrentStudentFromDrive,
    ricevuto ? () => _handleSharedDeleted(name) : null,
  );
}

// ── Link magico: ?condividi=CODICE ──────────────────────────────
// Salva il codice in sessionStorage SUBITO (sopravvive al reload OAuth)
const PENDING_SHARE_KEY = 'caa_pending_share_v1';
{
  const fromUrl = new URLSearchParams(location.search).get('condividi');
  if (fromUrl) {
    sessionStorage.setItem(PENDING_SHARE_KEY, fromUrl);
    // Pulisce l'URL senza ricaricare la pagina
    history.replaceState(null, '', location.pathname);
  }
}

function _fillPendingShareInputs(code) {
  const pre  = document.getElementById('shared-code-input-pre');
  const post = document.getElementById('shared-code-input-post');
  if (pre)  pre.value = code;
  if (post) post.value = code;
  // Mostra il banner nel modal
  const banner = document.getElementById('drive-incoming-banner');
  if (banner) {
    banner.style.display = 'block';
    const codeEl = banner.querySelector('#drive-incoming-code');
    if (codeEl) codeEl.textContent = code;
  }
}

function applyPendingShare() {
  const code = sessionStorage.getItem(PENDING_SHARE_KEY);
  if (!code) return;
  _fillPendingShareInputs(code);
  _refreshDriveSharePanel();
  openDriveModal();
  showDriveToast('📥 Codice vocabolario ricevuto! Collega il Drive e clicca Carica.');
}

// Applica il codice dopo che Drive e DOM sono pronti
setTimeout(applyPendingShare, 800);

// Esponi funzioni Drive all'HTML (onclick nei pulsanti del modal)
window._openDriveModal  = () => { _refreshDriveSharePanel(); openDriveModal(); };
window._openDriveFolder = () => {
  const url = getDriveFolderUrl();
  if (url) window.open(url, '_blank');
};
window._closeDriveModal = closeDriveModal;
window._connectDrive    = connectToDrive;
window._disconnectDrive = () => disconnectDrive(() => {
  // Privacy PC condiviso di scuola (18/07/2026): con Drive connesso i dati vivono
  // su Drive/Firebase — alla disconnessione non deve restare nessuna traccia
  // locale (dizionari, immagini custom, nomi alunni) sul browser.
  if (_liveUnsubscribe) { _liveUnsubscribe(); _liveUnsubscribe = null; }
  purgeAllLocalData();
  updateStudentSelector('');
  setCurrentStudent('');
  dictionary   = loadDictionary();
  customImages = loadCustomImagesForStudent('');
  customLabels = loadLabelsForStudent('');
  if (tiles.length > 0) renderPages();
  _refreshLocalWarning(); // da qui in poi nulla verrà più salvato: va detto
});
// Costruisce il testo del messaggio di condivisione (riusato da copia e mailto)
function _buildShareMessage(code, studentName) {
  const shareUrl = `${location.origin}${location.pathname}?condividi=${code}`;
  return `📚 Ti condivido il vocabolario CAA di "${studentName}" tramite CAArtella.

Ora APRI L'APP CAArtella — copia SOLO questo link:


👉  ${shareUrl}


e incollalo nella barra degli indirizzi del browser
(la barra in cima al browser dove si scrivono i siti web, non nel motore di ricerca), poi premi Invio.

Una volta aperta la pagina, si aprirà automaticamente il pannello Drive con il codice già precompilato. Poi:

1. Clicca "Collega a Google Drive" e accedi con il tuo account Google scolastico

   ⚠️ AVVISO NORMALE — La prima volta Google potrebbe mostrare la schermata "Questa app non è verificata".
   Non è un virus. È normale per le app scolastiche interne.
   Come procedere: clicca "Avanzate" (in basso a sinistra) → poi "Vai su edutechlab.it (non sicuro)" → autorizza.
   Questo avviso, se compare, è SOLO la prima volta. Dopo, il collegamento è automatico.

2. Nel box giallo/blu vedrai il codice già pronto — clicca "Carica"
3. Il vocabolario di "${studentName}" apparirà nel selettore alunno!

Da quel momento le nostre modifiche si sincronizzano automaticamente 🎉

---
⚠️ Se il link non si apre correttamente, puoi usare il codice manuale:
Apri ${location.origin}${location.pathname}, clicca "Drive" in alto a destra, collega il tuo account Google, poi incolla questo codice nel box blu "Hai ricevuto un vocabolario?":


👉  ${code}


e clicca Carica.`;
}

// NOTA IMPORTANTE (18/07/2026): clipboard.writeText() e mailto: richiedono di
// avvenire A RIDOSSO SINCRONO del click utente — se prima si aspetta (await) una
// chiamata di rete (es. makeShareReady su Firebase), il browser può bloccare
// silenziosamente l'azione (nessun errore, nessun effetto visibile). Per questo
// l'azione utente (copia/apertura mail) va SEMPRE prima, e la pubblicazione su
// Firebase in background dopo, mai il contrario.
window._copyShareCode   = async () => {
  const code        = document.getElementById('drive-share-code')?.value;
  const studentName = getCurrentStudent();
  if (!code || code.startsWith('—') || code.startsWith('⏳')) return;
  if (isSharedStudent(studentName)) return; // ri-condivisione riservata al proprietario (vedi _emailShareCode)

  const msg = _buildShareMessage(code, studentName);

  try {
    await navigator.clipboard.writeText(msg);
    alert(
      '✅ Messaggio copiato!\n\n' +
      'Incollalo dove preferisci per inviarlo al/alla collega (email, chat, ecc.).\n\n' +
      'Il messaggio contiene già il codice, il link e tutte le istruzioni.'
    );
  } catch(e) {
    alert('⚠️ Non sono riuscito a copiare automaticamente. Codice da condividere manualmente: ' + code);
  }

  // Pubblica lo snapshot corrente su Firebase, in background (non blocca l'azione sopra)
  makeShareReady(code, studentName, dictionary, customImages, customLabels)
    .then(() => _resubscribeLive(studentName)) // vedi nota "il proprietario nasceva sordo"
    .catch(e => showDriveToast('⚠️ Errore pubblicazione condivisione: ' + e.message));
};

// Versione breve del messaggio, SOLO per mailto: i link mailto: hanno un limite
// pratico di ~2000 caratteri (Windows ShellExecute tronca/ignora l'URL oltre questa
// soglia, senza errore visibile) — il messaggio completo di _buildShareMessage() è
// troppo lungo. "Copia messaggio" invece non ha questo limite (va nella clipboard).
function _buildShareMessageShort(code, studentName) {
  const shareUrl = `${location.origin}${location.pathname}?condividi=${code}`;
  return `📚 Ti condivido il vocabolario CAA di "${studentName}" tramite CAArtella.

Apri questo link, si collega tutto in automatico:
👉 ${shareUrl}

Poi clicca "Collega a Google Drive" (accedi col tuo account Google scolastico) e infine "Carica".

⚠️ Se Google mostra "app non verificata": clicca "Avanzate" → "Vai su edutechlab.it" → autorizza. È normale per le app della scuola, capita solo la prima volta.

Se il link non si apre, apri ${location.origin}${location.pathname}, clicca "Drive", collegati e incolla questo codice:
👉 ${code}`;
}

// Apre il client email con oggetto e messaggio già pronti (destinatario da compilare:
// col proprio account scolastico l'autocomplete della rubrica lo suggerisce da solo)
window._emailShareCode = async () => {
  const code        = document.getElementById('drive-share-code')?.value;
  const studentName = getCurrentStudent();
  if (!code || code.startsWith('—') || code.startsWith('⏳')) return;
  // Seconda barriera, sincrona (la prima è nel pannello, vedi _refreshDriveSharePanel):
  // isSharedStudent legge la memoria, non la rete, quindi non rompe il vincolo
  // "mailto: deve partire a ridosso del click".
  if (isSharedStudent(studentName)) return;

  const msg     = _buildShareMessageShort(code, studentName);
  const subject = `Vocabolario CAA condiviso — ${studentName || 'alunno'} (CAArtella)`;
  const mailto  = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(msg)}`;
  // Link <a target="_blank"> cliccato via JS: a differenza sia di location.href
  // (sostituisce la pagina corrente, chiudendo CAArtella) sia di window.open()
  // (non attiva in modo affidabile il gestore di protocollo registrato per mailto:),
  // un vero elemento <a> è gestito correttamente dal browser in entrambi i casi.
  const a = document.createElement('a');
  a.href = mailto;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Pubblica lo snapshot corrente su Firebase, in background (non blocca l'apertura sopra)
  makeShareReady(code, studentName, dictionary, customImages, customLabels)
    .then(() => _resubscribeLive(studentName)) // vedi nota "il proprietario nasceva sordo"
    .catch(e => showDriveToast('⚠️ Errore pubblicazione condivisione: ' + e.message));
};
// Copia solo il codice (file ID)
window._copyCode = () => {
  const code = document.getElementById('drive-share-code')?.value;
  if (!code || code.startsWith('—') || code.startsWith('⏳')) return;
  navigator.clipboard.writeText(code)
    .then(() => alert('✅ Codice copiato!\n\nIncollalo nel box blu "Hai ricevuto un vocabolario?" nell\'app CAArtella.'));
};
// Collegamento vocabolario condiviso — dalla schermata di login (non ancora connessa)
window._connectShared = async () => {
  const input = document.getElementById('shared-code-input-pre');
  const code  = input ? input.value.trim() : '';
  if (!code) { alert('Inserisci il codice ricevuto dal/dalla collega.'); return; }
  try {
    const data = await connectSharedFile(code);
    const finalName = _resolveIncomingStudentName(data.studentName, code);
    recordSharedCode(finalName, code);
    addStudent(finalName);
    // Salva i dati ricevuti in locale
    saveDictionaryForStudent(finalName, data.dict);
    saveCustomImagesForStudent(finalName, data.custom || {});
    saveLabelsForStudent(finalName, data.labels || {});
    updateStudentSelector(finalName);
    setCurrentStudent(finalName);
    dictionary   = data.dict;
    customImages = data.custom || {};
    customLabels = data.labels || {};
    // FIX (27/07/2026 — difetto 1 del test incrociato): senza questo il vocabolario
    // appena installato NON viene messo in ascolto. La sottoscrizione push viene
    // aperta solo dall'handler `change` del selettore, che scatta unicamente se
    // l'utente muove il menù a tendina con la mano: qui l'alunno è selezionato via
    // codice, quindi l'handler non passa mai. Effetto osservato dal vivo (e per due
    // giorni scambiato per "il push non consegna"): chi riceveva un vocabolario
    // restava sordo agli aggiornamenti finché non deselezionava e riselezionava
    // l'alunno a mano — il "giochetto" non era un rimedio a un ritardo, era l'unico
    // modo di far partire l'ascolto.
    _resubscribeLive(finalName);
    closeDriveModal();
    showStatus(finalName === data.studentName
      ? `✅ Vocabolario di "${finalName}" caricato e sincronizzato!`
      : `✅ Vocabolario ricevuto! Avevi già un'alunna/o "${data.studentName}" tuo/a — questo è stato salvato come "${finalName}" per non sovrascriverlo.`,
      'success');
  } catch(err) {
    alert('❌ ' + err.message);
  }
};
// Collegamento vocabolario condiviso — dalla schermata già connessa
window._connectSharedPost = async () => {
  const input = document.getElementById('shared-code-input-post');
  const code  = input ? input.value.trim() : '';
  if (!code) { alert('Inserisci il codice ricevuto dal/dalla collega.'); return; }
  try {
    const data = await connectSharedFile(code);
    const finalName = _resolveIncomingStudentName(data.studentName, code);
    recordSharedCode(finalName, code);
    addStudent(finalName);
    saveDictionaryForStudent(finalName, data.dict);
    saveCustomImagesForStudent(finalName, data.custom || {});
    saveLabelsForStudent(finalName, data.labels || {});
    updateStudentSelector(finalName);
    setCurrentStudent(finalName);
    dictionary   = data.dict;
    customImages = data.custom || {};
    customLabels = data.labels || {};
    _resubscribeLive(finalName); // mette subito in ascolto — vedi nota in _connectShared
    if (input) input.value = '';
    sessionStorage.removeItem(PENDING_SHARE_KEY); // codice usato, pulizia
    const banner = document.getElementById('drive-incoming-banner');
    if (banner) banner.style.display = 'none';
    _refreshDriveSharePanel();
    showStatus(finalName === data.studentName
      ? `✅ Vocabolario di "${finalName}" caricato e attivo!`
      : `✅ Vocabolario ricevuto! Avevi già un'alunna/o "${data.studentName}" tuo/a — questo è stato salvato come "${finalName}" per non sovrascriverlo.`,
      'success');
  } catch(err) {
    alert('❌ ' + err.message);
  }
};

// ══════════════════════════════════════════════════════════════════
//  GENERA TESSERE
// ══════════════════════════════════════════════════════════════════
async function handleGenerate() {
  // Rigenerazione da una casella: l'anteprima resta dov'è, niente salti di pagina.
  const autoRegen = _autoRegen;
  _autoRegen = false;

  const text = txtInput.value.trim();
  if (!text) { showStatus('Inserisci prima un testo.', 'error'); return; }

  const phrases = parseTextToPhrases(text, chkStop.checked);
  if (phrases.length === 0) {
    showStatus('Nessuna parola trovata dopo il filtro. Prova a deselezionare "Rimuovi articoli…".', 'error');
    return;
  }

  _lastSource = 'text';
  lemmaLog = {};
  const allWords = phrases.flat();
  const jobs = [];
  phrases.forEach(phrase => phrase.forEach((word, wi) => jobs.push({
    word, prevWord: wi > 0 ? phrase[wi - 1] : undefined, phraseEnd: wi === phrase.length - 1,
  })));

  const genLabel = btnGenerate.innerHTML;
  const openBook = $('btn-open-book');
  btnGenerate.disabled = true;
  openBook.disabled = true;   // niente libretto mezzo pronto mentre si cerca
  if (!autoRegen) secPreview.classList.add('hidden');
  let ok = 0, fail = 0;
  try {
    // ── 6 parole alla volta (v5.58): prima si cercavano una dopo l'altra, e ogni attesa
    // si sommava (35 tessere: 11 s). Risultati e ordine restano identici: ogni parola
    // finisce al suo posto in `results`, e le tessere nuove sostituiscono le vecchie
    // tutte insieme solo alla fine.
    const results = new Array(jobs.length);
    let next = 0, done = 0;
    const progress = () => {
      btnGenerate.textContent = `⏳ Preparo le tessere… ${done} di ${jobs.length}`;
      showStatus(`⏳ Cerco i pittogrammi… ${done} di ${jobs.length}`);
    };
    progress();
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await _resolveWord(jobs[i]);
        done++;
        progress();
      }
    }));
    const newTiles = results;
    newTiles.forEach(t => {
      t.id ? ok++ : fail++;
      if (t.lemma && !(t.word in lemmaLog)) lemmaLog[t.word] = t.lemma;
    });

    if (chkMarkPlural.checked || chkMarkTense.checked) {
      showStatus('⏳ Cerco plurali e tempi dei verbi…');
      await ensureAutoMarkers(newTiles);
    }
    _applyAuxPast(newTiles);
    newTiles.forEach(t => { t.imageUrl = tileImageUrl(t); });
    tiles = newTiles;

    currentOptions = {
      cols:        parseInt(selCols.value),
      rows:        parseInt(selRows.value),
      tileSize:    parseInt(selSize.value),
      orientation: selOrient.value,
    };
    renderPages();
    // Le immagini per il PDF si scaricano in sottofondo: il libretto le mostra mentre
    // arrivano, e la stampa riprova da sola quelle che mancassero ancora.
    _prefetchTileImages();
  } finally {
    btnGenerate.innerHTML = genLabel;
    btnGenerate.disabled = false;
    openBook.disabled = false;
  }

  // ── Componi messaggio di riepilogo ────────────────────────────
  const lemmaEntries = Object.entries(lemmaLog);
  let msg = fail > 0
    ? `✅ Completato! ${ok} tessere OK, ${fail} parole senza pittogramma (❓).`
    : `✅ Completato! ${allWords.length} tessere generate in ${phrases.length} fras${phrases.length === 1 ? 'e' : 'i'}.`;

  if (lemmaEntries.length > 0) {
    const list = lemmaEntries.map(([orig, base]) => `${orig} → ${base}`).join(', ');
    msg += `\n📝 Forma base usata per: ${list}`;
  }

  const markerParts = _markerSummary();
  if (markerParts.length > 0) msg += `\n🔤 Segni grammaticali: ${markerParts.join(', ')}`;

  showStatus(msg, 'success');
  if (!autoRegen) {
    secPreview.scrollIntoView({ block: 'start' });   // chiudendo il libretto si ritrova la barra
    book.open();
  }
}

// Una parola → la sua tessera: dal vocabolario se c'è, altrimenti da ARASAAC
// (prima l'infinito, poi la parola così com'è). Stessa logica di prima della v5.58,
// solo estratta per poter cercare più parole insieme.
async function _resolveWord({ word, prevWord, phraseEnd }) {
  // "ha letto" → leggere lo decide la parola prima: non si legge né si scrive nel
  // vocabolario, che ha un pittogramma per parola ("vado a letto" resta il mobile).
  const byContext = !!contextParticiple(word, prevWord);
  const savedId = byContext ? null : lookupWord(dictionary, word);
  let id = savedId, alts = [], lemma = null;
  // Segno grammaticale: qui viene gratis dalle ricerche già fatte; per le parole
  // già nel vocabolario lo calcola ensureAutoMarkers, solo se un interruttore è acceso.
  let autoMarker = null;

  if (!savedId) {
    try {
      for (const { candidate, tense } of getCandidates(word, prevWord)) {
        try {
          const candidateAlts = await searchPictograms(candidate);
          if (candidateAlts.length > 0) {
            alts = candidateAlts; lemma = candidate; autoMarker = tense;
            break;
          }
        } catch { /* prossimo candidato */ }
      }
      if (alts.length === 0) {
        alts = await searchPictograms(word);
        if (isPluralForm(word, alts)) autoMarker = 'plurale';
      }
      if (!byContext) _markerCache.set(word, autoMarker);
      if (alts.length > 0) {
        id = alts[0].id;
        if (!byContext) {
          dictionary = rememberWord(dictionary, word, id);
          scheduleDriveSync();
        }
      }
    } catch (e) {
      console.warn('[app] Errore ARASAAC per', word, e.message);
    }
  }
  // Per le parole già nel vocabolario le alternative non si cercano più qui: le cerca
  // la finestra della tessera quando la si apre (prima: una richiesta in più a parola).

  return {
    word,
    id,
    imageUrl:  null,             // assegnato dopo da tileImageUrl, dopo i segni grammaticali
    dataURL:   customImages[word] || null,
    alts,
    lemma,
    autoMarker,
    _markerDone: !savedId,
    afterAux:  !!prevWord && AUSILIARI.has(prevWord),
    phraseEnd,                   // true = ultima parola di questa frase
  };
}

// ══════════════════════════════════════════════════════════════════
//  STAMPA VOCABOLARIO COMPLETO
// ══════════════════════════════════════════════════════════════════
async function handlePrintVocab() {
  if (btnGenerate.disabled) { showStatus('⏳ Attendi: sto ancora preparando le tessere della frase.'); return; }
  const allWords = new Set([
    ...Object.keys(dictionary),
    ...Object.keys(customImages),
  ]);

  if (allWords.size === 0) {
    showStatus('Il vocabolario è vuoto. Prima genera alcune tessere.', 'error');
    return;
  }

  currentOptions = {
    cols:        parseInt(selCols.value),
    rows:        parseInt(selRows.value),
    tileSize:    parseInt(selSize.value),
    orientation: selOrient.value,
  };

  lemmaLog = {};
  _lastSource = 'vocab';
  tiles = [...allWords].sort().map(word => {
    const id           = dictionary[word] ?? null;
    const customDataURL = customImages[word] ?? null;
    return {
      word,
      id,
      imageUrl:  null,
      dataURL:   customDataURL || null,
      alts:      [],
      lemma:     null,
      autoMarker: null,
      _markerDone: false,
      phraseEnd: false,
    };
  });

  if (chkMarkPlural.checked || chkMarkTense.checked) {
    btnPrintVocab.disabled = true;
    showStatus(`⏳ Cerco plurali e tempi dei verbi su ${tiles.length} parole…`);
    await ensureAutoMarkers(tiles);
    btnPrintVocab.disabled = false;
  }
  tiles.forEach(t => { t.imageUrl = tileImageUrl(t); });

  renderPages();
  book.open();
  showStatus(`📖 Vocabolario completo: ${tiles.length} tessere. Clicca "🖨️ Stampa" per stamparlo.`, 'success');
}

// ══════════════════════════════════════════════════════════════════
//  LAYOUT FRASE-AWARE
//  Produce array di pagine; ogni pagina è array di righe;
//  ogni riga è array di (tile | null).  null = cella vuota (fine frase).
// ══════════════════════════════════════════════════════════════════
function computeLayout(tilesArr, cols, rows) {
  const pages = [];
  let page = [];
  let row  = [];

  for (const tile of tilesArr) {
    row.push(tile);
    const rowFull   = row.length >= cols;
    const breakHere = tile.phraseEnd;

    if (rowFull || breakHere) {
      while (row.length < cols) row.push(null);   // padding celle vuote
      page.push(row);
      row = [];
      if (page.length >= rows) {
        pages.push(page);
        page = [];
      }
    }
  }

  // Flush riga/pagina parziale rimasta
  if (row.length > 0) {
    while (row.length < cols) row.push(null);
    page.push(row);
  }
  if (page.length > 0) pages.push(page);

  return pages;
}

// ══════════════════════════════════════════════════════════════════
//  LE TESSERE: barra nella pagina + libretto a tutto schermo (v5.57)
//  Prima le pagine A4 stavano in fondo alla pagina, una sotto l'altra; ora si
//  sfogliano nel libretto. Tutti i punti che cambiano le tessere chiamano
//  renderPages(), che aggiorna la barra e ridisegna il libretto se è aperto.
// ══════════════════════════════════════════════════════════════════
function renderPages() {
  const { cols, rows } = currentOptions;
  lblCount.textContent = tiles.length;
  lblPages.textContent = computeLayout(tiles, cols, rows).length;
  secPreview.classList.remove('hidden');
  _syncBookControls();
  book.render();
}

// Le caselle e i menu del libretto rispecchiano quelli della pagina.
const BOOK_CHECKS  = [[$('bk-stop'), chkStop], [$('bk-plur'), chkMarkPlural], [$('bk-tense'), chkMarkTense]];
const BOOK_SELECTS = [[$('bk-cols'), selCols], [$('bk-rows'), selRows], [$('bk-size'), selSize], [$('bk-orient'), selOrient]];
BOOK_SELECTS.forEach(([b, main]) => { b.innerHTML = main.innerHTML; });

function _syncBookControls() {
  BOOK_CHECKS.forEach(([b, main]) => { b.checked = main.checked; });
  BOOK_SELECTS.forEach(([b, main]) => { b.value = main.value; });
}

const book = createBook({
  layout:    () => computeLayout(tiles, currentOptions.cols, currentOptions.rows),
  geometry:  pageGeometry,
  buildTile: tile => buildTileElement(tile),
  onOpen:    _syncBookControls,
});

// Una casella del libretto agisce come quella della pagina (stesso evento, stessa logica).
BOOK_CHECKS.forEach(([b, main]) => b.addEventListener('change', () => {
  main.checked = b.checked;
  main.dispatchEvent(new Event('change'));
}));
// Colonne, righe, misura e orientamento: dal libretto o dalla pagina, le tessere si rifanno.
function _onSheetChange() {
  _readPrintOptions();
  if (tiles.length > 0) renderPages();
}
BOOK_SELECTS.forEach(([b, main]) => {
  b.addEventListener('change', () => { main.value = b.value; _onSheetChange(); });
  main.addEventListener('change', _onSheetChange);
});
$('bk-print').addEventListener('click', handleExportPDF);
$('btn-open-book').addEventListener('click', () => { if (tiles.length > 0) book.open(); });

function buildTileElement(tile) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.title     = `Clicca per cambiare pittogramma: ${tile.word}`;

  // Icona hover "cambia"
  const hint = document.createElement('span');
  hint.className   = 'swap-hint';
  hint.textContent = '↔';
  el.appendChild(hint);

  // Zona immagine
  const imgWrap = document.createElement('div');
  imgWrap.className = 'tile-img-wrap';

  const customDataURL = customImages[tile.word];
  if (customDataURL) {
    // Immagine personalizzata (priorità su ARASAAC)
    const img = document.createElement('img');
    img.src = customDataURL;
    img.alt = tile.word;
    imgWrap.appendChild(img);
    // Badge 📷 per immagini custom
    const badge = document.createElement('span');
    badge.className   = 'custom-badge';
    badge.title       = 'Immagine personalizzata';
    badge.textContent = '📷';
    el.appendChild(badge);
  } else if (tile.imageUrl) {
    const img = document.createElement('img');
    img.src     = tile.dataURL || tile.imageUrl;
    img.alt     = tile.word;
    img.loading = 'lazy';
    if (tile.id && img.src !== getPictogramUrl(tile.id)) {
      img.onerror = () => { img.onerror = null; img.src = getPictogramUrl(tile.id); };
    }
    imgWrap.appendChild(img);
    const marker = effectiveMarker(tile);
    if (marker) el.title += ` — segno: ${MARKER_LABEL[marker]}`;
  } else {
    const ph = document.createElement('div');
    ph.className   = 'no-image';
    ph.textContent = '❓';
    imgWrap.appendChild(ph);
  }

  // Zona parola (usa etichetta personalizzata se presente)
  const wordEl = document.createElement('div');
  wordEl.className   = 'tile-word';
  const customLabel  = customLabels[tile.word.toUpperCase()];
  wordEl.textContent = customLabel || tile.word;

  // Badge ✏️ se l'etichetta è stata personalizzata
  if (customLabel) {
    const lblBadge = document.createElement('span');
    lblBadge.className   = 'label-badge';
    lblBadge.title       = `Etichetta personalizzata (parola cercata: "${tile.word}")`;
    lblBadge.textContent = '✏️';
    el.appendChild(lblBadge);
  }

  // Badge "≈" se è stata usata la forma base (lemma)
  if (tile.lemma) {
    const badge = document.createElement('span');
    badge.className = 'lemma-badge';
    badge.title     = `Trovato come: "${tile.lemma}"`;
    badge.textContent = '≈';
    el.appendChild(badge);
  }

  el.appendChild(imgWrap);
  el.appendChild(wordEl);

  // Click → modale alternative
  el.addEventListener('click', () => openModal(tile));
  return el;
}

// ══════════════════════════════════════════════════════════════════
//  MODAL SELEZIONE ALTERNATIVA
// ══════════════════════════════════════════════════════════════════
async function openModal(tile) {
  modalWord.textContent = tile.word;
  modalAlts.innerHTML   = '<p style="color:#64748b;font-size:.9rem">Carico alternative…</p>';
  modalOverlay.classList.remove('hidden');

  // ── Carica alternative ARASAAC (con fallback lemmatizzazione) ─
  if (!tile.alts || tile.alts.length === 0) {
    try {
      tile.alts = await searchPictograms(tile.word);
    } catch {
      tile.alts = [];
    }

    // Se ARASAAC non trova nulla, prova la forma base (es. mangia → mangiare)
    if (tile.alts.length === 0) {
      const candidates = getCandidates(tile.word);
      for (const { candidate } of candidates) {
        try {
          const found = await searchPictograms(candidate);
          if (found.length > 0) {
            tile.alts = found;
            tile.lemma = candidate;
            break;
          }
        } catch { /* prossimo */ }
      }
    }
  }

  // ── Render modal ──────────────────────────────────────────────
  modalAlts.innerHTML = '';

  // ── Sezione modifica etichetta (SEMPRE visibile) ──────────────
  const labelSection = document.createElement('div');
  labelSection.className = 'label-edit-section';

  const labelTitle = document.createElement('p');
  labelTitle.className = 'label-edit-title';
  labelTitle.textContent = '✏️ Testo sulla tessera';
  labelSection.appendChild(labelTitle);

  const currentLabel = customLabels[tile.word.toUpperCase()] || '';

  const labelRow = document.createElement('div');
  labelRow.className = 'label-edit-row';

  const labelInput = document.createElement('input');
  labelInput.type        = 'text';
  labelInput.className   = 'label-edit-input';
  labelInput.placeholder = tile.word;
  labelInput.value       = currentLabel;
  labelInput.title       = 'Testo mostrato sulla tessera al posto della parola originale';

  const labelSaveBtn = document.createElement('button');
  labelSaveBtn.className   = 'btn secondary small';
  labelSaveBtn.textContent = '✓ Salva';
  labelSaveBtn.addEventListener('click', () => {
    const newLabel = labelInput.value.trim();
    const wordKey  = tile.word.toUpperCase();
    if (newLabel && newLabel !== tile.word) {
      customLabels[wordKey] = newLabel;
    } else {
      delete customLabels[wordKey];
    }
    saveLabels(customLabels);
    scheduleDriveSync();
    renderPages();
    showStatus(`✏️ Etichetta di "${tile.word}" aggiornata.`, 'success');
    closeModal();
  });

  const labelResetBtn = document.createElement('button');
  labelResetBtn.className   = 'btn small';
  labelResetBtn.textContent = '↩';
  labelResetBtn.title       = 'Ripristina testo originale';
  labelResetBtn.disabled    = !currentLabel;
  labelResetBtn.addEventListener('click', () => {
    delete customLabels[tile.word.toUpperCase()];
    saveLabels(customLabels);
    scheduleDriveSync();
    renderPages();
    closeModal();
  });

  labelRow.appendChild(labelInput);
  labelRow.appendChild(labelSaveBtn);
  labelRow.appendChild(labelResetBtn);
  labelSection.appendChild(labelRow);
  modalAlts.appendChild(labelSection);

  // ── Segno grammaticale scelto a mano (v5.49) ──────────────────
  // Il riconoscimento automatico può sbagliare ("spremuta" presa per un participio):
  // qui la maestra decide, e la scelta vale per tutte le tessere con questa parola
  // finché la pagina resta aperta. Con un'immagine personalizzata il segno non si applica.
  if (tile.id && !customImages[tile.word]) {
    const markSection = document.createElement('div');
    markSection.className = 'label-edit-section marker-section';
    const markTitle = document.createElement('p');
    markTitle.className = 'label-edit-title';
    markTitle.textContent = '🔤 Segno grammaticale sul pittogramma';
    markSection.appendChild(markTitle);

    const current = _markerOverrides.has(tile.word) ? _markerOverrides.get(tile.word) : 'auto';
    const autoTxt = tile.autoMarker ? MARKER_LABEL[tile.autoMarker] : 'nessuno';
    const options = [
      ['auto', `Automatico (${autoTxt})`],
      [null, 'Nessuno'],
      ['plurale', '+ Plurale'],
      ['passato', '← Passato'],
      ['futuro', '→ Futuro'],
    ];
    const row = document.createElement('div');
    row.className = 'marker-options';
    for (const [value, text] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small marker-option' + (value === current ? ' active' : '');
      b.textContent = text;
      b.addEventListener('click', async () => {
        if (value === 'auto') {
          _markerOverrides.delete(tile.word);
          if (!tile._markerDone) await ensureAutoMarkers(tiles.filter(t => t.word === tile.word));
        } else {
          _markerOverrides.set(tile.word, value);
        }
        refreshTileImages();
        const m = effectiveMarker(tile);
        showStatus(`🔤 "${tile.word}": ${m ? 'segno ' + MARKER_LABEL[m] : 'nessun segno'}.`, 'success');
        closeModal();
      });
      row.appendChild(b);
    }
    markSection.appendChild(row);
    if (current === 'auto' && tile.autoMarker && !effectiveMarker(tile)) {
      const note = document.createElement('p');
      note.className = 'marker-note';
      note.textContent = 'Il segno automatico è spento: attivalo con le caselle "Segni grammaticali" sopra il pulsante Genera.';
      markSection.appendChild(note);
    }
    modalAlts.appendChild(markSection);
  }

  // ── Sezione immagine personalizzata (SEMPRE visibile) ────────
  const customSection = document.createElement('div');
  customSection.className = 'custom-upload-section';

  const customDataURL = customImages[tile.word];
  if (customDataURL) {
    const currentCustom = document.createElement('div');
    currentCustom.className = 'current-custom';
    currentCustom.innerHTML = `
      <img src="${customDataURL}" alt="Immagine personalizzata"
           style="width:80px;height:80px;object-fit:contain;border:2px solid #22c55e;border-radius:8px;">
      <span>Immagine personalizzata attiva</span>
      <button class="btn secondary small" id="btn-remove-custom">↩ Ripristina immagine ARASAAC</button>
    `;
    currentCustom.querySelector('#btn-remove-custom').addEventListener('click', () => {
      customImages = removeCustomImage(customImages, tile.word);
      saveCustomImages(customImages);
      scheduleDriveSync();
      refreshTileImages(); // prima restava l'immagine personalizzata finché non si rigenerava
      openModal(tile);
    });
    customSection.appendChild(currentCustom);
  }

  const uploadLabel = document.createElement('label');
  uploadLabel.className = 'custom-upload-label';
  uploadLabel.innerHTML = `
    📁 Carica immagine personalizzata (PNG, JPG, GIF…)
    <input type="file" accept="image/*" style="display:none">
  `;
  uploadLabel.querySelector('input[type=file]').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataURL = await fileToDataURL(file);
      customImages  = addCustomImage(customImages, tile.word, dataURL);
      saveCustomImages(customImages);
      tile.dataURL  = dataURL;
      tile.imageUrl = dataURL;
      scheduleDriveSync();
      renderPages();
      closeModal();
    } catch (err) {
      alert('Errore caricamento immagine: ' + err.message);
    }
  });
  customSection.appendChild(uploadLabel);

  // ── Rimuovi parola dal dizionario ─────────────────────────────
  const forgetBtn = document.createElement('button');
  forgetBtn.className   = 'btn danger small';
  forgetBtn.style.marginTop = '0.5rem';
  forgetBtn.textContent = '🗑️ Rimuovi dal dizionario';
  forgetBtn.title       = 'Elimina questa parola dal vocabolario salvato. Operazione irreversibile.';
  forgetBtn.addEventListener('click', () => {
    if (!confirm(`Rimuovere "${tile.word}" dal dizionario?\n\nQuesta operazione è irreversibile: la tessera scomparirà dal vocabolario salvato.`)) return;
    const wordKey = tile.word.toUpperCase();
    const updated = { ...dictionary };
    delete updated[wordKey];
    dictionary = updated;
    saveDictionary(dictionary);
    if (customImages[wordKey]) {
      customImages = removeCustomImage(customImages, tile.word);
      saveCustomImages(customImages);
    }
    scheduleDriveSync();
    tiles = tiles.filter(t => t.word !== tile.word);
    closeModal();
    renderPages();
    showStatus(`🗑️ "${tile.word}" rimosso dal vocabolario.`, 'success');
  });
  customSection.appendChild(forgetBtn);

  modalAlts.appendChild(customSection);

  // ── Se nessun risultato ARASAAC → messaggio + stop ────────────
  if (tile.alts.length === 0) {
    const noRes = document.createElement('p');
    noRes.style.cssText = 'color:#64748b;font-size:.85rem;text-align:center;padding:0.8rem 0 0.3rem;';
    noRes.textContent   = 'Nessun pittogramma trovato su ARASAAC. Puoi usare un\'immagine personalizzata qui sopra.';
    modalAlts.appendChild(noRes);
    return;
  }

  // ── Divisore + griglia ARASAAC ────────────────────────────────
  const divider = document.createElement('div');
  divider.className   = 'modal-divider';
  divider.innerHTML   = '<span>oppure scegli un pittogramma ARASAAC</span>';
  modalAlts.appendChild(divider);

  tile.alts.forEach(alt => {
    const el = document.createElement('div');
    el.className = 'alt-tile' + (alt.id === tile.id ? ' selected' : '');

    const img = document.createElement('img');
    img.src     = alt.imageUrl;
    img.alt     = alt.keyword;
    img.loading = 'lazy';

    const lbl = document.createElement('span');
    lbl.textContent = `#${alt.id}`;

    el.appendChild(img);
    el.appendChild(lbl);

    el.addEventListener('click', async () => {
      // Aggiorna tessera e dizionario (il segno grammaticale resta sul nuovo pittogramma)
      tile.id       = alt.id;
      tile.imageUrl = tileImageUrl(tile);
      tile.dataURL  = await fetchTileDataURL(tile);
      dictionary    = rememberWord(dictionary, tile.word, alt.id);
      scheduleDriveSync();
      renderPages();
      closeModal();
    });

    modalAlts.appendChild(el);
  });
}

function closeModal() {
  modalOverlay.classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════════
//  IMPORT DIZIONARIO
// ══════════════════════════════════════════════════════════════════
async function handleImportDict(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const { dict, imgs, labels, student } = await importAll(file);
    const nd = Object.keys(dict).length;
    const ni = Object.keys(imgs).length;

    // FIX (22/07/2026): un backup scaricato da Drive porta con sé il nome dell'alunno
    // (`student`). In quel caso RIPRISTINA su quell'alunno (creandolo se manca,
    // sostituendo se esiste) invece di sommare ciecamente le parole all'alunno che
    // capita essere selezionato — era proprio il caso EMMA finita mescolata con MARIO.
    if (student) {
      const exists = getStudentsList().includes(student);
      const ok = confirm(
        exists
          ? `Questo è un backup del vocabolario di "${student}", che esiste già.\n\n` +
            `Vuoi SOSTITUIRE il vocabolario di "${student}" con questo backup ` +
            `(${nd} parole${ni ? ' + ' + ni + ' immagini' : ''})?\n\n` +
            `Il contenuto attuale di "${student}" verrà rimpiazzato.`
          : `Questo è un backup del vocabolario di "${student}".\n\n` +
            `Vuoi importarlo creando l'alunno "${student}" ` +
            `(${nd} parole${ni ? ' + ' + ni + ' immagini' : ''})?`
      );
      if (!ok) { e.target.value = ''; return; }

      if (!exists) addStudent(student);
      // Ripristino da backup = sostituzione completa (non merge), per quel singolo alunno.
      saveDictionaryForStudent(student, dict);
      saveCustomImagesForStudent(student, imgs);
      saveLabelsForStudent(student, labels);
      setCurrentStudent(student);
      updateStudentSelector(student);
      _resubscribeLive(student); // stesso motivo di _connectShared: selezione via codice, l'handler `change` non passa
      dictionary   = loadDictionaryForStudent(student);
      customImages = loadCustomImagesForStudent(student);
      customLabels = loadLabelsForStudent(student);
      clearPreview();
      scheduleDriveSync();
      showStatus(`✅ Vocabolario di "${student}" ripristinato: ${nd} parole${ni ? ' + ' + ni + ' immagini' : ''}.`, 'success');
      e.target.value = '';
      return;
    }

    // Formato export generico (senza alunno): merge sull'alunno attualmente selezionato.
    dictionary   = { ...dictionary, ...dict };
    customImages = { ...customImages, ...imgs };
    customLabels = { ...customLabels, ...labels };
    saveDictionary(dictionary);
    saveCustomImages(customImages);
    saveLabels(customLabels);
    scheduleDriveSync(); // altrimenti l'import resta solo locale finché non arriva un'altra modifica
    const msg = ni > 0
      ? `✅ Importati: ${nd} pittogrammi + ${ni} immagini personalizzate.`
      : `✅ Dizionario importato: ${nd} parole.`;
    showStatus(msg, 'success');
  } catch (err) {
    showStatus(`❌ Errore importazione: ${err.message}`, 'error');
  }

  e.target.value = '';
}

// ══════════════════════════════════════════════════════════════════
//  ESPORTAZIONE PDF  (jsPDF, nessun backend)
// ══════════════════════════════════════════════════════════════════
// ── Anteprima di stampa (v5.50) ────────────────────────────────────────────
// "Stampa" apre il PDF VERO in una finestra, con i parametri modificabili accanto:
// si vede il risultato prima di sprecare fogli, poi si stampa o si scarica.
// Su iPad/iPhone/Android un PDF non si mostra dentro la pagina: lì resta Scarica.
const printOverlay = $('print-overlay');
const pvFrame      = $('pv-frame');
const pvLoading    = $('pv-loading');
const PV_SELECTS   = [[$('pv-cols'), selCols], [$('pv-rows'), selRows], [$('pv-size'), selSize], [$('pv-orient'), selOrient]];
PV_SELECTS.forEach(([pv, main]) => { pv.innerHTML = main.innerHTML; });
const CAN_INLINE_PDF = navigator.pdfViewerEnabled !== false
  && !/iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
  && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let _pvUrl = null, _pvDoc = null, _pvToken = 0;

function _readPrintOptions() {
  currentOptions = {
    cols:        parseInt(selCols.value),
    rows:        parseInt(selRows.value),
    tileSize:    parseInt(selSize.value),
    orientation: selOrient.value,
  };
}

async function _ensureTileImages() {
  const missing = tiles.filter(t => t.imageUrl && !t.dataURL);
  if (missing.length === 0) return;
  showStatus(`⏳ Riprovo ${missing.length} immagini mancanti…`);
  for (const t of missing) t.dataURL = await fetchTileDataURL(t);
}

const _cm = mm => (mm / 10).toLocaleString('it-IT', { maximumFractionDigits: 1 });

async function refreshPrintPreview() {
  const token = ++_pvToken;
  pvLoading.classList.remove('hidden');
  _readPrintOptions();
  renderPages();
  let built;
  try {
    built = await buildPDF();
  } catch (err) {
    console.error('[PDF]', err);
    pvLoading.textContent = '❌ ' + err.message;
    return;
  }
  if (token !== _pvToken) return;
  _pvDoc = built.doc;

  const { cols, rows } = currentOptions;
  $('pv-info').textContent = `${built.pageCount} ${built.pageCount === 1 ? 'pagina' : 'pagine'} · `
    + `${tiles.length} tessere · tessera ${_cm(built.cell)} × ${_cm(built.cell)} cm`;
  const warn = $('pv-warn');
  warn.hidden = !built.reduced;
  if (built.reduced) {
    warn.textContent = `Con ${cols} colonne e ${rows} righe la tessera entra al massimo di `
      + `${_cm(built.cell)} cm, non ${_cm(built.wanted)}: per averla più grande togli colonne o righe.`;
  }

  if (!CAN_INLINE_PDF) {
    pvLoading.textContent = 'Su tablet e telefono l\'anteprima del PDF non si apre qui dentro: '
      + 'premi «Scarica PDF» e stampa dall\'app che lo apre. La disposizione delle tessere '
      + 'è la stessa dell\'anteprima sulla pagina.';
    return;
  }
  const url = URL.createObjectURL(built.doc.output('blob'));
  pvFrame.onload = () => { if (token === _pvToken) pvLoading.classList.add('hidden'); };
  pvFrame.src = url + '#navpanes=0&view=Fit';   // senza colonna miniature, pagina intera
  if (_pvUrl) URL.revokeObjectURL(_pvUrl);
  _pvUrl = url;
}

function closePrintPreview() {
  if (printOverlay.classList.contains('hidden')) return;
  printOverlay.classList.add('hidden');
  _pvToken++;
  pvFrame.src = 'about:blank';
  if (_pvUrl) { URL.revokeObjectURL(_pvUrl); _pvUrl = null; }
}

PV_SELECTS.forEach(([pv, main]) => pv.addEventListener('change', () => {
  main.value = pv.value;
  refreshPrintPreview();
}));
$('print-close').addEventListener('click', closePrintPreview);
printOverlay.addEventListener('click', e => { if (e.target === printOverlay) closePrintPreview(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePrintPreview(); });

$('pv-print').addEventListener('click', () => {
  try {
    pvFrame.contentWindow.focus();
    pvFrame.contentWindow.print();
  } catch (err) {
    console.warn('[PDF] stampa diretta non riuscita, scarico il file', err);
    _pvDoc?.save('caartella.pdf');
  }
});
$('pv-download').addEventListener('click', () => {
  if (!_pvDoc) return;
  _pvDoc.save('caartella.pdf');
  showStatus('✅ PDF scaricato!', 'success');
});

async function handleExportPDF() {
  if (tiles.length === 0) return;
  btnPdf.disabled = true;
  try {
    await _ensureTileImages();
    PV_SELECTS.forEach(([pv, main]) => { pv.value = main.value; });
    $('pv-print').classList.toggle('hidden', !CAN_INLINE_PDF);
    pvLoading.textContent = '⏳ Preparo l\'anteprima…';
    printOverlay.classList.remove('hidden');
    await refreshPrintPreview();
  } finally {
    btnPdf.disabled = false;
  }
}

// Misure del foglio A4 in mm: UN solo calcolo per PDF e libretto, così ciò che si
// vede sfogliando è esattamente ciò che si stampa.
function pageGeometry() {
  const { cols, rows, orientation } = currentOptions;
  const isLandscape = orientation === 'landscape';
  const PAGE_W = isLandscape ? 297 : 210;   // ⚙️ larghezza pagina
  const PAGE_H = isLandscape ? 210 : 297;   // ⚙️ altezza pagina
  const MARGIN = 8;                         // ⚙️ margine esterno in mm
  const GAP    = 2;                         // ⚙️ spazio tra tessere in mm
  const availW = PAGE_W - 2 * MARGIN;
  const availH = PAGE_H - 2 * MARGIN - 5;   // -5mm per nota licenza in fondo
  // Fino alla v5.49 la misura scelta ("Tessera") non veniva usata: la tessera prendeva
  // sempre tutto lo spazio lasciato da colonne e righe. Ora vale la misura scelta,
  // ridotta solo se con quelle colonne/righe non ci sta (anteprima e libretto lo dicono).
  const cellMax = Math.min((availW - (cols - 1) * GAP) / cols, (availH - (rows - 1) * GAP) / rows);
  const wanted  = currentOptions.tileSize || cellMax;
  const cell    = Math.min(wanted, cellMax);
  return { PAGE_W, PAGE_H, MARGIN, GAP, cell, wanted, cellMax, reduced: wanted - cellMax > 0.5 };
}

async function buildPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('Libreria jsPDF non caricata. Verifica la connessione Internet.');
  }

  const { cols, rows, orientation } = currentOptions;
  const { jsPDF }                   = window.jspdf;
  const { PAGE_W, PAGE_H, MARGIN, GAP, cell, wanted, reduced } = pageGeometry();
  const IMG_PAD = 1;                          // ⚙️ padding interno immagine in mm

  // ── Font e zona testo adattativi alla dimensione della tessera ──
  const FONT_SIZE = Math.max(4, Math.min(14, Math.round(cell * 0.30)));
  const TEXT_H    = Math.max(5, Math.min(10, Math.round(cell * 0.20)));

  const imgSize = cell - TEXT_H - IMG_PAD * 2;
  // ── Offset X centrato per l'immagine all'interno della tessera ─
  const imgX    = (cell - imgSize) / 2;

  // ── Layout frase-aware (condiviso con il preview) ─────────────
  const layout    = computeLayout(tiles, cols, rows);
  const pageCount = layout.length;

  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(FONT_SIZE);

  // ── Genera ogni pagina ────────────────────────────────────────
  for (let pi = 0; pi < pageCount; pi++) {
    if (pi > 0) doc.addPage();

    layout[pi].forEach((row, rowIdx) => {
      row.forEach((tile, colIdx) => {
        if (!tile) return;  // cella vuota (fine frase) → salta

        const x = MARGIN + colIdx * (cell + GAP);
        const y = MARGIN + rowIdx * (cell + GAP);

        // ── Bordo tessera ─────────────────────────────────────
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.3);
        doc.roundedRect(x, y, cell, cell, 1, 1, 'S');

        // ── Immagine (centrata orizzontalmente nella tessera) ──
        if (tile.dataURL && tile.dataURL.startsWith('data:')) {
          try {
            doc.addImage(
              tile.dataURL, 'PNG',
              x + imgX, y + IMG_PAD,
              imgSize, imgSize,
              undefined, 'FAST'
            );
          } catch (e) {
            console.warn('[PDF] addImage fallito per', tile.word, e.message);
            drawNoImage(doc, x, y, cell, imgSize, imgX);
          }
        } else {
          drawNoImage(doc, x, y, cell, imgSize, imgX);
        }

        // ── Linea separatrice immagine / testo ────────────────
        const sepY = y + IMG_PAD + imgSize + 0.5;
        doc.setDrawColor(220, 220, 220);
        doc.line(x + 1, sepY, x + cell - 1, sepY);

        // ── Testo parola: centrato V/H nella zona sotto la linea ─
        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(FONT_SIZE);

        const label   = customLabels[tile.word.toUpperCase()] || tile.word;
        const maxW    = cell - 2;
        const lines   = doc.splitTextToSize(label, maxW);
        // altezza di una riga in mm (1pt = 0.3528mm, interlinea ×1.15)
        const lineH   = FONT_SIZE * 0.3528 * 1.15;
        const totalH  = lines.length * lineH;
        // zona testo: da sepY+1 a y+cell-1
        const zoneTop = sepY + 1;
        const zoneH   = (y + cell - 1) - zoneTop;
        // baseline della prima riga centrata verticalmente nella zona
        const startY  = zoneTop + (zoneH - totalH) / 2 + lineH * 0.75;

        lines.forEach((line, i) => {
          doc.text(line, x + cell / 2, startY + i * lineH, { align: 'center' });
        });
      });
    });
  }

  // ── Nota di licenza ARASAAC (obbligatoria per CC BY-NC-SA) ───
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(4.5);
    doc.setTextColor(170, 170, 170);
    doc.text(
      'Pittogrammi ARASAAC \u00a9 Gobierno de Arag\u00f3n \u2013 Licenza CC BY-NC-SA 4.0 \u2013 arasaac.org  |  \u00a9 2026 EduTechLab \u2013 Fabio Rizzotto \u2013 Tutti i diritti riservati  |  App a scopo didattico non commerciale  |  D.Lgs. 196/2003',
      PAGE_W / 2, PAGE_H - 2.5,
      { align: 'center' }
    );
  }

  return { doc, pageCount, cell, wanted, reduced };
}

/** Disegna un segnaposto testuale quando l'immagine non è disponibile. */
function drawNoImage(doc, x, y, cell, imgSize, imgX) {
  doc.setFontSize(16);
  doc.setTextColor(210, 210, 210);
  // centrato orizzontalmente, verticalmente al centro dell'area immagine
  doc.text('?', x + cell / 2, y + 1 + imgSize / 2 + 3, { align: 'center' });
  doc.setTextColor(0, 0, 0);
}

// ══════════════════════════════════════════════════════════════════
//  SELETTORE ALUNNO
// Nasconde/azzera l'anteprima tessere (griglia + stato "Vocabolario completo") —
// usata quando cambia l'alunno selezionato. FIX (19/07/2026, segnalato da Fabio):
// prima la preview restava esposta con le tessere del vecchio alunno anche dopo
// il cambio (o addirittura in modalità "uso generico", che deve restare vuota) —
// il cambio alunno si limitava a ri-renderizzare le STESSE parole sul dizionario
// nuovo invece di svuotare, perché la preview è legata al testo elaborato per uno
// specifico alunno e perde senso non appena si cambia contesto.
function clearPreview() {
  tiles = [];
  book.close();
  secPreview.classList.add('hidden');
  statusDiv.classList.add('hidden');
}

function initStudentSelector() {
  updateStudentSelector();

  $('sel-student').addEventListener('change', async e => {
    const name  = e.target.value;
    const token = ++_selectorLoadToken;
    setCurrentStudent(name);
    dictionary   = loadDictionary();
    customImages = loadCustomImagesForStudent(name);
    customLabels = loadLabelsForStudent(name);
    _resubscribeLive(name); // ascolta in tempo reale solo l'alunno ora in vista

    // Se Drive connesso, sostituisce col dizionario da Drive/Firebase (fonte
    // autorevole) — NON un merge: una versione più vecchia in cache locale non deve
    // poter far "resuscitare" una tessera cancellata altrove nel frattempo.
    if (isDriveConnected()) {
      const driveData = await loadStudentFromDrive(name);
      // Il token protegge SOLO l'applicazione dei dati Drive (una risposta
      // arrivata in ritardo per un alunno non più selezionato non deve sovrascrivere
      // quello attuale) — ma l'aggiornamento dei bottoni e il reset della preview
      // qui sotto devono avvenire comunque, altrimenti l'UI resta bloccata sullo
      // stato dell'alunno precedente finché non si ricarica la pagina (bug reale
      // segnalato da Fabio 20/07/2026: bottoni non ricompaiono riselezionando un alunno).
      if (token === _selectorLoadToken && driveData) {
        dictionary   = driveData.dict   || {};
        customImages = driveData.custom || {};
        customLabels = driveData.labels || {};
        saveDictionary(dictionary);
        saveCustomImages(customImages);
        saveLabelsForStudent(name, customLabels);
      } else if (token === _selectorLoadToken && !driveData &&
                 (isEphemeralStudent(name) || isSharedStudent(name))) {
        // Un vocabolario RICEVUTO che non restituisce dati può essere stato eliminato
        // dal proprietario. Il valore vuoto NON è una prova — Firebase risponde così
        // anche a un permesso negato o a un intoppo di token (lezione 22/07/2026) —
        // quindi qui non si cancella niente sulla base del vuoto: lo si usa solo come
        // INNESCO di una verifica affidabile, quella basata sull'evento di apertura
        // della sottoscrizione. Serve come rete di sicurezza per il caso osservato nel
        // test del 28/07: aprire un vocabolario già eliminato e non ricevere risposta.
        const code = await getShareCodeForStudent(name);
        if (code && (await checkSharedAlive(code)) === 'deleted') {
          await _handleSharedDeleted(name);
          return;
        }
      }
    }

    _updateRemoveBtn(name);
    // Cambio alunno: l'anteprima tessere si riferisce al testo elaborato per
    // l'alunno precedente, va sempre azzerata (non ri-renderizzata sul nuovo dizionario).
    clearPreview();

    // Vocabolario RICEVUTO aperto senza Drive collegato: non esiste una copia
    // locale da mostrare (per scelta, vedi ephemeral-store.js) e senza connessione
    // non si può scaricare da Firebase. Meglio dirlo chiaramente che lasciare un
    // vocabolario apparentemente vuoto, che sembrerebbe una perdita di dati.
    if (isEphemeralStudent(name) && !isDriveConnected()) {
      showStatus(
        `🔒 "${name}" è un vocabolario condiviso da una collega: collegati a Google Drive per aprirlo. ` +
        `I vocabolari condivisi non restano salvati su questo computer.`,
        'error'
      );
    }
  });

  $('btn-add-student').addEventListener('click', async () => {
    // PRIVACY (26/07/2026): l'etichetta scelta qui viaggia ovunque — file su Drive,
    // nodo Firebase se il vocabolario viene condiviso, localStorage del browser (anche
    // su un PC condiviso di scuola). Trattandosi di CAA, il solo fatto che esista un
    // vocabolario per un alunno rivela una condizione di disabilità: il nome per esteso
    // renderebbe quel dato identificativo. Chiedere iniziali/pseudonimo è la misura più
    // efficace perché impedisce al dato di entrare nel sistema, invece di ripulirlo dopo.
    const name = prompt(
      '⚠️ PRIVACY — non scrivere il nome per esteso dell\'alunno.\n\n' +
      'Per rispettare le norme sulla protezione dei dati, usa solo le\n' +
      'INIZIALI o uno PSEUDONIMO — es. "E.R.", "M.B.", "Sole".\n\n' +
      'Etichetta alunno:'
    );
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    addStudent(trimmed);
    updateStudentSelector(trimmed);
    setCurrentStudent(trimmed);
    dictionary   = loadDictionary();
    customImages = loadCustomImagesForStudent(trimmed);
    clearPreview();

    // Migrazione: se esisteva vecchio dizionario anonimo, chiedi se importarlo
    const legacyCount = getLegacyDictionaryCount();
    if (legacyCount > 0) {
      const migrate = confirm(
        `Hai ${legacyCount} parole già salvate nel dizionario generico.\n` +
        `Vuoi importarle anche per "${trimmed}"?`
      );
      if (migrate) {
        const legacy = loadDictionaryForStudent('');
        dictionary   = { ...legacy, ...dictionary };
        saveDictionary(dictionary);
      }
    }
    _updateRemoveBtn(trimmed);
  });

  // FIX (19/07/2026, richiesta esplicita di Fabio): prima il pulsante ✕ toglieva
  // l'alunno solo dall'elenco locale, MAI dal file reale su Drive — confusionario,
  // perché sembrava un'eliminazione ma i dati (anche quelli condivisi con le
  // colleghe) restavano sempre lì. Ora offre due percorsi distinti: rimozione
  // leggera (solo elenco locale, reversibile) oppure eliminazione definitiva da
  // Drive (irreversibile, doppia conferma). L'eliminazione definitiva è permessa
  // SOLO al proprietario del vocabolario (isOwnStudent) — chi ha solo ricevuto una
  // condivisione da una collega non può mai cancellare il file di qualcun altro,
  // può solo togliersi la voce dal proprio elenco.
  $('btn-remove-student').addEventListener('click', async () => {
    const name = getCurrentStudent();
    if (!name) return;

    const isOwner = isDriveConnected() && await isOwnStudent(name);

    const removeOnly = confirm(
      `Rimuovere "${name}" solo dal tuo elenco?\n` +
      `Il vocabolario resta salvato su Drive: potrai ritrovarlo riconnettendoti.\n\n` +
      (isOwner
        ? `Premi Annulla per eliminarlo invece DEFINITIVAMENTE da Drive.`
        : `(non sei il proprietario di questo vocabolario condiviso: non puoi eliminarlo da Drive, solo toglierlo dal tuo elenco)`)
    );

    if (removeOnly) {
      removeStudent(name);
      updateStudentSelector('');
      setCurrentStudent('');
      dictionary   = loadDictionary();
      customImages = loadCustomImagesForStudent('');
      clearPreview();
      return;
    }

    if (!isOwner) return; // annullato, e comunque non eliminabile da qui

    const reallyDelete = confirm(
      `⚠️ ATTENZIONE: stai per ELIMINARE DEFINITIVAMENTE il vocabolario di "${name}" da Drive.\n` +
      `Se lo avevi condiviso con delle colleghe, anche loro perderanno l'accesso ai dati.\n` +
      `Questa azione NON si può annullare.\n\nProcedere?`
    );
    if (!reallyDelete) return;

    try {
      await deleteStudentFromDrive(name);
      showDriveToast(`🗑️ Vocabolario di "${name}" eliminato definitivamente da Drive`);
    } catch(err) {
      showStatus(`⚠️ Eliminazione da Drive fallita: ${err.message}`, 'error');
      return;
    }
    removeStudent(name);
    deleteStudentData(name); // dizionario + etichette
    // FIX (27/07/2026): le immagini personalizzate hanno una chiave a parte, che
    // deleteStudentData NON tocca — questo era l'unico dei quattro punti di
    // cancellazione a dimenticarla, lasciando le immagini (spesso foto scattate in
    // classe) nel browser dopo un'eliminazione dichiarata "definitiva".
    studentStoreRemove(name, _customKey(name));
    updateStudentSelector('');
    setCurrentStudent('');
    dictionary   = loadDictionary();
    customImages = loadCustomImagesForStudent('');
    clearPreview();
  });

  // Rinomina alunno (es. correggere un errore di battitura) — se l'alunno è
  // condiviso, la modifica viene propagata a chi lo vede (proprietario o colleghe)
  // tramite Firebase, al prossimo refresh automatico.
  $('btn-rename-student').addEventListener('click', async () => {
    const oldName = getCurrentStudent();
    if (!oldName) return;

    // ── Rinomina riservata al proprietario (regola decisa da Fabio 26/07/2026) ──
    // Il campo "student" su Firebase deve avere UNA sola sorgente di scrittura: se
    // anche chi riceve può rinominare, i due lati si sovrascrivono a vicenda ed è da
    // lì che nascevano i doppioni e le rinomine che tornavano indietro. Chi riceve
    // continua a usare e modificare il vocabolario normalmente: solo l'etichetta è
    // decisa da chi l'ha creato. `null` = non è stato possibile stabilirlo (Drive
    // irraggiungibile): si VIETA lo stesso, meglio rimandare che lasciare due file
    // incoerenti da bonificare a mano.
    const canRename = await canManageStudent(oldName);
    if (canRename !== true) {
      alert(
        canRename === false
          ? `"${oldName}" è un vocabolario condiviso da una collega.\n\n` +
            'Solo chi lo ha creato può cambiarne l\'etichetta: così il nome resta uguale ' +
            'per tutte e non si creano copie doppie.\n\n' +
            'Se il nome va corretto, chiedilo alla collega che te lo ha condiviso.'
          : 'Non riesco a verificare su Drive se questo vocabolario è tuo o condiviso ' +
            'da una collega.\n\nPer sicurezza la rinomina è sospesa: controlla la ' +
            'connessione e riprova fra poco.'
      );
      return;
    }

    // Stesso avviso privacy del pulsante "+ Nuovo" — la rinomina è l'altra porta
    // d'ingresso da cui un nome per esteso può entrare nel sistema.
    const input = prompt(
      `Nuova etichetta per "${oldName}"\n\n` +
      '⚠️ Solo INIZIALI o PSEUDONIMO (es. "E.R.", "Sole") —\n' +
      'mai il nome per esteso dell\'alunno.',
      oldName
    );
    if (!input) return;
    const newName = input.trim();
    if (!newName || newName === oldName) return;
    if (getStudentsList().includes(newName)) {
      alert(`Esiste già un alunno chiamato "${newName}". Scegli un nome diverso.`);
      return;
    }

    // Annulla un eventuale salvataggio automatico già in coda (scheduleDriveSync,
    // debounce 1.5s): se scattasse proprio durante la rinomina, andrebbe in gara
    // con essa e creerebbe un file Drive duplicato invece di rinominare quello
    // esistente (bug reale osservato da Fabio il 18/07/2026).
    clearTimeout(_driveSaveTimer);

    // Migra i dati locali dal vecchio al nuovo nome
    const dictToMove   = loadDictionaryForStudent(oldName);
    const labelsToMove = loadLabelsForStudent(oldName);
    const imagesToMove = loadCustomImagesForStudent(oldName);
    saveDictionaryForStudent(newName, dictToMove);
    saveLabelsForStudent(newName, labelsToMove);
    saveCustomImagesForStudent(newName, imagesToMove);
    deleteStudentData(oldName);
    studentStoreRemove(oldName, _customKey(oldName));
    renameStudentInList(oldName, newName);
    updateStudentSelector(newName);
    setCurrentStudent(newName);
    dictionary   = dictToMove;
    customLabels = labelsToMove;
    customImages = imagesToMove;

    // Propaga su Drive/Firebase (se connesso) — vale sia per alunno proprio che condiviso
    if (isDriveConnected()) {
      try {
        await renameStudentOnDrive(oldName, newName, dictionary, customImages, customLabels);
        showStatus(`✅ Alunno rinominato in "${newName}"`, 'success');
      } catch(err) {
        showStatus(`⚠️ Rinominato in locale, ma la sincronizzazione su Drive è fallita: ${err.message}`, 'error');
      }
    }
    if (tiles.length > 0) renderPages();
  });
}

function updateStudentSelector(selectName) {
  const sel  = $('sel-student');
  const list = getStudentsList();
  const curr = selectName !== undefined ? selectName : getCurrentStudent();

  sel.innerHTML = '<option value="">— Nessun nome (uso generico) —</option>';
  list.filter(n => n !== '').forEach(name => {
    const opt = document.createElement('option');
    opt.value       = name;
    opt.textContent = name;
    if (name === curr) opt.selected = true;
    sel.appendChild(opt);
  });
  if (curr === '' || !curr) sel.value = '';
  _updateRemoveBtn(curr);
}

function _updateRemoveBtn(studentName) {
  const btn = $('btn-remove-student');
  btn.style.display = studentName ? 'inline-block' : 'none';
  const renameBtn = $('btn-rename-student');
  if (renameBtn) {
    renameBtn.style.display = studentName ? 'inline-block' : 'none';
    // Vocabolario ricevuto da una collega: l'etichetta la decide chi lo ha creato
    // (regola 26/07/2026). Il pulsante resta visibile ma spento, così è chiaro che
    // la funzione esiste e non è sparita — la spiegazione arriva dall'handler e dal
    // tooltip. Guardia sincrona: il caso "non determinabile" lo copre l'handler.
    // NON si usa `disabled`: un pulsante morto sulla LIM non spiega nulla (il tooltip
    // non esiste al tocco). Resta cliccabile e mostra il messaggio che dice perché.
    const received = studentName ? isSharedStudent(studentName) : false;
    renameBtn.style.opacity = received ? '0.5' : '';
    renameBtn.title = received
      ? 'Vocabolario condiviso da una collega: l\'etichetta la cambia chi lo ha creato'
      : 'Cambia etichetta alunno';
  }
  // Il vocabolario completo ha senso solo con un alunno specifico selezionato —
  // in modalità "uso generico" nascondiamo il pulsante (nessun nome da mostrare).
  if (btnPrintVocab) {
    if (studentName) {
      btnPrintVocab.style.display = 'flex';   // flex + margin auto (CSS) = centrato
      btnPrintVocab.textContent = `📖 Mostra vocabolario completo di "${studentName}"`;
    } else {
      btnPrintVocab.style.display = 'none';
    }
  }
}

// Helper per caricare custom images per alunno specifico.
// Come dizionario ed etichette, per un vocabolario RICEVUTO passano dalla memoria
// di sessione e non toccano il disco (ephemeral-store.js). Qui la cosa pesa doppio:
// le immagini custom sono spesso foto scattate in classe, il dato più identificativo
// che l'app tratti.
function _customKey(studentName) {
  return studentName === '' ? 'caa_custom_images_v1' : `caa_custom_v2_${studentName}`;
}

function loadCustomImagesForStudent(studentName) {
  try {
    const saved = studentStoreGet(studentName, _customKey(studentName));
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function saveCustomImages(imgs) {
  saveCustomImagesForStudent(getCurrentStudent(), imgs);
}

function saveCustomImagesForStudent(studentName, imgs) {
  studentStoreSet(studentName, _customKey(studentName), JSON.stringify(imgs));
}

function saveLabels(lbls) {
  saveLabelsForStudent(getCurrentStudent(), lbls);
}

// ── Sync lista alunni da Drive (riconcilia: aggiunge E rimuove) ─────
// FIX (19/07/2026): prima era solo additiva (mai una rimozione) — un alunno rinominato
// o mai davvero salvato restava per sempre nella lista locale di QUESTO browser, anche
// se su Drive non esisteva più con quel nome. Bug reale osservato da Fabio: browser
// diversi, stesso account Drive, mostravano liste alunni diverse (residui di test vari
// mai ripuliti) — e dopo una rinomina il nome vecchio ricompariva al refresh successivo
// perché il file Drive con quel nome esisteva ancora (vedi fix in renameStudentOnDrive).
// Ora la lista locale è sempre riconciliata con la realtà di Drive/Firebase: si aggiunge
// chi manca, si toglie chi non c'è più — tranne "" (anonimo, sempre valido) e l'alunno
// attualmente selezionato (potrebbe essere appena creato, non ancora salvato la prima volta).
async function syncStudentListFromDrive() {
  if (!isDriveConnected()) return;
  const driveStudents = await listStudentsOnDrive();
  const driveNames = new Set(driveStudents.map(s => s.name).filter(n => n !== undefined));
  const current = getCurrentStudent();

  driveNames.forEach(name => addStudent(name));

  getStudentsList()
    .filter(name => name !== '' && name !== current && !driveNames.has(name))
    .forEach(name => removeStudent(name));

  updateStudentSelector();
}

// ── Aggiorna pannello condivisione nel modal Drive ────────────────
async function _refreshDriveSharePanel() {
  const studentName   = getCurrentStudent();
  const nameEl        = document.getElementById('drive-share-student-name');
  const noStudentEl   = document.getElementById('drive-share-no-student');
  const withStudentEl = document.getElementById('drive-share-with-student');
  const codeEl        = document.getElementById('drive-share-code');
  const fileNameEl    = document.getElementById('drive-share-filename');
  const emailBtnEl    = document.getElementById('btn-email-share');

  if (nameEl) nameEl.textContent = studentName || '—';
  if (emailBtnEl) emailBtnEl.textContent = studentName ? `✉️ Invia vocabolario di "${studentName}"` : '✉️ Invia via email';

  if (!studentName || !isDriveConnected()) {
    if (noStudentEl)   noStudentEl.style.display   = 'block';
    if (withStudentEl) withStudentEl.style.display = 'none';
    return;
  }

  if (noStudentEl)   noStudentEl.style.display   = 'none';
  if (withStudentEl) withStudentEl.style.display = 'block';

  // Mostra vocabolari condivisi ricevuti (informativo: resta visibile anche quando
  // la sezione di condivisione qui sotto è preclusa perché l'alunno non è proprio)
  const sharedStudentsEl = document.getElementById('drive-shared-students');
  const sharedListEl     = document.getElementById('drive-shared-list');
  const students = getStudentsList().filter(n => n && isSharedStudent(n));
  if (sharedStudentsEl && sharedListEl) {
    if (students.length > 0) {
      sharedStudentsEl.style.display = 'block';
      sharedListEl.innerHTML = students
        .map(n => `<span style="display:inline-block;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:2px 8px;margin:2px;font-size:0.8rem;">📂 ${n}</span>`)
        .join('');
    } else {
      sharedStudentsEl.style.display = 'none';
    }
  }

  // ── Ri-condivisione riservata al proprietario (regola di Fabio 26/07/2026) ──
  // Chi ha RICEVUTO un vocabolario non lo ricondivide a sua volta: ogni catena di
  // condivisione parte da chi l'ha creato, così esiste sempre un solo responsabile
  // del vocabolario (e del nome che ci sta sopra). Il controllo va fatto QUI, dove
  // si può attendere la risposta di Drive: dentro gli handler dei pulsanti non si
  // può, perché mailto:/clipboard devono partire a ridosso sincrono del click
  // (vedi nota 18/07/2026 sopra _copyShareMessage) — un await lì li blocca in silenzio.
  const canShare = await canManageStudent(studentName);
  const shareBlockedEl = document.getElementById('drive-share-blocked');
  if (canShare !== true) {
    if (withStudentEl)   withStudentEl.style.display   = 'none';
    if (shareBlockedEl) {
      shareBlockedEl.style.display = 'block';
      shareBlockedEl.textContent = canShare === false
        ? `📂 "${studentName}" è condiviso con te da una collega: puoi usarlo e modificarlo, ` +
          'ma la condivisione ad altre persone la gestisce chi lo ha creato.'
        : '⚠️ Non riesco a verificare su Drive se questo vocabolario è tuo o condiviso. ' +
          'La condivisione è sospesa per sicurezza: riprova fra poco.';
    }
    return;
  }
  if (shareBlockedEl) shareBlockedEl.style.display = 'none';

  // Carica il codice (file ID) per questo alunno
  if (codeEl) {
    codeEl.value = '⏳ Carico codice…';
    const code = await getStudentShareCode(studentName);
    codeEl.value = code || '— salva prima un vocabolario per questo alunno —';
    if (fileNameEl) {
      const safeName = studentName.replace(/[/\\?%*:|"<>]/g, '-');
      fileNameEl.textContent = `vocabolario-${safeName}.json`;
    }
  }

}

// ── Salvataggio Drive con debounce (evita chiamate troppo frequenti) ─
function scheduleDriveSync() {
  if (!isDriveConnected()) return;
  clearTimeout(_driveSaveTimer);
  _driveSaveTimer = setTimeout(async () => {
    const studentName = getCurrentStudent();
    await saveStudentToDrive(studentName, dictionary, customImages, customLabels);
  }, 1500); // aspetta 1.5s dopo l'ultima modifica prima di salvare
}

// ── Utility ────────────────────────────────────────────────────
let _statusBannerTimer = null;
function showStatus(msg, type = '') {
  statusDiv.textContent = msg;
  statusDiv.className   = `status ${type}`;
  statusDiv.classList.remove('hidden');

  // Echo in sovraimpressione sempre visibile, indipendente dallo scroll (vedi nota CSS).
  // Aggiunta X (20/07/2026) per chiuderlo subito: sparisce comunque da solo dopo 4.5s,
  // ma la notifica resta poi consultabile nell'elenco della campanella.
  if (statusBanner) {
    clearTimeout(_statusBannerTimer);
    statusBanner.innerHTML = `<span>${msg.replace(/</g,'&lt;')}</span><span class="banner-x" role="button" aria-label="Chiudi">✕</span>`;
    statusBanner.className  = `status-banner show ${type}`;
    const x = statusBanner.querySelector('.banner-x');
    if (x) x.addEventListener('click', () => statusBanner.classList.remove('show'));
    _statusBannerTimer = setTimeout(() => statusBanner.classList.remove('show'), 4500);
  }
}
