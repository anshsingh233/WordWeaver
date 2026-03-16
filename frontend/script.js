// ══════════════════════════════════════════════════════
// CONFIG  ← change this if your backend runs elsewhere
// ══════════════════════════════════════════════════════
const API = "http://localhost:8000";

// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
let lastSelectionRange  = null;
let pages               = [];
let pageCount           = 0;
let currentPageContent  = null;
let citationStyle       = "apa";
let citations           = [];
let citationCounter     = 1;
let footnoteCounter     = 1;
let pendingImageSrc     = null;
let currentZoom         = 100;

// Feature toggle states
let suggestOn   = false;
let grammarOn   = false;
let spellOn     = false;

// GPT-2 / trigram suggestion state
let suggestDebounceTimer = null;
let currentSuggestions   = [];

// Spell check state
let spellDebounceTimer = null;

// Grammar state
let grammarTimer = null;

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  addPage();
  getFirstPage().setAttribute(
    "data-placeholder",
    "Click here and start writing your research paper…"
  );
  setTimeout(loadSaved, 300);

  // Drop-zone wiring
  const dropZone = document.getElementById("dropZone");
  if (dropZone) {
    dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); });
    dropZone.addEventListener("drop",      (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      handleImageFile(e.dataTransfer.files[0]);
    });
  }
});

function getFirstPage() { return pages[0]; }

// ══════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════
function addPage() {
  pageCount++;
  const idx     = pageCount;
  const wrapper = document.createElement("div");
  wrapper.className      = "page-wrapper";
  wrapper.dataset.pageIdx = idx;

  const label = document.createElement("div");
  label.className   = "page-num-label";
  label.textContent = `Page ${idx}`;
  wrapper.appendChild(label);

  const controls = document.createElement("div");
  controls.className = "page-controls";
  controls.innerHTML = `<button class="page-ctrl-btn" onclick="duplicatePage(${idx})">Duplicate</button>
    <button class="page-ctrl-btn danger" onclick="deletePage(${idx})">Delete</button>`;
  wrapper.appendChild(controls);

  const page    = document.createElement("div");
  page.className    = "page";
  page.dataset.pageId = idx;

  const content = document.createElement("div");
  content.className       = "page-content";
  content.contentEditable = "true";
  content.spellcheck      = false;
  content.dataset.pageId  = idx;

  const footer = document.createElement("div");
  footer.className  = "page-footer";
  footer.textContent = idx;

  content.addEventListener("focus",    () => { currentPageContent = content; });
  content.addEventListener("input",    onEditorInput);
  content.addEventListener("keydown",  onEditorKeydown);
  content.addEventListener("paste",    handlePaste);
  content.addEventListener("dragover", (e) => e.preventDefault());
  content.addEventListener("drop",     (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) { currentPageContent = content; readAndInsertImage(f); }
  });

  page.appendChild(content);
  page.appendChild(footer);
  wrapper.appendChild(page);

  const addBtn = document.querySelector(".add-page-btn");
  document.getElementById("canvasArea").insertBefore(wrapper, addBtn);

  pages.push(content);
  currentPageContent = content;
  content.focus();
  updateStatus();
  return content;
}

function deletePage(idx) {
  if (pages.length <= 1) { showToast("Cannot delete the only page."); return; }
  document.querySelector(`.page-wrapper[data-page-idx="${idx}"]`)?.remove();
  pages     = Array.from(document.querySelectorAll(".page-content"));
  pageCount = pages.length;
  document.querySelectorAll(".page-wrapper").forEach((w, i) => {
    w.dataset.pageIdx = i + 1;
    w.querySelector(".page-num-label").textContent = `Page ${i + 1}`;
    w.querySelector(".page-footer").textContent = i + 1;
  });
  updateStatus();
}

function duplicatePage(idx) {
  const src = document.querySelector(`.page-wrapper[data-page-idx="${idx}"] .page-content`);
  const c   = addPage();
  c.innerHTML = src.innerHTML;
}

// ══════════════════════════════════════════════════════
// EDITOR INPUT HANDLER
// ══════════════════════════════════════════════════════
function onEditorInput() {
  updateStatus();
  refreshTOC();
  autoSave();
  if (suggestOn) scheduleSuggest();
  if (spellOn)   scheduleSpellCheck();
  if (grammarOn) scheduleGrammarCheck();
}

function onEditorKeydown(e) {
  if (e.key === "Tab" && suggestOn && currentSuggestions.length) {
    e.preventDefault();
    acceptSuggestion(currentSuggestions[0]);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br   = document.createElement("br");
    const stub = document.createTextNode("\u200B");
    range.insertNode(stub);
    range.insertNode(br);
    range.setStartAfter(stub);
    range.setEndAfter(stub);
    sel.removeAllRanges();
    sel.addRange(range);
    setTimeout(() => {
      if (currentPageContent) {
        currentPageContent.querySelectorAll("br + *").forEach((n) => {
          if (n.nodeType === 3 && n.nodeValue === "\u200B") n.remove();
        });
      }
      checkPageOverflow(e.target);
    }, 0);
    return;
  }
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    document.execCommand("insertLineBreak");
    return;
  }
  if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt") hideSpellPopup();
}

function checkPageOverflow(content) {
  if (content.scrollHeight > 912 && pages.indexOf(content) === pages.length - 1) addPage();
}

// ══════════════════════════════════════════════════════
// ① NEXT-WORD SUGGESTIONS  ←→  POST /suggest
// ══════════════════════════════════════════════════════
function toggleSuggest() {
  suggestOn = !suggestOn;
  const btn = document.getElementById("btn-suggest");
  if (suggestOn) {
    btn.classList.add("on");
    btn.style.cssText = "background:rgba(249,115,22,.3);color:#fdba74;border:1px solid rgba(249,115,22,.6);";
    updateAIStatus("Suggestions ON");
    showToast("💡 Suggestions ON — start typing");
  } else {
    btn.classList.remove("on");
    btn.style.cssText = "background:rgba(249,115,22,.1);color:#fdba74;border:1px solid rgba(249,115,22,.25);";
    hideSuggestionBar();
    updateAIStatus("AI: Off");
    showToast("Suggestions OFF");
  }
}

function scheduleSuggest() {
  clearTimeout(suggestDebounceTimer);
  suggestDebounceTimer = setTimeout(fetchSuggestions, 400);
}

async function fetchSuggestions() {
  if (!suggestOn || !currentPageContent) return;
  const text = currentPageContent.innerText;
  if (!text.trim()) { hideSuggestionBar(); return; }

  try {
    const res = await fetch(`${API}/suggest`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text, n: 5 }),
    });
    if (!res.ok) return;
    const data = await res.json();
    currentSuggestions = data.suggestions || [];
    renderSuggestionBar(currentSuggestions);
  } catch (err) {
    console.warn("[Suggest]", err);
  }
}

function renderSuggestionBar(words) {
  if (!words.length) { hideSuggestionBar(); return; }
  const bar   = document.getElementById("suggestion-bar");
  const pills = document.getElementById("sug-pills");
  pills.innerHTML = words.map((w, i) =>
    `<div class="sug-pill" onclick="acceptSuggestion('${w}')">
       <span class="pill-num">${i + 1}</span>${w}
     </div>`
  ).join("");
  bar.classList.add("visible");
}

function hideSuggestionBar() {
  document.getElementById("suggestion-bar").classList.remove("visible");
  currentSuggestions = [];
}

function acceptSuggestion(word) {
  if (!word || !currentPageContent) return;
  currentPageContent.focus();
  document.execCommand("insertText", false, word + " ");
  hideSuggestionBar();
  if (suggestOn) setTimeout(fetchSuggestions, 300);
}

// ══════════════════════════════════════════════════════
// ② GRAMMAR CHECK  ←→  POST /grammar
// ══════════════════════════════════════════════════════
function toggleGrammarCheck() {
  grammarOn = !grammarOn;
  const btn   = document.getElementById("btn-grammar");
  const panel = document.getElementById("grammar-panel");

  if (grammarOn) {
    btn.classList.add("on");
    btn.style.cssText = "background:rgba(124,77,255,.3);color:#a78bfa;border:1px solid rgba(124,77,255,.6);";
    panel.classList.add("visible");
    updateAIStatus("Grammar ON");
    showToast("Grammar check ON");
    runGrammarCheck();
  } else {
    btn.classList.remove("on");
    btn.style.cssText = "background:rgba(124,77,255,.1);color:#a78bfa;border:1px solid rgba(124,77,255,.25);";
    panel.classList.remove("visible");
    updateAIStatus("AI: Off");
    showToast("Grammar check OFF");
  }
}

function scheduleGrammarCheck() {
  clearTimeout(grammarTimer);
  grammarTimer = setTimeout(runGrammarCheck, 1500);
}

async function runGrammarCheck() {
  if (!grammarOn) return;
  const text = getAllText();
  if (!text.trim()) {
    document.getElementById("gp-body").innerHTML = '<div class="gp-empty">No text to check.</div>';
    return;
  }
  document.getElementById("gp-body").innerHTML =
    '<div class="gp-empty"><div class="spinner" style="margin:0 auto 8px;"></div>Checking grammar…</div>';

  try {
    const res = await fetch(`${API}/grammar`, {           // ← /grammar endpoint
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    renderGrammarPanel(data.issues || []);                // ← reads data.issues
  } catch (err) {
    document.getElementById("gp-body").innerHTML =
      `<div class="gp-empty" style="color:#fca5a5;"><i class="fas fa-exclamation-circle"></i><br>Backend error.<br><small>Is the server running?</small></div>`;
    console.error("[Grammar]", err);
  }
}

function renderGrammarPanel(issues) {
  const body = document.getElementById("gp-body");
  if (!issues.length) {
    body.innerHTML = '<div class="gp-empty" style="color:#6ee7b7;"><i class="fas fa-check-circle" style="font-size:24px;margin-bottom:8px;"></i><br>No grammar issues found!</div>';
    return;
  }
  body.innerHTML = issues.map((issue) => {
    const cls  = issue.severity === "high" ? "error" : issue.category === "STYLE" ? "style" : "";
    const fixes = (issue.replacements || []).map((r) =>
      `<span class="grammar-fix" onclick="applyGrammarFix('${escHtml(issue.bad_word)}','${escHtml(r)}')">${escHtml(r)}</span>`
    ).join("");
    return `<div class="grammar-card ${cls}">
      <div class="grammar-msg">${escHtml(issue.message)}</div>
      <div class="grammar-ctx">${escHtml(issue.context)}</div>
      ${fixes ? `<div class="grammar-fixes">${fixes}</div>` : ""}
    </div>`;
  }).join("");
}

function applyGrammarFix(bad, good) {
  if (!bad) return;
  document.querySelectorAll(".page-content").forEach((p) => {
    p.innerHTML = p.innerHTML.replace(new RegExp(escapeRegex(bad), "g"), good);
  });
  showToast(`Fixed: "${bad}" → "${good}"`);
  setTimeout(runGrammarCheck, 600);
}

// ══════════════════════════════════════════════════════
// ③ FORMALITY CHECK  ←→  POST /formality
// ══════════════════════════════════════════════════════
async function toggleFormalityCheck() {
  const text = getAllText();
  if (!text.trim()) { showToast("Write some text first!"); return; }

  openModal("formalityModal");
  document.getElementById("formalityBody").innerHTML =
    '<div style="text-align:center;padding:20px;"><div class="spinner" style="margin:0 auto;width:28px;height:28px;border-width:3px;"></div><div style="margin-top:12px;color:var(--text-muted);font-size:13px;">Analysing tone…</div></div>';

  try {
    const res = await fetch(`${API}/formality`, {         // ← /formality endpoint
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    renderFormalityResult(data);
  } catch (err) {
    document.getElementById("formalityBody").innerHTML =
      `<div style="color:#fca5a5;text-align:center;padding:20px;"><i class="fas fa-exclamation-circle" style="font-size:24px;margin-bottom:8px;"></i><br>Backend error. Is the server running?</div>`;
    console.error("[Formality]", err);
  }
}

function renderFormalityResult(data) {
  const label   = (data.label || "UNKNOWN").toUpperCase();
  const conf    = data.confidence || 0;
  const details = data.details   || {};
  const method  = data.method    || "";

  const cls   = label === "FORMAL" ? "formal" : "informal";
  const emoji = label === "FORMAL" ? "📋" : "💬";
  const color = label === "FORMAL" ? "#60a5fa" : "#fbbf24";

  document.getElementById("formalityBody").innerHTML = `
    <div class="formality-result">
      <div class="formality-badge ${cls}">${emoji} ${label}</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">
        Confidence: <strong style="color:${color}">${conf.toFixed(1)}%</strong>
      </div>
      <div class="meter-bar"><div class="meter-fill ${cls}" style="width:${conf}%"></div></div>
      <div class="formality-details">
        <div class="fd-item"><div class="fd-key">Informal signals</div><div class="fd-val">${details.informal_signals ?? "—"}</div></div>
        <div class="fd-item"><div class="fd-key">Formal signals</div>  <div class="fd-val">${details.formal_signals   ?? "—"}</div></div>
        <div class="fd-item"><div class="fd-key">Avg sentence length</div><div class="fd-val">${details.avg_sentence_len ?? "—"} words</div></div>
        <div class="fd-item"><div class="fd-key">Method</div><div class="fd-val" style="font-size:11px">${method}</div></div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════
// ④ SPELL CHECK  ←→  POST /spellcheck/text
// ══════════════════════════════════════════════════════
function toggleSpellCheck() {
  spellOn = !spellOn;
  const btn = document.getElementById("btn-spell");
  if (spellOn) {
    btn.classList.add("on");
    updateAIStatus("Spell Check ON");
    showToast("🔤 Spell check ON");
    runFullSpellCheck();
  } else {
    btn.classList.remove("on");
    removeSpellHighlights();
    updateAIStatus("AI: Off");
    showToast("Spell check OFF");
  }
}

function scheduleSpellCheck() {
  clearTimeout(spellDebounceTimer);
  spellDebounceTimer = setTimeout(runFullSpellCheck, 800);
}

async function runFullSpellCheck() {
  if (!spellOn) return;
  const text = getAllText();
  if (!text.trim()) return;

  try {
    const res = await fetch(`${API}/spellcheck/text`, {   // ← /spellcheck/text endpoint
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const data = await res.json();
    applySpellHighlights(data.errors || []);              // ← reads data.errors
  } catch (err) {
    console.warn("[Spell]", err);
  }
}

function applySpellHighlights(errors) {
  // Remove existing highlights first
  document.querySelectorAll(".page-content").forEach((p) => {
    p.querySelectorAll(".spell-error").forEach((el) =>
      el.replaceWith(document.createTextNode(el.innerText))
    );
  });
  if (!errors.length) return;

  // Build word → suggestions map
  const suggMap = {};
  errors.forEach((e) => { suggMap[e.word.toLowerCase()] = e.suggestions || []; });

  document.querySelectorAll(".page-content").forEach((p) => {
    highlightSpellingInNode(p, suggMap);
  });
}

function highlightSpellingInNode(node, suggMap) {
  const walker    = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
  const toReplace = [];
  let n;
  while ((n = walker.nextNode())) {
    const parent = n.parentNode;
    if (parent.classList &&
        (parent.classList.contains("spell-error") ||
         parent.tagName === "CODE" || parent.tagName === "PRE")) continue;
    const text  = n.nodeValue;
    const regex = /\b([a-zA-Z']{2,})\b/g;
    let m, hasMatch = false;
    while ((m = regex.exec(text)) !== null) {
      if (suggMap[m[1].toLowerCase()] !== undefined) { hasMatch = true; break; }
    }
    if (hasMatch) toReplace.push(n);
  }

  toReplace.forEach((textNode) => {
    const parent = textNode.parentNode;
    const frag   = document.createDocumentFragment();
    let remaining = textNode.nodeValue, lastIdx = 0;
    const regex  = /\b([a-zA-Z']{2,})\b/g;
    let m;
    while ((m = regex.exec(remaining)) !== null) {
      const word = m[1], key = word.toLowerCase();
      if (suggMap[key] !== undefined) {
        if (m.index > lastIdx)
          frag.appendChild(document.createTextNode(remaining.slice(lastIdx, m.index)));
        const span = document.createElement("span");
        span.className         = "spell-error";
        span.textContent       = word;
        span.dataset.suggestions = JSON.stringify(suggMap[key]);
        span.addEventListener("mouseenter", showSpellPopupForSpan);
        span.addEventListener("mouseleave", hideSpellPopupDelayed);
        frag.appendChild(span);
        lastIdx = m.index + word.length;
      }
    }
    if (lastIdx < remaining.length)
      frag.appendChild(document.createTextNode(remaining.slice(lastIdx)));
    parent.replaceChild(frag, textNode);
  });
}

function removeSpellHighlights() {
  document.querySelectorAll(".spell-error").forEach((el) =>
    el.replaceWith(document.createTextNode(el.innerText))
  );
}

// ── Spell popup ────────────────────────────────────────────────────────────
let spellPopupHideTimer = null;
const spellPopup        = document.getElementById("spell-popup");

function showSpellPopupForSpan(e) {
  clearTimeout(spellPopupHideTimer);
  const span = e.currentTarget;
  const sugs = JSON.parse(span.dataset.suggestions || "[]");
  const rect = span.getBoundingClientRect();

  spellPopup.innerHTML = sugs.length
    ? sugs.map((s) => `<div class="spell-option" data-word="${escHtml(s)}">${escHtml(s)}</div>`).join("")
    : `<div class="spell-option no-sug">No suggestions</div>`;

  spellPopup.querySelectorAll(".spell-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      span.replaceWith(document.createTextNode(opt.dataset.word));
      hideSpellPopup();
    });
  });

  spellPopup.style.left = `${rect.left}px`;
  spellPopup.style.top  = `${rect.bottom + 4}px`;
  spellPopup.classList.add("visible");
  spellPopup.addEventListener("mouseenter", () => clearTimeout(spellPopupHideTimer));
  spellPopup.addEventListener("mouseleave", hideSpellPopupDelayed);
}

function hideSpellPopupDelayed() { spellPopupHideTimer = setTimeout(hideSpellPopup, 250); }
function hideSpellPopup()        { spellPopup.classList.remove("visible"); }

// ══════════════════════════════════════════════════════
// FORMATTING & COMMAND HELPERS
// ══════════════════════════════════════════════════════
function exec(cmd, val = null) {
  document.execCommand(cmd, false, val);
  if (currentPageContent) currentPageContent.focus();
}
function fmtToggle(cmd, btnId) {
  exec(cmd);
  document.getElementById(btnId)?.classList.toggle("active");
}
function applyHeading(val) { if (!val) return; exec("formatBlock", val); refreshTOC(); }
function setLineSpacing(val) {
  if (!val) return;
  document.querySelectorAll(".page-content").forEach((p) => (p.style.lineHeight = val));
}
function applyColor(cmd, val) {
  exec(cmd, val);
  const swatchId = cmd === "foreColor" ? "foreColorSwatch" : "hiliteColorSwatch";
  const swatchEl = document.getElementById(swatchId);
  if (swatchEl) swatchEl.style.backgroundColor = val;
}

// ── Tab switching ──────────────────────────────────────
function switchTab(btn, tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
  const panel = document.getElementById("tab-" + tab);
  if (panel) panel.style.display = "flex";
}

// ── Insert helpers ─────────────────────────────────────
function insertHR()                  { exec("insertHorizontalRule"); }
function insertLink()                { const u = prompt("URL:"); if (u) exec("createLink", u); }
function insertSpecialChar(c)        { exec("insertText", c); }
function insertPageBreak()           { exec("insertHTML", '<div style="page-break-after:always;border-top:1px dashed #aaa;margin:20px 0;text-align:center;font-size:10px;color:#aaa;">— Page Break —</div>'); }
function insertMathBlock()           { exec("insertHTML", '<div class="math" contenteditable="true">[Math Expression]</div><p><br></p>'); }
function insertCodeBlock()           { exec("insertHTML", '<pre><code contenteditable="true">// code here</code></pre><p><br></p>'); }
function insertTable() {
  const r = parseInt(prompt("Rows:", "3")) || 3;
  const c = parseInt(prompt("Columns:", "3")) || 3;
  let html = "<table><thead><tr>" + Array.from({ length: c }, (_, i) => `<th>Col ${i + 1}</th>`).join("") + "</tr></thead><tbody>";
  for (let i = 0; i < r; i++)
    html += "<tr>" + Array.from({ length: c }, () => "<td>&nbsp;</td>").join("") + "</tr>";
  exec("insertHTML", html + "</tbody></table><p><br></p>");
}

// ── Research inserts ───────────────────────────────────
function insertAbstract()     { exec("insertHTML", `<div class="research-abstract"><div class="research-abstract-title">Abstract</div><p>Write your abstract here (150–300 words).</p></div><p><br></p>`); }
function insertTOC()          { exec("insertHTML", `<div style="border:1px solid #ddd;padding:16px;margin:16px 0;font-size:11pt;"><div style="font-weight:700;font-size:12pt;text-align:center;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Table of Contents</div><p style="color:#888;font-style:italic;">1. Introduction ............... 1<br>2. Literature Review ......... 2<br>3. Methodology ............... 3<br>4. Results ................... 4<br>5. Conclusion ................ 5</p></div><p><br></p>`); }
function insertKeywords()     { exec("insertHTML", "<p><strong>Keywords:</strong> keyword1, keyword2, keyword3</p>"); }
function insertAffiliation()  { exec("insertHTML", `<div style="text-align:center;font-size:11pt;margin:8px 0;"><div style="font-weight:700;">Author Name<sup>1</sup></div><div style="font-style:italic;"><sup>1</sup>Department, University, Country</div></div><p><br></p>`); }
function insertFigure()       { exec("insertHTML", '<p class="img-caption" contenteditable="true">Figure 1: Caption.</p>'); }
function insertFootnote() {
  const n = footnoteCounter++;
  exec("insertHTML", `<sup class="citation">[fn${n}]</sup>`);
  if (currentPageContent) {
    let fa = currentPageContent.querySelector(".footnote-area");
    if (!fa) { fa = document.createElement("div"); fa.className = "footnote-area"; currentPageContent.appendChild(fa); }
    const fn = document.createElement("p");
    fn.innerHTML = `<sup>${n}</sup> Footnote text.`;
    fn.contentEditable = "true";
    fa.appendChild(fn);
  }
}

// ── Citation ───────────────────────────────────────────
function setCitationStyle(s) { citationStyle = s; }
function openCitationModal() { openModal("citationModal"); }
function insertCitation() {
  const a = document.getElementById("citeAuthor").value.trim();
  const y = document.getElementById("citeYear").value.trim();
  const t = document.getElementById("citeTitle").value.trim();
  const j = document.getElementById("citeJournal").value.trim();
  const v = document.getElementById("citeVolume").value.trim();
  const d = document.getElementById("citeDOI").value.trim();
  let inText = citationStyle === "ieee" ? `[${citationCounter}]` : `(${a}, ${y})`;
  let ref = citationStyle === "apa"
    ? `${a} (${y}). <em>${t}</em>. <em>${j}</em>, ${v}.${d ? " https://doi.org/" + d : ""}`
    : citationStyle === "ieee" ? `[${citationCounter}] ${a}, "${t}," <em>${j}</em>, ${y}.`
    : `${a}. "${t}." <em>${j}</em>, ${y}.`;
  citations.push({ id: citationCounter, inText, ref });
  exec("insertHTML", `<span class="citation" title="${ref}">${inText}</span>`);
  citationCounter++;
  closeModal("citationModal");
  ["citeAuthor","citeYear","citeTitle","citeJournal","citeVolume","citeDOI"].forEach((id) => (document.getElementById(id).value = ""));
}
function openBibModal() {
  const list = document.getElementById("bibList");
  list.innerHTML = citations.length
    ? citations.map((c) => `<div style="margin-bottom:10px;font-size:12px;color:var(--text);padding:8px;border:1px solid var(--border);border-radius:4px;"><span style="color:var(--accent);font-weight:600;">[${c.id}]</span> ${c.ref}</div>`).join("")
    : '<div style="color:var(--text-muted);font-size:12px;">No citations yet.</div>';
  openModal("bibModal");
}
function insertBibliography() {
  if (!citations.length) { alert("No citations added."); return; }
  let html = "<h2>References</h2>";
  citations.forEach((c) => { html += `<p style="padding-left:28px;text-indent:-28px;">${c.ref}</p>`; });
  exec("insertHTML", html);
  closeModal("bibModal");
}

// ── Templates ──────────────────────────────────────────
function openTemplateModal() { openModal("templateModal"); }
const templates = {
  ieee:   `<h1>Title of the Research Paper</h1><div style="text-align:center;font-size:11pt;">Author Name<br><em>Institution, Country</em><br>email@example.com</div><div class="research-abstract"><div class="research-abstract-title">Abstract</div><p>Abstract goes here (150–250 words).</p></div><p><strong>Keywords—</strong>keyword1, keyword2</p><h2>I. Introduction</h2><p>Introduce the research problem.</p><h2>II. Related Work</h2><p>Review relevant literature.</p><h2>III. Methodology</h2><p>Describe the methodology.</p><h2>IV. Results</h2><p>Present results.</p><h2>V. Discussion</h2><p>Interpret results.</p><h2>VI. Conclusion</h2><p>Summarize findings.</p><h2>References</h2>`,
  apa:    `<h1>Title of the Research Paper</h1><div style="text-align:center;">Author Name<br>Department, University</div><div class="research-abstract"><div class="research-abstract-title">Abstract</div><p>Abstract (150–250 words).</p><p><strong>Keywords:</strong> keyword1, keyword2</p></div><h2>Introduction</h2><p>Introduce the topic.</p><h2>Method</h2><h3>Participants</h3><p>Sample description.</p><h3>Procedure</h3><p>Step by step.</p><h2>Results</h2><p>Findings.</p><h2>Discussion</h2><p>Interpretation.</p><h2>References</h2>`,
  thesis: `<h1>Thesis Title</h1><div style="text-align:center;">By Student Name<br>University, Year</div><div class="research-abstract"><div class="research-abstract-title">Abstract</div><p>Summary (300–500 words).</p></div><h2>Chapter 1: Introduction</h2><p>Background and objectives.</p><h2>Chapter 2: Literature Review</h2><p>Review of existing research.</p><h2>Chapter 3: Methodology</h2><p>Research design and methods.</p><h2>Chapter 4: Results</h2><p>Findings.</p><h2>Chapter 5: Discussion</h2><p>Interpretation.</p><h2>Chapter 6: Conclusion</h2><p>Summary and future work.</p><h2>References</h2>`,
  review: `<h1>Literature Review Title</h1><div class="research-abstract"><div class="research-abstract-title">Abstract</div><p>Scope and purpose.</p></div><h2>1. Introduction</h2><p>Purpose of this review.</p><h2>2. Search Strategy</h2><p>Databases, keywords, criteria.</p><h2>3. Thematic Analysis</h2><h3>3.1 Theme One</h3><p>Analysis.</p><h3>3.2 Theme Two</h3><p>Analysis.</p><h2>4. Gaps in Literature</h2><p>What is missing.</p><h2>5. Conclusion</h2><p>Key insights.</p><h2>References</h2>`,
  case:   `<h1>Case Study Title</h1><div class="research-abstract"><div class="research-abstract-title">Executive Summary</div><p>Brief summary.</p></div><h2>1. Background</h2><p>Context.</p><h2>2. Problem Statement</h2><p>Central challenge.</p><h2>3. Analysis</h2><p>Root cause analysis.</p><h2>4. Recommendations</h2><p>Best course of action.</p><h2>5. Conclusion</h2><p>Lessons learned.</p><h2>References</h2>`,
};
function loadTemplate() {
  const key = document.getElementById("templateSelect").value;
  if (templates[key] && pages[0]) { pages[0].innerHTML = templates[key]; refreshTOC(); updateStatus(); }
  closeModal("templateModal");
}

// ── Image ──────────────────────────────────────────────
function saveSelection() {
  const sel = window.getSelection();
  if (sel.getRangeAt && sel.rangeCount) lastSelectionRange = sel.getRangeAt(0);
}
function openImageModal() {
  saveSelection();
  pendingImageSrc = null;
  const dropZone = document.getElementById("dropZone");
  if (dropZone) dropZone.innerHTML = '<i class="fas fa-cloud-upload-alt"></i>Drop image or click to browse';
  openModal("imageModal");
}
function handleImageFile(f) {
  if (!f || !f.type.startsWith("image/")) return;
  const r = new FileReader();
  r.onload = (e) => {
    pendingImageSrc = e.target.result;
    const dropZone = document.getElementById("dropZone");
    if (dropZone) dropZone.innerHTML = `<i class="fas fa-check-circle" style="color:var(--accent)"></i><br>File: ${f.name}`;
  };
  r.readAsDataURL(f);
}
function readAndInsertImage(f) {
  const r = new FileReader();
  r.onload = (e) => doInsertImage(e.target.result, "", "75%");
  r.readAsDataURL(f);
}
function insertImage() {
  const urlInput = document.getElementById("imgUrlInput");
  const url = urlInput ? urlInput.value.trim() : "";
  const cap = document.getElementById("imgCaption").value.trim();
  const w   = document.getElementById("imgWidth").value;
  const src = pendingImageSrc || url;
  if (!src) { alert("Please provide an image."); return; }
  if (lastSelectionRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(lastSelectionRange);
  } else if (currentPageContent) {
    currentPageContent.focus();
  }
  doInsertImage(src, cap, w);
  closeModal("imageModal");
  pendingImageSrc = null;
  if (urlInput) urlInput.value = "";
}
function doInsertImage(src, cap, w) {
  const html = `<div style="text-align:center;margin:12px 0;">
    <img src="${src}" style="width:${w};max-width:100%;height:auto;" alt="Figure">
    ${cap ? `<p class="img-caption" style="text-align:center;font-style:italic;font-size:10pt;color:#666;margin-top:8px;">${cap}</p>` : ""}
  </div><p><br></p>`;
  exec("insertHTML", html);
  if (typeof autoSave === "function") autoSave();
}

// ── Layout ─────────────────────────────────────────────
function setPageMargin(t) {
  const m = { normal: "72px 90px", narrow: "48px 54px", wide: "72px 126px" };
  document.querySelectorAll(".page-content").forEach((p) => (p.style.margin = m[t]));
}
function setOrientation(t) {
  document.querySelectorAll(".page").forEach((p) => {
    p.style.width   = t === "landscape" ? "1056px" : "816px";
    p.style.minHeight = t === "landscape" ? "816px" : "1056px";
  });
}
function setColumns(n) {
  document.querySelectorAll(".page-content").forEach((p) => {
    p.style.columnCount = n > 1 ? n : "";
    p.style.columnGap   = n > 1 ? "24px" : "";
    p.style.columnRule  = n > 1 ? "1px solid #ddd" : "";
  });
}
function setZoom(v) {
  document.getElementById("canvasArea").style.zoom  = v / 100;
  document.getElementById("zoom-label").textContent = v + "%";
  document.getElementById("st-zoom").textContent    = v + "%";
}

// ── Find & Replace ─────────────────────────────────────
let findResults = [], findIdx = -1;
function openFindReplace()  { document.getElementById("findBar").classList.add("visible"); document.getElementById("findInput").focus(); }
function closeFindReplace() { document.getElementById("findBar").classList.remove("visible"); clearHighlights(); }
function doFind() {
  clearHighlights();
  const q = document.getElementById("findInput").value;
  if (!q) { document.getElementById("findStatus").textContent = ""; return; }
  let count = 0;
  document.querySelectorAll(".page-content").forEach((p) => {
    p.innerHTML = p.innerHTML.replace(new RegExp(escapeRegex(q), "gi"), (m) => { count++; return `<mark class="search-highlight">${m}</mark>`; });
  });
  findResults = Array.from(document.querySelectorAll(".search-highlight"));
  document.getElementById("findStatus").textContent = `${count} result${count !== 1 ? "s" : ""}`;
  if (findResults.length) { findIdx = 0; scrollToResult(); }
}
function findNext()  { if (!findResults.length) return; findIdx = (findIdx + 1) % findResults.length; scrollToResult(); }
function findPrev()  { if (!findResults.length) return; findIdx = (findIdx - 1 + findResults.length) % findResults.length; scrollToResult(); }
function scrollToResult() { findResults[findIdx]?.scrollIntoView({ behavior: "smooth", block: "center" }); }
function clearHighlights() { document.querySelectorAll(".search-highlight").forEach((el) => el.replaceWith(document.createTextNode(el.textContent))); findResults = []; }
function doReplace() {
  const q = document.getElementById("findInput").value, r = document.getElementById("replaceInput").value;
  if (!q) return;
  findResults[findIdx]?.replaceWith(document.createTextNode(r));
  findResults = Array.from(document.querySelectorAll(".search-highlight"));
}
function doReplaceAll() {
  const q = document.getElementById("findInput").value, r = document.getElementById("replaceInput").value;
  if (!q) return;
  document.querySelectorAll(".search-highlight").forEach((el) => el.replaceWith(document.createTextNode(r)));
  document.getElementById("findStatus").textContent = "All replaced";
  findResults = [];
}

// ── Status & TOC ───────────────────────────────────────
function getAllText() {
  return Array.from(document.querySelectorAll(".page-content")).map((p) => p.innerText).join("\n");
}
function updateStatus() {
  const t = getAllText();
  const w = t.trim() ? t.trim().split(/\s+/).filter(Boolean).length : 0;
  document.getElementById("st-pages").textContent = pages.length;
  document.getElementById("st-words").textContent = w;
  document.getElementById("st-chars").textContent = t.length;
}
function updateAIStatus(msg) { const el = document.getElementById("ai-status"); if (el) el.textContent = msg; }
function refreshTOC() {
  const list = document.getElementById("tocList");
  const hs   = document.querySelectorAll(".page-content h1,.page-content h2,.page-content h3");
  if (!hs.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px;">No headings found…</div>'; return; }
  list.innerHTML = Array.from(hs).map((h) => {
    const t = h.tagName.toLowerCase();
    const cls = t === "h1" ? "h1" : t === "h2" ? "h2" : "h3";
    return `<div class="toc-item ${cls}" onclick="this.closest('.editor-layout').querySelector('.canvas-area').scrollTo({top:${h.offsetTop},behavior:'smooth'})" title="${h.innerText}">${h.innerText}</div>`;
  }).join("");
}
function toggleSidebar() { document.getElementById("sidebar").classList.toggle("collapsed"); }

// ── Modals ─────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }
document.querySelectorAll(".modal-overlay").forEach((m) =>
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); })
);

// ── Word Count & Readability ───────────────────────────
function countWords() {
  const t = getAllText(), w = t.trim() ? t.trim().split(/\s+/).length : 0, s = (t.match(/[.!?]+/g) || []).length;
  document.getElementById("wcBody").innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    <div>Pages</div><div style="color:var(--accent)">${pages.length}</div>
    <div>Words</div><div style="color:var(--accent)">${w.toLocaleString()}</div>
    <div>Characters</div><div style="color:var(--accent)">${t.length.toLocaleString()}</div>
    <div>Sentences</div><div style="color:var(--accent)">${s.toLocaleString()}</div>
    <div>Reading time</div><div style="color:var(--accent)">${Math.ceil(w / 200)} min</div></div>`;
  openModal("wcModal");
}
function showReadability() {
  const t = getAllText(), w = t.trim().split(/\s+/).length || 1, s = (t.match(/[.!?]+/g) || []).length || 1;
  const syl = t.toLowerCase().replace(/[^a-z]/g, "").replace(/[aeiouy]+/g, "|").split("|").length - 1;
  const fk  = 206.835 - 1.015 * (w / s) - 84.6 * (syl / w);
  alert(`Flesch Reading Ease: ${fk.toFixed(1)}\n${fk > 70 ? "Easy" : fk > 50 ? "Standard" : "Complex"}\n\nWords/sentence: ${(w / s).toFixed(1)}\nSyllables/word: ${(syl / w).toFixed(2)}`);
}

// ── Paste (clean) ──────────────────────────────────────
function handlePaste(e) {
  e.preventDefault();
  const t = (e.clipboardData || window.clipboardData).getData("text/plain");
  exec("insertText", t);
}

// ── Auto Save ──────────────────────────────────────────
let saveTimer;
function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("wordweaver_doc", JSON.stringify({
        title: document.getElementById("docTitle").value,
        pages: pages.map((p) => p.innerHTML),
        citations, citationCounter, footnoteCounter,
      }));
    } catch (e) {}
  }, 1500);
}
function loadSaved() {
  try {
    const raw = localStorage.getItem("wordweaver_doc");
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.title) document.getElementById("docTitle").value = d.title;
    if (d.pages && d.pages.length) {
      document.querySelectorAll(".page-wrapper").forEach((w) => w.remove());
      pages = []; pageCount = 0;
      d.pages.forEach((html) => { const p = addPage(); p.innerHTML = html; });
      citations       = d.citations       || [];
      citationCounter = d.citationCounter || 1;
      footnoteCounter = d.footnoteCounter || 1;
      updateStatus(); refreshTOC();
    }
  } catch (e) {}
}

// ── PDF Export ─────────────────────────────────────────
function downloadPDF() {
  const title = document.getElementById("docTitle").value || "document";
  const css   = `<style>@import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400;1,600&display=swap');
  body{background:white;margin:0;font-family:'Crimson Pro',serif;}
  .page{width:816px;min-height:1056px;background:white;page-break-after:always;box-sizing:border-box;}
  .page-content{margin:72px 90px;font-size:12pt;line-height:2;color:#1a1a1a;}
  h1{font-size:18pt;font-weight:700;text-align:center;margin:16px 0 4px;}
  h2{font-size:13pt;font-weight:700;margin:14px 0 4px;border-bottom:1px solid #ddd;padding-bottom:4px;}
  h3{font-size:12pt;font-weight:600;margin:10px 0 4px;font-style:italic;}
  p{margin-bottom:10px;text-align:justify;}
  table{width:100%;border-collapse:collapse;margin:12px 0;}
  th{background:#f0f0f0;border:1px solid #ccc;padding:6px 10px;font-weight:600;}
  td{border:1px solid #ccc;padding:6px 10px;}
  img{max-width:100%;height:auto;}
  .research-abstract{background:#f8f9fa;border-left:3px solid #333;padding:12px 16px;margin:16px 0;}
  .research-abstract-title{font-weight:700;text-align:center;text-transform:uppercase;letter-spacing:1px;}
  .spell-error{border:none!important;}
  .page-footer{text-align:center;font-size:10pt;color:#888;padding:16px 0;}</style>`;
  const html = Array.from(document.querySelectorAll(".page")).map((p, i) =>
    `<div class="page"><div class="page-content">${p.querySelector(".page-content").innerHTML}</div><div class="page-footer">${i + 1}</div></div>`
  ).join("");
  const win = window.open("", "_blank");
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>${css}</head><body>${html}<script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script></body></html>`);
  win.document.close();
}

// ── Utilities ──────────────────────────────────────────
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escHtml(s)     { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function showToast(msg, dur = 2500) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), dur);
}

// ── Keyboard Shortcuts ─────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case "b": e.preventDefault(); fmtToggle("bold",      "bold-btn");      break;
      case "i": e.preventDefault(); fmtToggle("italic",    "italic-btn");    break;
      case "u": e.preventDefault(); fmtToggle("underline", "underline-btn"); break;
      case "z": e.preventDefault(); exec("undo");     break;
      case "y": e.preventDefault(); exec("redo");     break;
      case "f": e.preventDefault(); openFindReplace(); break;
      case "p": e.preventDefault(); downloadPDF();    break;
      case "m": e.preventDefault(); addPage();        break;
    }
  }
  if (e.key === "Escape") {
    closeFindReplace();
    document.querySelectorAll(".modal-overlay").forEach((m) => m.classList.add("hidden"));
    hideSpellPopup();
  }
});