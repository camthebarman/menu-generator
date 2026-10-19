import { makeIngredient } from '../domain/factory';
import type { Allergen, Conversion, Dimension, Ingredient, IngredientCategory } from '../domain/types';

interface Opt {
  allergens?: Allergen[] | null;
  veg?: boolean | null;
  vegan?: boolean | null;
  alcoholic?: boolean | null;
  abv?: number;
  perishable?: boolean;
  staple?: boolean;
  conv?: Conversion[];
  yield?: number;
  aliases?: string[];
  style?: string;
  ref?: { amount: number; perQuantity: number; perUnit: Ingredient['dimension'] extends never ? never : 'g' | 'kg' | 'ml' | 'l' | 'each' | 'lb' | 'bottle' };
}

const c = (fromQty: number, fromUnit: Conversion['fromUnit'], toQty: number, toUnit: Conversion['toUnit'], note?: string): Conversion => ({ fromQty, fromUnit, toQty, toUnit, verified: true, note });

function I(id: string, name: string, dimension: Dimension, category: IngredientCategory, o: Opt = {}): Ingredient {
  const vegan = o.vegan ?? (o.veg === false ? false : true);
  return makeIngredient({
    id, name, dimension, category, orgId: 'org_demo',
    allergens: o.allergens === undefined ? [] : o.allergens, allergensVerified: o.allergens !== null,
    diet: { vegetarian: o.veg ?? true, vegan },
    alcoholic: o.alcoholic ?? false, abv: o.abv ?? null, perishable: o.perishable ?? false, pantryStaple: o.staple ?? false,
    conversions: o.conv ?? [], edibleYield: o.yield ?? null, aliases: (o.aliases ?? []).map((text) => ({ text, confirmed: true })),
    spiritStyle: o.style ?? null, referenceCost: o.ref ? { amount: o.ref.amount, perQuantity: o.ref.perQuantity, perUnit: o.ref.perUnit } : null,
  });
}

const meat = { veg: false, vegan: false, perishable: true };
const dairy = { allergens: ['milk'] as Allergen[], vegan: false, perishable: true };

export const SEED_INGREDIENTS: Ingredient[] = [
  // Proteins
  I('chicken_thigh', 'Chicken thigh (boneless)', 'mass', 'protein', { ...meat, ref: { amount: 9.7, perQuantity: 1, perUnit: 'kg' } }),
  I('ground_beef', 'Ground beef 80/20', 'mass', 'protein', { ...meat, ref: { amount: 11, perQuantity: 1, perUnit: 'kg' } }),
  I('salmon', 'Salmon fillet', 'mass', 'protein', { ...meat, allergens: ['fish'], ref: { amount: 26, perQuantity: 1, perUnit: 'kg' } }),
  I('shrimp', 'Shrimp 16/20 (peeled)', 'mass', 'protein', { ...meat, allergens: ['shellfish'], ref: { amount: 22, perQuantity: 1, perUnit: 'kg' } }),
  I('pork_shoulder', 'Pork shoulder', 'mass', 'protein', { ...meat, ref: { amount: 7.5, perQuantity: 1, perUnit: 'kg' } }),
  I('eggs', 'Eggs (large)', 'count', 'protein', { allergens: ['egg'], vegan: false, perishable: true, conv: [c(1, 'each', 50, 'g', 'large egg, shelled')], ref: { amount: 0.35, perQuantity: 1, perUnit: 'each' } }),
  I('tofu', 'Firm tofu', 'mass', 'protein', { allergens: ['soy'], perishable: true, ref: { amount: 5, perQuantity: 1, perUnit: 'kg' } }),
  // Produce
  I('onion', 'Yellow onion', 'mass', 'produce', { conv: [c(1, 'each', 160, 'g', 'medium onion')], yield: 0.9 }),
  I('red_onion', 'Red onion', 'mass', 'produce', { conv: [c(1, 'each', 170, 'g')], yield: 0.9 }),
  I('garlic', 'Garlic', 'mass', 'produce', { conv: [c(1, 'each', 5, 'g', 'one clove')], yield: 0.85 }),
  I('shallot', 'Shallot', 'mass', 'produce', { yield: 0.88 }),
  I('carrot', 'Carrot', 'mass', 'produce', { perishable: true, yield: 0.85 }),
  I('potato', 'Yukon gold potato', 'mass', 'produce', { yield: 0.9 }),
  I('tomato', 'Tomato', 'mass', 'produce', { perishable: true }),
  I('romaine', 'Romaine lettuce', 'mass', 'produce', { perishable: true, yield: 0.8 }),
  I('cucumber', 'Cucumber', 'mass', 'produce', { perishable: true }),
  I('bell_pepper', 'Red bell pepper', 'mass', 'produce', { perishable: true, yield: 0.85 }),
  I('mushroom', 'Cremini mushrooms', 'mass', 'produce', { perishable: true }),
  I('scallion', 'Scallion', 'mass', 'produce', { perishable: true }),
  I('ginger', 'Ginger root', 'mass', 'produce', { yield: 0.85 }),
  I('apple', 'Apple (baking)', 'mass', 'produce', { perishable: true, yield: 0.8 }),
  I('raspberry', 'Raspberries', 'mass', 'produce', { perishable: true }),
  I('jalapeno', 'Jalapeño', 'mass', 'produce', { perishable: true, conv: [c(1, 'each', 15, 'g')] }),
  // Herbs
  I('parsley', 'Flat-leaf parsley', 'mass', 'herb', { perishable: true, conv: [c(1, 'bunch', 60, 'g')] }),
  I('cilantro', 'Cilantro', 'mass', 'herb', { perishable: true, conv: [c(1, 'bunch', 50, 'g')] }),
  I('basil', 'Basil', 'mass', 'herb', { perishable: true }),
  I('mint', 'Mint', 'mass', 'herb', { perishable: true, conv: [c(1, 'bunch', 30, 'g'), c(1, 'sprig', 1, 'g', 'one tip sprig')] }),
  I('rosemary', 'Rosemary', 'mass', 'herb', { perishable: true, conv: [c(1, 'sprig', 2, 'g')] }),
  I('thyme', 'Thyme', 'mass', 'herb', { perishable: true }),
  // Citrus (whole fruit, counted) and juices (separate ingredients; never silently equated)
  I('lemon', 'Lemon', 'count', 'citrus', { perishable: true, conv: [c(1, 'each', 110, 'g'), c(1, 'each', 8, 'wedge')], ref: { amount: 0.45, perQuantity: 1, perUnit: 'each' } }),
  I('lime', 'Lime', 'count', 'citrus', { perishable: true, conv: [c(1, 'each', 67, 'g'), c(1, 'each', 8, 'wedge')], ref: { amount: 0.3, perQuantity: 1, perUnit: 'each' } }),
  I('orange', 'Orange', 'count', 'citrus', { perishable: true, conv: [c(1, 'each', 180, 'g')] }),
  I('grapefruit', 'Grapefruit', 'count', 'citrus', { perishable: true, conv: [c(1, 'each', 300, 'g')] }),
  I('lemon_juice', 'Lemon juice (fresh)', 'volume', 'juice', { perishable: true, aliases: ['fresh lemon juice'] }),
  I('lime_juice', 'Lime juice (fresh)', 'volume', 'juice', { perishable: true, aliases: ['fresh lime juice'] }),
  I('grapefruit_juice', 'Grapefruit juice (fresh)', 'volume', 'juice', { perishable: true }),
  I('orange_wheel', 'Dehydrated orange wheel', 'count', 'prepared', {}),
  // Dairy
  I('butter', 'Unsalted butter', 'mass', 'dairy', { ...dairy, ref: { amount: 9, perQuantity: 1, perUnit: 'kg' } }),
  I('heavy_cream', 'Heavy cream 36%', 'volume', 'dairy', { ...dairy, aliases: ['heavy whipping cream'], ref: { amount: 5.2, perQuantity: 1, perUnit: 'l' } }),
  I('whole_milk', 'Whole milk', 'volume', 'dairy', { ...dairy }),
  I('parmesan', 'Parmesan (aged)', 'mass', 'dairy', { ...dairy, veg: null, vegan: false, perishable: false }),
  I('feta', 'Feta', 'mass', 'dairy', { ...dairy }),
  I('cheddar', 'Cheddar (sliced)', 'mass', 'dairy', { ...dairy, conv: [c(1, 'each', 21, 'g', 'one slice')] }),
  // Pantry
  I('olive_oil', 'Extra-virgin olive oil', 'volume', 'pantry', { ref: { amount: 14, perQuantity: 1, perUnit: 'l' } }),
  I('neutral_oil', 'Neutral oil (canola)', 'volume', 'pantry', {}),
  I('salt', 'Kosher salt', 'mass', 'pantry', { staple: true }),
  I('black_pepper', 'Black pepper', 'mass', 'pantry', { staple: true }),
  I('water', 'Water', 'volume', 'pantry', { staple: true }),
  I('ice', 'Ice', 'mass', 'pantry', { staple: true }),
  I('sugar', 'Granulated sugar', 'mass', 'pantry', { ref: { amount: 1.8, perQuantity: 1, perUnit: 'kg' } }),
  I('brown_sugar', 'Brown sugar', 'mass', 'pantry', {}),
  I('flour', 'All-purpose flour', 'mass', 'pantry', { allergens: ['wheat'] }),
  I('oats', 'Rolled oats', 'mass', 'grain', { allergens: null }),
  I('rice', 'Jasmine rice', 'mass', 'grain', { aliases: ['thai jasmine rice'], ref: { amount: 3.2, perQuantity: 1, perUnit: 'kg' } }),
  I('pasta', 'Spaghetti (dried)', 'mass', 'grain', { allergens: ['wheat'] }),
  I('soy_sauce', 'Soy sauce', 'volume', 'pantry', { allergens: ['soy', 'wheat'] }),
  I('honey', 'Honey', 'mass', 'pantry', { vegan: false }),
  I('dijon', 'Dijon mustard', 'mass', 'pantry', { allergens: ['mustard'] }),
  I('red_wine_vinegar', 'Red wine vinegar', 'volume', 'pantry', { allergens: ['sulfites'] }),
  I('cider_vinegar', 'Apple cider vinegar', 'volume', 'pantry', {}),
  I('canned_tomato', 'Whole peeled tomatoes (canned)', 'mass', 'pantry', {}),
  I('chickpeas', 'Chickpeas (canned, drained)', 'mass', 'pantry', {}),
  I('coconut_milk', 'Coconut milk', 'volume', 'pantry', { allergens: [] }),
  I('dark_chocolate', 'Dark chocolate 70%', 'mass', 'pantry', { allergens: ['soy', 'milk'], vegan: false }),
  I('vanilla', 'Vanilla extract', 'volume', 'pantry', { alcoholic: true, abv: 35 }),
  I('gelatin', 'Gelatin (powdered)', 'mass', 'pantry', { veg: false, vegan: false }),
  I('burger_bun', 'Brioche burger bun', 'count', 'grain', { allergens: ['wheat', 'egg', 'milk'], vegan: false, perishable: true }),
  I('tortilla', 'Corn tortilla', 'count', 'grain', { perishable: true }),
  I('pine_nut', 'Pine nuts', 'mass', 'pantry', { allergens: ['tree_nut'] }),
  I('chili_flake', 'Chili flakes', 'mass', 'pantry', {}),
  I('cumin', 'Ground cumin', 'mass', 'pantry', {}),
  I('paprika', 'Smoked paprika', 'mass', 'pantry', {}),
  I('sesame_oil', 'Toasted sesame oil', 'volume', 'pantry', { allergens: ['sesame'] }),
  I('mystery_hot_sauce', 'House hot sauce (supplier sample)', 'volume', 'pantry', { allergens: null, veg: null, vegan: null }),
  // Spirits & wine
  I('gin', 'London dry gin', 'volume', 'spirit', { alcoholic: true, abv: 43, style: 'London dry', ref: { amount: 22, perQuantity: 750, perUnit: 'ml' } }),
  I('white_rum', 'White rum (column still)', 'volume', 'spirit', { alcoholic: true, abv: 40, style: 'Light/white', aliases: ['light rum'] }),
  I('aged_rum', 'Aged rum (5 yr)', 'volume', 'spirit', { alcoholic: true, abv: 40, style: 'Aged' }),
  I('tequila', 'Tequila blanco (100% agave)', 'volume', 'spirit', { alcoholic: true, abv: 40, style: 'Blanco', ref: { amount: 28, perQuantity: 750, perUnit: 'ml' } }),
  I('mezcal', 'Mezcal espadín', 'volume', 'spirit', { alcoholic: true, abv: 42, style: 'Joven' }),
  I('bourbon', 'Bourbon', 'volume', 'spirit', { alcoholic: true, abv: 45, style: 'Straight bourbon' }),
  I('rye', 'Rye whiskey', 'volume', 'spirit', { alcoholic: true, abv: 45, style: 'Straight rye' }),
  I('vodka', 'Vodka', 'volume', 'spirit', { alcoholic: true, abv: 40 }),
  I('sweet_vermouth', 'Sweet vermouth', 'volume', 'wine', { alcoholic: true, abv: 16, allergens: ['sulfites'], perishable: true }),
  I('orange_liqueur', 'Orange liqueur (triple sec)', 'volume', 'liqueur', { alcoholic: true, abv: 40, ref: { amount: 24, perQuantity: 750, perUnit: 'ml' } }),
  I('bitter_aperitivo', 'Bitter red aperitivo', 'volume', 'liqueur', { alcoholic: true, abv: 25, ref: { amount: 27, perQuantity: 750, perUnit: 'ml' } }),
  I('orange_aperitivo', 'Low-ABV orange aperitivo', 'volume', 'liqueur', { alcoholic: true, abv: 11 }),
  I('coffee_liqueur', 'Coffee liqueur', 'volume', 'liqueur', { alcoholic: true, abv: 20, ref: { amount: 21, perQuantity: 750, perUnit: 'ml' } }),
  I('prosecco', 'Prosecco', 'volume', 'wine', { alcoholic: true, abv: 11, allergens: ['sulfites'] }),
  I('aromatic_bitters', 'Aromatic bitters', 'volume', 'bitters', { alcoholic: true, abv: 44.7, conv: [c(1, 'dash', 0.8, 'ml', 'house dasher calibration')] }),
  I('orange_bitters', 'Orange bitters', 'volume', 'bitters', { alcoholic: true, abv: 28, conv: [c(1, 'dash', 0.8, 'ml', 'house dasher calibration')] }),
  // Mixers
  I('soda_water', 'Soda water', 'volume', 'mixer', {}),
  I('tonic', 'Tonic water', 'volume', 'mixer', {}),
  I('ginger_beer', 'Ginger beer', 'volume', 'mixer', {}),
  I('espresso', 'Espresso (fresh)', 'volume', 'mixer', { perishable: true, ref: { amount: 0.4, perQuantity: 30, perUnit: 'ml' } }),
  // House-prepared components (produced by recipes)
  I('simple_syrup', 'Simple syrup 1:1', 'volume', 'syrup', { perishable: true }),
  I('honey_syrup', 'Honey syrup', 'volume', 'syrup', { perishable: true, vegan: false }),
  I('ginger_syrup', 'Ginger syrup', 'volume', 'syrup', { perishable: true }),
  I('lime_cordial', 'Lime cordial', 'volume', 'syrup', { perishable: true }),
  I('raspberry_shrub', 'Raspberry shrub', 'volume', 'syrup', { perishable: true }),
  I('aioli', 'Garlic aioli', 'mass', 'prepared', { allergens: ['egg'], vegan: false, perishable: true }),
  I('vinaigrette', 'House vinaigrette', 'volume', 'prepared', { allergens: ['mustard', 'sulfites'], perishable: true }),
  I('pickled_onion', 'Quick-pickled red onion', 'mass', 'prepared', { perishable: true }),
  I('salsa_verde', 'Salsa verde', 'volume', 'prepared', { allergens: ['sulfites'], perishable: true }),
  I('tomato_sauce', 'Simple tomato sauce', 'volume', 'prepared', { perishable: true }),
  I('whipped_cream', 'Whipped cream', 'volume', 'prepared', { ...dairy }),
  I('caramel', 'Salted caramel sauce', 'volume', 'prepared', { ...dairy }),
];
