// ══════════════════════════════════════════════════════════════════
//  guida.js — Guida illustrata a capitoli (v5.54), stesso schema di Horologium:
//  ricerca in alto, capitoli a sinistra, testo con immagini a destra. Si apre solo
//  dal pulsante «?» dell'intestazione: niente «?» sparsi (deciso con Fabio).
//  ⚠️ Le immagini in guida/ sono schermate dell'app: vanno rifatte quando cambia
//  l'aspetto di ciò che mostrano, sempre con dati di fantasia.
// ══════════════════════════════════════════════════════════════════

const img = (file, alt, cap) =>
  `<figure class="g-shot"><img src="guida/${file}" alt="${alt}" loading="lazy">` +
  (cap ? `<figcaption>${cap}</figcaption>` : '') + '</figure>';

const coppia = (a, wa, b, wb) =>
  `<div class="g-pair"><div class="g-tile"><img src="guida/${a}" alt="" loading="lazy"><span>${wa}</span></div>` +
  `<div class="g-tile"><img src="guida/${b}" alt="" loading="lazy"><span>${wb}</span></div></div>`;

export const GUIDA = [
  { id: 'avvio', icon: '🚀', t: 'Da dove si comincia', c: `
    <p>CAArtella trasforma una frase in tessere di pittogrammi da stampare, ritagliare e incollare sul quaderno. Tre passi:</p>
    <ol class="g-steps">
      <li><b>Scrivi la frase</b> nel riquadro «Inserisci il testo». Un a capo = una frase nuova, che sul foglio parte da una riga nuova.</li>
      <li>Premi <b>«🔍 Genera Pittogrammi CAA»</b>: l'app cerca un pittogramma ARASAAC per ogni parola e ti porta all'anteprima.</li>
      <li>Premi <b>«🖨️ Stampa»</b>: vedi il foglio A4 com'è davvero e lo mandi alla stampante.</li>
    </ol>
    ${img('inizio.jpg', 'La parte alta di CAArtella: intestazione, avviso Drive e selettore alunno', 'In alto: l\'avviso arancione ricorda che senza Google Drive nulla viene salvato. Sotto, il selettore dell\'alunno.')}
    <p class="g-tip">💡 Questa guida si riapre quando vuoi con il pulsante <b>?</b> in alto a destra. Scrivi una parola nella ricerca per trovare subito il capitolo.</p>` },

  { id: 'frase', icon: '✏️', t: 'La frase e le opzioni', c: `
    <p>Sotto il testo scegli come sarà il foglio:</p>
    <ul>
      <li><b>Colonne e Righe</b> — quante tessere per pagina (4 × 5 = 20 tessere).</li>
      <li><b>Tessera</b> — la misura stampata, da 1 cm a 7 cm. Se con colonne e righe scelte non ci sta, l'anteprima di stampa te lo dice.</li>
      <li><b>Orientamento</b> — verticale o orizzontale.</li>
    </ul>
    <p>Poi il riquadro viola <b>«Come trasformare la frase»</b>:</p>
    ${img('frase.jpg', 'Il riquadro viola Come trasformare la frase')}
    <ul>
      <li><b>Rimuovi articoli, pronomi e preposizioni</b> — tiene solo le parole piene (toglie il, la, di, a…).</li>
      <li><b>Segni sui pittogrammi</b> — il + del plurale e le frecce del tempo: vedi il capitolo <a href="#" data-gvai="segni">Segni grammaticali</a>.</li>
    </ul>
    <p>Le tre caselle si possono cambiare anche <b>dopo</b> aver generato: le tessere si aggiornano da sole. A ogni apertura dell'app ripartono spente, così su un PC condiviso nessuno eredita le scelte di chi c'era prima.</p>` },

  { id: 'verbi', icon: '🔤', t: 'Come vengono riconosciuti i verbi', c: `
    <p>ARASAAC conosce i verbi all'infinito. Se scrivi <i>mangia</i>, l'app cerca <i>mangiare</i>: le tessere trovate così hanno un piccolo badge verde <b>≈</b>.</p>
    <div class="g-table"><table>
      <thead><tr><th>Scrivi</th><th>Trova il pittogramma di</th></tr></thead>
      <tbody>
        <tr><td>mangia · mangiamo · mangiava · mangiato · mangiando</td><td><b>mangiare</b></td></tr>
        <tr><td>mangerò · giocherà · dormiremo</td><td><b>mangiare, giocare, dormire</b></td></tr>
        <tr><td>ho · ha · hanno</td><td><b>avere</b></td></tr>
        <tr><td>è · sono · siamo · era</td><td><b>essere</b></td></tr>
        <tr><td>va · fa · sta · può · deve · beve · dice</td><td><b>andare, fare, stare, potere, dovere, bere, dire</b></td></tr>
        <tr><td>andrà · farò · sarà · bevuto · preso · visto</td><td><b>andare, fare, essere, bere, prendere, vedere</b></td></tr>
      </tbody>
    </table></div>
    <p><b>Guarda anche la parola prima.</b> «Vado a <i>letto</i>» mostra il letto; «la maestra ha <i>letto</i> un libro» mostra leggere. Lo stesso per <i>ho fatto</i> ed <i>è stato</i>.</p>
    <p class="g-tip">💡 «Sei» resta il numero 6, perché a scuola capita spesso. Se nella frase è il verbo essere, clicca la tessera e scegli il pittogramma giusto: l'app se lo ricorda.</p>` },

  { id: 'segni', icon: '➕', t: 'Segni grammaticali: plurale, passato, futuro', c: `
    <p>Spuntando le caselle del riquadro viola, ARASAAC disegna un piccolo segno nell'angolo del pittogramma: lo stesso sistema dei programmi di CAA professionali.</p>
    <div class="g-signs">
      <div><h4><span class="g-sym">+</span> Plurale</h4>${coppia('segno-alb0.jpg', 'ALBERO', 'segno-alb1.jpg', 'ALBERI')}
        <p>Anche femminili e irregolari: <i>case, mele, uova, dita</i>. <i>Città</i> e <i>re</i>, uguali al singolare, restano senza segno.</p></div>
      <div><h4><span class="g-sym">←</span> Passato</h4>${coppia('segno-man0.jpg', 'MANGIA', 'segno-man1.jpg', 'MANGIAVA')}
        <p><i>mangiava, ha mangiato, sono andate, ho bevuto</i>.</p></div>
      <div><h4><span class="g-sym">→</span> Futuro</h4>${coppia('segno-and0.jpg', 'VA', 'segno-and1.jpg', 'ANDRÀ')}
        <p><i>mangerà, giocheremo, andrà, farò</i>.</p></div>
    </div>
    <p>I segni finiscono anche nel foglio stampato. Partono spenti: per alcuni bambini aiutano, per altri sono solo rumore, e decide l'insegnante.</p>
    <p><b>Un segno è sbagliato o manca?</b> Clicca la tessera e correggilo: capitolo <a href="#" data-gvai="tessera">Cambiare una tessera</a>.</p>` },

  { id: 'tessera', icon: '↔️', t: 'Cambiare una tessera', c: `
    <p>Clicca su qualsiasi tessera dell'anteprima: si apre questa finestra.</p>
    <div class="g-side">
      ${img('finestra.jpg', 'La finestra di una tessera: testo, segno grammaticale, immagine personalizzata e pittogrammi alternativi')}
      <ul>
        <li><b>Testo sulla tessera</b> — cambi la scritta senza cambiare la ricerca (es. <i>beve</i> → <i>bere</i>). Badge ✏️.</li>
        <li><b>Segno grammaticale</b> — <i>Automatico</i> è la scelta dell'app (fra parentesi c'è cosa ha riconosciuto); oppure <i>Nessuno</i>, <i>+ Plurale</i>, <i>← Passato</i>, <i>→ Futuro</i>. Vale per quella parola finché la pagina resta aperta.</li>
        <li><b>Carica immagine personalizzata</b> — vedi <a href="#" data-gvai="immagini">Immagini personalizzate</a>.</li>
        <li><b>Pittogrammi ARASAAC</b> — clicca quello che preferisci: l'app lo ricorda e lo usa ogni volta che scrivi quella parola.</li>
        <li><b>Rimuovi dal dizionario</b> — toglie la parola dal vocabolario dell'alunno.</li>
      </ul>
    </div>` },

  { id: 'immagini', icon: '📷', t: 'Immagini personalizzate', c: `
    <p>Puoi usare una <b>foto o un disegno tuo</b> al posto del pittogramma: l'oggetto vero della classe, il personaggio preferito, il disegno del bambino.</p>
    <ol class="g-steps">
      <li>Clicca la tessera.</li>
      <li>Premi <b>«📁 Carica immagine personalizzata»</b> e scegli il file (PNG, JPG, GIF…).</li>
      <li>La tessera mostra la tua immagine e un badge 📷. Per tornare al pittogramma: <b>«↩ Ripristina immagine ARASAAC»</b>.</li>
    </ol>
    <p>L'immagine viene rimpicciolita e salvata nel vocabolario dell'alunno su Google Drive. Sulle immagini personalizzate i segni grammaticali non si mettono.</p>
    <p class="g-warn">⚠️ Niente foto in cui si riconoscono i bambini: sono dati personali di minori.</p>` },

  { id: 'stampa', icon: '🖨️', t: 'Stampa e anteprima', c: `
    <p>Il pulsante <b>«🖨️ Stampa»</b>, sopra l'anteprima, apre il foglio A4 esattamente come uscirà dalla stampante.</p>
    ${img('stampa.jpg', 'Anteprima di stampa con il foglio A4 e i parametri a sinistra', 'A sinistra cambi colonne, righe, misura e orientamento: il foglio si rifà subito.')}
    <ul>
      <li><b>🖨️ Stampa</b> — manda il foglio direttamente alla stampante.</li>
      <li><b>⬇ Scarica PDF</b> — salva il file per stamparlo dopo o mandarlo a una collega.</li>
    </ul>
    <p>Se la misura scelta non ci sta, un avviso arancione dice qual è la misura massima e cosa cambiare.</p>
    <p class="g-tip">💡 Su iPad e telefono l'anteprima del PDF non si apre dentro la pagina: usa «Scarica PDF» e stampa dall'app che apre il file.</p>
    <p>Per stampare <b>tutte</b> le parole di un alunno: <a href="#" data-gvai="alunni">Alunni e vocabolario</a>.</p>` },

  { id: 'alunni', icon: '👤', t: 'Alunni e vocabolario', c: `
    <p>Ogni alunno ha il suo <b>vocabolario</b>: le parole già usate, con i pittogrammi scelti, i testi cambiati e le immagini personalizzate.</p>
    ${img('alunno.jpg', 'Il selettore alunno con i pulsanti Nuovo, modifica, elimina e Mostra vocabolario completo')}
    <ul>
      <li><b>+ Nuovo</b> — crea un alunno. <b>✏️</b> cambia il nome, <b>✕</b> lo elimina.</li>
      <li><b>📖 Mostra vocabolario completo</b> — mette in anteprima tutte le sue parole, pronte da stampare.</li>
      <li><b>Nessun nome (uso generico)</b> — per lavorare senza legare le parole a un alunno.</li>
    </ul>
    <p class="g-warn">⚠️ <b>Mai il nome per esteso.</b> Usa le iniziali o uno pseudonimo (<i>E.R.</i>, <i>Sole</i>). Il nome viaggia col vocabolario su Drive e, se lo condividi, sul server di sincronizzazione: un vocabolario CAA riguarda un alunno con bisogni comunicativi specifici, e il nome completo lo renderebbe un dato delicato di un minore.</p>` },

  { id: 'drive', icon: '☁️', t: 'Salvare su Google Drive', c: `
    <p>Senza Google Drive CAArtella funziona e stampa, ma <b>non salva niente</b>: chiudendo la pagina il lavoro si perde. Col Drive collegato ogni modifica si salva da sola e ritrovi tutto da qualsiasi PC o tablet.</p>
    <div class="g-side">
      ${img('drive-collega.jpg', 'Il pannello Google Drive prima del collegamento')}
      <ol class="g-steps">
        <li>Premi il pulsante tondo in basso a destra <img class="g-inline" src="guida/pulsante-account.jpg" alt="pulsante account"> oppure <b>«Collega Drive»</b> nell'avviso arancione.</li>
        <li>Premi <b>«🔑 Collega a Google Drive»</b> e scegli il tuo account <b>scolastico</b>.</li>
        <li>Nella schermata di Google <b>spunta la casella</b> del permesso Drive, poi «Continua». Senza la spunta l'app non può salvare, e te lo dice.</li>
      </ol>
    </div>
    <p>Da quel momento il pulsante tondo mostra la tua foto e l'avviso arancione sparisce.</p>` },

  { id: 'condividi', icon: '🤝', t: 'Condividere con una collega', c: `
    <p>Due insegnanti possono lavorare <b>sullo stesso vocabolario</b>: le parole che aggiunge una compaiono anche all'altra, da sole.</p>
    <div class="g-side">
      ${img('drive-collegato.jpg', 'Il pannello Google Drive collegato, con la condivisione del vocabolario di Sole', 'Dati di esempio.')}
      <div>
        <h4>Per condividere</h4>
        <ol class="g-steps">
          <li>Seleziona l'alunno e apri il pannello Drive.</li>
          <li>Premi <b>«✉️ Invia via email»</b>: si apre una mail già pronta, aggiungi la collega e invia.</li>
          <li>Se la mail non si apre: <i>«La mail non si apre? Invia il messaggio a mano»</i> → <b>«📋 Copia messaggio»</b>, e incollalo dove vuoi.</li>
        </ol>
        <h4>Per ricevere</h4>
        <ol class="g-steps">
          <li>Apri il link della mail: CAArtella si apre con il codice già pronto.</li>
          <li>Collega il Drive e premi <b>«Carica»</b> nel riquadro blu.</li>
        </ol>
      </div>
    </div>
    <ul>
      <li>La <b>campanella</b> in alto avvisa quando la collega cambia qualcosa, e dice cosa.</li>
      <li>Il nome dell'alunno e la condivisione li gestisce <b>chi ha creato</b> il vocabolario.</li>
      <li>Se chi l'ha creato lo elimina, sparisce anche dalla collega.</li>
    </ul>
    <p class="g-warn">⚠️ Il codice apre il vocabolario a chi lo riceve: mandalo solo alle colleghe giuste, mai in gruppi pubblici.</p>` },

  { id: 'dati', icon: '🔒', t: 'Dove finiscono i dati', c: `
    <p>CAArtella <b>non conserva nulla su questo computer</b>: né i vocabolari, né i testi, né le foto delle tessere.</p>
    <ul>
      <li><b>Con Drive collegato</b> — i vocabolari stanno sul <b>tuo</b> Drive; quelli condivisi passano dal server di sincronizzazione. Il computer è solo una finestra.</li>
      <li><b>Senza Drive</b> — tutto vive finché la pagina resta aperta.</li>
      <li><b>Vocabolari ricevuti</b> — si aprono solo col Drive collegato.</li>
    </ul>
    <p>È fatto così perché CAArtella si usa spesso sui PC condivisi della scuola, e un vocabolario CAA riguarda un alunno con bisogni specifici: nulla sul disco vuol dire nulla da dimenticare lì.</p>
    <p>I pittogrammi arrivano ogni volta da <b>ARASAAC</b> (server in Europa): serve Internet.</p>
    <p>🔒 <a href="https://edutechlab.it/privacy-policy/" target="_blank" rel="noopener">Informativa privacy</a> — quali dati tratta CAArtella, dove finiscono e per quanto restano.</p>` },

  { id: 'backup', icon: '💾', t: 'Copia di sicurezza', c: `
    <p>Oltre al salvataggio automatico su Drive puoi tenere una copia del vocabolario in un file:</p>
    ${img('anteprima.jpg', 'L\'anteprima delle tessere con i pulsanti Esporta dizionario e Stampa in alto')}
    <ul>
      <li><b>⬇ Esporta dizionario</b> — sopra l'anteprima: scarica un file con parole, testi e immagini dell'alunno.</li>
      <li><b>⬆ Importa vocabolario da backup</b> — nel pannello Drive, dopo il collegamento. Se il file è un vocabolario scaricato da Google Drive, l'app riconosce l'alunno da sola; altrimenti le parole si aggiungono all'alunno selezionato.</li>
    </ul>
    <p class="g-warn">⚠️ Il file contiene il vocabolario di un alunno: tienilo sul Drive della scuola, non su chiavette o computer di casa.</p>` },

  { id: 'installa', icon: '📱', t: 'Installare come app', c: `
    <p>CAArtella si può installare: si apre come una vera app, senza passare dal browser (serve comunque Internet).</p>
    <ul>
      <li><b>PC e Chromebook</b> — Chrome o Edge: icona ⊕ nella barra degli indirizzi → «Installa».</li>
      <li><b>Android</b> — Chrome: menu ⋮ → «Aggiungi a schermata Home».</li>
      <li><b>iPad e iPhone</b> — Safari: pulsante Condividi → «Aggiungi a schermata Home».</li>
      <li><b>LIM</b> — basta il browser Chrome o Edge.</li>
    </ul>
    <p>L'app si aggiorna da sola: quando c'è una versione nuova compare «Aggiornata a…», non serve fare nulla.</p>
    <p class="g-legal">Pittogrammi: Sergio Palao. Origine: <a href="https://arasaac.org" target="_blank" rel="noopener">ARASAAC</a>. Licenza
    <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>, Governo di Aragona —
    uso gratuito per scopo educativo non commerciale. © 2026 <a href="https://edutechlab.it" target="_blank" rel="noopener">EduTechLab</a> –
    Fabio Rizzotto – App sviluppata a scopo didattico non commerciale.</p>` },
];

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Collega la guida all'interfaccia. `version` serve solo al messaggio di assistenza.
 * @returns {(id?:string) => void} funzione che apre la guida su un capitolo
 */
export function initGuida(version) {
  const $ = id => document.getElementById(id);
  const overlay = $('info-overlay'), menu = $('guide-menu'), text = $('guide-text'), q = $('guide-q');
  let current = GUIDA[0].id;

  menu.innerHTML = GUIDA.map(g =>
    `<button type="button" class="g-item" data-gsez="${g.id}"><span class="g-ico">${g.icon}</span>${g.t}</button>`).join('');
  $('guide-select').innerHTML = GUIDA.map(g => `<option value="${g.id}">${g.icon} ${g.t}</option>`).join('');

  const body = 'Cosa stavo facendo:\n\n\nCosa è successo:\n\n\n--------------------\nCAArtella ' + version + '\n';
  $('guide-mail').href = 'mailto:edutechlab.ita@gmail.com?subject=' + encodeURIComponent('CAArtella — richiesta di aiuto') +
    '&body=' + encodeURIComponent(body);

  function show(id, focusText) {
    const i = Math.max(0, GUIDA.findIndex(g => g.id === id));
    const g = GUIDA[i];
    current = g.id;
    text.innerHTML = `<h2><span class="g-ico">${g.icon}</span>${g.t}</h2>${g.c}`;
    text.scrollTop = 0;
    menu.querySelectorAll('[data-gsez]').forEach(b => b.classList.toggle('active', b.dataset.gsez === g.id));
    $('guide-select').value = g.id;
    const prev = GUIDA[i - 1], next = GUIDA[i + 1];
    $('guide-prev').hidden = !prev;
    $('guide-next').hidden = !next;
    if (prev) $('guide-prev').textContent = '‹ ' + prev.t;
    if (next) $('guide-next').textContent = next.t + ' ›';
    if (focusText) text.focus();
  }

  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-gsez]');
    if (b) show(b.dataset.gsez, true);
  });
  $('guide-select').addEventListener('change', e => show(e.target.value, true));
  text.addEventListener('click', e => {
    const a = e.target.closest('[data-gvai]');
    if (a) { e.preventDefault(); show(a.dataset.gvai, true); }
  });
  $('guide-prev').addEventListener('click', () => show(GUIDA[GUIDA.findIndex(g => g.id === current) - 1]?.id));
  $('guide-next').addEventListener('click', () => show(GUIDA[GUIDA.findIndex(g => g.id === current) + 1]?.id));

  q.addEventListener('input', () => {
    const term = norm(q.value).trim();
    let first = null, found = 0;
    GUIDA.forEach(g => {
      const hit = !term || norm(g.t + ' ' + g.c.replace(/<[^>]+>/g, ' ')).includes(term);
      const b = menu.querySelector(`[data-gsez="${g.id}"]`);
      if (b) b.hidden = !hit;
      if (hit) { found++; if (!first) first = g.id; }
    });
    if (term && first) show(first);
    if (term && !found) {
      text.innerHTML = `<div class="g-empty">Nessun capitolo parla di «${q.value.replace(/</g, '&lt;')}».<br>` +
        'Prova con una parola più semplice, oppure scrivici con il pulsante qui sotto.</div>';
    }
  });

  function open(id) {
    q.value = '';
    menu.querySelectorAll('[data-gsez]').forEach(b => { b.hidden = false; });
    show(id || current);
    overlay.classList.remove('hidden');
  }
  return open;
}
