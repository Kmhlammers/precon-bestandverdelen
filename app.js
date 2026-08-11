// Bestandverdelen Précon
// Vanilla JS, File System Access API, geen build-stap nodig.
// Werkt alleen in Chromium-browsers (Chrome/Edge) op Windows/macOS met directe schrijftoegang tot (netwerk)mappen.

const app = document.getElementById("app");

const ARTIKEL_REGEX = /^\s*(\d{2,}(?:[.\-_]\d+)+|\d{4,})/;
const INBOX_NAAM = "01_INBOX";
const NIET_VERWERKT_NAAM = "02_NIET_VERWERKT";
const MAX_RECENT = 5;

const state = {
  bronHandle: null,
  doelHandle: null,
  recentDoel: [], // [{name, handle}]
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

async function getUniqueFileName(dirHandle, filename) {
  if (!(await fileExists(dirHandle, filename))) return filename;
  const { base, ext } = splitName(filename);
  let n = 2;
  let candidate;
  do {
    candidate = `${base} (${n})${ext}`;
    n++;
  } while (await fileExists(dirHandle, candidate));
  return candidate;
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

async function listDirFileNames(dirHandle) {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file") out.push(name);
  }
  return out.sort();
}

async function moveFile(sourceDirHandle, sourceName, destDirHandle, destName) {
  const srcFileHandle = await sourceDirHandle.getFileHandle(sourceName);
  const srcFile = await srcFileHandle.getFile();
  const destFileHandle = await destDirHandle.getFileHandle(destName, { create: true });
  const writable = await destFileHandle.createWritable();
  await srcFile.stream().pipeTo(writable);
  await sourceDirHandle.removeEntry(sourceName);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ===== Verdeel-logica (poort van Bestanden_Verdelen_V7.ps1) =====

async function processFile(item, doelHandle, nietVerwerktHandle, counts, log) {
  const { name, dirHandle, inNietVerwerkt } = item;
  try {
    const { base } = splitName(name);
    const match = base.match(ARTIKEL_REGEX);

    if (match) {
      const artikelcode = match[1].trim();
      const artikelDir = await doelHandle.getDirectoryHandle(artikelcode, { create: true });

      if (!(await fileExists(artikelDir, name))) {
        await moveFile(dirHandle, name, artikelDir, name);
        counts.verdeeld++;
        log(name, "verdeeld", `naar map ${artikelcode}`);
        return;
      }

      const destFile = await (await artikelDir.getFileHandle(name)).getFile();
      const srcFile = await (await dirHandle.getFileHandle(name)).getFile();

      if (await sameContent(srcFile, destFile)) {
        await dirHandle.removeEntry(name);
        counts.dubbel++;
        log(name, "dubbel", "identiek bestand bestond al, verwijderd");
      } else {
        if (!inNietVerwerkt) {
          const conflictNaam = `${splitName(name).base} - CONFLICT${splitName(name).ext}`;
          const uniekeNaam = await getUniqueFileName(nietVerwerktHandle, conflictNaam);
          await moveFile(dirHandle, name, nietVerwerktHandle, uniekeNaam);
        }
        counts.conflict++;
        log(name, "conflict", `bestand met dezelfde naam bestaat al in map ${artikelcode}`);
      }
      return;
    }

    if (!inNietVerwerkt) {
      const uniekeNaam = await getUniqueFileName(nietVerwerktHandle, name);
      await moveFile(dirHandle, name, nietVerwerktHandle, uniekeNaam);
    }
    counts.nietVerwerkt++;
    log(name, "nietverwerkt", "geen artikelcode herkend in bestandsnaam");
  } catch (e) {
    counts.fouten++;
    log(name, "fout", e.message || String(e));
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
  const bronOk = state.bronHandle && (await verifyPermission(state.bronHandle, false));
  const doelOk = state.doelHandle && (await verifyPermission(state.doelHandle, false));

  setView(`
    <div class="intro">
      <h1>Bestanden automatisch verdelen</h1>
      <p>Kies de map met binnengekomen bestanden en de map waarin artikelmappen worden aangemaakt. Bestandverdelen sorteert daarna alles op artikelcode.</p>
    </div>

    ${opts.melding ? `<div class="notice notice-error">${escapeHtml(opts.melding)}</div>` : ""}

    <div class="card">
      <div class="card-body">
        <div class="card-title">Stap 1 — Bronmap</div>
        <p class="card-sub">De map waarin ${INBOX_NAAM} en ${NIET_VERWERKT_NAAM} staan (of worden aangemaakt).</p>
        <div class="folder-row">
          <div class="folder-icon">1</div>
          <div class="folder-info">
            <div class="folder-label">Huidige bronmap</div>
            <div class="folder-path ${bronOk ? "" : "empty"}">${bronOk ? escapeHtml(state.bronHandle.name) : "Nog geen map gekozen"}</div>
          </div>
          <button class="btn btn-outline btn-sm" id="btnKiesBron">${bronOk ? "Wijzigen" : "Kiezen…"}</button>
        </div>
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
      <button class="btn btn-primary" id="btnStart" ${bronOk && doelOk ? "" : "disabled"}>Start verdelen</button>
    </div>
  `);

  document.getElementById("btnKiesBron").addEventListener("click", kiesBron);
  document.getElementById("btnKiesDoel").addEventListener("click", kiesDoel);
  document.querySelectorAll("[data-recent]").forEach((el) => {
    el.addEventListener("click", () => kiesRecentDoel(Number(el.dataset.recent)));
  });
  const startBtn = document.getElementById("btnStart");
  if (startBtn) startBtn.addEventListener("click", startVerdelen);
}

async function kiesBron() {
  try {
    const handle = await window.showDirectoryPicker({ id: "bestandverdelen-bron", mode: "readwrite" });
    state.bronHandle = handle;
    await idbSet("bronHandle", handle);
    renderSetup();
  } catch (e) {
    if (e.name !== "AbortError") renderSetup({ melding: `Kon bronmap niet instellen: ${e.message}` });
  }
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
          <div class="stat-tile"><div class="num">${counts.dubbel}</div><div class="lbl">Dubbel verwijderd</div></div>
          <div class="stat-tile warn"><div class="num">${counts.nietVerwerkt}</div><div class="lbl">Niet verwerkt</div></div>
          <div class="stat-tile warn"><div class="num">${counts.conflict}</div><div class="lbl">Conflicten</div></div>
          <div class="stat-tile bad"><div class="num">${counts.fouten}</div><div class="lbl">Fouten</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="card-title" style="margin-bottom:14px;">Laatste bestanden</div>
        <div class="progress-list" id="progressList">
          ${logRegels.slice(-60).reverse().map(renderLogRegel).join("")}
        </div>
      </div>
    </div>
  `);
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
    </div>
  `;
}

async function startVerdelen() {
  const bronOk = await verifyPermission(state.bronHandle, true);
  const doelOk = await verifyPermission(state.doelHandle, true);
  if (!bronOk || !doelOk) {
    renderSetup({ melding: "Toegang tot de bron- of doelmap is niet (meer) verleend. Kies de mappen opnieuw." });
    return;
  }

  logRegels = [];
  const counts = { verdeeld: 0, dubbel: 0, nietVerwerkt: 0, conflict: 0, fouten: 0 };

  let inboxHandle, nietVerwerktHandle;
  try {
    inboxHandle = await state.bronHandle.getDirectoryHandle(INBOX_NAAM, { create: true });
    nietVerwerktHandle = await state.bronHandle.getDirectoryHandle(NIET_VERWERKT_NAAM, { create: true });
  } catch (e) {
    renderSetup({ melding: `Kon ${INBOX_NAAM}/${NIET_VERWERKT_NAAM} niet aanmaken in de bronmap: ${e.message}` });
    return;
  }

  const [inboxFiles, nietVerwerktFiles] = await Promise.all([
    listDirFileNames(inboxHandle),
    listDirFileNames(nietVerwerktHandle),
  ]);

  const wachtrij = [
    ...inboxFiles.map((name) => ({ name, dirHandle: inboxHandle, inNietVerwerkt: false })),
    ...nietVerwerktFiles.map((name) => ({ name, dirHandle: nietVerwerktHandle, inNietVerwerkt: true })),
  ];

  renderRunning(counts, 0, wachtrij.length);

  const log = (name, tag, detail) => {
    logRegels.push({ name, tag, detail });
  };

  let verwerkt = 0;
  for (const item of wachtrij) {
    await processFile(item, state.doelHandle, nietVerwerktHandle, counts, log);
    verwerkt++;
    renderRunning(counts, verwerkt, wachtrij.length);
  }

  renderResult(counts, wachtrij.length);
}

function renderResult(counts, totaal) {
  let banner = "success";
  let titel = "Het is gelukt";
  let sub = "Alle bestanden zijn verdeeld.";

  if (totaal === 0) {
    banner = "partial";
    titel = "Geen bestanden gevonden";
    sub = `${INBOX_NAAM} en ${NIET_VERWERKT_NAAM} waren leeg.`;
  } else if (counts.fouten > 0) {
    banner = "error";
    titel = "Er zijn fouten opgetreden";
    sub = "Bekijk de details hieronder.";
  } else if (counts.nietVerwerkt > 0 || counts.conflict > 0) {
    banner = "partial";
    titel = "Het is deels gelukt";
    sub = `Controleer de map ${NIET_VERWERKT_NAAM}.`;
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
          <div class="stat-tile"><div class="num">${counts.dubbel}</div><div class="lbl">Dubbel verwijderd</div></div>
          <div class="stat-tile warn"><div class="num">${counts.nietVerwerkt}</div><div class="lbl">Niet verwerkt</div></div>
          <div class="stat-tile warn"><div class="num">${counts.conflict}</div><div class="lbl">Conflicten</div></div>
          <div class="stat-tile bad"><div class="num">${counts.fouten}</div><div class="lbl">Fouten</div></div>
        </div>
      </div>
    </div>

    ${logRegels.length ? `
      <div class="card">
        <div class="card-body">
          <div class="card-title" style="margin-bottom:14px;">Overzicht (${logRegels.length})</div>
          <div class="progress-list">
            ${logRegels.slice().reverse().map(renderLogRegel).join("")}
          </div>
        </div>
      </div>
    ` : ""}

    <div class="actions-row">
      <button class="btn btn-primary" id="btnOpnieuw">Opnieuw verdelen</button>
      <button class="btn btn-ghost" id="btnWijzig">Bron- of doelmap wijzigen</button>
    </div>
  `);

  document.getElementById("btnOpnieuw").addEventListener("click", startVerdelen);
  document.getElementById("btnWijzig").addEventListener("click", () => renderSetup());
}

// ===== Init =====

async function init() {
  if (!window.showDirectoryPicker) {
    renderUnsupported();
    return;
  }

  try {
    const [bron, doel, recent] = await Promise.all([
      idbGet("bronHandle"),
      idbGet("doelHandle"),
      idbGet("recentDoel"),
    ]);
    state.bronHandle = bron || null;
    state.doelHandle = doel || null;
    state.recentDoel = recent || [];
  } catch (e) {
    // Geen eerdere staat gevonden, negeren.
  }

  renderSetup();
}

init();
