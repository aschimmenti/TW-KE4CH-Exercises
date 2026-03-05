/**
 * wd-tooltip.js
 * 
 * Reads any <span wd="Q..."> element in the page.
 * On hover, queries the Wikidata API and renders a small
 * info card beside the element.
 *
 * USAGE:
 *   <span wd="Q5582">Homer</span>
 *   <script src="wd-tooltip.js"></script>
 *
 * The `wd` attribute must contain a Wikidata QID (e.g. Q42, Q64, Q8016).
 * The script auto-detects whether the entity is a person, place, or book
 * from its Wikidata "instance of" claim and renders the appropriate card.
 */

(function () {
  "use strict";

  /* ---- Wikidata SPARQL endpoint ---- */
  const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

  /* ---- Queries per entity type ---- */
  const QUERIES = {
    // Used for first detection pass — asks: what is this entity?
    detect: (qid) => `
      SELECT ?typeLabel WHERE {
        wd:${qid} wdt:P31 ?type .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } LIMIT 5`,

    person: (qid) => `
      SELECT ?label ?birthDate ?deathDate ?citizenshipLabel ?image ?wpLink
             (GROUP_CONCAT(DISTINCT ?workLabel; separator="; ") AS ?works)
      WHERE {
        wd:${qid} rdfs:label ?label . FILTER(LANG(?label) = "en")
        OPTIONAL { wd:${qid} wdt:P569 ?birthDate. }
        OPTIONAL { wd:${qid} wdt:P570 ?deathDate. }
        OPTIONAL { wd:${qid} wdt:P27 ?citizenship.
                   ?citizenship rdfs:label ?citizenshipLabel. FILTER(LANG(?citizenshipLabel)="en") }
        OPTIONAL { wd:${qid} wdt:P18 ?image. }
        OPTIONAL { ?wpArticle schema:about wd:${qid};
                              schema:isPartOf <https://en.wikipedia.org/>;
                              schema:name ?wpName.
                   BIND(CONCAT("https://en.wikipedia.org/wiki/", ENCODE_FOR_URI(?wpName)) AS ?wpLink) }
        OPTIONAL { wd:${qid} wdt:P800 ?work.
                   ?work rdfs:label ?workLabel. FILTER(LANG(?workLabel)="en") }
      } GROUP BY ?label ?birthDate ?deathDate ?citizenshipLabel ?image ?wpLink
      LIMIT 1`,

    place: (qid) => `
      SELECT ?label ?countryLabel ?image ?wpLink
      WHERE {
        wd:${qid} rdfs:label ?label. FILTER(LANG(?label)="en")
        OPTIONAL { wd:${qid} wdt:P17 ?country.
                   ?country rdfs:label ?countryLabel. FILTER(LANG(?countryLabel)="en") }
        OPTIONAL { wd:${qid} wdt:P18 ?image. }
        OPTIONAL { ?wpArticle schema:about wd:${qid};
                              schema:isPartOf <https://en.wikipedia.org/>;
                              schema:name ?wpName.
                   BIND(CONCAT("https://en.wikipedia.org/wiki/", ENCODE_FOR_URI(?wpName)) AS ?wpLink) }
      } LIMIT 1`,

    book: (qid) => `
      SELECT ?label ?authorLabel ?pubDate ?image ?wpLink
      WHERE {
        wd:${qid} rdfs:label ?label. FILTER(LANG(?label)="en")
        OPTIONAL { wd:${qid} wdt:P50 ?author.
                   ?author rdfs:label ?authorLabel. FILTER(LANG(?authorLabel)="en") }
        OPTIONAL { wd:${qid} wdt:P577 ?pubDate. }
        OPTIONAL { wd:${qid} wdt:P18 ?image. }
        OPTIONAL { ?wpArticle schema:about wd:${qid};
                              schema:isPartOf <https://en.wikipedia.org/>;
                              schema:name ?wpName.
                   BIND(CONCAT("https://en.wikipedia.org/wiki/", ENCODE_FOR_URI(?wpName)) AS ?wpLink) }
      } LIMIT 1`,
  };

  /* ---- Entity-type detection heuristics ---- */
  const PERSON_TYPES  = ["human", "person", "individual"];
  const PLACE_TYPES   = ["city", "municipality", "country", "region", "geographic",
                         "location", "administrative", "commune", "town", "village",
                         "sovereign state", "island", "lake", "river", "mountain"];
  const BOOK_TYPES    = ["book", "literary work", "written work", "novel",
                         "poem", "play", "epic", "manuscript"];

  function detectType(typeLabels) {
    const labels = typeLabels.map(l => l.toLowerCase());
    if (labels.some(l => PERSON_TYPES.some(t => l.includes(t)))) return "person";
    if (labels.some(l => BOOK_TYPES.some(t => l.includes(t))))   return "book";
    if (labels.some(l => PLACE_TYPES.some(t => l.includes(t))))  return "place";
    return "unknown";
  }

  /* ---- SPARQL fetch helper ---- */
  async function sparql(query) {
    const url = SPARQL_ENDPOINT + "?query=" + encodeURIComponent(query) +
                "&format=json";
    const res = await fetch(url, {
      headers: { "Accept": "application/sparql-results+json" }
    });
    if (!res.ok) throw new Error("SPARQL request failed: " + res.status);
    const data = await res.json();
    return data.results.bindings;
  }

  /* ---- Format a Wikidata date string (e.g. "+1844-01-01T00:00:00Z") ---- */
  function fmtDate(raw) {
    if (!raw) return null;
    const m = raw.match(/^[+-]?(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return raw;
    const [, y, mo, d] = m;
    if (mo === "00" || d === "00") return y;
    const months = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${parseInt(d, 10)} ${months[parseInt(mo,10)-1]} ${y}`;
  }

  /* ---- Thumbnail from full Wikimedia URL ---- */
  function thumbUrl(fullUrl, width = 120) {
    if (!fullUrl) return null;
    // Convert Special:FilePath or commons URL to thumbnail
    const name = decodeURIComponent(fullUrl.split("/").pop()).replace(/ /g, "_");
    return `https://commons.wikimedia.org/w/index.php?title=Special:FilePath&file=${encodeURIComponent(name)}&width=${width}`;
  }

  /* ---- Card HTML builders ---- */
  function cardPerson(r) {
    const name    = r.label?.value || "—";
    const birth   = fmtDate(r.birthDate?.value);
    const death   = fmtDate(r.deathDate?.value);
    const dates   = birth ? (death ? `${birth} – ${death}` : `b. ${birth}`) : null;
    const citizen = r.citizenshipLabel?.value;
    const img     = thumbUrl(r.image?.value);
    const works   = r.works?.value;
    const wp      = r.wpLink?.value;

    return buildCard({
      title: name,
      subtitle: dates,
      meta: citizen ? `Citizenship: ${citizen}` : null,
      extra: works ? `Notable works: ${works}` : null,
      img, wp, type: "person"
    });
  }

  function cardPlace(r) {
    const name    = r.label?.value || "—";
    const country = r.countryLabel?.value;
    const img     = thumbUrl(r.image?.value);
    const wp      = r.wpLink?.value;
    return buildCard({
      title: name,
      meta: country ? `Country: ${country}` : null,
      img, wp, type: "place"
    });
  }

  function cardBook(r) {
    const name   = r.label?.value || "—";
    const author = r.authorLabel?.value;
    const pub    = fmtDate(r.pubDate?.value);
    const img    = thumbUrl(r.image?.value);
    const wp     = r.wpLink?.value;
    return buildCard({
      title: name,
      subtitle: pub ? `Published: ${pub}` : null,
      meta: author ? `Author: ${author}` : null,
      img, wp, type: "book"
    });
  }

  function buildCard({ title, subtitle, meta, extra, img, wp, type }) {
    const COLOR = { person: "#1a1a2e", place: "#1b4332", book: "#4a1942" };
    const bg = COLOR[type] || "#333";

    let html = `<div style="
        font-family:Arial,sans-serif; font-size:0.82rem; color:#222;
        background:#fff; border-radius:8px; overflow:hidden;
        box-shadow:0 4px 16px rgba(0,0,0,0.18); width:220px;">`;

    // Header strip
    html += `<div style="background:${bg};color:#fff;padding:0.5rem 0.7rem;font-weight:bold;font-size:0.9rem;">${escHtml(title)}</div>`;

    // Image + body side by side
    html += `<div style="display:flex;gap:0.6rem;padding:0.6rem;">`;

    if (img) {
      html += `<img src="${escAttr(img)}" alt="${escAttr(title)}" 
               style="width:70px;height:80px;object-fit:cover;border-radius:4px;flex-shrink:0;"
               onerror="this.style.display='none'">`;
    }

    html += `<div>`;
    if (subtitle) html += `<p style="margin:0 0 0.3rem;color:#555;">${escHtml(subtitle)}</p>`;
    if (meta)     html += `<p style="margin:0 0 0.2rem;">${escHtml(meta)}</p>`;
    if (extra)    html += `<p style="margin:0.2rem 0 0;color:#555;font-size:0.75rem;">${escHtml(extra)}</p>`;
    html += `</div></div>`;

    if (wp) {
      html += `<div style="padding:0 0.7rem 0.6rem;">
        <a href="${escAttr(wp)}" target="_blank" rel="noopener"
           style="font-size:0.75rem;color:${bg};">→ Wikipedia</a>
      </div>`;
    }

    html += `</div>`;
    return html;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function escAttr(s) { return escHtml(s); }

  /* ---- Tooltip DOM management ---- */
  let tooltip = null;
  let hideTimer = null;
  const cache = {};

  function createTooltip() {
    tooltip = document.createElement("div");
    tooltip.id = "wd-tooltip";
    tooltip.style.cssText =
      "position:absolute;z-index:9999;pointer-events:auto;display:none;";
    tooltip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    tooltip.addEventListener("mouseleave", hideTooltip);
    document.body.appendChild(tooltip);
  }

  function showTooltip(html, anchorEl) {
    clearTimeout(hideTimer);
    tooltip.innerHTML = html;
    tooltip.style.display = "block";

    const rect = anchorEl.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    let left = rect.left + scrollX;
    let top  = rect.bottom + scrollY + 6;

    // Don't overflow right edge
    const ttW = 230;
    if (left + ttW > window.innerWidth + scrollX - 10) {
      left = window.innerWidth + scrollX - ttW - 10;
    }
    tooltip.style.left = left + "px";
    tooltip.style.top  = top  + "px";
  }

  function hideTooltip() {
    hideTimer = setTimeout(() => {
      if (tooltip) tooltip.style.display = "none";
    }, 250);
  }

  /* ---- Main: attach events to all [wd] spans ---- */
  async function attachToElement(el) {
    const qid = el.getAttribute("wd");
    if (!qid || !/^Q\d+$/.test(qid)) return;

    // Subtle visual hint that these spans are interactive
    el.style.borderBottom  = "1px dotted #888";
    el.style.cursor        = "help";

    el.addEventListener("mouseenter", async () => {
      if (cache[qid]) {
        showTooltip(cache[qid], el);
        return;
      }

      showTooltip('<div style="padding:1rem;color:#555;font-size:0.82rem;font-family:Arial;">Loading…</div>', el);

      try {
        // Step 1: detect type
        const typeRows = await sparql(QUERIES.detect(qid));
        const typeLabels = typeRows.map(r => r.typeLabel?.value || "");
        const type = detectType(typeLabels);

        // Step 2: fetch details
        let html;
        if (type === "person") {
          const rows = await sparql(QUERIES.person(qid));
          html = rows.length ? cardPerson(rows[0]) : `<div style="padding:0.8rem">${qid}: no data</div>`;
        } else if (type === "place") {
          const rows = await sparql(QUERIES.place(qid));
          html = rows.length ? cardPlace(rows[0]) : `<div style="padding:0.8rem">${qid}: no data</div>`;
        } else if (type === "book") {
          const rows = await sparql(QUERIES.book(qid));
          html = rows.length ? cardBook(rows[0]) : `<div style="padding:0.8rem">${qid}: no data</div>`;
        } else {
          html = `<div style="padding:0.8rem;font-family:Arial;font-size:0.82rem;">
                    <strong>${qid}</strong><br>
                    <a href="https://www.wikidata.org/wiki/${qid}" target="_blank">View on Wikidata →</a>
                  </div>`;
        }

        cache[qid] = html;
        showTooltip(html, el);

      } catch (err) {
        const errHtml = `<div style="padding:0.8rem;font-family:Arial;font-size:0.82rem;color:#c00;">
                           Error fetching data for ${qid}.<br>
                           ${err.message}
                         </div>`;
        showTooltip(errHtml, el);
      }
    });

    el.addEventListener("mouseleave", hideTooltip);
  }

  /* ---- Init ---- */
  function init() {
    createTooltip();
    document.querySelectorAll("span[wd]").forEach(attachToElement);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
