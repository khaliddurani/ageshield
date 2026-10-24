import { z } from 'zod';

// Per-shop settings (D1 `settings`). A shop without a row uses DEFAULT_SETTINGS.

export const COUNTRIES = ['DK', 'SE', 'NO', 'FI'] as const;
export type Country = (typeof COUNTRIES)[number];

export const MIN_AGES = [15, 16, 18, 21] as const;
export type MinAge = (typeof MIN_AGES)[number];

export const GATE_MODES = ['product_page', 'cart'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const minAgeSchema = z.union([z.literal(15), z.literal(16), z.literal(18), z.literal(21)]);
export const countrySchema = z.enum(COUNTRIES);

const popupTextSchema = z.object({
  heading: z.string().trim().max(120),
  body: z.string().trim().max(600),
  button: z.string().trim().max(60),
});

/** Storefront popup texts per locale ("en", "da", "sv", "pt-BR"…); missing locales use the theme's defaults. */
export const popupTextsSchema = z.record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), popupTextSchema);

export const settingsSchema = z.object({
  enabledCountries: z.array(countrySchema).min(1).max(COUNTRIES.length),
  defaultMinAge: minAgeSchema,
  gateMode: z.enum(GATE_MODES),
  popupTexts: popupTextsSchema,
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  enabledCountries: [...COUNTRIES],
  defaultMinAge: 18,
  gateMode: 'product_page',
  popupTexts: {},
  brandColor: null,
};

interface SettingsRow {
  enabled_countries: string;
  default_min_age: number;
  gate_mode: string;
  popup_texts: string;
  brand_color: string | null;
}

/** Stored settings, or the defaults. A stored value that no longer validates falls back to its default. */
export async function getSettings(db: D1Database, shop: string): Promise<Settings> {
  const row = await db
    .prepare(
      'SELECT enabled_countries, default_min_age, gate_mode, popup_texts, brand_color FROM settings WHERE shop = ?1',
    )
    .bind(shop)
    .first<SettingsRow>();
  if (!row) return DEFAULT_SETTINGS;
  const parse = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const result = schema.safeParse(value);
    return result.success ? result.data : fallback;
  };
  const json = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  return {
    enabledCountries: parse(
      settingsSchema.shape.enabledCountries,
      json(row.enabled_countries),
      DEFAULT_SETTINGS.enabledCountries,
    ),
    defaultMinAge: parse(minAgeSchema, row.default_min_age, DEFAULT_SETTINGS.defaultMinAge),
    gateMode: parse(settingsSchema.shape.gateMode, row.gate_mode, DEFAULT_SETTINGS.gateMode),
    popupTexts: parse(popupTextsSchema, json(row.popup_texts), DEFAULT_SETTINGS.popupTexts),
    brandColor: parse(settingsSchema.shape.brandColor, row.brand_color, null),
  };
}

/** Replaces the shop's settings. Returns whether the default minimum age changed (rules may need a re-sync). */
export async function saveSettings(
  db: D1Database,
  shop: string,
  settings: Settings,
  now: number,
): Promise<{ defaultMinAgeChanged: boolean }> {
  const before = await getSettings(db, shop);
  await db
    .prepare(
      `INSERT INTO settings (shop, enabled_countries, default_min_age, gate_mode, popup_texts, brand_color, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(shop) DO UPDATE SET
         enabled_countries = excluded.enabled_countries, default_min_age = excluded.default_min_age,
         gate_mode = excluded.gate_mode, popup_texts = excluded.popup_texts, brand_color = excluded.brand_color,
         updated_at = excluded.updated_at`,
    )
    .bind(
      shop,
      JSON.stringify([...new Set(settings.enabledCountries)]),
      settings.defaultMinAge,
      settings.gateMode,
      JSON.stringify(settings.popupTexts),
      settings.brandColor,
      now,
    )
    .run();
  return { defaultMinAgeChanged: before.defaultMinAge !== settings.defaultMinAge };
}
