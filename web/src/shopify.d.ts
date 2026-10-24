// Minimal typing for the App Bridge global (loaded from the Shopify CDN in index.html).

interface ResourcePickerVariant {
  id: string;
  title?: string;
}

/** A selected product or collection (`variants` only for products). */
interface ResourcePickerResource {
  id: string;
  title: string;
  variants?: ResourcePickerVariant[];
}

interface ResourcePickerOptions {
  type: 'product' | 'variant' | 'collection';
  multiple?: boolean | number;
  action?: 'add' | 'select';
  filter?: { variants?: boolean; draft?: boolean; archived?: boolean; hidden?: boolean; query?: string };
  selectionIds?: { id: string; variants?: { id: string }[] }[];
}

declare global {
  const shopify: {
    idToken(): Promise<string>;
    /** Resolves to the selection, or undefined when the merchant cancels. */
    resourcePicker(options: ResourcePickerOptions): Promise<ResourcePickerResource[] | undefined>;
    saveBar: {
      show(id: string): Promise<void>;
      hide(id: string): Promise<void>;
      leaveConfirmation(): Promise<void>;
    };
    toast: {
      show(message: string, options?: { isError?: boolean; duration?: number }): void;
    };
  };
}

export type { ResourcePickerResource };
