/*!
 * Support Chat Widget — self-contained, no API.
 * Answers come from a local knowledge file (kb.json) built from your Zoho Desk ticket export.
 *
 * Embed:
 *   <script src="/support-chat/support-chat.js"
 *           data-kb="/support-chat/kb.json"
 *           data-title="Help center"
 *           data-color="#1f6feb" defer></script>
 *
 * Or set window.SupportChatConfig = {...} before the script loads (used by the WordPress plugin).
 */
(function () {
  "use strict";
  if (window.__supportChatLoaded) return;
  window.__supportChatLoaded = true;

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */
  var script = document.currentScript;
  var ds = (script && script.dataset) || {};
  var user = window.SupportChatConfig || {};
  function pick(key, fallback) {
    if (user[key] !== undefined && user[key] !== "") return user[key];
    if (ds[key] !== undefined && ds[key] !== "") return ds[key];
    return fallback;
  }
  var CFG = {
    kb: pick("kb", "kb.json"),                 // URL of kb.json (used directly, or as the backup when Firebase is set)
    firebaseProject: pick("firebaseProject", ""), // Firebase project ID: answers load from Firestore
    firebaseKey: pick("firebaseKey", ""),         // Firebase web API key (safe to be public; access is controlled by security rules)
    kbDoc: pick("kbDoc", "kb/current"),           // Firestore document holding the answers
    firestoreBase: pick("firestoreBase", "https://firestore.googleapis.com/v1"),
    kbData: user.kbData || null,               // or pass the knowledge object inline
    title: pick("title", "Website support"),
    subtitle: pick("subtitle", ""),            // optional line under the title
    greeting: pick("greeting", "Hi! Ask me how to update your website or fix a problem, and I'll walk you through it step by step."),
    color: pick("color", "#0e78a8"),          // buttons (readable with white text)
    accent: pick("accent", "#189ad0"),        // brand blue for marks and highlights
    logo: pick("logo", ""),                   // optional header icon URL; defaults to the built-in REACHRIGHT mark
    launcherLabel: pick("launcherLabel", "Need help?"),
    theme: pick("theme", "auto"),                 // "auto" follows the device; "light" always light (WordPress dashboard)
    userName: pick("userName", ""),               // pre-fill the ticket form (logged-in admin)
    userEmail: pick("userEmail", ""),
    siteLabel: pick("siteLabel", ""),
    nonce: pick("nonce", ""),                     // WordPress security token for tickets
    position: pick("position", "right"),        // "right" | "left"
    contactUrl: pick("contactUrl", ""),        // e.g. your Zoho Desk help-center ticket form
    contactEmail: pick("contactEmail", ""),    // mailto fallback, transcript prefilled
    contactLabel: pick("contactLabel", "Submit a ticket"),
    supportEmail: pick("supportEmail", ""),     // where ticket-form requests go (shown to visitors, used for mailto fallback)
    ticketEndpoint: pick("ticketEndpoint", ""), // same-site URL that emails the form (WordPress plugin or send.php); "test" = preview only
    suggestions: parseList(pick("suggestions", "")), // starter chips, "a|b|c"
    threshold: parseFloat(pick("threshold", "0.35")), // 0–1, higher = stricter matching
    maxTries: pick("maxTries", "2"),           // failed fixes before suggesting a ticket
    persist: pick("persist", "true") !== "false"
  };
  function parseList(v) {
    if (Array.isArray(v)) return v;
    return String(v || "").split("|").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * Search engine: BM25 + typo tolerance, fully in-browser
   * ------------------------------------------------------------------ */
  var STOP = {};
  ("a an and are as at be been but by can could do does did for from had has have how i im i'm if in into is it its " +
   "me my of on or our please so that the their them then there these they this to was we were what when where which " +
   "who why will with would you your hi hello hey thanks thank need want get got help know tell about just " +
   "website websites site web issue issues problem problems question questions stuff thing things working work again another our us change changing edit editing").split(" ")
    .forEach(function (w) { STOP[w] = 1; });

  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function stem(w) {
    if (w.length <= 3) return w;
    return w.replace(/(ingly|edly|ing|ies|ied|ed|ly|es|s)$/, function (m) {
      return m === "ies" || m === "ied" ? "y" : "";
    }) || w;
  }
  function tokens(s) {
    var out = [];
    norm(s).split(/[^a-z0-9]+/).forEach(function (w) {
      if (w && !STOP[w] && (w.length > 1 || /\d/.test(w))) out.push(stem(w));
    });
    return out;
  }
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function Engine(entries) {
    var self = this;
    this.docs = [];
    this.df = {};
    this.vocab = [];
    var totalLen = 0;
    entries.forEach(function (e, idx) {
      if (!e || !e.a) return;
      var qText = [e.q].concat(e.alt || [], e.tags || [], e.cat ? [e.cat] : []).join(" ");
      var qt = tokens(qText), at = tokens(e.a);
      var tf = {};
      qt.forEach(function (t) { tf[t] = (tf[t] || 0) + 2.0; });   // question/keywords weigh most
      at.forEach(function (t) { tf[t] = (tf[t] || 0) + 0.4; });   // answer text helps a little
      var len = qt.length * 2 + at.length * 0.4;
      totalLen += len;
      var qset = {};
      qt.forEach(function (t) { qset[t] = 1; });
      Object.keys(tf).forEach(function (t) { self.df[t] = (self.df[t] || 0) + 1; });
      var phrases = [e.q].concat(e.alt || []).map(function (x) { return tokens(x).join(" "); }).filter(Boolean);
      self.docs.push({ e: e, tf: tf, len: len, qset: qset, idx: idx, phrases: phrases });
    });
    this.avgLen = this.docs.length ? totalLen / this.docs.length : 1;
    this.vocab = Object.keys(this.df);
    this.fixCache = {};
  }
  Engine.prototype.correct = function (t) {
    if (this.df[t] || t.length < 4 || /\d/.test(t)) return t;
    if (this.fixCache[t] !== undefined) return this.fixCache[t];
    var max = t.length > 7 ? 2 : 1, best = null, bestD = max + 1, bestDf = 0;
    for (var i = 0; i < this.vocab.length; i++) {
      var v = this.vocab[i];
      if (Math.abs(v.length - t.length) > max) continue;
      var d = lev(t, v, max);
      if (d < bestD || (d === bestD && this.df[v] > bestDf)) { best = v; bestD = d; bestDf = this.df[v]; }
    }
    return (this.fixCache[t] = bestD <= max ? best : t);
  };
  Engine.prototype.search = function (query, limit) {
    var self = this, N = this.docs.length, k1 = 1.4, b = 0.7;
    var qt = tokens(query).map(function (t) { return self.correct(t); });
    var uniq = qt.filter(function (t, i) { return qt.indexOf(t) === i; });
    if (!uniq.length || !N) return [];
    var maxIdf = 0;
    var idf = {};
    uniq.forEach(function (t) {
      var df = self.df[t] || 0;
      idf[t] = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      maxIdf += idf[t];
    });
    var results = [];
    var qPhrase = " " + qt.join(" ") + " ";
    this.docs.forEach(function (d) {
      var s = 0, hitIdf = 0, qHits = 0;
      uniq.forEach(function (t) {
        var f = d.tf[t];
        if (!f) return;
        s += idf[t] * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / self.avgLen));
        hitIdf += idf[t];
        if (d.qset[t]) qHits++;
      });
      if (s > 0) {
        // confidence: how much of the (weighted) query this entry covers, favoring question matches
        var coverage = hitIdf / maxIdf;
        var conf = coverage * (0.6 + 0.4 * (qHits / uniq.length));
        // answers built from real ticket solutions win close calls over starter answers
        if (d.e.src === "ticket") conf += 0.05;
        // exact phrase match with the question or a listed "other way to ask" wins ties
        for (var p = 0; p < d.phrases.length; p++) {
          if (d.phrases[p] && qPhrase.indexOf(" " + d.phrases[p] + " ") > -1) { conf += 0.15 * Math.min(1, d.phrases[p].split(" ").length / uniq.length); break; }
        }
        results.push({ entry: d.e, score: s, conf: conf, qHits: qHits, qRatio: qHits / uniq.length });
      }
    });
    results.sort(function (a, b) { return b.conf - a.conf || b.score - a.score; });
    return results.slice(0, limit || 3);
  };

  /* ------------------------------------------------------------------ *
   * Small talk / intents that don't need the knowledge base
   * ------------------------------------------------------------------ */
  function intent(text) {
    var t = norm(text).trim();
    if (/^(hi|hello|hey|good (morning|afternoon|evening)|yo|kumusta|hola)\b[!. ]*$/.test(t)) return "greet";
    if (/^(thanks|thank you|ty|thx|salamat|great|perfect|ok(ay)?|cool)\b/.test(t) && t.length < 30) return "thanks";
    if (/\b(human|agent|person|representative|real person|talk to (someone|support)|contact (you|support|us)|open a ticket|submit a ticket)\b/.test(t)) return "human";
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function formatAnswer(s) {
    var links = [];
    // [link text](https://...) and bare URLs / emails become links; everything else is escaped text
    var text = String(s).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      links.push('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>");
      return "\u0000" + (links.length - 1) + "\u0000";
    });
    var html = esc(text)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(>*])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1<a href="mailto:$2">$2</a>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\u0000(\d+)\u0000/g, function (_, i) { return links[+i]; });
    return html.split(/\n{2,}/).map(function (p) { return "<p>" + p.replace(/\n/g, "<br>") + "</p>"; }).join("");
  }
  var LOOM = /https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([a-f0-9]{16,40})[^\s)\]]*/gi;
  function splitVideos(text, extra) {
    var ids = [];
    var add = function (id) { id = id.toLowerCase(); if (ids.indexOf(id) === -1) ids.push(id); };
    var clean = String(text || "").replace(/\[([^\]]*)\]\((https?:\/\/(?:www\.)?loom\.com\/[^)]+)\)/gi, "$2") // [label](loom) -> bare
      .replace(LOOM, function (_, id) { add(id); return ""; });
    (Array.isArray(extra) ? extra : extra ? [extra] : []).forEach(function (u) { String(u).replace(LOOM, function (_, id) { add(id); return ""; }); });
    // tidy leftovers like "Video walkthrough:" or "Here's a video:" with nothing after them
    clean = clean.replace(/^[^\n]{0,60}(video|loom|walkthrough|watch)[^\n]{0,40}:\s*$/gim, "").replace(/\(\s*\)/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return { text: clean, ids: ids };
  }
  var ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
  function videoCards(ids) {
    return ids.map(function (id, i) {
      return '<button type="button" class="vid" data-vid="' + esc(id) + '"><span class="play">' + ICON_PLAY + "</span><span><strong>" +
        (ids.length > 1 ? "Watch video walkthrough " + (i + 1) : "Watch the video walkthrough") + "</strong><small>Loom video · plays right here</small></span></button>";
    }).join("");
  }
  function renderAnswer(a, video) {
    var v = splitVideos(a, video);
    return { html: formatAnswer(v.text) + videoCards(v.ids), hasVideo: v.ids.length > 0 };
  }
  function firestoreUrl(path) {
    return CFG.firestoreBase + "/projects/" + encodeURIComponent(CFG.firebaseProject) +
      "/databases/(default)/documents/" + path + (CFG.firebaseKey ? "?key=" + encodeURIComponent(CFG.firebaseKey) : "");
  }
  function loadFromFirebase() {
    // Answers are stored as one document (a JSON string), so each visit costs a single read.
    return fetch(firestoreUrl(CFG.kbDoc))
      .then(function (r) { if (!r.ok) throw new Error("Firestore " + r.status); return r.json(); })
      .then(function (doc) {
        var f = doc && doc.fields && doc.fields.json;
        if (!f || !f.stringValue) throw new Error("No answers published yet");
        return JSON.parse(f.stringValue);
      });
  }
  function store(key, val) {
    if (!CFG.persist) return null;
    try {
      if (val === undefined) return JSON.parse(sessionStorage.getItem(key) || "null");
      sessionStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* storage blocked: chat still works, just not across pages */ }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * UI (Shadow DOM so the host site's CSS can't break it)
   * ------------------------------------------------------------------ */
  var SIDE = CFG.position === "left" ? "left" : "right";
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    ".wrap{--c:" + CFG.color + ";--accent:" + CFG.accent + ";--ink:#040707;--text:#1c2226;--mute:#5b656c;--line:#e2e7ea;--bg:#fff;--soft:#f3f6f8;--me:#040707;--meText:#fff;--chipText:" + CFG.color + ";",
    "position:fixed;bottom:20px;" + SIDE + ":20px;z-index:2147483000;",
    "font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}",
    "@media (prefers-color-scheme:dark){.wrap{--text:#e7ecef;--mute:#9aa6ae;--line:#2a3237;--bg:#151a1d;--soft:#0d1113;--me:#2a3237;--chipText:" + CFG.accent + "}}",
    /* launcher: black pill with the brand mark */
    ".launch{display:flex;align-items:center;gap:10px;height:54px;padding:0 20px 0 16px;border:0;border-radius:999px;background:var(--ink);color:#fff;cursor:pointer;",
    "font:800 15px/1 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.01em;box-shadow:0 10px 28px rgba(4,7,7,.28);transition:transform .15s,box-shadow .15s;margin-left:auto}",
    ".launch:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(4,7,7,.34)}",
    ".launch .mk{width:22px;height:25px;flex:none}",
    ".launch.open{width:54px;padding:0;justify-content:center}",
    ".launch.open .lbl,.launch.open .mk{display:none}",
    ".launch .x{display:none}.launch.open .x{display:block}",
    "button:focus-visible,a:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}",
    /* panel */
    ".panel{position:absolute;bottom:70px;" + SIDE + ":0;width:380px;height:600px;max-height:calc(100vh - 110px);background:var(--bg);border-radius:18px;overflow:hidden;",
    "display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(4,7,7,.28);border:1px solid var(--line);transform-origin:bottom " + SIDE + ";transition:opacity .18s,transform .18s}",
    ".panel[hidden]{display:flex;opacity:0;transform:scale(.95) translateY(10px);pointer-events:none;visibility:hidden}",
    ".head{background:var(--ink);color:#fff;padding:18px 18px 16px;border-bottom:3px solid var(--accent);display:flex;align-items:center;gap:14px}",
    ".head .icon{width:30px;height:34px;flex:none;margin-top:1px;object-fit:contain}",
    ".head h2{margin:0;font-size:17px;font-weight:800;line-height:1.2;letter-spacing:-.005em}",
    ".head p{margin:3px 0 0;font-size:13px;color:#b9c3c9}",

    ".head .x{margin-left:auto;background:transparent;border:0;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:grid;opacity:.8}",
    ".head .x:hover{background:rgba(255,255,255,.12);opacity:1}",
    /* messages */
    ".log{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;background:var(--soft)}",
    ".msg{max-width:88%;padding:11px 14px;border-radius:16px;word-wrap:break-word}",
    ".msg p{margin:0 0 8px}.msg p:last-child{margin:0}",
    ".msg a{color:var(--c);font-weight:600}",
    ".msg strong{color:inherit;font-weight:700}",
    ".bot{background:var(--bg);border:1px solid var(--line);border-bottom-left-radius:5px;align-self:flex-start}",
    ".me{background:var(--me);color:var(--meText);border-bottom-right-radius:5px;align-self:flex-end}",
    ".me a{color:#fff}",
    ".src{display:block;margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--mute)}",
    ".chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:100%}",
    ".chip{background:var(--bg);border:1.5px solid var(--line);color:var(--text);border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:border-color .12s,color .12s}",
    ".chip:hover{border-color:var(--accent);color:var(--chipText)}",
    ".cta{display:inline-block;margin-top:6px;background:var(--c);color:#fff !important;text-decoration:none !important;padding:10px 16px;border-radius:10px;font-size:14px;font-weight:700}",
    ".cta:hover{filter:brightness(1.08)}",
    ".vid{display:flex;align-items:center;gap:12px;width:100%;margin-top:10px;padding:10px 12px;border:1.5px solid var(--line);border-radius:12px;background:var(--soft);color:var(--text);font:inherit;text-align:left;cursor:pointer;transition:border-color .12s}",
    ".vid:hover{border-color:var(--accent)}",
    ".vid .play{width:40px;height:40px;border-radius:50%;background:var(--ink);display:grid;place-items:center;flex:none}",
    "@media (prefers-color-scheme:dark){.vid .play{background:var(--c)}}",
    ".vid strong{display:block;font-size:14px;font-weight:700}",
    ".vid small{display:block;font-size:12px;color:var(--mute)}",
    ".vframe{position:relative;width:100%;padding-top:62.5%;margin-top:10px;border-radius:12px;overflow:hidden;background:#000}",
    ".vframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
    ".vopen{display:inline-block;margin-top:6px;font-size:12px}",
    ".msg.hasvid{max-width:92%}",
    ".typing{display:flex;gap:5px;padding:15px}",
    ".typing i{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:b 1s infinite}",
    ".typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}",
    "@keyframes b{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}",
    /* composer */
    "form.comp{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line);background:var(--bg)}",
    "form.comp textarea{flex:1;resize:none;border:1.5px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit;color:var(--text);background:var(--bg);max-height:110px}",
    "form.comp textarea:focus{border-color:var(--accent);outline:none}",
    ".send{border:0;background:var(--ink);color:#fff;border-radius:12px;width:46px;cursor:pointer;display:grid;place-items:center}",
    "@media (prefers-color-scheme:dark){.send{background:var(--c)}}",
    ".send:disabled{opacity:.35;cursor:default}",
    ".foot{display:flex;justify-content:space-between;align-items:center;padding:0 14px 10px;background:var(--bg);font-size:12px;color:var(--mute)}",
    ".foot button{background:none;border:0;color:var(--mute);font:inherit;cursor:pointer;text-decoration:underline;padding:0}",
    /* ticket form */
    ".tform{display:flex;flex-direction:column;gap:9px;width:100%}",
    ".tform .ttl{margin:0;font-weight:800;font-size:15px}",
    ".tform .sub{margin:-4px 0 2px;font-size:13px;color:var(--mute)}",
    ".tform label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600}",
    ".tform input,.tform textarea{font:inherit;font-weight:400;font-size:14px;padding:9px 11px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);width:100%}",
    ".tform input:focus,.tform textarea:focus{border-color:var(--accent);outline:none}",
    ".tform .chk{flex-direction:row;align-items:flex-start;gap:8px;font-weight:400;line-height:1.35}",
    ".tform .chk input{width:auto;margin:2px 0 0;accent-color:var(--c)}",
    ".tform .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}",
    ".tform .row{display:flex;gap:10px;align-items:center;margin-top:2px}",
    ".tform .cta{margin-top:0;border:0;cursor:pointer;font:inherit;font-weight:700}",
    ".tform .cancel{background:none;border:0;color:var(--mute);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline}",
    ".tform .err{color:#c62828;font-size:13px;margin:0}",
    ".msg.wide{max-width:100%;width:100%}",
    "@media (max-width:480px){.wrap{bottom:14px;" + SIDE + ":14px}.panel{position:fixed;inset:0;width:auto;height:auto;max-height:none;border-radius:0;bottom:0}}",
    "@media (prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important}}"
  ].filter(function (rule) { return CFG.theme !== "light" || rule.indexOf("prefers-color-scheme:dark") === -1; }).join("");

  var MARK = '<svg class="mk" viewBox="0 0 34 38" aria-hidden="true"><g fill="' + CFG.accent + '"><polygon points="8,1 16.2,1 13.7,11.6 11.1,11.6"/><path d="M25.2,9H30.6C31.6,9 31.9,9.8 31.6,10.9L30.3,15.6C30,16.6 29.3,17.1 28.4,17.1H23L24.1,10.4C24.3,9.5 24.7,9 25.2,9Z"/><path d="M6.3,20.6H12L10.9,27.3C10.7,28.2 10.2,28.6 9.6,28.6H4.4C3.4,28.6 3.1,27.8 3.4,26.8L4.7,22C5,21.1 5.5,20.6 6.3,20.6Z"/><polygon points="21,26.2 24.2,26.2 27.1,37.6 18.9,37.6"/></g></svg>';
  var ICON_X = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';

  function mount() {
    var host = document.createElement("div");
    host.id = "support-chat-root";
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML =
      "<style>" + CSS + "</style>" +
      '<div class="wrap">' +
        '<section class="panel" role="dialog" aria-label="' + esc(CFG.title) + '" hidden>' +
          '<header class="head">' +
            (CFG.logo ? '<img class="icon" src="' + esc(CFG.logo) + '" alt="">' : MARK.replace('class="mk"', 'class="icon"')) +
            "<div><h2>" + esc(CFG.title) + "</h2>" + (CFG.subtitle ? "<p>" + esc(CFG.subtitle) + "</p>" : "") + "</div>" +
          '<button class="x" type="button" aria-label="Close chat">' + ICON_X + "</button></header>" +
          '<div class="log" aria-live="polite"></div>' +
          '<form class="comp"><textarea rows="1" placeholder="Ask a question…" aria-label="Your question"></textarea>' +
          '<button class="send" type="submit" aria-label="Send" disabled>' + ICON_SEND + "</button></form>" +
          '<div class="foot"><span>Step-by-step website help</span><button type="button" class="reset">Start over</button></div>' +
        "</section>" +
        '<button class="launch" type="button" aria-label="Open support chat" aria-expanded="false">' + MARK + '<span class="lbl">' + esc(CFG.launcherLabel) + '</span><span class="x">' + ICON_X + "</span></button>" +
      "</div>";

    var $ = function (s) { return root.querySelector(s); };
    var panel = $(".panel"), log = $(".log"), form = $("form.comp"), input = $("textarea"),
        send = $(".send"), launch = $(".launch");
    var engine = null, guides = null, history = store("sc_history") || [], busy = false;

    /* --- rendering --- */
    function scroll() { log.scrollTop = log.scrollHeight; }
    function addMsg(who, html, save) {
      var el = document.createElement("div");
      el.className = "msg " + who;
      el.innerHTML = html;
      log.appendChild(el);
      if (save !== false) { history.push({ w: who, h: html }); store("sc_history", history.slice(-60)); }
      scroll();
      return el;
    }
    function addChips(list, onPick) {
      var box = document.createElement("div");
      box.className = "chips";
      list.forEach(function (label) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "chip"; b.textContent = label;
        b.addEventListener("click", function () { box.remove(); onPick(label); });
        box.appendChild(b);
      });
      log.appendChild(box);
      scroll();
    }
    function ticketFormOn() { return !!(CFG.ticketEndpoint || CFG.supportEmail); }
    function contactHtml(lead) {
      var html = lead ? "<p>" + lead + "</p>" : "";
      if (ticketFormOn()) {
        html += '<button type="button" class="cta" data-action="ticket" style="border:0;cursor:pointer;font:inherit;font-weight:600">' + esc(CFG.contactLabel) + "</button>";
      } else if (CFG.contactUrl) {
        html += '<a class="cta" href="' + esc(CFG.contactUrl) + '" target="_blank" rel="noopener">' + esc(CFG.contactLabel) + "</a>";
      } else if (CFG.contactEmail) {
        var transcript = history.filter(function (m) { return m.w === "me"; })
          .map(function (m) { return "- " + m.h.replace(/<[^>]+>/g, ""); }).join("\n");
        var href = "mailto:" + encodeURIComponent(CFG.contactEmail) +
          "?subject=" + encodeURIComponent("Support request from chat") +
          "&body=" + encodeURIComponent("My questions:\n" + transcript + "\n\nDetails:\n");
        html += '<a class="cta" href="' + esc(href) + '">Email support</a>';
      }
      return html;
    }

    /* --- ticket form (emails your support address through your own site) --- */
    function lastQuestion() {
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i].w === "me") {
          var t = history[i].h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          if (!/^(yes, all good|yes, that helped|not quite|no|something else|none of these)$/i.test(t)) return t;
        }
      }
      return "";
    }
    function transcriptText() {
      return history.map(function (m) {
        var t = m.h.replace(/<button[\s\S]*?<\/button>/g, "").replace(/<a class="cta"[\s\S]*?<\/a>/g, "").replace(/<span class="src">[\s\S]*?<\/span>/g, "").replace(/<p style="margin-top:10px">Still need help\?<\/p>/g, "").replace(/<br>/g, "\n").replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        return (m.w === "me" ? "Visitor: " : "Chat: ") + t;
      }).join("\n\n").slice(-8000);
    }
    function openTicketForm() {
      var old = log.querySelector(".tform");
      if (old) { old.querySelector("input[name=name]").focus(); return; }
      var el = document.createElement("div");
      el.className = "msg bot wide";
      el.innerHTML =
        '<form class="tform" novalidate>' +
          '<p class="ttl">Send a request to our support team</p>' +
          '<p class="sub">A real person replies within one business day (Mon–Fri, 9–5 Central).</p>' +
          '<label>Your name<input name="name" autocomplete="name" required></label>' +
          '<label>Your email<input name="email" type="email" autocomplete="email" required></label>' +
          '<label>Church name and website<input name="website" autocomplete="organization" placeholder="Grace Church, www.gracechurch.org"></label>' +
          '<label>How can we help?<textarea name="message" rows="4" required></textarea></label>' +
          '<label class="chk"><input type="checkbox" name="urgent"> My website is down (urgent)</label>' +
          '<label class="chk"><input type="checkbox" name="include" checked> Include this chat conversation</label>' +
          '<label class="hp" aria-hidden="true">Leave empty<input name="company_site" tabindex="-1" autocomplete="off"></label>' +
          '<p class="err" hidden></p>' +
          '<div class="row"><button type="submit" class="cta">Send request</button><button type="button" class="cancel">Cancel</button></div>' +
        "</form>";
      log.appendChild(el);
      var f = el.querySelector("form"), F = f.elements, err = el.querySelector(".err"), opened = Date.now();
      F.message.value = (thread && thread.q) || lastQuestion();
      if (CFG.userName) F.name.value = CFG.userName;
      if (CFG.userEmail) F.email.value = CFG.userEmail;
      if (CFG.siteLabel) F.website.value = CFG.siteLabel;
      if (/\b(down|not loading|offline|white screen|urgent)\b/i.test(F.message.value)) F.urgent.checked = true;
      f.querySelector(".cancel").addEventListener("click", function () { el.remove(); input.focus(); });
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var name = F.name.value.trim(), email = F.email.value.trim(), msg = F.message.value.trim();
        err.hidden = true;
        if (!name) return showErr("Enter your name.", F.name);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showErr("Enter a valid email address so we can reply.", F.email);
        if (msg.length < 5) return showErr("Tell us a little about what you need.", F.message);
        var data = {
          name: name, email: email, website: F.website.value.trim(), message: msg,
          transcript: F.include.checked ? transcriptText() : "",
          urgent: F.urgent.checked ? "1" : "",
          page: location.href, company_site: F.company_site.value, elapsed: String(Date.now() - opened)
        };
        var btn = f.querySelector("button[type=submit]");
        btn.disabled = true; btn.textContent = "Sending…";
        sendTicket(data).then(function (mode) {
          el.remove();
          if (mode === "test") {
            addMsg("bot", "<p><strong>Test mode:</strong> on your live site, this request would be emailed to " + esc(CFG.supportEmail || "your support address") + " with the visitor's details and this chat attached.</p>");
          } else {
            addMsg("bot", "<p>Thanks, " + esc(name.split(" ")[0]) + "! Your request is with our support team. We'll reply to <strong>" + esc(email) + "</strong> within one business day" + (data.urgent ? ", and urgent requests go to the front of the line" : "") + ".</p>");
          }
        }).catch(function () {
          btn.disabled = false; btn.textContent = "Send request";
          var fallback = CFG.supportEmail ? ' You can also email us at <a href="mailto:' + esc(CFG.supportEmail) + "?subject=" + encodeURIComponent("Support request") + "&body=" + encodeURIComponent(msg + "\n\n" + name + (data.website ? "\n" + data.website : "")) + '">' + esc(CFG.supportEmail) + "</a>." : "";
          err.innerHTML = "The request couldn't be sent. Check your connection and try again." + fallback;
          err.hidden = false;
        });
      });
      function showErr(t, field) { err.textContent = t; err.hidden = false; field.focus(); }
      scroll();
      (F.name.value ? (F.email.value ? F.message : F.email) : F.name).focus();
    }
    function ticketText(data) {
      return "New support request from the website chat\n\n" +
        "Name: " + data.name + "\nEmail: " + data.email + "\n" +
        (data.website ? "Church / website: " + data.website + "\n" : "") +
        (data.page ? "Sent from page: " + data.page + "\n" : "") +
        "\nMessage:\n" + data.message + "\n" +
        (data.transcript ? "\n--- Chat conversation ---\n" + data.transcript + "\n" : "");
    }
    function sendToFirebase(data) {
      // same spam traps the PHP handlers use: quietly "succeed" for bots
      if (data.company_site || +data.elapsed < 3000) return Promise.resolve("sent");
      var subject = (data.urgent ? "URGENT: Website Down - " : "Chat request: ") + data.message.replace(/\s+/g, " ").slice(0, 70);
      var sv = function (v) { return { stringValue: String(v || "").slice(0, 9000) }; };
      var body = { fields: {
        to: sv(CFG.supportEmail),
        replyTo: sv(data.name.replace(/[<>"]/g, "") + " <" + data.email + ">"),
        message: { mapValue: { fields: { subject: sv(subject), text: sv(ticketText(data)) } } },
        name: sv(data.name.slice(0, 100)), email: sv(data.email.slice(0, 200)), website: sv((data.website || "").slice(0, 200)),
        page: sv((data.page || "").slice(0, 500)), urgent: { booleanValue: !!data.urgent },
        status: sv("new"), createdAt: { timestampValue: new Date().toISOString() }
      } };
      return fetch(firestoreUrl("mail"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { if (!r.ok) throw new Error("Firestore " + r.status); return "sent"; });
    }
    function sendTicket(data) {
      if (!CFG.ticketEndpoint || CFG.ticketEndpoint === "test") return Promise.resolve("test");
      if (CFG.ticketEndpoint === "firebase") return sendToFirebase(data);
      var body = new FormData();
      Object.keys(data).forEach(function (k) { body.append(k, data[k]); });
      if (CFG.nonce) body.append("nonce", CFG.nonce);
      return fetch(CFG.ticketEndpoint, { method: "POST", body: body, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j || j.success === false) throw new Error("send failed"); return "sent"; }); });
    }
    log.addEventListener("click", function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-action="ticket"]');
      if (t) { ev.preventDefault(); openTicketForm(); return; }
      var v = ev.target.closest && ev.target.closest(".vid");
      if (v) {
        var id = v.getAttribute("data-vid");
        if (!/^[a-f0-9]{16,40}$/.test(id)) return;
        var box = document.createElement("div");
        box.innerHTML = '<div class="vframe"><iframe src="https://www.loom.com/embed/' + id + '?hide_owner=true&hide_share=true&hide_title=true" allow="fullscreen" allowfullscreen title="Video walkthrough"></iframe></div>' +
          '<a class="vopen" href="https://www.loom.com/share/' + id + '" target="_blank" rel="noopener noreferrer">Open in Loom</a>';
        v.replaceWith(box);
        var m = box.closest(".msg"); if (m) m.classList.add("wide");
      }
    });

    /* --- answering: answer, check in, try the next closest fix, then offer a ticket --- */
    var MAX_TRIES = Math.max(1, parseInt(CFG.maxTries, 10) || 2);
    var thread = null;   // { q, hits, shown, tries, cat }
    var misses = 0;      // questions in a row with no match
    function vary(list) { return list[Math.floor(Math.random() * list.length)]; }
    function entryKey(e) { return e.id || e.q; }
    function isNo(t) {
      t = norm(t).trim();
      return /^(no|nope|nah|not (really|quite|yet|working)|didn'?t (work|help|fix)|doesn'?t (work|help)|it didn'?t|that didn'?t|still (not|doesn'?t|isn'?t|broken|the same|having|getting|down)|same (problem|issue|thing)|nothing changed|none of (these|those)|something else)\b/.test(t);
    }
    function isYes(t) {
      t = norm(t).trim();
      return t.length < 45 && /^(yes|yep|yeah|yup|it worked|that worked|worked|fixed|solved|all good|perfect|great|awesome|thanks|thank you|ty|salamat|got it|that did it|that helped)\b/.test(t);
    }
    function showEntry(e, lead) {
      var cta = "";
      if (e.handoff && (ticketFormOn() || CFG.contactUrl || CFG.contactEmail)) {
        cta = '<p style="margin-top:10px">If this doesn\'t fix it, let us know right away:</p>' + contactHtml("");
      }
      var r = renderAnswer(e.a, e.video);
      var el = addMsg("bot", (lead ? "<p>" + lead + "</p>" : "") + r.html + cta);
      if (r.hasVideo) el.classList.add("hasvid");
      if (thread) { thread.shown[entryKey(e)] = 1; if (!thread.cat) thread.cat = e.cat || ""; if (!thread.firstText) thread.firstText = e.a || ""; }
      checkIn();
    }
    function checkIn() {
      addMsg("bot", "<p>" + vary(["Did that fix it?", "Did that solve it for you?", "Is it all good now?", "Did that do the trick?"]) + "</p>");
      addChips(["Yes, all good", "Not quite"], ask);
    }
    function resolved() {
      thread = null; misses = 0;
      addMsg("bot", "<p>" + vary(["Great, glad that's sorted!", "Awesome, happy that worked!", "Perfect, glad we got it fixed!"]) + " Anything else I can help with?</p>");
    }
    function suggestTicket(lead) {
      addMsg("bot", contactHtml(lead || "Sorry we couldn't fix this here. It sounds like this one needs a closer look from our team. Send a support ticket and a real person will reply within one business day."));
    }
    function nextAlternative() {
      var th = CFG.threshold;
      // follow-ups must match the question itself (not just common words like "Save" in the steps)
      var rest = thread.hits.filter(function (h) { return !thread.shown[entryKey(h.entry)] && h.conf >= th * 0.8 && h.qRatio >= 0.5; });
      rest.sort(function (a, b) {
        var sa = a.conf + (thread.cat && a.entry.cat === thread.cat ? 0.2 : 0);
        var sb = b.conf + (thread.cat && b.entry.cat === thread.cat ? 0.2 : 0);
        return sb - sa;
      });
      return rest[0];
    }
    function guideName(e) { return e && e.src === "wp" ? "WordPress help guides" : "Cornerstone help guides"; }
    function fromGuides() {
      if (!guides || thread.usedGuides) return null;
      var hits = guides.search(thread.q, 6).filter(function (h) { return h.conf >= CFG.threshold * 0.6 && h.qHits > 0 && !thread.shown["g:" + entryKey(h.entry)]; });
      // prefer the guide library that fits the first answer (Cornerstone steps -> Cornerstone guides)
      var lean = /cornerstone/i.test(thread.firstText || "") ? "cornerstone" : /(settings|appearance|users|media|posts|tools|plugins) →/i.test(thread.firstText || "") ? "wp" : "";
      hits.sort(function (a, b) {
        return (b.conf + (lean && b.entry.src === lean ? 0.12 : 0)) - (a.conf + (lean && a.entry.src === lean ? 0.12 : 0));
      });
      return hits[0] || null;
    }
    function notQuite() {
      thread.tries++;
      if (thread.tries >= MAX_TRIES) return suggestTicket();
      // second response: search the Cornerstone help guides
      var g = fromGuides();
      if (g) {
        thread.usedGuides = true;
        thread.shown["g:" + entryKey(g.entry)] = 1;
        var gn = guideName(g.entry);
        addMsg("bot", "<p>" + vary([
          "Sorry about that. I searched the " + gn + ", and here's what they suggest:",
          "Let's try another angle. Here's what the " + gn + " recommend:",
          "Okay, I looked this up in the " + gn + ". Try this:"
        ]) + "</p>" + renderAnswer(g.entry.a, g.entry.video).html + '<span class="src">From the ' + gn + ": " + esc(g.entry.q) + "</span>");
        return checkIn();
      }
      var alt = nextAlternative();
      if (!alt) return suggestTicket("Sorry about that. I don't have another fix for this one, so it's best to have our team take a look. Send a support ticket and a real person will reply within one business day.");
      showEntry(alt.entry, vary([
        "Sorry about that. Let's try this instead:",
        "Okay, here's another fix that often solves it:",
        "Got it. This is the next closest match to your issue:"
      ]));
    }
    function answer(q) {
      if (thread && /^something else$/i.test(q.trim())) {
        thread.tries++;
        if (thread.tries >= MAX_TRIES) return suggestTicket("No problem. Our team can take a closer look: send a support ticket and a real person will reply within one business day.");
        return addMsg("bot", "<p>No problem. Could you describe it another way? For example, which page it's on or what you see on the screen.</p>");
      }
      // replies to "Did that fix it?"
      if (thread && isNo(q)) return notQuite();
      if (thread && isYes(q)) return resolved();

      var kind = intent(q);
      if (kind === "greet") return addMsg("bot", "<p>Hello! What can I help you with today?</p>");
      if (kind === "thanks") return addMsg("bot", "<p>You're welcome! Anything else I can help with?</p>");
      if (kind === "human") return addMsg("bot", contactHtml("Sure. Send us a request and a real person on our support team will reply by email."));
      if (!engine) return addMsg("bot", contactHtml("The help library didn't load, so I can't search answers right now."));

      var hits = engine.search(q, 8);
      var top = hits[0];
      // Your own answers come first. The help guides answer first only when they're a clearly better match.
      var g = guides ? guides.search(q, 1)[0] : null;
      if (g && g.conf >= CFG.threshold && (!top || g.conf >= top.conf + 0.3)) {
        misses = 0;
        thread = { q: q, hits: hits, shown: {}, tries: 0, cat: "", usedGuides: true };
        thread.shown["g:" + entryKey(g.entry)] = 1;
        addMsg("bot", "<p>I searched the " + guideName(g.entry) + " for this. Here's what they suggest:</p>" + renderAnswer(g.entry.a, g.entry.video).html +
          '<span class="src">From the ' + guideName(g.entry) + ": " + esc(g.entry.q) + "</span>");
        checkIn();
      } else if (top && top.conf >= CFG.threshold) {
        misses = 0;
        thread = { q: q, hits: hits, shown: {}, tries: 0, cat: "" };
        showEntry(top.entry);
      } else if (hits.length && hits[0].conf >= CFG.threshold * 0.5) {
        misses = 0;
        thread = { q: q, hits: hits, shown: {}, tries: 0, cat: "" };
        addMsg("bot", "<p>I want to make sure I get this right. Which of these is closest to your issue?</p>");
        addChips(hits.slice(0, 3).map(function (h) { return h.entry.q; }).concat(["Something else"]), function (label) {
          if (label === "Something else") return ask(label);
          var h = hits.filter(function (x) { return x.entry.q === label; })[0];
          addMsg("me", esc(label));
          if (h) showEntry(h.entry);
        });
      } else {
        misses++;
        if (thread) thread.tries++;
        if (misses >= MAX_TRIES || (thread && thread.tries >= MAX_TRIES)) {
          suggestTicket("I'm not finding an answer for this one. Our team can help: send a support ticket and a real person will reply within one business day.");
        } else {
          addMsg("bot", "<p>" + vary(["Hmm, I'm not sure I have an answer for that yet.", "I couldn't find an answer for that one."]) +
            " Could you describe it another way? For example, which page it's on or what you see on the screen.</p>");
        }
      }
    }
    function ask(q) {
      q = String(q || "").trim();
      if (!q || busy) return;
      busy = true;
      root.querySelectorAll(".chips").forEach(function (c) { c.remove(); });
      addMsg("me", esc(q));
      var t = document.createElement("div");
      t.className = "msg bot typing";
      t.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(t); scroll();
      setTimeout(function () { t.remove(); answer(q); busy = false; }, 350 + Math.random() * 300);
    }

    /* --- start / restore --- */
    function greet() {
      addMsg("bot", "<p>" + esc(CFG.greeting) + "</p>");
      if (CFG.suggestions.length) addChips(CFG.suggestions, ask);
    }
    if (history.length) history.forEach(function (m) { addMsg(m.w, m.h, false); });
    else greet();

    /* --- events --- */
    function toggle(open) {
      var isOpen = open !== undefined ? open : panel.hidden;
      panel.hidden = !isOpen;
      launch.setAttribute("aria-expanded", String(isOpen));
      launch.classList.toggle("open", isOpen);
      launch.setAttribute("aria-label", isOpen ? "Close support chat" : "Open support chat");
      store("sc_open", isOpen);
      if (isOpen) setTimeout(function () { input.focus(); scroll(); }, 60);
    }
    launch.addEventListener("click", function () { toggle(); });
    $(".x").addEventListener("click", function () { toggle(false); launch.focus(); });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) { toggle(false); launch.focus(); } });
    input.addEventListener("input", function () {
      send.disabled = !input.value.trim();
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 110) + "px";
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = input.value; input.value = ""; input.style.height = "auto"; send.disabled = true;
      ask(v);
    });
    $(".reset").addEventListener("click", function () {
      history = []; store("sc_history", []); log.innerHTML = ""; thread = null; misses = 0; greet();
    });
    if (store("sc_open")) toggle(true);

    /* --- load knowledge (same-site static file or inline object) --- */
    function useKb(data) {
      var entries = Array.isArray(data) ? data : (data && data.entries) || [];
      engine = new Engine(entries);
      guides = new Engine((data && data.resources) || []);
    }
    function loadFile() {
      return fetch(CFG.kb, { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(useKb)
        .catch(function (err) { console.warn("[support-chat] Could not load knowledge file:", CFG.kb, err); });
    }
    if (CFG.kbData) useKb(CFG.kbData);
    else if (CFG.firebaseProject) {
      var cached = null;
      try { cached = JSON.parse(sessionStorage.getItem("sc_kb_cache") || "null"); } catch (e) {}
      if (cached && cached.t > Date.now() - 10 * 60 * 1000 && cached.d) useKb(cached.d);
      else {
        loadFromFirebase()
          .then(function (d) {
            useKb(d);
            try { sessionStorage.setItem("sc_kb_cache", JSON.stringify({ t: Date.now(), d: d })); } catch (e) {}
          })
          .catch(function (err) {
            console.warn("[support-chat] Firebase unavailable, using backup file:", err);
            loadFile();
          });
      }
    } else loadFile();

    window.SupportChat = { open: function () { toggle(true); }, close: function () { toggle(false); }, ask: function (q) { toggle(true); ask(q); } };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  // exposed for testing
  window.__SupportChatEngine = Engine;
})();
