// ══════════════════════════════════════════════════════════════════
//  libretto.js — Le tessere in un libretto a tutto schermo che si sfoglia
//  come un libro vero (v5.57, disegnato con Fabio sul banco di prova).
//  Due pagine affiancate su schermi larghi, una alla volta su telefono.
//  Il libretto disegna e sfoglia; tessere, misure e impaginazione arrivano
//  dall'app (le stesse del PDF), così ciò che si vede è ciò che si stampa.
// ══════════════════════════════════════════════════════════════════

/**
 * @param {{
 *   layout: () => Array<Array<Array<object|null>>>,   // pagine → righe → tessere
 *   geometry: () => {PAGE_W:number, PAGE_H:number, MARGIN:number, GAP:number, cell:number, wanted:number, cellMax:number, reduced:boolean},
 *   buildTile: (tile:object) => HTMLElement,
 *   onOpen?: () => void,
 * }} app
 */
export function createBook(app) {
  const $ = id => document.getElementById(id);
  const overlay = $('book-overlay'), stage = $('bk-stage'), spread = $('bk-spread');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pages = [], G = null, px = { w: 0, h: 0 }, current = 0, busy = false;

  const isOpen = () => !overlay.classList.contains('hidden');
  const twoUp = () => innerWidth > 760 && innerWidth > innerHeight * 0.9;

  function measure(per) {
    const arrows = 2 * ($('bk-prev').offsetWidth + 14);
    const availH = stage.clientHeight - 36;
    const availW = stage.clientWidth - arrows - 24;
    const ratio = G.PAGE_W / G.PAGE_H;
    const h = Math.max(120, Math.min(availH, availW / (per * ratio)));
    px = { w: Math.round(h * ratio), h: Math.round(h) };
  }

  function pageEl(i) {
    const p = document.createElement('div');
    p.className = 'bk-page';
    p.style.width = px.w + 'px';
    p.style.height = px.h + 'px';
    const rows = pages[i];
    if (!rows) { p.classList.add('blank'); return p; }
    const k = px.w / G.PAGE_W;   // pixel per millimetro
    const grid = document.createElement('div');
    grid.className = 'bk-grid';
    Object.assign(grid.style, {
      left: G.MARGIN * k + 'px', top: G.MARGIN * k + 'px', gap: G.GAP * k + 'px',
      gridTemplateColumns: `repeat(${rows[0].length}, ${G.cell * k}px)`,
      gridTemplateRows: `repeat(${rows.length}, ${G.cell * k}px)`,
    });
    // stesso corpo del testo del PDF (punti → mm → pixel)
    const fontPx = Math.max(4, Math.min(14, Math.round(G.cell * 0.30))) * 0.3528 * k;
    rows.flat().forEach(t => {
      if (!t) {
        const e = document.createElement('div');
        e.className = 'tile tile--empty';
        grid.appendChild(e);
        return;
      }
      const el = app.buildTile(t);
      const w = el.querySelector('.tile-word');
      if (w) w.style.fontSize = Math.max(6, fontPx) + 'px';
      grid.appendChild(el);
    });
    const foot = document.createElement('div');
    foot.className = 'bk-page-foot';
    foot.style.bottom = 2 * k + 'px';
    foot.style.fontSize = Math.max(6, 2.2 * k) + 'px';
    foot.textContent = `Pagina ${i + 1} di ${pages.length}`;
    p.append(grid, foot);
    return p;
  }

  function blank() {
    const p = document.createElement('div');
    p.className = 'bk-page blank';
    p.style.width = px.w + 'px';
    p.style.height = px.h + 'px';
    return p;
  }

  function fill(per, list) {
    spread.className = 'bk-spread ' + (per === 2 ? 'two' : 'one');
    spread.innerHTML = '';
    list.forEach(i => spread.appendChild(pageEl(i)));
  }

  function render() {
    if (!isOpen()) return;
    G = app.geometry();
    pages = app.layout();
    const per = twoUp() ? 2 : 1;
    measure(per);
    const nSpreads = Math.max(1, Math.ceil(pages.length / per));
    current = Math.max(0, Math.min(current, nSpreads - 1));
    fill(per, Array.from({ length: per }, (_, k) => current * per + k));

    const tiles = pages.flat(2).filter(Boolean).length;
    const a = current * per + 1, b = Math.min(pages.length, a + per - 1);
    $('bk-count').textContent = `${tiles} ${tiles === 1 ? 'tessera' : 'tessere'}`;
    $('bk-where').textContent = a === b ? `Pagina ${a} di ${pages.length}` : `Pagine ${a}–${b} di ${pages.length}`;
    $('bk-prev').disabled = current === 0;
    $('bk-next').disabled = current >= nSpreads - 1;
    const dots = $('bk-dots');
    dots.innerHTML = '';
    for (let s = 0; s < nSpreads; s++) {
      const d = document.createElement('button');
      d.type = 'button';
      d.setAttribute('aria-label', per === 2 ? `Vai alle pagine ${s * 2 + 1}–${s * 2 + 2}` : `Vai alla pagina ${s + 1}`);
      if (s === current) d.setAttribute('aria-current', 'true');
      d.addEventListener('click', () => go(s - current));
      dots.appendChild(d);
    }
    const warn = $('bk-warn');
    warn.hidden = !G.reduced;
    if (G.reduced) {
      const cm = mm => (mm / 10).toLocaleString('it-IT', { maximumFractionDigits: 1 });
      warn.textContent = `Con queste colonne e righe la tessera entra al massimo di ${cm(G.cellMax)} cm, `
        + `non ${cm(G.wanted)}: per averla più grande togli colonne o righe.`;
    }
  }

  // Il foglio si solleva dal dorso e gira: davanti la pagina di ora, dietro quella che viene.
  function turn(per, fwd, target) {
    const cur = current * per, nxt = target * per;
    let under, front, back, side;
    if (per === 2) {
      if (fwd) { under = [cur, nxt + 1]; front = cur + 1; back = nxt; side = 'right'; }
      else     { under = [nxt, cur + 1]; front = cur; back = nxt + 1; side = 'left'; }
    } else if (fwd) { under = [nxt]; front = cur; back = null; side = 'full-f'; }
    else            { under = [cur]; front = nxt; back = null; side = 'full-b'; }
    fill(per, under);
    const leaf = document.createElement('div');
    leaf.className = 'bk-leaf';
    Object.assign(leaf.style, {
      width: px.w + 'px', height: px.h + 'px', left: (side === 'right' ? px.w : 0) + 'px',
      transformOrigin: side === 'left' ? 'right center' : 'left center',
    });
    const faceF = document.createElement('div');
    faceF.className = 'bk-face';
    faceF.appendChild(pageEl(front));
    const shade = document.createElement('div');
    shade.className = 'bk-shade';
    shade.style.background = side === 'left'
      ? 'linear-gradient(to left, rgba(0,0,0,.35), transparent 60%)'
      : 'linear-gradient(to right, rgba(0,0,0,.35), transparent 60%)';
    faceF.appendChild(shade);
    const faceB = document.createElement('div');
    faceB.className = 'bk-face back';
    faceB.appendChild(back === null ? blank() : pageEl(back));
    leaf.append(faceF, faceB);
    spread.appendChild(leaf);
    const from = side === 'full-b' ? -180 : 0;
    const to = side === 'full-b' ? 0 : (side === 'left' ? 180 : -180);
    const dur = 750;
    shade.animate([{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: dur });
    const anim = leaf.animate([
      { transform: `rotateY(${from}deg)` },
      { transform: `rotateY(${(from + to) / 2}deg) translateZ(1px)`, offset: 0.5 },
      { transform: `rotateY(${to}deg)` },
    ], { duration: dur, easing: 'cubic-bezier(.45,.05,.35,1)' });
    // Con la scheda in secondo piano il browser ferma le animazioni e `finished` non
    // arriva mai: il libretto restava bloccato «a metà giro». Il tempo massimo lo sblocca.
    return Promise.race([anim.finished.catch(() => {}), new Promise(r => setTimeout(r, dur + 150))]);
  }

  async function go(delta) {
    const per = twoUp() ? 2 : 1;
    const nSpreads = Math.ceil(pages.length / per);
    const target = current + delta;
    if (busy || delta === 0 || target < 0 || target >= nSpreads) return;
    busy = true;
    try {
      if (!reduce && !document.hidden && Math.abs(delta) === 1) await turn(per, delta > 0, target);
    } finally {
      current = target;
      busy = false;
      render();
    }
  }

  function open() {
    current = 0;
    overlay.classList.remove('hidden');
    document.body.classList.add('book-open');
    app.onOpen?.();
    render();
    $('bk-close').focus();
  }
  function close() {
    overlay.classList.add('hidden');
    document.body.classList.remove('book-open');
  }

  $('bk-prev').addEventListener('click', () => go(-1));
  $('bk-next').addEventListener('click', () => go(1));
  $('bk-close').addEventListener('click', close);

  // Le frecce e Esc valgono solo se sopra il libretto non c'è un'altra finestra.
  const otherOpen = () =>
    ['modal-overlay', 'print-overlay', 'info-overlay'].some(id => !$(id)?.classList.contains('hidden'))
    || ($('drive-modal') && $('drive-modal').style.display !== 'none');
  document.addEventListener('keydown', e => {
    if (!isOpen() || otherOpen()) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Escape') close();
  });
  // Sfoglio col dito (LIM, tablet). Uno scorrimento che finisce su una tessera
  // non deve anche aprirne la finestra: il clic che segue si scarta.
  let x0 = null, swiped = false;
  stage.addEventListener('pointerdown', e => { swiped = false; if (e.pointerType !== 'mouse') x0 = e.clientX; });
  stage.addEventListener('pointerup', e => {
    if (x0 !== null && Math.abs(e.clientX - x0) > 50) { swiped = true; go(e.clientX < x0 ? 1 : -1); }
    x0 = null;
  });
  stage.addEventListener('click', e => { if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; } }, true);
  addEventListener('resize', () => { if (!busy) render(); });

  return { open, close, render, isOpen };
}
