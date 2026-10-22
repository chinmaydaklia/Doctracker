import { Store } from "../js/store.js";
import { memoryAdapter } from "../js/db.js";
import { defaultCategories } from "../js/model.js";

export const R = (rupees) => rupees * 100;

// A store with one direct-pay clinic (new ₹300 / follow-up ₹150) and one hospital
// location whose fees the hospital collects.
export async function setup(adapter = memoryAdapter()) {
  let t = Date.UTC(2026, 0, 1);
  const store = await Store.open(adapter, { clock: () => ++t });
  const hosp = await store.savePayer({ name: "Hospital A" });
  const clinic = await store.saveLocation(
    { name: "Own clinic", kind: "clinic", arrangement: "direct" },
    { effectiveFrom: "2026-01-01", categories: defaultCategories(R(300), R(150)) },
  );
  const ward = await store.saveLocation(
    { name: "Hospital A — Private ward", kind: "hospital", arrangement: "hospital", payerId: hosp.id },
    { effectiveFrom: "2026-01-01", categories: defaultCategories(R(300), R(300)) },
  );
  return { store, hosp, clinic, ward };
}

export function lines(store, locationId, date, counts) {
  const rate = store.currentRate(locationId, date);
  return rate.categories.map((c) => ({ ...c, count: counts[c.key] || 0 }));
}
