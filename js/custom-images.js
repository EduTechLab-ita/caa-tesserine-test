// ══════════════════════════════════════════════════════════════════
//  custom-images.js — Gestione immagini personalizzate
//  Le immagini sono salvate come base64 in localStorage.
//  Vengono esportate/importate insieme al dizionario ARASAAC.
// ══════════════════════════════════════════════════════════════════

const CUSTOM_KEY = 'caa_custom_images_v1';

/** Prefisso per distinguere immagini custom dagli ID ARASAAC numerici */
export const CUSTOM_PREFIX = 'CUSTOM_';

/** Carica tutte le immagini custom salvate. @returns {Object} { 'BING': 'data:image/...', ... } */
export function loadCustomImages() {
  try {
    const s = localStorage.getItem(CUSTOM_KEY);
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

/** Salva il dizionario di immagini custom. */
export function saveCustomImages(imgs) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(imgs));
}

/**
 * Aggiunge o aggiorna un'immagine personalizzata.
 * @param {Object} imgs - dizionario corrente
 * @param {string} word - parola (uppercase)
 * @param {string} dataURL - base64 dell'immagine
 * @returns {Object} dizionario aggiornato
 */
export function addCustomImage(imgs, word, dataURL) {
  const updated = { ...imgs, [word.toUpperCase()]: dataURL };
  saveCustomImages(updated);
  return updated;
}

/** Rimuove un'immagine personalizzata. */
export function removeCustomImage(imgs, word) {
  const updated = { ...imgs };
  delete updated[word.toUpperCase()];
  saveCustomImages(updated);
  return updated;
}

/**
 * Dato un file (File object), lo ridimensiona a max 300×300px e lo
 * converte in JPEG compresso (qualità 0.75) per contenere l'uso di localStorage.
 * @param {File} file
 * @returns {Promise<string>} dataURL JPEG compresso
 */
export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 300;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width);  width = MAX; }
          else                { width  = Math.round(width  * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Esporta il dizionario ARASAAC + immagini custom come JSON unificato.
 * Il file esportato contiene tutto quello che serve per ricondividere con le colleghe.
 * @param {Object} dict   - dizionario ARASAAC { PAROLA: id }
 * @param {Object} imgs   - immagini custom { PAROLA: dataURL }
 */
export function exportAll(dict, imgs, labels = {}) {
  const payload = { arasaac: dict, custom: imgs, labels, version: 2 };
  const blob    = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url     = URL.createObjectURL(blob);
  const a       = Object.assign(document.createElement('a'), {
    href: url, download: 'caartella-dizionario.json'
  });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Importa da file JSON. Riconosce TRE formati:
 *  - Export dell'app        → { arasaac:{PAROLA:id}, custom:{}, labels:{}, version }
 *  - Backup scaricato da Drive → { dict:{PAROLA:id}, custom:{}, labels:{}, student, shareCode, savedAt }
 *  - Legacy nudo            → { PAROLA:id, ... }  (solo dizionario, nessuna struttura)
 * FIX (22/07/2026): prima il formato di backup Drive (chiave `dict`, non `arasaac`)
 * cadeva nel ramo legacy e trattava le SUE chiavi di primo livello (dict, custom,
 * student, savedAt, shareCode) come se fossero parole del vocabolario → importava
 * 5-6 voci-spazzatura invece delle parole reali. Ora il ramo `dict` è gestito, e
 * il campo `student` viene restituito così il chiamante sa a chi appartiene il backup.
 * @param {File} file
 * @returns {Promise<{ dict: Object, imgs: Object, labels: Object, student: string|null }>}
 */
export async function importAll(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data && typeof data.arasaac === 'object') {
          // Export dell'app (v1 solo dict+imgs, v2 con labels)
          resolve({ dict: data.arasaac || {}, imgs: data.custom || {}, labels: data.labels || {}, student: data.student || null });
        } else if (data && typeof data.dict === 'object') {
          // Backup scaricato da Drive
          resolve({ dict: data.dict || {}, imgs: data.custom || {}, labels: data.labels || {}, student: data.student || null });
        } else {
          // Legacy: l'intero oggetto è il dizionario ARASAAC
          resolve({ dict: data || {}, imgs: {}, labels: {}, student: null });
        }
      } catch { reject(new Error('File JSON non valido')); }
    };
    reader.onerror = () => reject(new Error('Errore lettura file'));
    reader.readAsText(file);
  });
}
