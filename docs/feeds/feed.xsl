<?xml version="1.0" encoding="UTF-8"?>
<!--
  What a browser shows when someone clicks the RSS link before subscribing.

  Readers never see this: they parse the RSS and ignore the stylesheet. It only
  fires in a browser, which would otherwise print the raw element tree under a
  warning about missing style information — a poor first impression for a link
  people click precisely because they do not yet know what it is.

  COLOURS ARE COPIED, NOT IMPORTED, from _sass/cave.scss. A stylesheet applied
  by the XSLT engine gets no site chrome and cannot pull in another file, so the
  handful of tokens the page needs are inlined below. They are the same values:
  cave-air, rock, rock-edge, text, text-dim, and the ore ramp.

  ONE ACCENT, AND IT IS ORE. The Dig proper uses lamp-blue for links and gold
  for the thing worth carrying up. Here everything worth showing is already the
  thing worth carrying up — a paper that cleared the bar — so the page runs on
  ore alone, and the only thing that varies is how deep the seam is: each
  paper's grade paints its rank chip a step along the ore ramp.

  XSLT 1.0, because that is what browsers implement.
-->
<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:atom="http://www.w3.org/2005/Atom"
                xmlns:arxave="https://arxave.com/ns/feed"
                exclude-result-prefixes="atom arxave">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/rss">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="channel/title"/></title>
        <style>
          :root {
            --cave-air: #15181d;
            --rock-deep: #1b1f26;
            --rock: #21262e;
            --rock-edge: #333a44;
            --rock-lit: #4a525e;
            --text: #d7dbe0;
            --text-dim: #99a1ad;
            --text-faint: #6d7682;
            --ore: #f5b301;
            --ore-dim: #b98a08;
            --ore-deep: #5d4a1a;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 2.5rem 1.2rem 4rem;
            background: var(--cave-air);
            color: var(--text);
            font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI",
                  Roboto, Helvetica, Arial, sans-serif;
          }
          .sheet { max-width: 48rem; margin: 0 auto; }

          header { margin-bottom: 1.6rem; }
          h1 {
            font-size: 2rem; line-height: 1.15; letter-spacing: -0.01em;
            margin: 0 0 0.4rem; color: #e8ebef;
          }
          .lede { color: var(--text-dim); margin: 0; font-size: 1.05rem; }

          /* The subscribe box: the one thing a first-time visitor needs, which
             is that the URL in the address bar is the product. */
          .how {
            background: var(--rock-deep);
            border: 1px solid var(--rock-edge);
            border-left: 3px solid var(--ore);
            border-radius: 5px;
            padding: 0.85rem 1rem;
            margin: 1.4rem 0 2.2rem;
            color: var(--text-dim);
            font-size: 0.92rem;
          }
          .how p { margin: 0 0 0.5rem; }
          .how p:last-child { margin-bottom: 0; }
          .how code {
            display: block;
            background: var(--cave-air);
            border: 1px solid var(--rock-edge);
            border-radius: 4px;
            padding: 0.45rem 0.6rem;
            color: var(--ore);
            font-size: 0.85rem;
            word-break: break-all;
          }
          a { color: var(--ore); text-decoration: none; }
          a:hover { text-decoration: underline; }

          article {
            background: var(--rock-deep);
            border: 1px solid var(--rock-edge);
            border-radius: 6px;
            padding: 1rem 1.1rem;
            margin-bottom: 1rem;
          }
          .head { display: flex; gap: 0.7rem; align-items: baseline; }
          /* The rank chip is the seam: one colour, filled deeper the higher the
             grade. Nothing else on the page carries colour, so this reads. */
          .seam {
            flex: none;
            width: 1.9rem; height: 1.9rem;
            display: flex; align-items: center; justify-content: center;
            border-radius: 3px;
            border: 1px solid var(--ore-dim);
            background: var(--ore-deep);
            color: var(--ore);
            font-size: 0.8rem; font-weight: 700;
          }
          article:first-of-type .seam { background: var(--ore); color: #1b1f26; }
          /* The announcement day. A feed with lookback_days > 1 mixes several
             days in one list, and the rank chip says nothing about which. Set
             quiet and pushed to the end of the line: it is the field you look
             for, never the field you read first. */
          .when {
            margin-left: auto; flex: none;
            color: var(--text-faint); font-size: 0.8rem;
            font-variant-numeric: tabular-nums; white-space: nowrap;
          }
          h2 { font-size: 1.06rem; line-height: 1.35; margin: 0; }
          h2 a { color: var(--text); }
          h2 a:hover { color: var(--ore); }

          .body { margin-top: 0.7rem; font-size: 0.95rem; }
          .body p { margin: 0.45rem 0; color: var(--text); }
          .body strong { color: var(--ore-dim); font-weight: 600; }
          /* Figures come off arXiv at whatever size LaTeXML rendered them, and
             a plot is unreadable below about 20rem, so the cap is generous and
             the floor is the column. The pale plate matters: most of these are
             line art on transparent SVG, which on a dark page is invisible.
             Centred, because a figure narrower than the column ragged-left
             reads as a mistake rather than as a plate. */
          .figure {
            margin: 0.8rem auto; max-width: 34rem; text-align: center;
          }
          .figure img {
            display: block; width: 100%; height: auto;
            border-radius: 3px; background: #f4f1ea; padding: 0.5rem;
            cursor: zoom-in;
          }
          /* The caption is the model's gloss, not the paper's own — written for
             someone who has not read the paper. It lives inside the plate's own
             box, so it is exactly as wide as the image above it however wide
             that turns out to be — a caption set to the column while the image
             is set to 34rem reads as the next paragraph of the brief, which is
             the one thing it must not look like. */
          .figure-caption {
            margin: 0.5rem 0 0;
            color: var(--text-dim); font-size: 0.85rem; line-height: 1.5;
            text-align: center;
          }
          /* A plot at 34rem on a dark card is a thumbnail of a plot: the axis
             labels in these are set for a printed page. Clicking one throws it
             up full-screen on its own plate, which is the only way some of them
             are legible at all. Click anywhere, or Escape, to put it back. */
          .lightbox {
            display: none; position: fixed; inset: 0; z-index: 50;
            background: rgba(10, 12, 15, 0.94);
            padding: 2rem; cursor: zoom-out;
            flex-direction: column; align-items: center; justify-content: center;
          }
          .lightbox.open { display: flex; }
          .lightbox img {
            max-width: 100%; max-height: 86vh; width: auto; height: auto;
            border-radius: 4px; background: #f4f1ea; padding: 1rem;
          }
          .lightbox p {
            margin: 1rem 0 0; max-width: 48rem; text-align: center;
            color: var(--text-dim); font-size: 0.9rem;
          }
          .body .grade { color: var(--text-faint); font-size: 0.85rem; }
          .body .grade strong { color: var(--text-dim); }
          /* EVERYTHING BUT THE FINDING IS FOLDED. A card open is most of a
             screen; a page of them is not a list any more, and the list is the
             product. So a card at rest is its title, its authors and one line
             of finding, and the six drawers under it — figure, asks, before,
             but, tools, abstract — are each one click, opened on the one paper
             a reader actually wants them for. Nothing is gone and nothing is
             behind a fetch: it is all in this file, closed.

             The drawers sit in a row rather than stacked, because six stacked
             summaries are taller than the card they belong to. */
          .folds {
            display: flex; flex-wrap: wrap; gap: 0.35rem 0.5rem;
            margin-top: 0.6rem;
            border-top: 1px solid var(--rock-edge);
            padding-top: 0.5rem;
          }
          /* A closed drawer is a chip in the row; an open one takes the whole
             width and pushes the rest down, so two open drawers never end up
             side by side reading as columns. */
          .fold { flex: none; }
          .fold[open] { flex: 1 0 100%; }
          .fold > summary {
            cursor: pointer;
            list-style: none;
            color: var(--text-faint);
            font-size: 0.82rem;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            font-weight: 700;
            padding: 0.1rem 0.1rem;
          }
          .fold > summary::-webkit-details-marker { display: none; }
          /* The caret is drawn rather than inherited, because the default
             marker sits differently in every engine and this one has to line
             up with a chip row above it. */
          .fold > summary::before {
            content: "\25B8";
            display: inline-block;
            margin-right: 0.4rem;
            transition: transform 0.12s ease;
          }
          .fold[open] > summary::before { transform: rotate(90deg); }
          .fold > summary:hover { color: var(--ore-dim); }
          .fold .fold-body {
            margin: 0.45rem 0 0;
            color: var(--text-dim);
            font-size: 0.9rem;
          }
          .fold[open] > summary { color: var(--ore-dim); }
          /* "Open everything on this card" — one control, on the card, because
             the alternative is six clicks to read one paper properly. It is a
             toggle: the same button closes them again. Set as the quietest
             thing in the row, since it is a convenience and not a field. */
          .unfold {
            flex: none; margin-left: auto;
            background: none; border: 1px solid var(--rock-edge);
            border-radius: 3px; padding: 0.1rem 0.45rem;
            color: var(--text-faint); font: inherit;
            font-size: 0.78rem; text-transform: uppercase;
            letter-spacing: 0.06em; font-weight: 700;
            cursor: pointer;
          }
          .unfold:hover { color: var(--ore-dim); border-color: var(--ore-dim); }
          /* Authors are their own line now, under the title: they used to ride
             the end of the grade line, where a ten-author collaboration pushed
             the grade and the matched row off the visible width. */
          .byline {
            margin: 0.35rem 0 0; color: var(--text-dim); font-size: 0.85rem;
          }
          /* The finding is the one thing a closed card says about the paper, so
             it is centred and given its own line — the eye goes title, authors,
             finding, and stops, which is exactly the first-look this page is
             for. */
          .body .result {
            margin: 0.7rem auto 0; max-width: 42rem;
            text-align: center; font-size: 1rem; line-height: 1.55;
          }
          /* The chip line: how sure the assay was, and what sort of paper it
             is. No read/skim flag — the band already says how much to trust the
             card, and a second verdict on top of it was one label too many. */
          .body .chips {
            font-size: 1rem; line-height: 1.5; margin: 0 0 0.2rem;
          }
          .kind {
            display: inline-block; vertical-align: baseline;
            border-radius: 3px; padding: 0.05rem 0.4rem; margin-right: 0.35rem;
            font-size: 0.72rem; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.06em;
          }
          /* The band is how sure the assay was, and it is deliberately a ramp
             rather than three unrelated colours: solid ore for pay dirt, ore
             outline for worth-a-look, plain rock for a long shot. Read down the
             page, the colour draining out *is* the confidence draining out. */
          .band {
            display: inline-block; vertical-align: baseline;
            border-radius: 3px; padding: 0.05rem 0.4rem; margin-right: 0.4rem;
            font-size: 0.72rem; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.06em;
          }
          .band-paydirt { background: var(--ore); color: #1b1f26; }
          .band-look { background: none; border: 1px solid var(--ore-dim);
                       color: var(--ore-dim); }
          .band-longshot { background: none; border: 1px solid var(--rock-edge);
                           color: var(--text-faint); }
          /* A long shot is on the page because the floor put it there, so it
             sits back: the card is present, but it does not compete with a
             paper the assay actually stood behind. */
          article.is-longshot { opacity: 0.82; }
          article.is-longshot .seam { background: var(--rock);
                                      border-color: var(--rock-edge);
                                      color: var(--text-faint); }
          .tally {
            margin: 0.5rem 0 0; color: var(--text-dim); font-size: 0.95rem;
          }
          .kind {
            background: none; border: 1px solid var(--rock-edge);
            color: var(--text-faint); font-weight: 600;
          }
          /* The caveat is the field that makes the rest credible, so it is set
             apart rather than blended into the run of paragraphs. */
          .body .but { color: var(--text-dim); }
          .body .but strong { color: var(--text-faint); }

          .empty {
            border: 1px dashed var(--rock-lit); border-radius: 6px;
            padding: 1.5rem; text-align: center; color: var(--text-dim);
          }
          footer {
            margin-top: 2rem; padding-top: 0.9rem;
            border-top: 1px solid var(--rock-edge);
            color: var(--text-faint); font-size: 0.85rem;
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          <header>
            <h1><xsl:value-of select="channel/title"/></h1>
            <p class="lede"><xsl:value-of select="channel/description"/></p>
            <!-- An empty top band is an answer, so it is said out loud above
                 the cards rather than left to be inferred from their chips. -->
            <xsl:if test="channel/arxave:tally">
              <p class="tally"><xsl:value-of select="channel/arxave:tally"/></p>
            </xsl:if>
          </header>

          <div class="how">
            <p>
              <strong>This page is a feed.</strong> Paste its address into any
              reader to get it each morning — nothing is sent to you, and
              nobody here learns that you subscribed.
            </p>
            <code><xsl:value-of select="channel/atom:link/@href"/></code>
            <p style="margin-top:0.55rem">
              <a>
                <xsl:attribute name="href"><xsl:value-of select="channel/link"/></xsl:attribute>
                Open the Dig
              </a>
              to change what it ranks for, or to move the weights yourself.
            </p>
          </div>

          <!-- A day where nothing cleared the bar is a real answer, and the
               page says so rather than looking broken. -->
          <xsl:if test="not(channel/item)">
            <div class="empty">
              Nothing cleared the bar in today's announcement.
            </div>
          </xsl:if>

          <xsl:for-each select="channel/item">
            <article>
              <xsl:if test="arxave:band = 'longshot'">
                <xsl:attribute name="class">is-longshot</xsl:attribute>
              </xsl:if>
              <div class="head">
                <span class="seam"><xsl:value-of select="position()"/></span>
                <h2>
                  <a>
                    <xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>
                    <xsl:value-of select="title"/>
                  </a>
                </h2>
                <xsl:if test="arxave:announced">
                  <span class="when"><xsl:value-of select="arxave:announced"/></span>
                </xsl:if>
              </div>
              <!-- Rendered from the arxave:* elements, never from <description>.
                   description holds escaped HTML for feed readers, and undoing
                   that escaping needs disable-output-escaping, which no browser
                   implements — it printed the tags on screen instead. -->
              <div class="body">
                <!-- The authors, on their own line under the title. One of the
                     three things a closed card shows. -->
                <xsl:if test="arxave:authors">
                  <p class="byline"><xsl:value-of select="arxave:authors"/></p>
                </xsl:if>
                <xsl:if test="arxave:band or arxave:kind">
                  <p class="chips">
                    <xsl:if test="arxave:band">
                      <span>
                        <xsl:attribute name="class">
                          <xsl:text>band band-</xsl:text><xsl:value-of select="arxave:band"/>
                        </xsl:attribute>
                        <xsl:value-of select="arxave:bandname"/>
                      </span>
                    </xsl:if>
                    <xsl:if test="arxave:kind">
                      <span class="kind"><xsl:value-of select="arxave:kind"/></span>
                    </xsl:if>
                  </p>
                </xsl:if>
                <!-- The finding: centred, on its own line, and the last thing
                     visible before the drawers. -->
                <xsl:if test="arxave:result">
                  <p class="result"><xsl:value-of select="arxave:result"/></p>
                </xsl:if>
                <p class="grade">
                  <strong>Grade <xsl:value-of select="arxave:grade"/></strong>
                  <xsl:if test="arxave:z">
                    <xsl:text> &#183; </xsl:text>
                    <xsl:value-of select="arxave:z"/>
                    <xsl:text>&#963; above the day&#8217;s baseline</xsl:text>
                  </xsl:if>
                  <xsl:if test="arxave:matched">
                    <xsl:text> &#183; matched &#8220;</xsl:text>
                    <xsl:value-of select="arxave:matched"/>
                    <xsl:text>&#8221;</xsl:text>
                  </xsl:if>
                </p>
                <!-- SIX DRAWERS, in the order a reader wants them: the picture
                     first because it is the fastest thing on the card to read,
                     then the question, then what it beats, then what it costs,
                     then the jargon, then the author&#8217;s own words. -->
                <div class="folds">
                  <!-- The figure is hotlinked from arxiv.org: this repository
                       stays text, and the image is already being served next to
                       the paper. Clicking it opens the lightbox rather than the
                       paper — the paper is one line up, in the title. -->
                  <xsl:if test="arxave:figure">
                    <details class="fold">
                      <summary>Figure</summary>
                      <div class="fold-body">
                        <figure class="figure">
                          <img>
                            <xsl:attribute name="src"><xsl:value-of select="arxave:figure"/></xsl:attribute>
                            <xsl:attribute name="alt"><xsl:value-of select="arxave:figurecaption"/></xsl:attribute>
                            <xsl:attribute name="data-caption"><xsl:value-of select="arxave:figurecaption"/></xsl:attribute>
                            <xsl:attribute name="loading">lazy</xsl:attribute>
                          </img>
                          <xsl:if test="arxave:figurecaption">
                            <figcaption class="figure-caption"><xsl:value-of select="arxave:figurecaption"/></figcaption>
                          </xsl:if>
                        </figure>
                      </div>
                    </details>
                  </xsl:if>
                  <xsl:if test="arxave:question">
                    <details class="fold">
                      <summary>Asks</summary>
                      <p class="fold-body"><xsl:value-of select="arxave:question"/></p>
                    </details>
                  </xsl:if>
                  <!-- `Before` is the field the whole full-text tier exists for:
                       a number with nothing to compare it against is not a
                       result yet. Absent when the paper states none, or when
                       arXiv has no HTML rendering to read — an abstract rarely
                       names the baseline it beats. -->
                  <xsl:if test="arxave:prior">
                    <details class="fold">
                      <summary>Before</summary>
                      <p class="fold-body"><xsl:value-of select="arxave:prior"/></p>
                    </details>
                  </xsl:if>
                  <!-- The caveat is the field that makes the rest credible. -->
                  <xsl:if test="arxave:limits">
                    <details class="fold">
                      <summary>But</summary>
                      <p class="fold-body but"><xsl:value-of select="arxave:limits"/></p>
                    </details>
                  </xsl:if>
                  <xsl:if test="arxave:tools or arxave:code">
                    <details class="fold">
                      <summary>Tools</summary>
                      <div class="fold-body">
                        <xsl:if test="arxave:tools">
                          <p><xsl:value-of select="arxave:tools"/></p>
                        </xsl:if>
                        <xsl:if test="arxave:code">
                          <p><strong>Code. </strong>
                            <a>
                              <xsl:attribute name="href"><xsl:value-of select="arxave:code"/></xsl:attribute>
                              <xsl:value-of select="arxave:code"/>
                            </a>
                          </p>
                        </xsl:if>
                      </div>
                    </details>
                  </xsl:if>
                  <xsl:if test="arxave:abstract">
                    <details class="fold">
                      <summary>Abstract</summary>
                      <p class="fold-body"><xsl:value-of select="arxave:abstract"/></p>
                    </details>
                  </xsl:if>
                  <button class="unfold" type="button">Unfold all</button>
                </div>
              </div>
            </article>
          </xsl:for-each>

          <!-- One overlay for the whole page, filled on click. A per-card
               overlay would mean one hidden copy of every figure in the DOM. -->
          <div class="lightbox" id="lightbox">
            <img id="lightbox-img" src="" alt=""/>
            <p id="lightbox-caption"></p>
          </div>

          <!-- SCRIPT IN AN XSL TEMPLATE. This is a stylesheet the browser
               applies to the RSS before painting it, so the output is an
               ordinary document and ordinary script runs in it. Feed readers
               never reach this branch at all: they parse the XML and ignore the
               stylesheet, so nothing here can break a subscription. Everything
               below is a convenience over markup that already works without it
               — the drawers are <details>, which open on their own. -->
          <script>
            <xsl:text disable-output-escaping="yes">/*<![CDATA[*/
            (function () {
              /* "Unfold all" is per card and is a toggle: if anything on this
                 card is still closed, open everything; otherwise close it. */
              document.addEventListener('click', function (ev) {
                var btn = ev.target.closest('.unfold');
                if (!btn) return;
                var row = btn.parentNode;
                var folds = row.querySelectorAll('details.fold');
                var anyClosed = false;
                folds.forEach(function (f) { if (!f.open) anyClosed = true; });
                folds.forEach(function (f) { f.open = anyClosed; });
                btn.textContent = anyClosed ? 'Fold all' : 'Unfold all';
              });

              /* A figure at column width is a thumbnail of a plot — these are
                 drawn for a printed page. Click throws it up full-screen. */
              var box = document.getElementById('lightbox');
              var boxImg = document.getElementById('lightbox-img');
              var boxCap = document.getElementById('lightbox-caption');
              function close() { box.classList.remove('open'); boxImg.src = ''; }
              document.addEventListener('click', function (ev) {
                var img = ev.target.closest('.figure img');
                if (!img) return;
                ev.preventDefault();
                boxImg.src = img.src;
                boxImg.alt = img.alt || '';
                boxCap.textContent = img.getAttribute('data-caption') || '';
                box.classList.add('open');
              });
              box.addEventListener('click', close);
              document.addEventListener('keydown', function (ev) {
                if (ev.key === 'Escape') close();
              });
            })();
            /*]]>*/</xsl:text>
          </script>

          <footer>
            Built <xsl:value-of select="channel/lastBuildDate"/> · ranked in the
            browser's own model, then written out here.
          </footer>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
