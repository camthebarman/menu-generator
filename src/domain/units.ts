import type { Dimension, Ingredient, UnitCode } from './types';

// Rounding boundary: all converted quantities are rounded to 1e-6 of a base unit
// (micro-grams/millilitres/each). Display rounding happens only in format helpers.
export const SCALE = 1_000_000;
export const toMicro = (n: number): number => Math.round(n * SCALE);
export const fromMicro = (m: number): number => m / SCALE;
export const roundBase = (n: number): number => Math.round(n * SCALE) / SCALE;

interface UnitDef {
  dimension: Dimension | 'package' | 'yield';
  /** factor to the dimension base unit (g, ml, each); undefined for package/yield units */
  toBase?: number;
  label: string;
}

export const UNITS: Record<UnitCode, UnitDef> = {
  g: { dimension: 'mass', toBase: 1, label: 'g' },
  kg: { dimension: 'mass', toBase: 1000, label: 'kg' },
  oz: { dimension: 'mass', toBase: 28.349523125, label: 'oz (wt)' },
  lb: { dimension: 'mass', toBase: 453.59237, label: 'lb' },
  ml: { dimension: 'volume', toBase: 1, label: 'ml' },
  l: { dimension: 'volume', toBase: 1000, label: 'L' },
  fl_oz: { dimension: 'volume', toBase: 29.5735295625, label: 'US fl oz' },
  cup: { dimension: 'volume', toBase: 236.5882365, label: 'cup' },
  tbsp: { dimension: 'volume', toBase: 14.78676478125, label: 'tbsp' },
  tsp: { dimension: 'volume', toBase: 4.92892159375, label: 'tsp' },
  each: { dimension: 'count', toBase: 1, label: 'each' },
  dozen: { dimension: 'count', toBase: 12, label: 'dozen' },
  // Package and bar-measure units have no universal size: they need an ingredient
  // conversion or a lot package size.
  bottle: { dimension: 'package', label: 'bottle' },
  case: { dimension: 'package', label: 'case' },
  pack: { dimension: 'package', label: 'pack' },
  bunch: { dimension: 'package', label: 'bunch' },
  can: { dimension: 'package', label: 'can' },
  dash: { dimension: 'package', label: 'dash' },
  barspoon: { dimension: 'package', label: 'barspoon' },
  sprig: { dimension: 'package', label: 'sprig' },
  wedge: { dimension: 'package', label: 'wedge' },
  serving: { dimension: 'yield', label: 'serving' },
};

export const UNIT_CODES = Object.keys(UNITS) as UnitCode[];

export const BASE_UNIT: Record<Dimension, UnitCode> = { mass: 'g', volume: 'ml', count: 'each' };

export function isUnitCode(u: string): u is UnitCode {
  return Object.prototype.hasOwnProperty.call(UNITS, u);
}

export function normalizeUnitText(raw: string): UnitCode | null {
  const t = raw.trim().toLowerCase().replace(/\.$/, '');
  const map: Record<string, UnitCode> = {
    g: 'g', gram: 'g', grams: 'g', kg: 'kg', kilogram: 'kg', kilograms: 'kg',
    oz: 'oz', ounce: 'oz', ounces: 'oz', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    ml: 'ml', millilitre: 'ml', milliliter: 'ml', l: 'l', litre: 'l', liter: 'l', liters: 'l', litres: 'l',
    'fl oz': 'fl_oz', fl_oz: 'fl_oz', floz: 'fl_oz', 'fluid ounce': 'fl_oz', 'fluid ounces': 'fl_oz',
    cup: 'cup', cups: 'cup', tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
    each: 'each', ea: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each', unit: 'each', units: 'each', dozen: 'dozen', dz: 'dozen',
    bottle: 'bottle', bottles: 'bottle', btl: 'bottle', case: 'case', cases: 'case', pack: 'pack', packs: 'pack', bunch: 'bunch', bunches: 'bunch',
    can: 'can', cans: 'can', dash: 'dash', dashes: 'dash', barspoon: 'barspoon', barspoons: 'barspoon', sprig: 'sprig', sprigs: 'sprig',
    wedge: 'wedge', wedges: 'wedge', serving: 'serving', servings: 'serving', portion: 'serving', portions: 'serving',
  };
  return map[t] ?? null;
}

export function unitDimension(u: UnitCode): UnitDef['dimension'] {
  return UNITS[u].dimension;
}

export type ConversionResult =
  | { ok: true; value: number; note?: string }
  | { ok: false; reason: string };

/**
 * Convert a quantity to the ingredient's base unit.
 * Same-dimension conversions use standard factors. Cross-dimension, package, and bar-measure
 * conversions require an ingredient-specific recorded conversion (or a lot package size).
 */
export function toIngredientBase(
  qty: number,
  unit: UnitCode,
  ingredient: Pick<Ingredient, 'dimension' | 'conversions' | 'name'>,
  packageSize?: { quantity: number; unit: UnitCode } | null,
): ConversionResult {
  const target = ingredient.dimension;
  const def = UNITS[unit];
  if (def.dimension === target) return { ok: true, value: roundBase(qty * (def.toBase as number)) };

  if (def.dimension === 'package' && packageSize) {
    const inner = toIngredientBase(packageSize.quantity, packageSize.unit, ingredient, null);
    if (inner.ok) return { ok: true, value: roundBase(qty * inner.value), note: `package size ${packageSize.quantity} ${packageSize.unit}` };
  }

  for (const c of ingredient.conversions) {
    // forward: unit ~ c.fromUnit, c.toUnit in target dimension
    const fwd = viaConversion(qty, unit, c.fromQty, c.fromUnit, c.toQty, c.toUnit, target);
    if (fwd !== null) return { ok: true, value: roundBase(fwd), note: conversionNote(c) };
    const rev = viaConversion(qty, unit, c.toQty, c.toUnit, c.fromQty, c.fromUnit, target);
    if (rev !== null) return { ok: true, value: roundBase(rev), note: conversionNote(c) };
  }
  if (def.dimension === 'yield') return { ok: false, reason: `"${unit}" is a yield unit and cannot measure ${ingredient.name} stock` };
  return {
    ok: false,
    reason: `No recorded conversion from ${UNITS[unit].label} to ${BASE_UNIT[target]} for ${ingredient.name}`,
  };
}

function conversionNote(c: { fromQty: number; fromUnit: UnitCode; toQty: number; toUnit: UnitCode; verified: boolean }): string {
  return `${c.fromQty} ${UNITS[c.fromUnit].label} = ${c.toQty} ${UNITS[c.toUnit].label}${c.verified ? '' : ' (unverified)'}`;
}

function sameScale(unit: UnitCode, ref: UnitCode): number | null {
  if (unit === ref) return 1;
  const a = UNITS[unit];
  const b = UNITS[ref];
  if (a.dimension === b.dimension && a.toBase !== undefined && b.toBase !== undefined) return a.toBase / b.toBase;
  return null;
}

function viaConversion(
  qty: number, unit: UnitCode, aQty: number, aUnit: UnitCode, bQty: number, bUnit: UnitCode, target: Dimension,
): number | null {
  const s = sameScale(unit, aUnit);
  if (s === null) return null;
  const bDef = UNITS[bUnit];
  if (bDef.dimension !== target || bDef.toBase === undefined) return null;
  return ((qty * s) / aQty) * bQty * bDef.toBase;
}

/** Convert a base quantity back into a display unit when possible. */
export function fromIngredientBase(
  base: number,
  unit: UnitCode,
  ingredient: Pick<Ingredient, 'dimension' | 'conversions' | 'name'>,
  packageSize?: { quantity: number; unit: UnitCode } | null,
): number | null {
  const one = toIngredientBase(1, unit, ingredient, packageSize);
  if (!one.ok || one.value === 0) return null;
  return base / one.value;
}

export function convertCostToBase(
  cost: { amount: number; perQuantity: number; perUnit: UnitCode },
  ingredient: Pick<Ingredient, 'dimension' | 'conversions' | 'name'>,
  packageSize?: { quantity: number; unit: UnitCode } | null,
): number | null {
  const base = toIngredientBase(cost.perQuantity, cost.perUnit, ingredient, packageSize);
  if (!base.ok || base.value <= 0) return null;
  return cost.amount / base.value;
}

export function formatQty(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return r.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Format a base quantity, choosing a friendlier larger unit when it reads better. */
export function formatBase(base: number, dimension: Dimension): string {
  if (dimension === 'mass') return Math.abs(base) >= 1000 ? `${formatQty(base / 1000, 3)} kg` : `${formatQty(base, 1)} g`;
  if (dimension === 'volume') return Math.abs(base) >= 1000 ? `${formatQty(base / 1000, 3)} L` : `${formatQty(base, 1)} ml`;
  return `${formatQty(base, 2)} each`;
}

/** Shortfalls are displayed rounded UP so purchasing never comes in under need. */
export function formatShortfall(base: number, dimension: Dimension): string {
  const up = (v: number, d: number) => Math.ceil(v * 10 ** d - 1e-9) / 10 ** d;
  if (dimension === 'mass') return base >= 1000 ? `${up(base / 1000, 3)} kg` : `${up(base, 1)} g`;
  if (dimension === 'volume') return base >= 1000 ? `${up(base / 1000, 3)} L` : `${up(base, 1)} ml`;
  return `${up(base, 2)} each`;
}

export function formatMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
}
