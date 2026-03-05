/**
 * wd-tooltip.js
 *
 * Reads any <span wd="Q..."> element in the page.
 * On hover, queries the Wikidata SPARQL endpoint and renders a small
 * info card beside the element.
 *
 * USAGE:
 *   <span wd="Q5582">Homer</span>
 *   <script src="wd-tooltip.js"></script>
 *
 * The `wd` attribute must contain a Wikidata QID (e.g. Q42, Q64, Q8016).
 * The script auto-detects whether the entity is a person, photographer,
 * place, book, or photograph/artwork from Wikidata "instance of" (P31)
 * AND "occupation" (P106) claims and renders the appropriate card.
 *
 * PROPERTY REFERENCE (verified against Wikidata documentation):
 *   P17   country (sovereign state of an item — correct for places)
 *   P18   image
 *   P27   country of citizenship (persons)
 *   P31   instance of
 *   P50   author (literary works)
 *   P106  occupation
 *   P131  located in administrative territorial entity (places)
 *   P136  genre (books, photographs, visual works)
 *   P166  award received
 *   P170  creator (visual/photographic works)
 *   P180  depicts (visual works — subject visually represented)
 *   P276  location (current physical location of an object)
 *   P569  date of birth
 *   P570  date of death
 *   P571  inception / date of creation (artworks, photographs)
 *   P577  publication date (books/written works — NOT for photographs)
 *   P800  notable work (persons — scientific, literary, artistic)
 */

(function () {
  "use strict";

  /* ── Wikidata SPARQL endpoint ─────────────────────────────────────────── */
  const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

  /* ── Queries ──────────────────────────────────────────────────────────── */
  const QUERIES = {

    /**
     * Detection pass.
     * Merges P31 (instance of) labels with P106 (occupation) labels into a
     * single ?signal column.  P31 alone always returns "human" for persons
     * and provides no signal about occupation; P106 carries that information
     * (e.g. "photographer", "poet", "novelist").
     */
    detect: (qid) => `
      SELECT DISTINCT ?signal WHERE {
        {
          wd:${qid} wdt:P31 ?type .
          ?type rdfs:label ?signal . FILTER(LANG(?signal) = "en")
        } UNION {
          wd:${qid} wdt:P106 ?occ .
          ?occ rdfs:label ?signal . FILTER(LANG(?signal) = "en")
        }
      } LIMIT 10`,

    /**
     * Person card query.
     * P569  date of birth
     * P570  date of death
     * P27   country of citizenship
     * P18   image
     * P106  occupation  (shown in card to distinguish writer/photographer/etc.)
     * P800  notable work
     * P166  award received  ← was absent in the original script
     */
    person: (qid) => `
      SELECT ?label ?birthDate ?deathDate ?citizenshipLabel ?image ?wpLink
             ?occupationLabel
             (GROUP_CONCAT(DISTINCT ?workLabel;  separator="; ") AS ?works)
             (GROUP_CONCAT(DISTINCT ?awardLabel; separator="; ") AS ?awards)
      WHERE {
        wd:${qid} rdfs:label ?label . FILTER(LANG(?label) = "en")
        OPTIONAL { wd:${qid} wdt:P569 ?birthDate . }
        OPTIONAL { wd:${qid} wdt:P570 ?deathDate . }
        OPTIONAL {
          wd:${qid} wdt:P27 ?citizenship .
          ?citizenship rdfs:label ?citizenshipLabel .
          FILTER(LANG(?citizenshipLabel) = "en")
        }
        OPTIONAL { wd:${qid} wdt:P18 ?image . }
        OPTIONAL {
          wd:${qid} wdt:P106 ?occupation .
          ?occupation rdfs:label ?occupationLabel .
          FILTER(LANG(?occupationLabel) = "en")
        }
        OPTIONAL {
          wd:${qid} wdt:P800 ?work .
          ?work rdfs:label ?workLabel . FILTER(LANG(?workLabel) = "en")
        }
        OPTIONAL {
          wd:${qid} wdt:P166 ?award .
          ?award rdfs:label ?awardLabel . FILTER(LANG(?awardLabel) = "en")
        }
        OPTIONAL {
          ?wpArticle schema:about wd:${qid} ;
                     schema:isPartOf <https://en.wikipedia.org/> ;
                     schema:name ?wpName .
          BIND(CONCAT("https://en.wikipedia.org/wiki/",
                      ENCODE_FOR_URI(?wpName)) AS ?wpLink)
        }
      }
      GROUP BY ?label ?birthDate ?deathDate ?citizenshipLabel
               ?image ?wpLink ?occupationLabel
      LIMIT 1`,

    /**
     * Photographer works sub-query.
     * Fetched in parallel alongside the person query when the detected type
     * is "photographer".  Retrieves visual works where the person is listed
     * as creator (P170), with creation date (P571) and genre (P136).
     * NOTE: P571 (inception) is the correct date property for visual works;
     *       P577 (publication date) applies only to written/published works.
     */
    photographerWorks: (qid) => `
      SELECT DISTINCT ?workLabel ?inceptionYear ?genreLabel WHERE {
        ?work wdt:P170 wd:${qid} .
        ?work rdfs:label ?workLabel . FILTER(LANG(?workLabel) = "en")
        OPTIONAL {
          ?work wdt:P571 ?inception .
          BIND(YEAR(?inception) AS ?inceptionYear)
        }
        OPTIONAL {
          ?work wdt:P136 ?genre .
          ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en")
        }
      }
      ORDER BY ?inceptionYear
      LIMIT 5`,

    /**
     * Place card query.
     * P17   country — "sovereign state of this item"; correct property for
     *                 places (not to be confused with P27, which is for persons)
     * P131  located in administrative territorial entity — adds regional context
     * P18   image
     */
    place: (qid) => `
      SELECT ?label ?countryLabel ?adminLabel ?image ?wpLink WHERE {
        wd:${qid} rdfs:label ?label . FILTER(LANG(?label) = "en")
        OPTIONAL {
          wd:${qid} wdt:P17 ?country .
          ?country rdfs:label ?countryLabel . FILTER(LANG(?countryLabel) = "en")
        }
        OPTIONAL {
          wd:${qid} wdt:P131 ?admin .
          ?admin rdfs:label ?adminLabel . FILTER(LANG(?adminLabel) = "en")
        }
        OPTIONAL { wd:${qid} wdt:P18 ?image . }
        OPTIONAL {
          ?wpArticle schema:about wd:${qid} ;
                     schema:isPartOf <https://en.wikipedia.org/> ;
                     schema:name ?wpName .
          BIND(CONCAT("https://en.wikipedia.org/wiki/",
                      ENCODE_FOR_URI(?wpName)) AS ?wpLink)
        }
      } LIMIT 1`,

    /**
     * Book / written work card query.
     * P50   author
     * P577  publication date — correct for written/published works
     * P136  genre  ← was absent in the original script
     * P18   image
     */
    book: (qid) => `
      SELECT ?label ?authorLabel ?pubDate ?genreLabel ?image ?wpLink WHERE {
        wd:${qid} rdfs:label ?label . FILTER(LANG(?label) = "en")
        OPTIONAL {
          wd:${qid} wdt:P50 ?author .
          ?author rdfs:label ?authorLabel . FILTER(LANG(?authorLabel) = "en")
        }
        OPTIONAL { wd:${qid} wdt:P577 ?pubDate . }
        OPTIONAL {
          wd:${qid} wdt:P136 ?genre .
          ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en")
        }
        OPTIONAL { wd:${qid} wdt:P18 ?image . }
        OPTIONAL {
          ?wpArticle schema:about wd:${qid} ;
                     schema:isPartOf <https://en.wikipedia.org/> ;
                     schema:name ?wpName .
          BIND(CONCAT("https://en.wikipedia.org/wiki/",
                      ENCODE_FOR_URI(?wpName)) AS ?wpLink)
        }
      } LIMIT 1`,

    /**
     * Photograph / visual artwork card query.
     * P170  creator — correct property for visual works (not P50, which is
     *                 for written works only)
     * P571  inception — date of creation; correct for artworks/photographs
     *                   (P577 publication date must NOT be used here)
     * P136  genre  (documentary photography, portrait photography, etc.)
     * P180  depicts — entity visually represented in the image
     * P276  location — current physical location of the object
     * P18   image (Wikimedia Commons file representing the work)
     */
    photograph: (qid) => `
      SELECT ?label ?creatorLabel ?inceptionDate ?genreLabel
             ?depictsLabel ?locationLabel ?image ?wpLink WHERE {
        wd:${qid} rdfs:label ?label . FILTER(LANG(?label) = "en")
        OPTIONAL {
          wd:${qid} wdt:P170 ?creator .
          ?creator rdfs:label ?creatorLabel . FILTER(LANG(?creatorLabel) = "en")
        }
        OPTIONAL { wd:${qid} wdt:P571 ?inceptionDate . }
        OPTIONAL {
          wd:${qid} wdt:P136 ?genre .
          ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en")
        }
        OPTIONAL {
          wd:${qid} wdt:P180 ?depicts .
          ?depicts rdfs:label ?depictsLabel . FILTER(LANG(?depictsLabel) = "en")
        }
        OPTIONAL {
          wd:${qid} wdt:P276 ?location .
          ?location rdfs:label ?locationLabel . FILTER(LANG(?locationLabel) = "en")
        }
        OPTIONAL { wd:${qid} wdt:P18 ?image . }
        OPTIONAL {
          ?wpArticle schema:about wd:${qid} ;
                     schema:isPartOf <https://en.wikipedia.org/> ;
                     schema:name ?wpName .
          BIND(CONCAT("https://en.wikipedia.org/wiki/",
                      ENCODE_FOR_URI(?wpName)) AS ?wpLink)
        }
      } LIMIT 1`,
  };

  /* ── Entity-type detection heuristics ───────────────────────────────── */
  /*
   * All strings are matched against the merged P31 + P106 signal set from
   * the detect query.  "photographer" is checked before the generic "person"
   * so that a person with occupation=photographer is routed to the richer
   * photographer card that also fetches their works.
   */
  const PHOTOGRAPHER_SIGNALS = [
    "photographer", "photojournalist", "documentary photographer",
    "portrait photographer",
  ];
  const PERSON_SIGNALS = ["human", "person", "individual"];
  const PLACE_SIGNALS  = [
    "city", "municipality", "country", "region", "geographic", "location",
    "administrative", "commune", "town", "village", "sovereign state",
    "island", "lake", "river", "mountain",
  ];
  const BOOK_SIGNALS   = [
    "book", "literary work", "written work", "novel", "poem", "play",
    "epic", "manuscript",
  ];
  const PHOTO_SIGNALS  = [
    "photograph", "painting", "drawing", "artwork", "work of art",
    "visual artwork",
  ];

  function detectType(signals) {
    const ls  = signals.map(s => s.toLowerCase());
    const has = (list) => ls.some(l => list.some(t => l.includes(t)));
    if (has(PHOTOGRAPHER_SIGNALS)) return "photographer";
    if (has(PHOTO_SIGNALS))        return "photograph";
    if (has(BOOK_SIGNALS))         return "book";
    if (has(PLACE_SIGNALS))        return "place";
    if (has(PERSON_SIGNALS))       return "person";
    return "unknown";
  }

  /* ── SPARQL fetch helper ─────────────────────────────────────────────── */
  async function sparql(query) {
    const url = SPARQL_ENDPOINT + "?query=" + encodeURIComponent(query) +
                "&format=json";
    const res = await fetch(url, {
      headers: { Accept: "application/sparql-results+json" },
    });
    if (!res.ok) throw new Error("SPARQL request failed: " + res.status);
    const data = await res.json();
    return data.results.bindings;
  }

  /* ── Date formatting ─────────────────────────────────────────────────── */
  function fmtDate(raw) {
    if (!raw) return null;
    const m = raw.match(/^[+-]?(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return raw;
    const [, y, mo, d] = m;
    if (mo === "00" || d === "00") return y;
    const months = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${parseInt(d, 10)} ${months[parseInt(mo, 10) - 1]} ${y}`;
  }

  /* ── Wikimedia thumbnail helper ──────────────────────────────────────── */
  function thumbUrl(fullUrl, width = 120) {
    if (!fullUrl) return null;
    const name = decodeURIComponent(fullUrl.split("/").pop()).replace(/ /g, "_");
    return `https://commons.wikimedia.org/w/index.php?title=Special:FilePath` +
           `&file=${encodeURIComponent(name)}&width=${width}`;
  }

  /* ── Card builders ───────────────────────────────────────────────────── */

  function cardPerson(r, extraPhotoWorks) {
    const birth  = fmtDate(r.birthDate?.value);
    const death  = fmtDate(r.deathDate?.value);
    const dates  = birth ? (death ? `${birth} – ${death}` : `b. ${birth}`) : null;

    const lines = [];
    if (r.citizenshipLabel?.value)
      lines.push({ label: "Citizenship", value: r.citizenshipLabel.value });
    if (r.occupationLabel?.value)
      lines.push({ label: "Occupation",  value: r.occupationLabel.value });
    if (r.works?.value)
      lines.push({ label: "Notable works", value: r.works.value, clamp: true });
    if (r.awards?.value)
      lines.push({ label: "Awards", value: r.awards.value, clamp: true });
    if (extraPhotoWorks?.length) {
      const wl = extraPhotoWorks
        .map(w => w.workLabel?.value).filter(Boolean).join("; ");
      if (wl) lines.push({ label: "Photographs", value: wl, clamp: true });
    }

    return buildCard({
      title:    r.label?.value || "—",
      subtitle: dates,
      lines,
      img: thumbUrl(r.image?.value),
      wp:  r.wpLink?.value,
      type: extraPhotoWorks ? "photographer" : "person",
    });
  }

  function cardPlace(r) {
    const lines = [];
    // Show region only when it differs from the country label
    if (r.adminLabel?.value && r.adminLabel.value !== r.countryLabel?.value)
      lines.push({ label: "Region",  value: r.adminLabel.value });
    if (r.countryLabel?.value)
      lines.push({ label: "Country", value: r.countryLabel.value });

    return buildCard({
      title: r.label?.value || "—",
      lines,
      img: thumbUrl(r.image?.value),
      wp:  r.wpLink?.value,
      type: "place",
    });
  }

  function cardBook(r) {
    const lines = [];
    if (r.authorLabel?.value)
      lines.push({ label: "Author",    value: r.authorLabel.value });
    if (r.genreLabel?.value)
      lines.push({ label: "Genre",     value: r.genreLabel.value });
    if (r.pubDate?.value)
      lines.push({ label: "Published", value: fmtDate(r.pubDate.value) });

    return buildCard({
      title: r.label?.value || "—",
      lines,
      img: thumbUrl(r.image?.value),
      wp:  r.wpLink?.value,
      type: "book",
    });
  }

  function cardPhotograph(r) {
    const lines = [];
    if (r.creatorLabel?.value)
      lines.push({ label: "Creator",  value: r.creatorLabel.value });
    if (r.inceptionDate?.value)
      lines.push({ label: "Date",     value: fmtDate(r.inceptionDate.value) });
    if (r.genreLabel?.value)
      lines.push({ label: "Genre",    value: r.genreLabel.value });
    if (r.depictsLabel?.value)
      lines.push({ label: "Depicts",  value: r.depictsLabel.value });
    if (r.locationLabel?.value)
      lines.push({ label: "Location", value: r.locationLabel.value });

    return buildCard({
      title: r.label?.value || "—",
      lines,
      img: thumbUrl(r.image?.value),
      wp:  r.wpLink?.value,
      type: "photograph",
    });
  }

  /* ── Generic card renderer ───────────────────────────────────────────── */
  function buildCard({ title, subtitle, lines = [], img, wp, type }) {
    const ACCENT = {
      person:      "#3a5a8c",
      photographer:"#5a3a8c",
      place:       "#2e7d5e",
      book:        "#7b3f8c",
      photograph:  "#8c5a2e",
    };
    const TINT = {
      person:      "#eef3fa",
      photographer:"#f0eefa",
      place:       "#eef7f3",
      book:        "#f7eefa",
      photograph:  "#faf3ee",
    };
    const accent = ACCENT[type] || "#444";
    const tint   = TINT[type]   || "#f5f5f5";

    let html = `<div style="
        font-family: system-ui, Arial, sans-serif;
        font-size: 0.875rem;
        line-height: 1.5;
        color: #1a1a1a;
        background: #fff;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 6px 20px rgba(0,0,0,0.14);
        width: 260px;
        border-top: 4px solid ${accent};">`;

    html += `<div style="
        background: ${tint};
        padding: 0.65rem 0.9rem 0.55rem;
        border-bottom: 1px solid rgba(0,0,0,0.07);">
      <div style="font-weight:700;font-size:1rem;color:${accent};
                  margin-bottom:${subtitle ? "0.2rem" : "0"};">
        ${escHtml(title)}
      </div>`;
    if (subtitle) {
      html += `<div style="font-size:0.8rem;color:#555;">${escHtml(subtitle)}</div>`;
    }
    html += `</div>`;

    html += `<div style="display:flex;gap:0.75rem;padding:0.75rem 0.9rem;">`;
    if (img) {
      html += `<img src="${escAttr(img)}" alt="${escAttr(title)}"
               style="width:72px;height:88px;object-fit:cover;border-radius:6px;
                      flex-shrink:0;border:1px solid rgba(0,0,0,0.08);"
               onerror="this.style.display='none'">`;
    }
    html += `<div style="display:flex;flex-direction:column;gap:0.35rem;min-width:0;">`;
    for (const line of lines) {
      html += `<div>
        <span style="font-size:0.72rem;font-weight:600;text-transform:uppercase;
                     letter-spacing:0.04em;color:#888;">${escHtml(line.label)}</span><br>
        <span style="color:${line.clamp ? "#444" : "#222"};
                     font-size:${line.clamp ? "0.8rem" : "inherit"};
                     ${line.clamp
                        ? "display:-webkit-box;-webkit-line-clamp:3;" +
                          "-webkit-box-orient:vertical;overflow:hidden;"
                        : ""}">
          ${escHtml(line.value)}
        </span>
      </div>`;
    }
    html += `</div></div>`;

    if (wp) {
      html += `<div style="padding:0 0.9rem 0.75rem;">
        <a href="${escAttr(wp)}" target="_blank" rel="noopener"
           style="display:inline-block;font-size:0.78rem;font-weight:600;
                  color:#fff;background:${accent};
                  padding:0.3rem 0.7rem;border-radius:5px;text-decoration:none;">
          Wikipedia →
        </a>
      </div>`;
    }

    html += `</div>`;
    return html;
  }

  /* ── HTML escaping ───────────────────────────────────────────────────── */
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escAttr(s) { return escHtml(s); }

  /* ── Tooltip DOM management ──────────────────────────────────────────── */
  let tooltip   = null;
  let hideTimer = null;
  const cache   = {};

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

    const rect    = anchorEl.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    let left = rect.left + scrollX;
    let top  = rect.bottom + scrollY + 6;

    const ttW = 260;
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

  /* ── Attach events to [wd] spans ─────────────────────────────────────── */
  async function attachToElement(el) {
    const qid = el.getAttribute("wd");
    if (!qid || !/^Q\d+$/.test(qid)) return;

    el.style.borderBottom = "1px dotted #888";
    el.style.cursor       = "help";

    el.addEventListener("mouseenter", async () => {
      if (cache[qid]) { showTooltip(cache[qid], el); return; }

      showTooltip(
        '<div style="padding:1rem;color:#555;font-size:0.82rem;font-family:Arial;">Loading…</div>',
        el
      );

      try {
        // Step 1 — detect entity type from merged P31 + P106 signals
        const detRows = await sparql(QUERIES.detect(qid));
        const signals = detRows.map(r => r.signal?.value || "");
        const type    = detectType(signals);

        let html;

        if (type === "person") {
          const rows = await sparql(QUERIES.person(qid));
          html = rows.length
            ? cardPerson(rows[0], null)
            : `<div style="padding:0.8rem">${escHtml(qid)}: no data</div>`;

        } else if (type === "photographer") {
          // Fetch person details and their photographic works in parallel
          const [personRows, photoRows] = await Promise.all([
            sparql(QUERIES.person(qid)),
            sparql(QUERIES.photographerWorks(qid)),
          ]);
          html = personRows.length
            ? cardPerson(personRows[0], photoRows)
            : `<div style="padding:0.8rem">${escHtml(qid)}: no data</div>`;

        } else if (type === "place") {
          const rows = await sparql(QUERIES.place(qid));
          html = rows.length
            ? cardPlace(rows[0])
            : `<div style="padding:0.8rem">${escHtml(qid)}: no data</div>`;

        } else if (type === "book") {
          const rows = await sparql(QUERIES.book(qid));
          html = rows.length
            ? cardBook(rows[0])
            : `<div style="padding:0.8rem">${escHtml(qid)}: no data</div>`;

        } else if (type === "photograph") {
          const rows = await sparql(QUERIES.photograph(qid));
          html = rows.length
            ? cardPhotograph(rows[0])
            : `<div style="padding:0.8rem">${escHtml(qid)}: no data</div>`;

        } else {
          html = `<div style="padding:0.8rem;font-family:Arial;font-size:0.82rem;">
                    <strong>${escHtml(qid)}</strong><br>
                    <a href="https://www.wikidata.org/wiki/${escAttr(qid)}"
                       target="_blank" rel="noopener">
                      View on Wikidata →
                    </a>
                  </div>`;
        }

        cache[qid] = html;
        showTooltip(html, el);

      } catch (err) {
        showTooltip(
          `<div style="padding:0.8rem;font-family:Arial;font-size:0.82rem;color:#c00;">
             Error fetching data for ${escHtml(qid)}.<br>${escHtml(err.message)}
           </div>`,
          el
        );
      }
    });

    el.addEventListener("mouseleave", hideTooltip);
  }

  /* ── Init ────────────────────────────────────────────────────────────── */
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
