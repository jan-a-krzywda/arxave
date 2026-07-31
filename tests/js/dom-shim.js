/* Minimal DOM + localStorage shim, just enough to load filter.js and drive
   the claim/weight wiring. Not a browser — no layout, no canvas rendering. */

function El(tag, cls) {
  this.tagName = tag || 'div';
  this.className = cls || '';
  this.children = [];
  this.parent = null;
  this.dataset = {};
  this.style = {};
  this.value = '';
  this.textContent = '';
  this.checked = false;
  this.disabled = false;
  this._html = '';
  this._listeners = {};
  this.files = [];
}

El.prototype = {
  get innerHTML() { return this._html; },
  /* Build one child per class="..." token found. Enough for the row markup in
     filter.js, which always tags every input it later queries. */
  set innerHTML(html) {
    this._html = html;
    this.children = [];
    if (!html) return;
    var re = /<(\w+)([^>]*)>/g, m;
    while ((m = re.exec(html)) !== null) {
      var attrs = m[2];
      var cls = /class="([^"]*)"/.exec(attrs);
      var val = /value="([^"]*)"/.exec(attrs);
      var child = new El(m[1], cls ? cls[1] : '');
      if (val) child.value = val[1];
      child.parent = this;
      this.children.push(child);
    }
  },
  appendChild: function (c) { c.parent = this; this.children.push(c); return c; },
  removeChild: function (c) { this.children = this.children.filter(function (x) { return x !== c; }); },
  remove: function () { if (this.parent) this.parent.removeChild(this); },
  _all: function () {
    var out = [];
    for (var i = 0; i < this.children.length; i++) {
      out.push(this.children[i]);
      out = out.concat(this.children[i]._all());
    }
    return out;
  },
  _matches: function (sel) {
    var m;
    if ((m = /^\.([\w-]+)$/.exec(sel))) {
      return (' ' + this.className + ' ').indexOf(' ' + m[1] + ' ') !== -1;
    }
    if ((m = /^\.([\w-]+)\[data-id="([^"]+)"\]$/.exec(sel))) {
      return (' ' + this.className + ' ').indexOf(' ' + m[1] + ' ') !== -1 &&
        this.dataset.id === m[2];
    }
    return false;
  },
  querySelector: function (sel) {
    var all = this._all();
    for (var i = 0; i < all.length; i++) if (all[i]._matches(sel)) return all[i];
    return null;
  },
  querySelectorAll: function (sel) {
    return this._all().filter(function (e) { return e._matches(sel); });
  },
  addEventListener: function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  },
  fire: function (type, ev) {
    var ls = this._listeners[type] || [];
    for (var i = 0; i < ls.length; i++) ls[i].call(this, ev || {});
  },
};

function install(ids) {
  var registry = {};
  ids.forEach(function (id) { registry[id] = new El('div', ''); registry[id].id = id; });

  global.document = {
    _registry: registry,
    getElementById: function (id) {
      if (!registry[id]) { registry[id] = new El('div', ''); registry[id].id = id; }
      return registry[id];
    },
    createElement: function (tag) { return new El(tag, ''); },
    addEventListener: function () {},
  };

  var store = {};
  global.localStorage = {
    _store: store,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
  };

  global.window = {
    addEventListener: function () {},
    prompt: function () { return global.__promptAnswer; },
    confirm: function () { return global.__confirmAnswer !== false; },
    devicePixelRatio: 1,
  };
  global.setTimeout = global.setTimeout || function () {};
  global.fetch = function () { return Promise.reject(new Error('no network in smoke test')); };
  global.FileReader = function () {};

  return { registry: registry, store: store, El: El };
}

module.exports = { install: install, El: El };
