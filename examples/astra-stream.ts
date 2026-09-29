import { AstraClient } from "@avee/sdk/astra";

const BTC = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const astra = new AstraClient({ baseUrl: process.env.ASTRA_BASE_URL });
const sub = astra.subscribe([BTC], {
  channel: "fixed_rate@1000ms",
  onError: (err) => console.warn("astra:", err.message),
  onStateChange: (state) => console.info("connection", state),
});

process.once("SIGINT", () => sub.close());

for await (const u of sub) {
  console.log(new Date(u.price.publishTime * 1000).toISOString(), u.price.toDecimalString());
}
