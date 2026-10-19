// Table Zero starter library — original recipes written for this project. Classic drink ratios are
// common culinary knowledge; methods and wording are original. Free to use and adapt.

import { makeRecipe } from '../domain/factory';
import type { Form, Recipe, RecipeCategory, RecipeLine, UnitCode, Workspace } from '../domain/types';

type L = [ingredientId: string, quantity: number | null, unit: UnitCode, extra?: Partial<RecipeLine>];

interface Meta {
  servings?: number;
  yield?: [number, UnitCode];
  active?: number;
  total?: number;
  equip?: string[];
  tags?: string[];
  cuisine?: string;
  produces?: [string, Form];
  desc?: string;
  holdDays?: number;
}

const P: Partial<RecipeLine> = { form: 'prepared' };
const OPT: Partial<RecipeLine> = { optional: true };
const EP: Partial<RecipeLine> = { basis: 'edible' };
const SOURCE = 'Table Zero starter library (original)';

function R(id: string, name: string, workspaces: Workspace[], category: RecipeCategory, meta: Meta, ls: L[], method: string[]): Recipe {
  const servings = meta.servings ?? 1;
  return makeRecipe({
    id, name, workspaces, category, tags: meta.tags ?? [], cuisine: meta.cuisine ?? null, description: meta.desc ?? null,
    provenance: { kind: 'starter', source: SOURCE, license: 'Original content; free to use and adapt' },
    produces: meta.produces ? { ingredientId: meta.produces[0], form: meta.produces[1] } : null,
    version: {
      servings, yield: meta.yield ? { quantity: meta.yield[0], unit: meta.yield[1] } : { quantity: servings, unit: 'serving' },
      activeMinutes: meta.active ?? null, totalMinutes: meta.total ?? null, equipment: meta.equip ?? [], method, allergenStatus: 'unverified', confirmed: true,
      outputHoldDays: meta.holdDays ?? null, outputHoldVerified: false,
      lines: ls.map(([ingredientId, quantity, unit, extra], i) => ({ id: `${id}_l${i + 1}`, ingredientId, form: 'raw', quantity, unit, optional: false, basis: 'as_purchased', ...extra })),
    },
  });
}

const oz = 'fl_oz';

export const FOOD_RECIPES: Recipe[] = [
  // ---- Proteins / mains
  R('st_crispy_thighs', 'Crispy chicken thighs', ['food'], 'main', { servings: 4, active: 15, total: 35, equip: ['cast iron', 'oven'], tags: ['chicken', 'gluten-free'], cuisine: 'American' },
    [['chicken_thigh', 720, 'g'], ['neutral_oil', 20, 'ml'], ['salt', 8, 'g'], ['black_pepper', 2, 'g'], ['salsa_verde', 120, 'ml', P]],
    ['Pat thighs dry and season both sides.', 'Start skin-side down in a cold oiled pan; render over medium heat 12–14 min until crisp.', 'Flip and finish in a 200 °C oven to 74 °C internal.', 'Rest 3 min; serve with salsa verde.']),
  R('st_smash_burger', 'Smash burger', ['food'], 'main', { servings: 1, active: 8, total: 10, equip: ['flat-top'], tags: ['beef', 'menu'], cuisine: 'American' },
    [['ground_beef', 150, 'g'], ['burger_bun', 1, 'each'], ['cheddar', 1, 'each'], ['pickled_onion', 20, 'g', P], ['aioli', 20, 'g', P], ['salt', 2, 'g']],
    ['Portion beef into two 75 g balls.', 'Smash hard on a very hot griddle; season; cook until edges crisp, ~2 min.', 'Flip, add cheese, stack.', 'Toast bun; dress with aioli and pickled onion.']),
  R('st_salmon_lemon', 'Pan-seared salmon, lemon butter', ['food'], 'main', { servings: 2, active: 12, total: 15, equip: ['sauté pan'], tags: ['fish', 'gluten-free'] },
    [['salmon', 360, 'g'], ['butter', 30, 'g'], ['lemon_juice', 20, 'ml', P], ['parsley', 5, 'g'], ['neutral_oil', 10, 'ml'], ['salt', 3, 'g']],
    ['Season salmon; sear skin-side down until 3/4 cooked.', 'Flip briefly; remove.', 'Brown butter in the pan, add lemon juice and parsley; spoon over.']),
  R('st_garlic_shrimp', 'Garlic shrimp', ['food'], 'main', { servings: 2, active: 10, total: 12, equip: ['sauté pan'], tags: ['shellfish'] , cuisine: 'Spanish' },
    [['shrimp', 300, 'g'], ['garlic', 15, 'g'], ['olive_oil', 40, 'ml'], ['chili_flake', 1, 'g'], ['parsley', 5, 'g'], ['lemon_juice', 10, 'ml', P], ['salt', 3, 'g']],
    ['Gently warm sliced garlic and chili in oil.', 'Add shrimp; cook 1–2 min per side until just opaque.', 'Finish with lemon juice and parsley.']),
  R('st_pork_tacos', 'Braised pork tacos', ['food'], 'main', { servings: 6, active: 25, total: 200, equip: ['dutch oven', 'oven'], tags: ['pork'], cuisine: 'Mexican' },
    [['pork_shoulder', 900, 'g'], ['onion', 150, 'g'], ['garlic', 15, 'g'], ['cumin', 4, 'g'], ['tortilla', 18, 'each'], ['cilantro', 15, 'g'], ['lime_juice', 30, 'ml', P], ['pickled_onion', 60, 'g', { ...P, optional: true }], ['salt', 12, 'g']],
    ['Season pork; brown in batches.', 'Add onion, garlic, cumin and water to half-cover; braise covered at 160 °C ~3 h.', 'Shred; season with lime.', 'Serve in warm tortillas with cilantro and pickled onion.']),
  R('st_fried_rice', 'Chicken fried rice', ['food'], 'main', { servings: 2, active: 12, total: 15, equip: ['wok'], tags: ['chicken', 'uses cooked rice'], cuisine: 'Chinese-American' },
    [['rice', 400, 'g', { form: 'cooked' }], ['chicken_thigh', 200, 'g'], ['eggs', 2, 'each'], ['scallion', 20, 'g'], ['soy_sauce', 25, 'ml'], ['neutral_oil', 20, 'ml'], ['sesame_oil', 5, 'ml', OPT]],
    ['Stir-fry diced chicken until cooked; remove.', 'Scramble eggs; add cold cooked rice and toss until hot.', 'Return chicken; season with soy; finish with scallion.']),
  R('st_tofu_stirfry', 'Tofu & vegetable stir-fry', ['food'], 'main', { servings: 2, active: 15, total: 20, equip: ['wok'], tags: ['vegan'], cuisine: 'Pan-Asian' },
    [['tofu', 300, 'g'], ['bell_pepper', 150, 'g'], ['mushroom', 150, 'g'], ['ginger', 10, 'g'], ['garlic', 10, 'g'], ['soy_sauce', 30, 'ml'], ['neutral_oil', 25, 'ml'], ['rice', 300, 'g', { form: 'cooked' }]],
    ['Press and cube tofu; sear until golden.', 'Stir-fry peppers and mushrooms over high heat.', 'Add ginger, garlic, soy; toss with tofu.', 'Serve over rice.']),
  R('st_shakshuka', 'Shakshuka', ['food'], 'main', { servings: 2, active: 10, total: 30, equip: ['skillet'], tags: ['vegetarian', 'brunch'], cuisine: 'North African' },
    [['eggs', 4, 'each'], ['canned_tomato', 400, 'g'], ['onion', 100, 'g'], ['bell_pepper', 100, 'g'], ['cumin', 2, 'g'], ['paprika', 2, 'g'], ['olive_oil', 20, 'ml'], ['feta', 40, 'g', OPT], ['salt', 3, 'g']],
    ['Soften onion and pepper in oil; add spices.', 'Add tomatoes; simmer 10 min to thicken.', 'Make wells; crack in eggs; cover until whites set.', 'Finish with feta if using.']),
  // ---- Sides / vegetables / starches
  R('st_steamed_rice', 'Steamed jasmine rice', ['food'], 'side', { servings: 6, yield: [900, 'g'], active: 5, total: 25, equip: ['rice cooker'], tags: ['component', 'vegan'], produces: ['rice', 'cooked'], desc: 'Produces cooked rice for service and fried rice.' },
    [['rice', 300, 'g'], ['water', 450, 'ml']],
    ['Rinse rice until water runs clear.', 'Cook with water; rest 10 min covered.', 'Cool rapidly if holding; label with prep date.']),
  R('st_roast_potatoes', 'Rosemary roasted potatoes', ['food'], 'side', { servings: 4, active: 10, total: 45, equip: ['oven', 'sheet pan'], tags: ['vegan', 'gluten-free'] },
    [['potato', 600, 'g', EP], ['olive_oil', 30, 'ml'], ['rosemary', 4, 'g'], ['garlic', 10, 'g'], ['salt', 6, 'g']],
    ['Cut potatoes into 3 cm pieces (600 g trimmed).', 'Toss with oil, salt, rosemary, garlic.', 'Roast at 220 °C, turning once, ~35 min.']),
  R('st_glazed_carrots', 'Honey-glazed carrots', ['food'], 'side', { servings: 4, active: 10, total: 25, equip: ['sauté pan'], tags: ['vegetarian', 'gluten-free'] },
    [['carrot', 500, 'g', EP], ['butter', 30, 'g'], ['honey', 25, 'g'], ['thyme', 2, 'g'], ['salt', 3, 'g']],
    ['Peel and cut carrots on the bias (500 g trimmed).', 'Simmer with a splash of water, butter, honey until tender and glazed.', 'Finish with thyme.']),
  R('st_garden_salad', 'Garden salad', ['food'], 'side', { servings: 4, active: 10, total: 10, tags: ['vegan', 'menu'] },
    [['romaine', 300, 'g'], ['cucumber', 150, 'g'], ['tomato', 150, 'g'], ['vinaigrette', 60, 'ml', P], ['salt', 1, 'g']],
    ['Wash and dry lettuce; tear.', 'Slice cucumber and tomato.', 'Dress just before serving.']),
  R('st_chickpea_salad', 'Chickpea & herb salad', ['food'], 'side', { servings: 4, active: 10, total: 10, tags: ['vegetarian'], cuisine: 'Mediterranean' },
    [['chickpeas', 480, 'g'], ['cucumber', 150, 'g'], ['red_onion', 50, 'g'], ['parsley', 15, 'g'], ['lemon_juice', 30, 'ml', { ...P, substitutes: [{ ingredientId: 'lime_juice', form: 'prepared', quantity: 30, unit: 'ml', note: 'Lime for lemon: sharper, slightly more bitter' }] }], ['olive_oil', 40, 'ml'], ['feta', 60, 'g', OPT], ['salt', 4, 'g']],
    ['Combine drained chickpeas with diced cucumber and onion.', 'Dress with lemon and oil; fold in herbs.', 'Top with feta if using.']),
  R('st_sauteed_mushrooms', 'Mushrooms with thyme & parmesan', ['food'], 'side', { servings: 4, active: 12, total: 15, equip: ['sauté pan'], tags: ['cheese'] },
    [['mushroom', 450, 'g'], ['butter', 30, 'g'], ['thyme', 2, 'g'], ['garlic', 10, 'g'], ['parmesan', 30, 'g'], ['salt', 3, 'g']],
    ['Sear mushrooms in a hot dry pan until browned.', 'Add butter, garlic, thyme; toss.', 'Finish with grated parmesan.']),
  // ---- Sauces / dressings / condiments (components)
  R('st_aioli', 'Garlic aioli', ['food'], 'sauce', { servings: 20, yield: [400, 'g'], active: 10, total: 10, equip: ['immersion blender'], tags: ['component'], produces: ['aioli', 'prepared'], holdDays: 3 },
    [['eggs', 2, 'each'], ['garlic', 10, 'g'], ['lemon_juice', 20, 'ml', P], ['neutral_oil', 330, 'ml'], ['salt', 4, 'g']],
    ['Blend yolks, garlic, lemon and salt.', 'Stream in oil to emulsify.', 'Label with prep date; hold per your verified policy.']),
  R('st_vinaigrette', 'House vinaigrette', ['food'], 'sauce', { servings: 16, yield: [480, 'ml'], active: 5, total: 5, tags: ['component', 'vegan'], produces: ['vinaigrette', 'prepared'] },
    [['olive_oil', 330, 'ml'], ['red_wine_vinegar', 110, 'ml'], ['dijon', 30, 'g'], ['shallot', 20, 'g'], ['salt', 5, 'g']],
    ['Whisk vinegar, mustard, minced shallot and salt.', 'Whisk in oil.']),
  R('st_pickled_onion', 'Quick-pickled red onions', ['food'], 'sauce', { servings: 15, yield: [300, 'g'], active: 10, total: 70, tags: ['component', 'vegan'], produces: ['pickled_onion', 'prepared'] },
    [['red_onion', 300, 'g'], ['cider_vinegar', 200, 'ml'], ['sugar', 30, 'g'], ['salt', 8, 'g'], ['water', 100, 'ml']],
    ['Slice onions thinly.', 'Bring vinegar, water, sugar and salt to a simmer; pour over onions.', 'Cool 1 h before use.']),
  R('st_salsa_verde', 'Salsa verde', ['food'], 'sauce', { servings: 10, yield: [300, 'ml'], active: 10, total: 10, tags: ['component', 'vegan'], produces: ['salsa_verde', 'prepared'] },
    [['parsley', 60, 'g'], ['garlic', 10, 'g'], ['red_wine_vinegar', 40, 'ml'], ['olive_oil', 180, 'ml'], ['chili_flake', 2, 'g'], ['salt', 3, 'g']],
    ['Finely chop parsley and garlic.', 'Stir in vinegar, chili, salt, then oil.']),
  R('st_tomato_sauce', 'Simple tomato sauce', ['food'], 'sauce', { servings: 8, yield: [750, 'ml'], active: 10, total: 40, equip: ['saucepan'], tags: ['component', 'vegan'], produces: ['tomato_sauce', 'prepared'] },
    [['canned_tomato', 800, 'g'], ['garlic', 15, 'g'], ['olive_oil', 40, 'ml'], ['basil', 8, 'g', OPT], ['salt', 6, 'g']],
    ['Gently cook garlic in oil.', 'Add crushed tomatoes; simmer 30 min.', 'Season; tear in basil.']),
  // ---- Desserts
  R('st_pots_de_creme', 'Chocolate pots de crème', ['food'], 'dessert', { servings: 4, active: 20, total: 240, equip: ['oven', 'ramekins'], tags: ['vegetarian'], cuisine: 'French' },
    [['heavy_cream', 360, 'ml'], ['whole_milk', 120, 'ml'], ['eggs', 4, 'each'], ['dark_chocolate', 120, 'g'], ['sugar', 50, 'g'], ['vanilla', 5, 'ml']],
    ['Heat cream and milk; pour over chocolate.', 'Whisk into yolks and sugar; add vanilla.', 'Bake in a water bath at 150 °C until just set.', 'Chill at least 3 h.']),
  R('st_panna_cotta', 'Vanilla panna cotta', ['food'], 'dessert', { servings: 6, active: 15, total: 260, equip: ['moulds'], tags: [] , cuisine: 'Italian' },
    [['heavy_cream', 500, 'ml'], ['whole_milk', 250, 'ml'], ['sugar', 80, 'g'], ['gelatin', 8, 'g'], ['vanilla', 5, 'ml']],
    ['Bloom gelatin in cold milk.', 'Warm cream with sugar; dissolve gelatin; add vanilla.', 'Pour into moulds; chill 4 h.']),
  R('st_apple_crumble', 'Apple oat crumble', ['food'], 'dessert', { servings: 6, active: 20, total: 60, equip: ['oven'], tags: ['vegetarian'] },
    [['apple', 800, 'g', EP], ['brown_sugar', 100, 'g'], ['flour', 100, 'g'], ['oats', 80, 'g'], ['butter', 100, 'g'], ['whipped_cream', 180, 'ml', { ...P, optional: true }]],
    ['Slice apples (800 g trimmed); toss with half the sugar.', 'Rub butter into flour, oats and remaining sugar.', 'Top fruit; bake at 180 °C ~40 min.']),
  R('st_whipped_cream', 'Whipped cream', ['food'], 'dessert', { servings: 10, yield: [600, 'ml'], active: 5, total: 5, equip: ['whisk'], tags: ['component'], produces: ['whipped_cream', 'prepared'] },
    [['heavy_cream', 300, 'ml'], ['sugar', 25, 'g'], ['vanilla', 3, 'ml']],
    ['Whip cold cream with sugar and vanilla to soft peaks.']),
  R('st_caramel', 'Salted caramel sauce', ['food'], 'dessert', { servings: 12, yield: [360, 'ml'], active: 15, total: 20, equip: ['saucepan'], tags: ['component'], produces: ['caramel', 'prepared'] },
    [['sugar', 200, 'g'], ['butter', 60, 'g'], ['heavy_cream', 120, 'ml'], ['salt', 3, 'g']],
    ['Cook sugar to a deep amber.', 'Off heat, whisk in butter then warm cream.', 'Season with salt.']),
  // ---- Plated specials
  R('st_special_thigh_plate', 'Chicken thigh, potatoes & salsa verde', ['food'], 'special', { servings: 4, active: 30, total: 50, equip: ['oven', 'cast iron'], tags: ['chicken', 'uses older stock'] },
    [['chicken_thigh', 720, 'g'], ['potato', 600, 'g', EP], ['salsa_verde', 120, 'ml', P], ['romaine', 120, 'g'], ['olive_oil', 30, 'ml'], ['salt', 10, 'g']],
    ['Roast potatoes.', 'Crisp thighs skin-side down; finish in oven.', 'Plate over dressed leaves with salsa verde.']),
  R('st_special_salmon_chickpea', 'Salmon with herbed chickpeas', ['food'], 'special', { servings: 2, active: 20, total: 25, equip: ['sauté pan'], tags: ['fish'] },
    [['salmon', 360, 'g'], ['chickpeas', 240, 'g'], ['parsley', 10, 'g'], ['lemon_juice', 30, 'ml', P], ['olive_oil', 30, 'ml'], ['feta', 40, 'g', OPT], ['salt', 4, 'g']],
    ['Warm chickpeas with oil, lemon and herbs.', 'Sear salmon.', 'Plate salmon on chickpeas; crumble feta.']),
  R('st_special_beef_bowl', 'Beef & mushroom rice bowl', ['food'], 'special', { servings: 4, active: 20, total: 30, equip: ['wok'], tags: ['beef'] },
    [['ground_beef', 600, 'g'], ['mushroom', 200, 'g'], ['rice', 600, 'g', { form: 'cooked' }], ['scallion', 30, 'g'], ['soy_sauce', 40, 'ml'], ['eggs', 4, 'each']],
    ['Brown beef hard; add mushrooms.', 'Season with soy.', 'Serve over rice with a fried egg and scallion.']),
  R('st_special_pesto_pasta', 'Basil pesto spaghetti', ['food'], 'special', { servings: 4, active: 15, total: 20, equip: ['food processor'], tags: ['vegetarian'], cuisine: 'Italian' },
    [['pasta', 400, 'g'], ['basil', 60, 'g'], ['pine_nut', 40, 'g'], ['parmesan', 40, 'g', OPT], ['garlic', 5, 'g'], ['olive_oil', 100, 'ml'], ['salt', 10, 'g']],
    ['Blend basil, pine nuts, garlic, oil.', 'Fold in parmesan.', 'Toss with just-cooked spaghetti and pasta water.']),
];

export const BAR_RECIPES: Recipe[] = [
  // ---- Cocktails
  R('st_daiquiri', 'Daiquiri', ['bar'], 'cocktail', { active: 2, total: 2, equip: ['shaker'], tags: ['classic', 'rum', 'sour', 'menu'] },
    [['white_rum', 2, oz, { substitutes: [{ ingredientId: 'aged_rum', form: 'raw', quantity: 2, unit: oz, note: 'Aged rum: richer, oakier; same ABV' }] }], ['lime_juice', 0.75, oz, P], ['simple_syrup', 0.75, oz, P], ['ice', 150, 'g']],
    ['Shake hard with ice.', 'Double strain into a chilled coupe.']),
  R('st_margarita', 'Margarita', ['bar'], 'cocktail', { active: 2, total: 2, equip: ['shaker'], tags: ['classic', 'tequila', 'sour'] },
    [['tequila', 2, oz], ['orange_liqueur', 0.75, oz], ['lime_juice', 0.75, oz, P], ['salt', 1, 'g', OPT], ['ice', 150, 'g']],
    ['Optional salt rim.', 'Shake with ice; strain over fresh ice.']),
  R('st_gin_tonic', 'Gin & tonic', ['bar'], 'cocktail', { active: 1, total: 1, tags: ['highball', 'gin', 'menu'] },
    [['gin', 1.5, oz], ['tonic', 4, oz], ['lime', 1, 'wedge'], ['ice', 180, 'g']],
    ['Build gin over ice in a chilled highball.', 'Top with tonic; garnish with lime wedge.']),
  R('st_old_fashioned', 'Old fashioned', ['bar'], 'cocktail', { active: 2, total: 2, equip: ['mixing glass'], tags: ['classic', 'whiskey', 'stirred', 'menu'] },
    [['bourbon', 2, oz, { substitutes: [{ ingredientId: 'rye', form: 'raw', quantity: 2, unit: oz, note: 'Rye: spicier, drier' }] }], ['simple_syrup', 0.25, oz, P], ['aromatic_bitters', 2, 'dash'], ['orange', 0.1, 'each'], ['ice', 120, 'g']],
    ['Stir whiskey, syrup and bitters with ice.', 'Strain over a large cube; express orange peel.']),
  R('st_negroni', 'Negroni', ['bar'], 'cocktail', { active: 2, total: 2, equip: ['mixing glass'], tags: ['classic', 'gin', 'stirred', 'bitter'] },
    [['gin', 1, oz], ['sweet_vermouth', 1, oz], ['bitter_aperitivo', 1, oz], ['orange', 0.1, 'each'], ['ice', 120, 'g']],
    ['Stir with ice.', 'Strain over fresh ice; orange peel.']),
  R('st_whiskey_sour', 'Whiskey sour', ['bar'], 'cocktail', { active: 3, total: 3, equip: ['shaker'], tags: ['classic', 'whiskey', 'sour'] },
    [['bourbon', 2, oz], ['lemon_juice', 0.75, oz, P], ['simple_syrup', 0.75, oz, P], ['eggs', 1, 'each', OPT], ['aromatic_bitters', 2, 'dash', OPT], ['ice', 150, 'g']],
    ['Dry shake if using egg white.', 'Shake with ice; strain; dash bitters on the foam.']),
  R('st_mojito', 'Mojito', ['bar'], 'cocktail', { active: 3, total: 3, equip: ['muddler'], tags: ['classic', 'rum', 'highball'] },
    [['white_rum', 2, oz], ['lime_juice', 0.75, oz, P], ['simple_syrup', 0.75, oz, P], ['mint', 8, 'sprig'], ['soda_water', 2, oz], ['ice', 180, 'g']],
    ['Gently press mint with syrup.', 'Add rum, lime and crushed ice; churn.', 'Top with soda; mint garnish.']),
  R('st_paloma', 'Paloma', ['bar'], 'cocktail', { active: 2, total: 2, tags: ['tequila', 'highball'] },
    [['tequila', 2, oz], ['grapefruit_juice', 2, oz, P], ['lime_juice', 0.5, oz, P], ['simple_syrup', 0.25, oz, P], ['soda_water', 2, oz], ['salt', 0.5, 'g'], ['ice', 180, 'g']],
    ['Build over ice with a pinch of salt.', 'Top with soda; grapefruit wedge.']),
  R('st_mezcal_mule', 'Mezcal ginger mule', ['bar'], 'cocktail', { active: 2, total: 2, tags: ['mezcal', 'highball'] },
    [['mezcal', 1.5, oz], ['ginger_syrup', 0.75, oz, P], ['lime_juice', 0.75, oz, P], ['soda_water', 3, oz], ['ice', 180, 'g']],
    ['Build over ice.', 'Top with soda; lime wheel.']),
  R('st_espresso_martini', 'Espresso martini', ['bar'], 'cocktail', { active: 3, total: 5, equip: ['shaker', 'espresso machine'], tags: ['vodka', 'coffee'] },
    [['vodka', 1.5, oz], ['coffee_liqueur', 0.75, oz], ['espresso', 1, oz], ['simple_syrup', 0.25, oz, P], ['ice', 150, 'g']],
    ['Pull fresh espresso.', 'Shake very hard with ice; fine strain.']),
  R('st_spritz', 'Orange aperitivo spritz', ['bar'], 'cocktail', { active: 1, total: 1, tags: ['low-abv', 'sparkling'] },
    [['orange_aperitivo', 2, oz], ['prosecco', 3, oz], ['soda_water', 1, oz], ['orange', 0.1, 'each'], ['ice', 180, 'g']],
    ['Build in a wine glass over ice: prosecco, aperitivo, soda.', 'Orange slice.']),
  R('st_manhattan', 'Manhattan', ['bar'], 'cocktail', { active: 2, total: 2, equip: ['mixing glass'], tags: ['classic', 'whiskey', 'stirred'] },
    [['rye', 2, oz], ['sweet_vermouth', 1, oz], ['aromatic_bitters', 2, 'dash'], ['ice', 120, 'g']],
    ['Stir with ice.', 'Strain into a chilled coupe.']),
  // ---- Zero-proof
  R('st_ginger_lime_fizz', 'Ginger-lime fizz', ['bar'], 'zero_proof', { active: 2, total: 2, tags: ['zero-proof'] },
    [['ginger_syrup', 1, oz, P], ['lime_juice', 0.75, oz, P], ['soda_water', 4, oz], ['ice', 180, 'g']],
    ['Build over ice; top with soda; lime wheel.']),
  R('st_grapefruit_tonic', 'Grapefruit rosemary tonic', ['bar'], 'zero_proof', { active: 2, total: 2, tags: ['zero-proof'] },
    [['grapefruit_juice', 2, oz, P], ['tonic', 4, oz], ['rosemary', 1, 'sprig'], ['ice', 180, 'g']],
    ['Build over ice.', 'Slap rosemary sprig to garnish.']),
  R('st_shrub_soda', 'Raspberry shrub soda', ['bar'], 'zero_proof', { active: 1, total: 1, tags: ['zero-proof'] },
    [['raspberry_shrub', 1.5, oz, P], ['soda_water', 4, oz], ['lime', 1, 'wedge', OPT], ['ice', 180, 'g']],
    ['Build over ice; top with soda.']),
  R('st_bitters_soda', 'Bitters & soda', ['bar'], 'zero_proof', { active: 1, total: 1, tags: ['low-proof', 'contains bitters'], desc: 'Often sold as non-alcoholic; aromatic bitters contain alcohol, so status is flagged.' },
    [['soda_water', 5, oz], ['aromatic_bitters', 5, 'dash'], ['lime', 1, 'wedge'], ['ice', 180, 'g']],
    ['Dash bitters over ice; top with soda; lime.']),
  // ---- Syrups / cordials / shrubs / mixers (components)
  R('st_simple_syrup', 'Simple syrup 1:1', ['bar'], 'syrup', { servings: 33, yield: [750, 'ml'], active: 5, total: 15, equip: ['saucepan'], tags: ['component'], produces: ['simple_syrup', 'prepared'] },
    [['sugar', 500, 'g'], ['water', 500, 'ml']],
    ['Dissolve sugar in hot water; do not boil hard.', 'Cool, bottle, label with prep date.']),
  R('st_honey_syrup', 'Honey syrup', ['bar'], 'syrup', { servings: 16, yield: [375, 'ml'], active: 5, total: 10, tags: ['component'], produces: ['honey_syrup', 'prepared'] },
    [['honey', 300, 'g'], ['water', 150, 'ml']],
    ['Stir honey into warm water until smooth.']),
  R('st_ginger_syrup', 'Ginger syrup', ['bar'], 'syrup', { servings: 26, yield: [600, 'ml'], active: 15, total: 45, equip: ['juicer'], tags: ['component'], produces: ['ginger_syrup', 'prepared'] },
    [['ginger', 200, 'g'], ['sugar', 400, 'g'], ['water', 300, 'ml']],
    ['Juice or blend and press ginger.', 'Dissolve sugar in warm water; combine with ginger juice; strain.']),
  R('st_lime_cordial', 'Lime cordial', ['bar'], 'syrup', { servings: 18, yield: [400, 'ml'], active: 15, total: 30, tags: ['component'], produces: ['lime_cordial', 'prepared'] },
    [['lime_juice', 250, 'ml', P], ['sugar', 250, 'g'], ['lime', 4, 'each']],
    ['Zest limes into sugar; rest 20 min.', 'Dissolve in lime juice; strain.']),
  R('st_raspberry_shrub', 'Raspberry shrub', ['bar'], 'syrup', { servings: 13, yield: [600, 'ml'], active: 10, total: 1440, tags: ['component'], produces: ['raspberry_shrub', 'prepared'] },
    [['raspberry', 300, 'g'], ['sugar', 300, 'g'], ['cider_vinegar', 300, 'ml']],
    ['Macerate berries in sugar overnight.', 'Strain; whisk in vinegar.']),
  // ---- Garnishes / prep
  R('st_lime_juice', 'Fresh lime juice', ['bar', 'food'], 'garnish', { servings: 13, yield: [300, 'ml'], active: 10, total: 10, equip: ['juicer'], tags: ['component', 'prep'], produces: ['lime_juice', 'prepared'], desc: 'About 30 ml per lime; verify against your fruit.' },
    [['lime', 10, 'each']],
    ['Roll and halve limes.', 'Juice and fine-strain; label with prep time.']),
  R('st_lemon_juice', 'Fresh lemon juice', ['bar', 'food'], 'garnish', { servings: 18, yield: [400, 'ml'], active: 10, total: 10, equip: ['juicer'], tags: ['component', 'prep'], produces: ['lemon_juice', 'prepared'] },
    [['lemon', 10, 'each']],
    ['Juice and fine-strain; label with prep time.']),
  R('st_grapefruit_juice', 'Fresh grapefruit juice', ['bar'], 'garnish', { servings: 13, yield: [800, 'ml'], active: 10, total: 10, equip: ['juicer'], tags: ['component', 'prep'], produces: ['grapefruit_juice', 'prepared'] },
    [['grapefruit', 4, 'each']],
    ['Juice and strain.']),
  R('st_orange_wheels', 'Dehydrated orange wheels', ['bar'], 'garnish', { servings: 40, yield: [40, 'each'], active: 15, total: 360, equip: ['dehydrator'], tags: ['component', 'garnish'], produces: ['orange_wheel', 'raw'] },
    [['orange', 4, 'each']],
    ['Slice oranges 3 mm.', 'Dehydrate at 60 °C 5–6 h until crisp; store airtight.']),
  // ---- Batched drinks
  R('st_batched_negroni', 'Batched Negroni (10)', ['bar'], 'batched', { servings: 10, yield: [1040, 'ml'], active: 10, total: 10, equip: ['bottles', 'funnel'], tags: ['batch'] },
    [['gin', 300, 'ml'], ['sweet_vermouth', 300, 'ml'], ['bitter_aperitivo', 300, 'ml'], ['water', 140, 'ml']],
    ['Combine; add chilled water for dilution.', 'Bottle, label, refrigerate; serve 104 ml over ice.']),
  R('st_batched_old_fashioned', 'Batched old fashioned (10)', ['bar'], 'batched', { servings: 10, yield: [800, 'ml'], active: 10, total: 10, equip: ['bottles'], tags: ['batch'] },
    [['bourbon', 600, 'ml'], ['simple_syrup', 75, 'ml', P], ['aromatic_bitters', 20, 'dash'], ['water', 125, 'ml']],
    ['Combine and bottle; refrigerate.', 'Serve 80 ml over a large cube with orange peel.']),
  R('st_batched_margarita', 'Batched margarita (10)', ['bar'], 'batched', { servings: 10, yield: [1000, 'ml'], active: 10, total: 10, equip: ['bottles'], tags: ['batch'] },
    [['tequila', 600, 'ml'], ['orange_liqueur', 150, 'ml'], ['lime_cordial', 250, 'ml', P]],
    ['Combine with cordial (shelf-steadier than fresh juice).', 'Shake 100 ml per drink with ice.']),
];

export const STARTER_RECIPES: Recipe[] = [...FOOD_RECIPES, ...BAR_RECIPES];
