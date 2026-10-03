// ══════════════════════════════════════════════════════════════════
//  lemmatizer.js — Riconduce le forme flesse italiane all'infinito
//  (o alla forma base) prima di cercare su ARASAAC.
//
//  Perché serve: ARASAAC indicizza i verbi all'infinito.
//  "mangia" non si trova → "mangiare" sì.
//
//  Strategia: prova trasformazioni in ordine di affidabilità,
//  dalla più specifica (meno rischio di falsi positivi) alla più
//  generica. Ogni candidato viene verificato con l'API ARASAAC.
//
//  Ogni candidato porta con sé il TEMPO della forma di partenza
//  ('passato' | 'futuro' | null): serve ai marcatori grammaticali
//  (freccia ← / → sul pittogramma), dalla v5.49.
// ══════════════════════════════════════════════════════════════════

/**
 * Regole di lemmatizzazione: [suffisso_da_rimuovere, suffisso_da_aggiungere, tempo].
 * Ordinate per specificità (quelle più lunghe e sicure prima).
 *
 * ⚙️  Aggiungi qui nuovi pattern se noti che certe forme non vengono trovate.
 */
const RULES = [
  // ── Futuro — per -ò/-à solo le forme ACCENTATE: "sera", "pera", "nero" non sono futuri
  ['eranno', 'are', 'futuro'], ['eranno', 'iare', 'futuro'], ['eranno', 'ere', 'futuro'],
  ['iranno', 'ire', 'futuro'],
  ['eremo',  'are', 'futuro'], ['eremo',  'iare', 'futuro'], ['eremo',  'ere', 'futuro'],
  ['iremo',  'ire', 'futuro'],
  ['erete',  'are', 'futuro'], ['erete',  'iare', 'futuro'], ['erete',  'ere', 'futuro'],
  ['irete',  'ire', 'futuro'],
  ['erai',   'are', 'futuro'], ['erai',   'iare', 'futuro'], ['erai',   'ere', 'futuro'],
  ['irai',   'ire', 'futuro'],
  ['erò',    'are', 'futuro'], ['erò',    'iare', 'futuro'], ['erò',    'ere', 'futuro'],
  ['irò',    'ire', 'futuro'],
  ['erà',    'are', 'futuro'], ['erà',    'iare', 'futuro'], ['erà',    'ere', 'futuro'],
  ['irà',    'ire', 'futuro'],

  // ── Gerundi ───────────────────────────────────────────────────────────
  ['ando', 'are', null],        // mangiando  → mangiare
  ['endo', 'ere', null],        // correndo   → correre
  ['endo', 'ire', null],        // dormendo   → dormire

  // ── Participi passati ─────────────────────────────────────────────────
  ['ato', 'are', 'passato'],    // mangiato   → mangiare
  ['ata', 'are', 'passato'],    // mangiata   → mangiare
  ['ati', 'are', 'passato'],    // mangiati   → mangiare
  ['ate', 'are', null],         // mangiate   → mangiare (è anche il presente "voi mangiate")
  ['uto', 'ere', 'passato'],    // caduto     → cadere
  ['uta', 'ere', 'passato'],    // caduta     → cadere
  ['ito', 'ire', 'passato'],    // dormito    → dormire
  ['ita', 'ire', 'passato'],    // dormita    → dormire

  // ── Imperfetto ────────────────────────────────────────────────────────
  ['ava', 'are', 'passato'],    // mangiava   → mangiare
  ['avi', 'are', 'passato'],    // mangiavi   → mangiare
  ['avamo', 'are', 'passato'],  // mangiavamo → mangiare
  ['avano', 'are', 'passato'],  // mangiavano → mangiare
  ['eva', 'ere', 'passato'],    // correva    → correre
  ['evi', 'ere', 'passato'],
  ['evamo', 'ere', 'passato'],
  ['evano', 'ere', 'passato'],
  ['iva', 'ire', 'passato'],    // dormiva    → dormire
  ['ivi', 'ire', 'passato'],
  ['ivamo', 'ire', 'passato'],
  ['ivano', 'ire', 'passato'],

  // ── Presente — forme plurali (meno ambigue di singolare) ─────────────
  ['iamo', 'are', null],        // mangiamo   → mangiare
  ['iamo', 'ire', null],        // dormiamo   → dormire
  ['ano', 'are', null],         // mangiano   → mangiare
  ['ono', 'ere', null],         // corrono    → correre
  ['ono', 'ire', null],         // dormono    → dormire
  ['ete', 'ere', null],         // correte    → correre
  ['ite', 'ire', null],         // dormite    → dormire

  // ── Presente — 3ª persona singolare (più rischiosa: "la" "casa"…) ────
  ['isca', 'ire', null],        // finisca    → finire  (congiuntivo)
  ['isce', 'ire', null],        // finisce    → finire
  ['isco', 'ire', null],        // finisco    → finire

  // -a e -e (3ª sing.) — molto ambigue, tentate per ultime
  ['a', 'are', null],           // mangia     → mangiare  ⚠️ ambiguo
  ['e', 'ere', null],           // corre      → correre   ⚠️ ambiguo
  ['e', 'ire', null],           // dorme      → dormire   ⚠️ ambiguo
  ['i', 'are', null],           // mangi      → mangiare  ⚠️ ambiguo (tu)
  ['o', 'are', null],           // mangio     → mangiare  ⚠️ ambiguo (io)
  ['o', 'ere', null],           // corro      → correre
  ['o', 'ire', null],           // dormo      → dormire
];

// Participi passati irregolari frequenti a scuola, solo maschili (radice + o/i): i
// femminili sono spesso nomi (la risposta, la coperta, la scelta, la presa). Esclusi
// anche i maschili che sono nomi comuni (letto, corso, riso, stato, fatto, dipinto):
// "il letto" diventerebbe "leggere".
const PARTICIPI_IRREGOLARI = {
  bevut: 'bere', pres: 'prendere', dett: 'dire', vist: 'vedere', mess: 'mettere',
  scritt: 'scrivere', apert: 'aprire', chius: 'chiudere', rott: 'rompere',
  venut: 'venire', rimast: 'rimanere', nat: 'nascere', acces: 'accendere',
  sces: 'scendere', vint: 'vincere', pers: 'perdere', rispost: 'rispondere',
  chiest: 'chiedere', spent: 'spegnere', piant: 'piangere',
  cott: 'cuocere', tolt: 'togliere', scelt: 'scegliere', moss: 'muovere',
  copert: 'coprire', vissut: 'vivere', raccolt: 'raccogliere', spint: 'spingere',
};

// Futuri irregolari: radice → infinito (si aggiungono le desinenze sotto).
const FUTURI_IRREGOLARI = {
  andr: 'andare', far: 'fare', sar: 'essere', avr: 'avere', verr: 'venire',
  vedr: 'vedere', potr: 'potere', dovr: 'dovere', berr: 'bere', star: 'stare',
  dar: 'dare', dir: 'dire', sapr: 'sapere', vorr: 'volere', rimarr: 'rimanere',
  terr: 'tenere', vivr: 'vivere', cadr: 'cadere',
};
const DESINENZE_FUTURO = ['ò', 'ai', 'à', 'emo', 'ete', 'anno'];

// Voci irregolari frequenti, corrispondenza esatta. Senza questa tabella ARASAAC
// cercava la parola così com'è: "ha" mostrava dei funghi, "è" la lettera E, "sono"
// le nuvole, "hanno" niente. Escluso "sei": a scuola è spesso il numero 6.
const VOCI_IRREGOLARI = {
  ho: 'avere', hai: 'avere', ha: 'avere', abbiamo: 'avere', avete: 'avere', hanno: 'avere',
  sono: 'essere', 'è': 'essere', siamo: 'essere', siete: 'essere',
  vado: 'andare', vai: 'andare', va: 'andare', vanno: 'andare',
  faccio: 'fare', fai: 'fare', fa: 'fare', facciamo: 'fare', fate: 'fare', fanno: 'fare',
  sto: 'stare', stai: 'stare', sta: 'stare', stanno: 'stare',
  posso: 'potere', puoi: 'potere', 'può': 'potere', possiamo: 'potere', possono: 'potere',
  voglio: 'volere', vuoi: 'volere', vuole: 'volere', vogliamo: 'volere', vogliono: 'volere',
  devo: 'dovere', devi: 'dovere', deve: 'dovere', dobbiamo: 'dovere', devono: 'dovere',
  bevo: 'bere', bevi: 'bere', beve: 'bere', beviamo: 'bere', bevete: 'bere', bevono: 'bere',
  dico: 'dire', dici: 'dire', dice: 'dire', diciamo: 'dire', dicono: 'dire',
  vengo: 'venire', vieni: 'venire', viene: 'venire', veniamo: 'venire', vengono: 'venire',
  esco: 'uscire', esci: 'uscire', esce: 'uscire', usciamo: 'uscire', escono: 'uscire',
};
const VOCI_IRREGOLARI_PASSATO = {
  ero: 'essere', eri: 'essere', era: 'essere', eravamo: 'essere', eravate: 'essere', erano: 'essere',
  andavo: 'andare', facevo: 'fare', faceva: 'fare', facevano: 'fare',
  beveva: 'bere', bevevano: 'bere', diceva: 'dire', dicevano: 'dire',
};

// Nomi che le regole generiche trasformano in un verbo sbagliato: "letto" → "lettere"
// → ARASAAC mostrava una lettera. Non si dà la precedenza a ogni parola che ARASAAC
// conosce perché romperebbe verbi frequenti ("legge" → la legge, "balla" → di fieno).
const NON_VERBI = new Set(['letto', 'letti']);

/**
 * Dato un verbo flesso, genera i candidati all'infinito in ordine di priorità.
 * NON verifica se il candidato esiste su ARASAAC: lo fa la funzione chiamante.
 *
 * @param {string} word  - parola in UPPERCASE
 * @returns {Array<{candidate:string, tense:('passato'|'futuro'|null)}>}
 */
export function getCandidates(word) {
  const lower = word.toLowerCase();
  if (NON_VERBI.has(lower)) return [];
  const seen  = new Set();
  const out   = [];
  const push  = (candidate, tense) => {
    if (candidate && !seen.has(candidate) && candidate !== lower) {
      seen.add(candidate);
      out.push({ candidate, tense });
    }
  };

  // Irregolari prima: sono corrispondenze esatte, non tentativi.
  const own = Object.prototype.hasOwnProperty;
  if (own.call(VOCI_IRREGOLARI, lower)) push(VOCI_IRREGOLARI[lower], null);
  if (own.call(VOCI_IRREGOLARI_PASSATO, lower)) push(VOCI_IRREGOLARI_PASSATO[lower], 'passato');
  for (const [stem, inf] of Object.entries(FUTURI_IRREGOLARI)) {
    if (DESINENZE_FUTURO.some(d => lower === stem + d)) push(inf, 'futuro');
  }
  for (const [stem, inf] of Object.entries(PARTICIPI_IRREGOLARI)) {
    if (lower === stem + 'o' || lower === stem + 'i') push(inf, 'passato');
  }

  for (const [suffix, add, tense] of RULES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      let stem = lower.slice(0, lower.length - suffix.length);
      // giocherò → gioc-are, pagherà → pag-are: l'H serve solo a tenere il suono duro
      if (tense === 'futuro' && add === 'are' && /[cg]h$/.test(stem)) stem = stem.slice(0, -1);
      push(stem + add, tense);
    }
  }

  return out;
}
