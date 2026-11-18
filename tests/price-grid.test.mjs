import test from 'node:test';
import assert from 'node:assert/strict';
import { priceGridSchema, pricingOptionCreateSchema } from '../src/schemas/pricing-options.schema.ts';

const TOUR = '9f1c2d3e-0000-4000-8000-000000000001';

test('a grid with blank cells parses, blanks become null', () => {
  const parsed = priceGridSchema.parse({
    tiers: [
      {
        comfort_tier: 'essential',
        lodges: 'Tarangire Simba Lodge',
        child_price: '',
        bands: [
          { travellers_from: 1, travellers_to: 1, price: '' },
          { travellers_from: 2, travellers_to: 2, price: '5200' },
          { travellers_from: 3, travellers_to: 4, price: 4600 },
          { travellers_from: 5, travellers_to: 6, price: null }
        ]
      }
    ]
  });
  const [tier] = parsed.tiers;
  assert.equal(parsed.currency, 'USD');
  assert.equal(tier.child_price, null);
  assert.deepEqual(tier.bands.map((band) => band.price), [null, 5200, 4600, null]);
});

test('a group size outside the four bands is refused', () => {
  const result = priceGridSchema.safeParse({
    tiers: [{ comfort_tier: 'luxury', bands: [{ travellers_from: 2, travellers_to: 3, price: 100 }] }]
  });
  assert.equal(result.success, false);
});

test('the same comfort level twice is refused', () => {
  const tier = { comfort_tier: 'classic', bands: [] };
  assert.equal(priceGridSchema.safeParse({ tiers: [tier, tier] }).success, false);
});

test('a single option needs both traveller numbers or neither', () => {
  const base = { tour_id: TOUR, title: 'Classic', price: 100 };
  assert.equal(pricingOptionCreateSchema.safeParse(base).success, true);
  assert.equal(pricingOptionCreateSchema.safeParse({ ...base, travellers_from: 3, travellers_to: 4 }).success, true);
  assert.equal(pricingOptionCreateSchema.safeParse({ ...base, travellers_from: 3 }).success, false);
  assert.equal(pricingOptionCreateSchema.safeParse({ ...base, travellers_from: 4, travellers_to: 3 }).success, false);
});
