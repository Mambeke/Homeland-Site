(function (root) {
  'use strict';
  const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => escapes[char]);
  }
  function safeImageURL(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return '';
    if (/^\/api\/media\/[A-Za-z0-9-]+$/.test(raw)) return raw;
    try {
      const base = root.location && root.location.origin ? root.location.origin : 'https://homeland.invalid';
      const url = new URL(raw, base);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      return url.href;
    } catch (e) {
      return '';
    }
  }
  const helpers = Object.freeze({ escapeHTML, escapeAttr: escapeHTML, safeImageURL });
  root.HomelandSecurity = helpers;
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
})(globalThis);
