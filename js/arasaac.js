// ══════════════════════════════════════════════════════════════════
//  arasaac.js — Wrapper API ARASAAC
//  Docs: https://arasaac.org/developers/api
//  API:  https://api.arasaac.org/api/
// ══════════════════════════════════════════════════════════════════

const API_BASE = 'https://api.arasaac.org/api';
const LANG     = 'it';  // ⚙️ Cambia in 'es','en','fr' per altra lingua

/**
 * Costruisce l'URL dell'immagine PNG di un pittogramma.
 * ⚙️  Cambia _500 in _2500 per alta risoluzione da stampa.
 * @param {number|string} id
 * @returns {string}
 */
export function getPictogramUrl(id) {
  return `https://static.arasaac.org/pictograms/${id}/${id}_500.png`;
}

// Marcatori grammaticali (v5.49): ARASAAC disegna da sé il segno sul pittogramma,
// ma solo dall'endpoint che genera al volo — lo statico qui sopra resta per tutte le
// tessere senza segno, perché è più veloce e cacheabile. Verificato il 03/10/2026:
// stesso formato (PNG 500×500), CORS aperto (serve a jsPDF), tempi simili.
const MARKER_PARAMS = {
  plurale: 'plural=true',     // "+" in alto a destra
  passato: 'action=past',     // freccia ← in alto a sinistra
  futuro:  'action=future',   // freccia → in alto a destra
};

/**
 * URL del pittogramma con il segno grammaticale, o quello statico se il segno manca.
 * @param {number|string} id
 * @param {'plurale'|'passato'|'futuro'|null} marker
 */
export function getMarkedPictogramUrl(id, marker) {
  const p = MARKER_PARAMS[marker];
  return p ? `https://api.arasaac.org/v1/pictograms/${id}?${p}&resolution=500` : getPictogramUrl(id);
}

const _norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * La parola è la forma PLURALE di una voce ARASAAC? Lo dice ARASAAC stesso: ogni voce
 * porta il suo plurale (albero → alberi, casa → case, uovo → uova). Niente regole sui
 * suffissi, che sbaglierebbero i maschili in -e (cane, pane, fiore) e gli invariabili
 * (città, re): per quelli il plurale coincide col singolare e il segno non si mette.
 * @param {string} word
 * @param {Array<{keywords?:Array}>} results - risultati di searchPictograms
 */
export function isPluralForm(word, results) {
  const w = _norm(word);
  return (results || []).some(r => (r.keywords || []).some(k =>
    k.plural && _norm(k.plural) === w && _norm(k.keyword) !== w));
}

/**
 * Cerca pittogrammi in italiano per una parola.
 * Restituisce fino a 8 alternative ordinate per rilevanza ARASAAC.
 *
 * @param {string} word - parola in italiano (qualsiasi case)
 * @returns {Promise<Array<{id:number, keyword:string, imageUrl:string}>>}
 * @throws {Error} se la rete non risponde o ARASAAC ritorna errore HTTP
 */
// Stessa parola, stessa risposta: in una sessione ogni ricerca si fa una volta sola
// («con», «la», «il» ripetute, segni, finestra della tessera). Un errore non si
// conserva, così al tentativo dopo si riprova davvero.
const _searchCache = new Map();
export function searchPictograms(word) {
  const key = word.toLowerCase();
  if (!_searchCache.has(key)) {
    _searchCache.set(key, _search(key).catch(e => { _searchCache.delete(key); throw e; }));
  }
  return _searchCache.get(key);
}

async function _search(word) {
  const url = `${API_BASE}/pictograms/${LANG}/search/${encodeURIComponent(word.toLowerCase())}`;

  const resp = await fetch(url);
  // ARASAAC risponde 404 (con corpo []) quando la parola non ha pittogrammi: non è un
  // guasto, è «nessun risultato», e come tale si può ricordare.
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`ARASAAC HTTP ${resp.status} per "${word}"`);

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return [];

  return data.slice(0, 8).map(item => ({
    id:       item._id,
    keyword:  item.keywords?.[0]?.keyword ?? word,
    keywords: item.keywords || [],
    imageUrl: getPictogramUrl(item._id),
  }));
}

/**
 * Scarica un'immagine come dataURL base64.
 * Serve a jsPDF per incorporare le immagini nel PDF.
 *
 * ⚠️  Richiede che ARASAAC risponda con header CORS (Access-Control-Allow-Origin).
 *    Se il fetch fallisce (CORS o rete), ritorna null → nel PDF comparirà
 *    un segnaposto testuale invece dell'immagine.
 *
 * @param {string} url
 * @returns {Promise<string|null>}  dataURL 'data:image/png;base64,...' oppure null
 */
export async function fetchImageAsDataURL(url) {
  // ── Tentativo 1: Image + Canvas con crossOrigin ────────────────
  // Usa la pipeline di caricamento immagini del browser (più affidabile
  // del fetch diretto per i CDN ARASAAC che rispondono in modo inconsistente).
  try {
    return await new Promise((resolve, reject) => {
      const img   = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('timeout')), 12000);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          c.width  = img.naturalWidth  || 500;
          c.height = img.naturalHeight || 500;
          c.getContext('2d').drawImage(img, 0, 0);
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl.length < 200) throw new Error('immagine vuota');
          resolve(dataUrl);
        } catch (e) { reject(e); }
      };
      img.onerror = () => { clearTimeout(timer); reject(new Error('load error')); };
      img.src = url;
    });
  } catch { /* fallback sotto */ }

  // ── Tentativo 2: fetch CORS con retry e delay crescente ───────
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 700 * attempt));
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      if (attempt === 2) {
        console.warn('[ARASAAC] fetchImageAsDataURL fallito per', url, '—', err.message);
        return null;
      }
    }
  }
  return null;
}
