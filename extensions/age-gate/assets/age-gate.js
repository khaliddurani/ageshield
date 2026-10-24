/*
 * AgeShield age gate (theme app extension, app embed). Vanilla JS, no dependencies.
 *
 * 1. Reads #ageshield-data (rendered by blocks/age_gate.liquid only on pages that need an age check).
 * 2. Coming back from the eID login: reads the URL fragment (#ageshield=<token> or #ageshield_status=…), removes it
 *    with history.replaceState, saves the token as the cart attribute "_ageshield_token" (/cart/update.js).
 * 3. Until the cart holds a valid token for the required age, disables add-to-cart (gate mode "product_page") and
 *    checkout buttons, and shows "Verify your age" buttons for the merchant's countries. Verifying calls the App Proxy
 *    POST {proxyPath}/verify/start and navigates to the returned Idura URL.
 * UX only: the Phase 2 checkout Function is the real enforcement. "Buy it now" / accelerated checkout buttons skip
 * the cart (and its token), so they stay hidden on restricted product pages.
 * All text is set with textContent (merchant and translation strings are never parsed as HTML).
 */
(function () {
  'use strict';

  var dataEl = document.getElementById('ageshield-data');
  if (!dataEl || window.__ageshieldLoaded) return;
  window.__ageshieldLoaded = true;

  var data;
  try {
    data = JSON.parse(dataEl.textContent || '{}');
  } catch (e) {
    return;
  }

  var COUNTRIES = ['DK', 'SE', 'NO', 'FI'];
  var AGES = [15, 16, 18, 21];
  var config = data.config || {};
  var countries = (Array.isArray(config.countries) ? config.countries : COUNTRIES).filter(function (c) {
    return COUNTRIES.indexOf(c) !== -1;
  });
  var gateMode = config.gateMode === 'cart' ? 'cart' : 'product_page';
  var proxyPath = typeof config.proxyPath === 'string' && /^\/apps\/[\w-]+$/.test(config.proxyPath)
    ? config.proxyPath
    : '/apps/ageshield';
  var root = typeof data.root === 'string' && data.root.charAt(0) === '/' ? data.root.replace(/\/?$/, '/') : '/';
  var i18n = data.i18n || {};
  var hooks = window.AgeShield || {};
  var navigate = hooks.navigate || function (url) { window.location.assign(url); };
  var SESSION_KEY = 'ageshield_cart_age';

  /** Merchant text for the shop's language (exact locale, then the language), else the theme translation. */
  function merchantText(key) {
    var texts = config.texts || {};
    var locale = String(data.locale || '');
    var entry = texts[locale] || texts[locale.split('-')[0]];
    var value = entry && typeof entry[key] === 'string' ? entry[key].trim() : '';
    return value || null;
  }

  function t(key, vars) {
    var text = String(i18n[key] || '');
    Object.keys(vars || {}).forEach(function (name) {
      text = text.split('{' + name + '}').join(String(vars[name]));
    });
    return text;
  }

  function validAge(value) {
    var n = Number(value);
    return AGES.indexOf(n) !== -1 ? n : 0;
  }

  function sessionAge() {
    try {
      return validAge(window.sessionStorage.getItem(SESSION_KEY));
    } catch (e) {
      return 0;
    }
  }

  function rememberCartAge(age) {
    try {
      if (age > sessionAge()) window.sessionStorage.setItem(SESSION_KEY, String(age));
    } catch (e) {
      /* storage unavailable */
    }
  }

  var productAge = data.template === 'product' ? validAge(data.productAge) : 0;
  var addAge = gateMode === 'product_page' ? productAge : 0;
  function checkoutAge() {
    return Math.max(validAge(data.cartAge), sessionAge());
  }

  // --- Token (signature is checked server-side; here only expiry and age decide the UI) ---------------------------

  var TOKEN_RE = /^[A-Za-z0-9_-]{20,1500}\.[A-Za-z0-9_-]{20,100}$/;

  function tokenPayload(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    try {
      var b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(window.atob(b64));
      return payload && typeof payload.exp === 'number' && typeof payload.min_age === 'number' ? payload : null;
    } catch (e) {
      return null;
    }
  }

  var token = typeof data.token === 'string' ? data.token : '';

  function verifiedFor(age) {
    if (!age) return true;
    var payload = tokenPayload(token);
    return !!payload && payload.exp * 1000 > Date.now() && payload.min_age >= age;
  }

  function saveToken(value) {
    return fetch(root + 'cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ attributes: { _ageshield_token: value } }),
    }).then(function (res) {
      if (!res.ok) throw new Error('cart update ' + res.status);
    });
  }

  // --- Return from the eID login ---------------------------------------------------------------------------------

  var status = null; // { kind, age, country } message to show
  var pendingSave = null;

  (function readFragment() {
    var hash = window.location.hash.replace(/^#/, '');
    if (hash.indexOf('ageshield') === -1) return;
    var params = new URLSearchParams(hash);
    var newToken = params.get('ageshield');
    var result = params.get('ageshield_status');
    if (!newToken && !result) return;
    // Remove the fragment at once: the token must not stay in the address bar, history or shared links.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    if (newToken && tokenPayload(newToken)) {
      token = newToken;
      status = { kind: 'verified' };
      pendingSave = saveToken(newToken).catch(function () {
        status = { kind: 'error' };
        token = '';
        render();
      });
    } else if (result) {
      var kinds = ['rejected', 'cancelled', 'assurance', 'expired', 'error'];
      status = {
        kind: kinds.indexOf(result) !== -1 ? result : 'error',
        age: validAge(params.get('ageshield_age')),
        country: params.get('ageshield_country'),
      };
    }
  })();

  // --- Blocking ----------------------------------------------------------------------------------------------------

  var ADD_FORM = 'form[action*="/cart/add"]';
  var ADD_BUTTONS = ADD_FORM + ' [type="submit"], ' + ADD_FORM + ' button[name="add"]';
  var BUY_NOW = '.shopify-payment-button, shopify-accelerated-checkout, [data-shopify="payment-button"]';
  var CHECKOUT = '[name="checkout"], a[href*="/checkout"], form[action*="/checkout"] [type="submit"]';

  function blockedAdd() {
    return addAge > 0 && !verifiedFor(addAge);
  }
  function blockedCheckout() {
    var age = checkoutAge();
    return age > 0 && !verifiedFor(age);
  }

  function setDisabled(el, disabled) {
    if (disabled) {
      if (!el.hasAttribute('data-ageshield-disabled')) {
        el.setAttribute('data-ageshield-disabled', el.disabled ? 'was' : 'yes');
      }
      el.setAttribute('aria-disabled', 'true');
      if ('disabled' in el) el.disabled = true;
      el.classList.add('ageshield-blocked');
    } else if (el.hasAttribute('data-ageshield-disabled')) {
      if ('disabled' in el && el.getAttribute('data-ageshield-disabled') === 'yes') el.disabled = false;
      el.removeAttribute('data-ageshield-disabled');
      el.removeAttribute('aria-disabled');
      el.classList.remove('ageshield-blocked');
    }
  }

  function applyBlocking() {
    var add = blockedAdd();
    var checkout = blockedCheckout();
    document.querySelectorAll(ADD_BUTTONS).forEach(function (el) { setDisabled(el, add); });
    document.querySelectorAll(CHECKOUT).forEach(function (el) { setDisabled(el, checkout); });
    if (productAge) {
      document.querySelectorAll(BUY_NOW).forEach(function (el) { el.classList.add('ageshield-hidden'); });
    }
  }

  // Backup for themes that re-enable buttons or submit by script: stop the action itself (capture phase).
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var action = form.getAttribute('action') || '';
    if (action.indexOf('/cart/add') !== -1) {
      if (blockedAdd()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        focusNotice();
        return;
      }
      if (productAge) rememberCartAge(productAge);
    }
    if (action.indexOf('/checkout') !== -1 && blockedCheckout()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      goToNotice();
    }
  }, true);

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest(CHECKOUT + ', ' + ADD_BUTTONS) : null;
    if (!target) return;
    var isAdd = target.matches(ADD_BUTTONS);
    if (isAdd ? blockedAdd() : blockedCheckout()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isAdd) focusNotice(); else goToNotice();
    } else if (isAdd && productAge) {
      rememberCartAge(productAge); // AJAX add-to-cart themes never submit the form
    }
  }, true);

  // --- Notice ------------------------------------------------------------------------------------------------------

  var notice = null;
  var messageEl = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function anchor() {
    if (data.template === 'product') {
      return document.querySelector('main ' + ADD_FORM) || document.querySelector(ADD_FORM);
    }
    if (data.template === 'cart') {
      var checkout = document.querySelector('main [name="checkout"]') || document.querySelector('[name="checkout"]');
      return (checkout && checkout.closest('form')) || checkout;
    }
    return null;
  }

  /** The age this page asks to verify: the product (to add or buy it), or the cart (to check out). */
  function pageAge() {
    return data.template === 'product' ? productAge : checkoutAge();
  }

  function bodyText(age) {
    if (data.template === 'cart') return t('body_cart', { age: age });
    if (gateMode === 'cart') return t('body_checkout', { age: age });
    return merchantText('body') || t('body', { age: age });
  }

  function statusText() {
    if (!status) return '';
    var age = status.age || pageAge();
    switch (status.kind) {
      case 'verified': return t('verified');
      case 'rejected': return t('rejected', { age: age });
      case 'cancelled': return t('cancelled');
      case 'assurance': return status.country === 'DK' ? t('assurance_mitid') : t('assurance');
      case 'expired': return t('expired');
      case 'rate_limited': return t('rate_limited');
      case 'opening': return t('opening');
      default: return t('error');
    }
  }

  function start(country, button) {
    var age = pageAge();
    status = { kind: 'opening' };
    render();
    button.disabled = true;
    fetch(proxyPath + '/verify/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        country: country,
        minAge: age,
        returnPath: window.location.pathname + window.location.search,
        host: window.location.hostname,
      }),
    })
      .then(function (res) {
        if (res.status === 429) throw { kind: 'rate_limited' };
        if (!res.ok) throw { kind: 'error' };
        return res.json();
      })
      .then(function (body) {
        if (!body || typeof body.authorizeUrl !== 'string' || body.authorizeUrl.indexOf('https://') !== 0) {
          throw { kind: 'error' };
        }
        navigate(body.authorizeUrl);
      })
      .catch(function (err) {
        status = { kind: err && err.kind === 'rate_limited' ? 'rate_limited' : 'error' };
        button.disabled = false;
        render();
      });
  }

  function render() {
    var age = pageAge();
    var verified = verifiedFor(age);
    var needsNotice = data.template === 'product' ? productAge > 0 : data.template === 'cart' && checkoutAge() > 0;
    applyBlocking();
    if (!needsNotice) return;

    if (!notice) {
      notice = el('div', 'ageshield');
      notice.setAttribute('tabindex', '-1');
      if (typeof config.brandColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(config.brandColor)) {
        notice.style.setProperty('--ageshield-color', config.brandColor);
      }
      var target = anchor();
      if (target && target.parentNode) target.parentNode.insertBefore(notice, target);
      else (document.querySelector('main') || document.body).prepend(notice);
    }
    notice.textContent = '';
    notice.classList.toggle('ageshield--verified', verified);

    if (verified) {
      notice.appendChild(el('p', 'ageshield__verified', t('verified')));
    } else {
      notice.appendChild(el('p', 'ageshield__heading', merchantText('heading') || t('heading')));
      notice.appendChild(el('p', 'ageshield__body', bodyText(age)));
      var label = merchantText('button') || t('verify_with');
      var buttons = el('div', 'ageshield__buttons');
      countries.forEach(function (country) {
        var button = el('button', 'ageshield__button', t('method_' + country.toLowerCase()));
        button.type = 'button';
        button.setAttribute('aria-label', label + ' ' + t('method_' + country.toLowerCase()));
        button.setAttribute('data-country', country);
        button.addEventListener('click', function () { start(country, button); });
        buttons.appendChild(button);
      });
      notice.appendChild(el('p', 'ageshield__label', label));
      notice.appendChild(buttons);
    }
    if (productAge) notice.appendChild(el('p', 'ageshield__note', t('buy_now_hidden')));

    messageEl = el('p', 'ageshield__message');
    messageEl.setAttribute('role', 'status');
    messageEl.setAttribute('aria-live', 'polite');
    var message = status && !(verified && status.kind === 'verified') ? statusText() : '';
    if (message) {
      messageEl.textContent = message;
      messageEl.classList.add('ageshield__message--' + status.kind);
    }
    notice.appendChild(messageEl);
  }

  function focusNotice() {
    if (notice) notice.focus();
  }

  function goToNotice() {
    if (data.template === 'cart' && notice) notice.focus();
    else window.location.assign(root + 'cart');
  }

  render();
  if (pendingSave) pendingSave.then(render);

  // Themes re-render buttons (variant changes, cart drawers): re-apply blocking, batched per frame.
  var scheduled = false;
  new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(function () {
      scheduled = false;
      applyBlocking();
    });
  }).observe(document.body, { childList: true, subtree: true });

  hooks.state = function () {
    return { token: token, blockedAdd: blockedAdd(), blockedCheckout: blockedCheckout(), status: status };
  };
})();
