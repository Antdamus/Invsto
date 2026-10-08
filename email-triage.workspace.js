/* Preserve the operator's place while independent mailbox requests finish. */
(function (root) {
  'use strict';
  const rendered = new WeakMap();
  function paint(element, html) {
    if (!element || rendered.get(element) === html) return false;
    const scrollTop = element.scrollTop;
    const oldConversation = element.querySelector('[data-triage-selected]')?.dataset.triageSelected;
    const disclosures = new Map([...element.querySelectorAll('details')].map((item, index) => [
      item.dataset.triageDisclosure || `${index}:${item.querySelector('summary')?.textContent.trim()}`, item.open,
    ]));
    const active = element.contains(document.activeElement) ? document.activeElement : null;
    const field = active?.name;
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const form = active?.closest('form');
    const formKey = form?.getAttribute('data-ebay-conversation-id');
    const formMode = form?.getAttribute('data-ebay-composer-mode');
    element.innerHTML = html;
    rendered.set(element, html);
    const sameConversation = oldConversation === element.querySelector('[data-triage-selected]')?.dataset.triageSelected;
    if (sameConversation) {
      element.querySelectorAll('details').forEach((item, index) => {
        const key = item.dataset.triageDisclosure || `${index}:${item.querySelector('summary')?.textContent.trim()}`;
        if (disclosures.has(key)) item.open = disclosures.get(key);
      });
      element.scrollTop = scrollTop;
      if (field && formKey) {
        const replacement = [...element.querySelectorAll('form')].find(item =>
          item.getAttribute('data-ebay-conversation-id') === formKey && item.getAttribute('data-ebay-composer-mode') === formMode
        )?.elements.namedItem(field);
        if (replacement?.focus && !replacement.disabled) {
          replacement.focus({preventScroll: true});
          if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
        }
      }
    } else element.scrollTop = 0;
    return true;
  }
  function cleanPreview(value) {
    // eBay email previews sometimes arrive with encoded HTML padding. Decode as
    // inert textarea text, then let the caller escape it before rendering.
    const decoder = document.createElement('textarea');
    decoder.innerHTML = String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return decoder.value.replace(/[\u034f\u200b-\u200f\ufeff]/g, '').replace(/-->/g, '').replace(/\s+/g, ' ').trim();
  }
  root.EmailTriageWorkspace = Object.freeze({paint, cleanPreview});
})(window);
