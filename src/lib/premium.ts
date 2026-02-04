export type Spot = {
  tsUtc: string;         // ISO date
  currency: 'USD' | 'EUR';
  pricePerOz: number;    // per troy ounce
};

export type Coin = {
  id: string;
  name: string;
  fine_weight_g: number; // grams of pure gold
};

export type PremiumResult = {
  meltValue: number;      // in same currency as coinPrice
  premiumPct: number;     // e.g. 0.08 for +8%
};

const TROY_OUNCE_IN_G = 31.1034768;

export function spotPerGram(spot: Spot): number {
  return spot.pricePerOz / TROY_OUNCE_IN_G;
}

export function computePremium(spot: Spot, coin: Coin, coinPrice: number): PremiumResult {
  const perGram = spotPerGram(spot);
  const melt = perGram * coin.fine_weight_g;
  return { meltValue: melt, premiumPct: coinPrice / melt - 1 };
}
