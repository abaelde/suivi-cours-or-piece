const TROY_OUNCE_IN_G = 31.1034768;

function spotPerGram(spot) {
  return spot.pricePerOz / TROY_OUNCE_IN_G;
}

function computePremium(spot, coin, coinPrice) {
  const perGram = spotPerGram(spot);
  const melt = perGram * coin.fine_weight_g;
  return { meltValue: melt, premiumPct: coinPrice / melt - 1 };
}

module.exports = { TROY_OUNCE_IN_G, spotPerGram, computePremium };
