<?xml version="1.0" encoding="UTF-8"?>
<!--
  What a browser shows when someone clicks the RSS link before subscribing.

  Readers never see this: they parse the RSS and ignore the stylesheet. It only
  fires in a browser, which would otherwise print the raw element tree under a
  warning that the document has no style information — a poor first impression
  for a link people click precisely because they do not yet know what it is.

  XSLT 1.0, because that is what browsers implement, and no external anything:
  the stylesheet is served from the same origin as the feed and inlines its own
  CSS, so it works on a page with no site chrome around it.
-->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/rss">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="channel/title"/></title>
        <style>
          :root {
            color-scheme: light dark;
            --bg: #faf8f5; --fg: #1c1a18; --dim: #5d564e;
            --rule: #d9d2c8; --lamp: #b8741a;
          }
          @media (prefers-color-scheme: dark) {
            :root { --bg: #14120f; --fg: #ece7df; --dim: #9c948a;
                    --rule: #332d26; --lamp: #d8952f; }
          }
          body {
            margin: 0 auto; padding: 2rem 1.2rem; max-width: 46rem;
            background: var(--bg); color: var(--fg);
            font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          h1 { font-size: 1.5rem; margin: 0 0 0.3rem; }
          .lede { color: var(--dim); margin: 0 0 1.2rem; }
          .how {
            border: 1px solid var(--rule); border-radius: 6px;
            padding: 0.7rem 0.9rem; margin-bottom: 2rem; color: var(--dim);
            font-size: 0.9rem;
          }
          .how code { word-break: break-all; color: var(--fg); }
          article { border-top: 1px solid var(--rule); padding: 1.1rem 0; }
          article h2 { font-size: 1.05rem; margin: 0 0 0.35rem; }
          a { color: var(--lamp); }
          .meta { color: var(--dim); font-size: 0.85rem; margin-bottom: 0.5rem; }
          .body { color: var(--fg); }
          .body p { margin: 0.4rem 0; }
          footer { color: var(--dim); font-size: 0.85rem; margin-top: 2rem;
                   border-top: 1px solid var(--rule); padding-top: 0.8rem; }
        </style>
      </head>
      <body>
        <h1><xsl:value-of select="channel/title"/></h1>
        <p class="lede"><xsl:value-of select="channel/description"/></p>

        <!-- The one thing a first-time visitor needs: this page is a feed, and
             the URL in the address bar is what goes into a reader. -->
        <div class="how">
          This is an RSS feed. Paste this page's address into a feed reader to
          get it every morning, or
          <a><xsl:attribute name="href"><xsl:value-of select="channel/link"/></xsl:attribute>
          open the Dig</a> to change what it ranks for.
          <br/>
          <code><xsl:value-of select="channel/atom:link/@href"
                              xmlns:atom="http://www.w3.org/2005/Atom"/></code>
        </div>

        <xsl:for-each select="channel/item">
          <article>
            <h2>
              <a>
                <xsl:attribute name="href"><xsl:value-of select="link"/></xsl:attribute>
                <xsl:value-of select="title"/>
              </a>
            </h2>
            <!-- description carries escaped HTML; disable-output-escaping puts
                 the markup back rather than printing the tags. -->
            <div class="body">
              <xsl:value-of select="description" disable-output-escaping="yes"/>
            </div>
          </article>
        </xsl:for-each>

        <footer>
          Built <xsl:value-of select="channel/lastBuildDate"/>.
        </footer>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
