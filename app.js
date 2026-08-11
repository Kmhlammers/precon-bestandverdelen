// Bestandverdelen Précon
// Vanilla JS, File System Access API, geen build-stap nodig.
// Werkt alleen in Chromium-browsers (Chrome/Edge) op Windows/macOS met directe schrijftoegang tot (netwerk)mappen.

const app = document.getElementById("app");

const ARTIKEL_REGEX = /^\s*(\d{2,}(?:[.\-_]\d+)+|\d{4,})/;
const MAX_RECENT = 5;

const state = {
  doelHandle: null,
  recentDoel: [], // [{name, handle}]
  wachtrij: [], // File[]
};

// ===== IndexedDB opslag (bewaart de daadwerkelijke maptoegang, geen paden) =====

const DB_NAME = "bestandverdelen";
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ===== Helpers: bestandssysteem =====

async function verifyPermission(handle, requestIfNeeded) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (!requestIfNeeded) return false;
  try {
    return (await handle.requestPermission(opts)) === "granted";
  } catch (e) {
    return false;
  }
}

async function fileExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch (e) {
    if (e.name === "NotFoundError") return false;
    throw e;
  }
}

function splitName(filename) {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, idx), ext: filename.slice(idx) };
}

async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sameContent(fileA, fileB) {
  if (fileA.size !== fileB.size) return false;
  const [a, b] = await Promise.all([hashFile(fileA), hashFile(fileB)]);
  return a === b;
}

async function writeFile(dirHandle, name, file) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await file.stream().pipeTo(writable);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===== Bestanden verzamelen (drag-and-drop, ook mappen) =====

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) { resolve(all); return; }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function walkEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const kinderen = await readAllEntries(reader);
    for (const kind of kinderen) await walkEntry(kind, out);
  }
}

async function bestandenUitDataTransfer(dataTransfer) {
  const out = [];
  const items = Array.from(dataTransfer.items || []);
  if (items.length && items[0].webkitGetAsEntry) {
    const entries = items.map((item) => item.webkitGetAsEntry()).filter(Boolean);
    for (const entry of entries) await walkEntry(entry, out);
  } else {
    out.push(...Array.from(dataTransfer.files || []));
  }
  return out;
}

function voegBestandenToe(nieuw) {
  const bestaand = new Set(state.wachtrij.map((f) => `${f.name}::${f.size}`));
  for (const f of nieuw) {
    const sleutel = `${f.name}::${f.size}`;
    if (!bestaand.has(sleutel)) {
      state.wachtrij.push(f);
      bestaand.add(sleutel);
    }
  }
  renderSetup();
}

// ===== Verdeel-logica (poort van Bestanden_Verdelen_V7.ps1) =====

async function processFile(file, doelHandle, counts, log) {
  const name = file.name;
  try {
    const { base } = splitName(name);
    const match = base.match(ARTIKEL_REGEX);

    if (match) {
      const artikelcode = match[1].trim();
      const artikelDir = await doelHandle.getDirectoryHandle(artikelcode, { create: true });

      if (!(await fileExists(artikelDir, name))) {
        await writeFile(artikelDir, name, file);
        counts.verdeeld++;
        log(name, "verdeeld", `naar map ${artikelcode}`);
        return;
      }

      const destFile = await (await artikelDir.getFileHandle(name)).getFile();

      if (await sameContent(file, destFile)) {
        counts.dubbel++;
        log(name, "dubbel", `identiek bestand stond al in map ${artikelcode}, overgeslagen`);
      } else {
        counts.conflict++;
        log(name, "conflict", `bestand met dezelfde naam bestaat al in map ${artikelcode} en verschilt — download het hieronder`, file);
      }
      return;
    }

    counts.nietVerwerkt++;
    log(name, "nietverwerkt", "geen artikelcode herkend in bestandsnaam — download het hieronder", file);
  } catch (e) {
    counts.fouten++;
    log(name, "fout", e.message || String(e), file);
  }
}

// ===== Views =====

function setView(html) {
  app.innerHTML = html;
}

function renderUnsupported() {
  setView(`
    <div class="unsupported">
      <h2>Deze browser wordt niet ondersteund</h2>
      <p>Bestandverdelen heeft directe schrijftoegang tot mappen nodig. Open deze pagina in <strong>Google Chrome</strong> of <strong>Microsoft Edge</strong> op een Windows- of Mac-computer.</p>
    </div>
  `);
}

async function renderSetup(opts = {}) {
  const doelOk = state.doelHandle && (await verifyPermission(state.doelHandle, false));

  setView(`
    <div class="intro">
      <h1>Bestanden automatisch verdelen</h1>
      <p>Sleep bestanden hierheen (of een hele map) en kies waar de artikelmappen moeten komen. Bestandverdelen sorteert daarna alles op artikelcode.</p>
    </div>

    ${opts.melding ? `<div class="notice notice-error">${escapeHtml(opts.melding)}</div>` : ""}

    <div class="card">
      <div class="card-body">
        <div class="card-title">Stap 1 — Bestanden toevoegen</div>
        <p class="card-sub">Sleep bestanden of mappen naar het vak, of kies ze handmatig.</p>
        <div class="dropzone" id="dropzone">
          <div class="dropzone-text">Sleep bestanden of een map hierheen</div>
          <div class="dropzone-or">of</div>
          <button class="btn btn-outline btn-sm" id="btnBrowse">Bestanden kiezen…</button>
          <input type="file" id="fileInput" multiple hidden />
        </div>
        ${state.wachtrij.length ? `
          <div class="queue-header">
            <span>${state.wachtrij.length} bestand${state.wachtrij.length === 1 ? "" : "en"} klaar om te verdelen</span>
            <button class="btn btn-ghost btn-sm" id="btnWisWachtrij">Lijst wissen</button>
          </div>
          <div class="progress-list">
            ${state.wachtrij.map((f, i) => `
              <div class="progress-item">
                <span class="name">${escapeHtml(f.name)}</span>
                <span class="tag tag-dubbel">${formatSize(f.size)}</span>
                <button class="remove-btn" data-remove="${i}" title="Verwijderen">×</button>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="card-title">Stap 2 — Doelmap</div>
        <p class="card-sub">De map waarin de artikelmappen (op artikelcode) worden aangemaakt.</p>
        <div class="folder-row">
          <div class="folder-icon">2</div>
          <div class="folder-info">
            <div class="folder-label">Huidige doelmap</div>
            <div class="folder-path ${doelOk ? "" : "empty"}">${doelOk ? escapeHtml(state.doelHandle.name) : "Nog geen map gekozen"}</div>
          </div>
          <button class="btn btn-outline btn-sm" id="btnKiesDoel">${doelOk ? "Wijzigen" : "Kiezen…"}</button>
        </div>
        ${state.recentDoel.length ? `
          <div class="recent-list">
            ${state.recentDoel.map((r, i) => `<span class="recent-chip" data-recent="${i}" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>`).join("")}
          </div>
          <p class="card-sub" style="margin:10px 0 0;">Browsers tonen alleen de mapnaam, niet het volledige pad. Weet je niet zeker of dit de juiste map is? Kies de map dan opnieuw via "Wijzigen".</p>
        ` : ""}
      </div>
    </div>

    <div class="actions-row">
      <button class="btn btn-primary" id="btnStart" ${state.wachtrij.length && doelOk ? "" : "disabled"}>Start verdelen</button>
    </div>
  `);

  const dropzone = document.getElementById("dropzone");
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const bestanden = await bestandenUitDataTransfer(e.dataTransfer);
    voegBestandenToe(bestanden);
  });

  document.getElementById("btnBrowse").addEventListener("click", () => document.getElementById("fileInput").click());
  document.getElementById("fileInput").addEventListener("change", (e) => {
    voegBestandenToe(Array.from(e.target.files || []));
  });

  document.querySelectorAll("[data-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      state.wachtrij.splice(Number(el.dataset.remove), 1);
      renderSetup();
    });
  });
  const wisBtn = document.getElementById("btnWisWachtrij");
  if (wisBtn) wisBtn.addEventListener("click", () => { state.wachtrij = []; renderSetup(); });

  document.getElementById("btnKiesDoel").addEventListener("click", kiesDoel);
  document.querySelectorAll("[data-recent]").forEach((el) => {
    el.addEventListener("click", () => kiesRecentDoel(Number(el.dataset.recent)));
  });
  const startBtn = document.getElementById("btnStart");
  if (startBtn) startBtn.addEventListener("click", startVerdelen);
}

async function kiesDoel() {
  try {
    const handle = await window.showDirectoryPicker({ id: "bestandverdelen-doel", mode: "readwrite" });
    state.doelHandle = handle;
    await idbSet("doelHandle", handle);
    await onthoudRecentDoel(handle);
    renderSetup();
  } catch (e) {
    if (e.name !== "AbortError") renderSetup({ melding: `Kon doelmap niet instellen: ${e.message}` });
  }
}

async function kiesRecentDoel(index) {
  const entry = state.recentDoel[index];
  if (!entry) return;
  const ok = await verifyPermission(entry.handle, true);
  if (!ok) {
    renderSetup({ melding: "Toegang tot deze map is niet meer beschikbaar. Kies de map opnieuw." });
    return;
  }
  state.doelHandle = entry.handle;
  await idbSet("doelHandle", entry.handle);
  renderSetup();
}

async function onthoudRecentDoel(handle) {
  const zonderDubbel = [];
  for (const entry of state.recentDoel) {
    const zelfde = await entry.handle.isSameEntry(handle).catch(() => false);
    if (!zelfde) zonderDubbel.push(entry);
  }
  state.recentDoel = [{ name: handle.name, handle }, ...zonderDubbel].slice(0, MAX_RECENT);
  await idbSet("recentDoel", state.recentDoel);
}

// ===== Verwerken =====

let logRegels = [];

function renderRunning(counts, huidig, totaal) {
  setView(`
    <div class="intro" style="padding-top:4vh;">
      <h1>Bezig met verdelen…</h1>
      <p>Niet sluiten terwijl dit venster actief is.</p>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="progress-summary">
          <div class="spinner"></div>
          <span>${huidig} van ${totaal} bestanden verwerkt</span>
        </div>
        <div class="stat-grid">
          <div class="stat-tile"><div class="num">${counts.verdeeld}</div><div class="lbl">Verdeeld</div></div>
          <div class="stat-tile"><div class="num">${counts.dubbel}</div><div class="lbl">Dubbel overgeslagen</div></div>
          <div class="stat-tile warn"><div class="num">${counts.nietVerwerkt}</div><div class="lbl">Niet verwerkt</div></div>
          <div class="stat-tile warn"><div class="num">${counts.conflict}</div><div class="lbl">Conflicten</div></div>
          <div class="stat-tile bad"><div class="num">${counts.fouten}</div><div class="lbl">Fouten</div></div>
        </div>
      </div>
    </div>
    ${renderAandachtCard()}
    <div class="card">
      <div class="card-body">
        <div class="card-title" style="margin-bottom:14px;">Laatste bestanden</div>
        <div class="progress-list" id="progressList">
          ${logRegels.slice(-60).reverse().map(renderLogRegel).join("")}
        </div>
      </div>
    </div>
  `);
  bindDownloadKnoppen();
}

const TAG_LABEL = {
  verdeeld: "Verdeeld",
  dubbel: "Dubbel",
  conflict: "Conflict",
  nietverwerkt: "Niet verwerkt",
  fout: "Fout",
};

function renderLogRegel(regel) {
  return `
    <div class="progress-item">
      <span class="name" title="${escapeHtml(regel.detail)}">${escapeHtml(regel.name)}</span>
      <span class="tag tag-${regel.tag}">${TAG_LABEL[regel.tag]}</span>
      ${regel.file ? `<button class="btn btn-outline btn-sm" data-download-idx="${logRegels.indexOf(regel)}">Download</button>` : ""}
    </div>
  `;
}

function aandachtRegels() {
  return logRegels.filter((r) => r.tag !== "verdeeld" && r.tag !== "dubbel");
}

function renderAandachtCard() {
  const regels = aandachtRegels();
  if (!regels.length) return "";
  return `
    <div class="card card-attention">
      <div class="card-body">
        <div class="card-title">Aandacht nodig (${regels.length})</div>
        <p class="card-sub">Deze bestanden zijn niet automatisch verdeeld. Download ze en verwerk ze zelf.</p>
        <div class="progress-list">
          ${regels.slice().reverse().map(renderLogRegel).join("")}
        </div>
      </div>
    </div>
  `;
}

function bindDownloadKnoppen() {
  document.querySelectorAll("[data-download-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const regel = logRegels[Number(btn.dataset.downloadIdx)];
      if (regel && regel.file) downloadFile(regel.file);
    });
  });
}

async function startVerdelen() {
  const doelOk = await verifyPermission(state.doelHandle, true);
  if (!doelOk) {
    renderSetup({ melding: "Toegang tot de doelmap is niet (meer) verleend. Kies de map opnieuw." });
    return;
  }
  if (!state.wachtrij.length) return;

  logRegels = [];
  const counts = { verdeeld: 0, dubbel: 0, nietVerwerkt: 0, conflict: 0, fouten: 0 };

  const wachtrij = state.wachtrij;
  renderRunning(counts, 0, wachtrij.length);

  const log = (name, tag, detail, file) => {
    logRegels.push({ name, tag, detail, file });
  };

  let verwerkt = 0;
  for (const file of wachtrij) {
    await processFile(file, state.doelHandle, counts, log);
    verwerkt++;
    renderRunning(counts, verwerkt, wachtrij.length);
  }

  state.wachtrij = [];
  renderResult(counts, wachtrij.length);
}

function renderResult(counts, totaal) {
  let banner = "success";
  let titel = "Het is gelukt";
  let sub = "Alle bestanden zijn verdeeld.";

  if (counts.fouten > 0) {
    banner = "error";
    titel = "Er zijn fouten opgetreden";
    sub = "Bekijk de details hieronder.";
  } else if (counts.nietVerwerkt > 0 || counts.conflict > 0) {
    banner = "partial";
    titel = "Het is deels gelukt";
    sub = "Download de bestanden hieronder om ze handmatig te verwerken.";
  }

  const icon = banner === "success" ? "✓" : banner === "partial" ? "!" : "✕";

  setView(`
    <div class="intro" style="padding-top:4vh;">
      <h1>Klaar</h1>
    </div>

    <div class="result-banner ${banner}">
      <div class="icon">${icon}</div>
      <div class="text"><strong>${titel}</strong><span>${sub}</span></div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="card-title">Doelmap: ${escapeHtml(state.doelHandle.name)}</div>
        <div class="stat-grid">
          <div class="stat-tile"><div class="num">${counts.verdeeld}</div><div class="lbl">Verdeeld</div></div>
          <div class="stat-tile"><div class="num">${counts.dubbel}</div><div class="lbl">Dubbel overgeslagen</div></div>
          <div class="stat-tile warn"><div class="num">${counts.nietVerwerkt}</div><div class="lbl">Niet verwerkt</div></div>
          <div class="stat-tile warn"><div class="num">${counts.conflict}</div><div class="lbl">Conflicten</div></div>
          <div class="stat-tile bad"><div class="num">${counts.fouten}</div><div class="lbl">Fouten</div></div>
        </div>
      </div>
    </div>

    ${renderAandachtCard()}

    ${logRegels.length ? `
      <div class="card">
        <div class="card-body">
          <div class="card-title" style="margin-bottom:14px;">Volledig overzicht (${logRegels.length})</div>
          <div class="progress-list">
            ${logRegels.slice().reverse().map(renderLogRegel).join("")}
          </div>
        </div>
      </div>
    ` : ""}

    <div class="actions-row">
      <button class="btn btn-primary" id="btnNieuwe">Meer bestanden verdelen</button>
      <button class="btn btn-ghost" id="btnWijzig">Doelmap wijzigen</button>
    </div>
  `);

  bindDownloadKnoppen();
  document.getElementById("btnNieuwe").addEventListener("click", () => renderSetup());
  document.getElementById("btnWijzig").addEventListener("click", () => renderSetup());
}

// ===== Init =====

async function init() {
  if (!window.showDirectoryPicker) {
    renderUnsupported();
    return;
  }

  try {
    const [doel, recent] = await Promise.all([
      idbGet("doelHandle"),
      idbGet("recentDoel"),
    ]);
    state.doelHandle = doel || null;
    state.recentDoel = recent || [];
  } catch (e) {
    // Geen eerdere staat gevonden, negeren.
  }

  renderSetup();
}

init();
