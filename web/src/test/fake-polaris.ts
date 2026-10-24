// Test-only stand-ins for the Polaris web components (the real ones load from Shopify's CDN). Like the real
// components they are form-associated-style hosts with a `value` / `checked` property and fire `input` / `change`.

/**
 * Like the real components, the first render after connecting initializes the value from the `value` attribute,
 * overwriting a property set right after the element was created (staging: edit forms opened blank).
 */
class FakeValueField extends HTMLElement {
  value = '';
  connectedCallback() {
    queueMicrotask(() => {
      this.value = this.getAttribute('value') ?? '';
    });
  }
}

class FakeCheckbox extends HTMLElement {
  checked = false;
  connectedCallback() {
    queueMicrotask(() => {
      this.checked = this.hasAttribute('checked');
    });
  }
}

const VALUE_TAGS = ['s-text-field', 's-text-area', 's-date-field', 's-select'];

export function defineFakePolaris(): void {
  for (const tag of VALUE_TAGS) {
    if (!customElements.get(tag)) customElements.define(tag, class extends FakeValueField {});
  }
  if (!customElements.get('s-checkbox')) customElements.define('s-checkbox', FakeCheckbox);
}

/** What the browser does when the user types into a field (or autofill fills it). */
export function typeInto(el: Element, value: string): void {
  (el as HTMLElement & { value: string }).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

export function fieldByLabel(root: ParentNode, label: string): HTMLElement {
  const el = [...root.querySelectorAll<HTMLElement>('[label]')].find(
    (e) => e.getAttribute('label') === label,
  );
  if (!el) throw new Error(`No field labelled "${label}"`);
  return el;
}
