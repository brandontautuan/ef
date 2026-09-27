// Mog Scan homepage wrapper <-> iframe route bridge.
//
// Paste into the public homepage that embeds `/mog-scan/index.html` (the Zo
// Space homepage), after the iframe element. It keeps public URLs such as
// https://mog.zo.space/#/mogs/<post-id> in sync with the app inside the
// same-origin iframe, including Back/Forward and direct links on a fresh load.
//
// Only this navigation bridge is needed on the homepage; do not change its design.
(function mogRouteBridge() {
  var frame = document.querySelector('iframe[data-mog-scan], iframe[src*="/mog-scan/"]');
  if (!frame) return;
  var ORIGIN = window.location.origin;
  var ROUTE = /^(#\/?)?$|^#\/(mogs|my-mogs|my-upmogs)$|^#\/mogs\/[A-Za-z0-9_-]{8,32}$/;
  var lastSent = null;

  function normalize(hash) {
    return hash === '#' || hash === '#/' ? '' : hash;
  }

  function sendRoute(force) {
    var hash = normalize(window.location.hash);
    if (!ROUTE.test(hash) || !frame.contentWindow) return;
    if (!force && hash === lastSent) return; // avoid echo loops
    lastSent = hash;
    frame.contentWindow.postMessage({ type: 'mog:navigate', hash: hash }, ORIGIN);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'mog:ready') { sendRoute(true); return; }
    if (data.type !== 'mog:route' || typeof data.hash !== 'string' || !ROUTE.test(data.hash)) return;
    var hash = normalize(data.hash);
    lastSent = hash;
    if (normalize(window.location.hash) === hash) return;
    // pushState does not fire hashchange, so the iframe is not told about its own move.
    history.pushState(null, '', hash || window.location.pathname + window.location.search);
  });

  window.addEventListener('hashchange', function () { sendRoute(false); });
  window.addEventListener('popstate', function () { sendRoute(false); });
  frame.addEventListener('load', function () { sendRoute(true); });
})();
