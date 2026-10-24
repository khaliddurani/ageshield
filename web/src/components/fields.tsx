import { useEffect, useId, useRef } from 'react';

// React 18 passes props to custom elements as attributes and doesn't wire their events, so these wrappers set
// `value` / `checked` as properties and listen to the components' native input/change events. They also render the
// value as an attribute: the Polaris components initialize from the attribute on their first render, which would
// otherwise overwrite a value property set right after creation (staging: edit forms opened with blank fields).
//
// Field isolation (RecallKit staging bug: text ended up in the wrong fields): every field gets its own `name` and
// `autocomplete="off"`, so the browser can't offer one field's saved text as a suggestion in another; listeners
// only react to events whose target is the field itself; and form setters must use functional state updates
// (setForm((f) => ({ ...f, key: value }))) so several fields changing before a re-render don't overwrite each other.

type ValueElement = HTMLElement & { value: string };
type CheckedElement = HTMLElement & { checked: boolean };

/** Boolean attribute for a custom element: present only when true (see polaris.d.ts). */
export const flag = (value: boolean | undefined): true | undefined => (value ? true : undefined);

/** Ref that always holds the latest value (for event listeners attached once). */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Unique, stable form-control name for this field instance (React's useId contains ":" which names don't need). */
function useFieldName(name: string | undefined): string {
  const id = useId();
  return name ?? `as-field-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function useValueBinding(value: string, onChange: (value: string) => void) {
  const ref = useRef<ValueElement>(null);
  const handler = useLatest(onChange);
  useEffect(() => {
    const el = ref.current;
    if (el && el.value !== value) el.value = value;
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (event: Event) => {
      if (event.target !== el) return; // bubbled up from something inside this field
      handler.current(el.value ?? '');
    };
    el.addEventListener('input', listener);
    el.addEventListener('change', listener);
    return () => {
      el.removeEventListener('input', listener);
      el.removeEventListener('change', listener);
    };
  }, [handler]);
  return ref;
}

interface BaseProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  details?: string | undefined;
  /** Shown greyed out while the field is empty. */
  placeholder?: string | undefined;
  required?: boolean;
  disabled?: boolean;
  /** Form-control name; a unique one is generated when omitted. */
  name?: string;
}

export function TextField(props: BaseProps & { maxLength?: number }) {
  const ref = useValueBinding(props.value, props.onChange);
  const name = useFieldName(props.name);
  return (
    <s-text-field
      ref={ref}
      name={name}
      autocomplete="off"
      value={props.value}
      label={props.label}
      error={props.error}
      details={props.details}
      placeholder={props.placeholder}
      required={flag(props.required)}
      disabled={flag(props.disabled)}
      maxLength={props.maxLength}
    />
  );
}

export function TextArea(props: BaseProps & { rows?: number; maxLength?: number }) {
  const ref = useValueBinding(props.value, props.onChange);
  const name = useFieldName(props.name);
  return (
    <s-text-area
      ref={ref}
      name={name}
      autocomplete="off"
      value={props.value}
      label={props.label}
      error={props.error}
      details={props.details}
      placeholder={props.placeholder}
      required={flag(props.required)}
      disabled={flag(props.disabled)}
      rows={props.rows ?? 4}
      maxLength={props.maxLength}
    />
  );
}

/** Date as YYYY-MM-DD. */
export function DateField(props: BaseProps) {
  const ref = useValueBinding(props.value, props.onChange);
  const name = useFieldName(props.name);
  return (
    <s-date-field
      ref={ref}
      name={name}
      autocomplete="off"
      value={props.value}
      label={props.label}
      error={props.error}
      details={props.details}
      required={flag(props.required)}
      disabled={flag(props.disabled)}
    />
  );
}

export function Select(props: BaseProps & { options: { value: string; label: string }[] }) {
  const ref = useValueBinding(props.value, props.onChange);
  const name = useFieldName(props.name);
  return (
    <s-select
      ref={ref}
      name={name}
      autocomplete="off"
      value={props.value}
      label={props.label}
      error={props.error}
      details={props.details}
      disabled={flag(props.disabled)}
    >
      {props.options.map((o) => (
        <s-option key={o.value} value={o.value}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

export function Checkbox(props: {
  /** Visible label. Use accessibilityLabel instead when the row already shows the text (no visible label then). */
  label: string;
  accessibilityLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  details?: string | undefined;
  error?: string | undefined;
  disabled?: boolean;
  name?: string;
}) {
  const ref = useRef<CheckedElement>(null);
  const handler = useLatest(props.onChange);
  const name = useFieldName(props.name);
  useEffect(() => {
    const el = ref.current;
    if (el && el.checked !== props.checked) el.checked = props.checked;
  }, [props.checked]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (event: Event) => {
      if (event.target !== el) return;
      handler.current(Boolean(el.checked));
    };
    el.addEventListener('change', listener);
    return () => el.removeEventListener('change', listener);
  }, [handler]);
  return (
    <s-checkbox
      ref={ref}
      name={name}
      checked={flag(props.checked)}
      label={props.accessibilityLabel ? undefined : props.label}
      accessibilityLabel={props.accessibilityLabel}
      details={props.details}
      error={props.error}
      disabled={flag(props.disabled)}
    />
  );
}
