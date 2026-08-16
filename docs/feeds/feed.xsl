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
          h2 { font-size: 1.06rem; line-height: 1.35; margin: 0; }
          h2 a { color: var(--text); }
          h2 a:hover { color: var(--ore); }

          .body { margin-top: 0.7rem; font-size: 0.95rem; }
          .body p { margin: 0.45rem 0; color: var(--text); }
          .body strong { color: var(--ore-dim); font-weight: 600; }
          .body .grade { color: var(--text-faint); font-size: 0.85rem; }
          .body .grade strong { color: var(--text-dim); }
          /* The abstract is the long tail of the card; dimming it puts the
             generated fields first without hiding the author's own words. */
          .body .abstract { color: var(--text-dim); font-size: 0.9rem; }
          /* The decision line leads the card and is the only text set larger
             than the body. The verdict itself is a flag, not a colour: `read`
             is ore, `skim` is rock, and nothing else on a card competes. */
          .body .verdict {
            font-size: 1rem; line-height: 1.5; margin: 0 0 0.5rem;
          }
          .flag, .kind {
            display: inline-block; vertical-align: baseline;
            border-radius: 3px; padding: 0.05rem 0.4rem; margin-right: 0.35rem;
            font-size: 0.72rem; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.06em;
          }
          .flag-read { background: var(--ore); color: #1b1f26; }
          .flag-skim { background: var(--rock); color: var(--text-dim);
                       border: 1px solid var(--rock-edge); }
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
              </div>
              <!-- Rendered from the arxave:* elements, never from <description>.
                   description holds escaped HTML for feed readers, and undoing
                   that escaping needs disable-output-escaping, which no browser
                   implements — it printed the tags on screen instead. -->
              <div class="body">
                <!-- The decision first, as in the feed itself: verdict, what
                     sort of paper it is, and the finding with its number. The
                     provenance line under it explains the ranking rather than
                     describing the paper, so it is set quiet. -->
                <xsl:if test="arxave:band or arxave:verdict or arxave:kind or arxave:headline">
                  <p class="verdict">
                    <xsl:if test="arxave:band">
                      <span>
                        <xsl:attribute name="class">
                          <xsl:text>band band-</xsl:text><xsl:value-of select="arxave:band"/>
                        </xsl:attribute>
                        <xsl:value-of select="arxave:bandname"/>
                      </span>
                    </xsl:if>
                    <xsl:if test="arxave:verdict">
                      <span>
                        <xsl:attribute name="class">
                          <xsl:text>flag flag-</xsl:text><xsl:value-of select="arxave:verdict"/>
                        </xsl:attribute>
                        <xsl:value-of select="arxave:verdict"/>
                      </span>
                    </xsl:if>
                    <xsl:if test="arxave:kind">
                      <span class="kind"><xsl:value-of select="arxave:kind"/></span>
                    </xsl:if>
                    <xsl:if test="arxave:headline">
                      <xsl:text> </xsl:text><xsl:value-of select="arxave:headline"/>
                    </xsl:if>
                  </p>
                </xsl:if>
                <p class="grade">
                  <strong>Grade <xsl:value-of select="arxave:grade"/></strong>
                  <xsl:if test="arxave:z">
                    <xsl:text> · </xsl:text>
                    <xsl:value-of select="arxave:z"/>
                    <xsl:text>&#963; above the day's baseline</xsl:text>
                  </xsl:if>
                  <xsl:if test="arxave:matched">
                    <xsl:text> · matched &#8220;</xsl:text>
                    <xsl:value-of select="arxave:matched"/>
                    <xsl:text>&#8221;</xsl:text>
                  </xsl:if>
                  <xsl:if test="arxave:authors">
                    <xsl:text> · </xsl:text><xsl:value-of select="arxave:authors"/>
                  </xsl:if>
                </p>
                <xsl:if test="arxave:sowhat">
                  <p><strong>So what. </strong><xsl:value-of select="arxave:sowhat"/></p>
                </xsl:if>
                <xsl:if test="arxave:caveat">
                  <p class="but"><strong>But. </strong><xsl:value-of select="arxave:caveat"/></p>
                </xsl:if>
                <xsl:if test="arxave:tools">
                  <p><strong>Tools. </strong><xsl:value-of select="arxave:tools"/></p>
                </xsl:if>
                <p class="abstract">
                  <strong>Abstract. </strong><xsl:value-of select="arxave:abstract"/>
                </p>
                <p>
                  <a>
                    <xsl:attribute name="href"><xsl:value-of select="/rss/channel/link"/></xsl:attribute>
                    Tune this in the Dig
                  </a>
                </p>
              </div>
            </article>
          </xsl:for-each>

          <footer>
            Built <xsl:value-of select="channel/lastBuildDate"/> · ranked in the
            browser's own model, then written out here.
          </footer>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
