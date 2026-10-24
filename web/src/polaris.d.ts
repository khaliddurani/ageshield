// Minimal JSX typings for the Polaris web components (polaris.js) and App Bridge elements (app-bridge.js),
// both loaded from the Shopify CDN. Extend as new components are used.
//
// React 18 sets props on custom elements as HTML attributes, verbatim. Polaris reads each property from its
// lowercased name (gridTemplateColumns → "gridtemplatecolumns"; checked in polaris.js 2026-10), and HTML lowercases
// attribute names, so multi-word props are written in camelCase. Kebab-case (grid-template-columns) is silently
// ignored. Boolean flags must be passed as `true` or left out — `false` would render as the attribute "false",
// which still counts as set.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type El<P = object> = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & P;

type Tone = 'info' | 'success' | 'warning' | 'critical' | 'neutral' | 'caution' | 'auto';
type Flag = true | undefined;

interface FieldProps {
  label?: string;
  /** Announced by screen readers; with no `label`, nothing is shown visually. */
  accessibilityLabel?: string;
  name?: string;
  autocomplete?: string;
  value?: string;
  checked?: Flag;
  error?: string | undefined;
  details?: string | undefined;
  placeholder?: string | undefined;
  required?: Flag;
  disabled?: Flag;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      's-page': El<{ heading?: string; inlineSize?: 'small' | 'base' | 'large' }>;
      's-section': El<{ heading?: string; padding?: 'base' | 'none' }>;
      's-box': El<{ padding?: string; background?: string; borderRadius?: string }>;
      's-stack': El<{
        direction?: 'block' | 'inline';
        gap?: string;
        alignItems?: string;
        justifyContent?: string;
      }>;
      's-query-container': El;
      's-grid': El<{ gridTemplateColumns?: string; gap?: string }>;
      's-divider': El;
      's-heading': El;
      's-paragraph': El<{ tone?: Tone; color?: 'base' | 'subdued' }>;
      's-text': El<{ tone?: Tone; color?: 'base' | 'subdued'; type?: 'strong' | 'generic' }>;
      's-link': El<{ href?: string; rel?: string; target?: string; tone?: Tone }>;
      's-spinner': El<{ accessibilityLabel?: string; size?: 'base' | 'large' | 'large-100' }>;
      's-banner': El<{ heading?: string; tone?: Tone; dismissible?: Flag }>;
      's-badge': El<{ tone?: Tone }>;
      's-button': El<{
        variant?: 'primary' | 'secondary' | 'tertiary' | 'auto';
        tone?: Tone;
        disabled?: Flag;
        loading?: Flag;
        href?: string;
        slot?: string;
        accessibilityLabel?: string;
      }>;
      's-text-field': El<FieldProps & { maxLength?: number }>;
      's-text-area': El<FieldProps & { rows?: number; maxLength?: number }>;
      's-date-field': El<FieldProps>;
      's-select': El<FieldProps>;
      's-option': El<{ value?: string }>;
      's-checkbox': El<FieldProps>;
      's-table': El<{ paginate?: Flag; hasNextPage?: Flag; hasPreviousPage?: Flag; loading?: Flag }>;
      's-table-header-row': El;
      's-table-header': El;
      's-table-body': El;
      's-table-row': El;
      's-table-cell': El;
      's-unordered-list': El;
      's-ordered-list': El;
      's-list-item': El;
      's-app-nav': El;
      'ui-save-bar': El<{ id: string }>;
    }
  }
}
