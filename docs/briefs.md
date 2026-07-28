---
layout: page
title: Briefs
permalink: /briefs/
---

<p>
  Below is every daily brief the scout has generated. Each one is a
  standalone page with the ranked papers, connections, and verdicts.
</p>

{% assign sorted_briefs = site.briefs | sort: "date" | reverse %}
{% if sorted_briefs.size > 0 %}
  <ul class="brief-list">
    {% for brief in sorted_briefs %}
      <li>
        <a href="{{ brief.url | relative_url }}">
          {{ brief.date | date: "%A, %d %B %Y" }}
        </a>
        {% if brief.title %}<span class="brief-subtitle">— {{ brief.title }}</span>{% endif %}
      </li>
    {% endfor %}
  </ul>
{% else %}
  <p class="empty">
    No briefs yet. Run <code>arxave run</code> and commit the generated
    <code>briefs/</code> directory, then this page will populate automatically.
  </p>
{% endif %}