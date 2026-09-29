import { AstraClient } from "@avee/sdk/astra";

const BTC = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const ETH = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

const astra = new AstraClient({ baseUrl: process.env.ASTRA_BASE_URL });

for (const u of await astra.latestPrices([BTC, ETH])) {
  console.log(u.id, u.price.toDecimalString(), "±", u.price.confToNumber(), "as 1e18:", u.price.scaled(18));
}

const health = await astra.status();
console.log(health.feeds.filter((f) => f.stale).map((f) => f.symbol));
