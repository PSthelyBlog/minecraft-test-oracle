// Boot self-check template — re-derive the CHEAPEST invariants and THROW at startup,
// in the SAME runtime as production. Import selfCheck() and call it once at init.
// Replace the example invariant with your module's real ones (totality, a small
// bijection, a tiny round-trip). See the make-failures-loud skill.

class SelfCheckError extends Error {}
const must = (cond, msg) => {
  if (!cond) throw new SelfCheckError(msg);
};

export function selfCheck() {
  // EXAMPLE invariant — delete and replace with yours:
  const encode = (b) => {
    const o = [];
    for (let i = 0; i < b.length; ) {
      let j = i + 1;
      while (j < b.length && b[j] === b[i]) j++;
      o.push(j - i, b[i]);
      i = j;
    }
    return o;
  };
  const decode = (r) => {
    const o = [];
    for (let i = 0; i < r.length; i += 2) for (let k = 0; k < r[i]; k++) o.push(r[i + 1]);
    return o;
  };
  const sample = [1, 1, 2, 3, 3, 3];
  must(
    JSON.stringify(decode(encode(sample))) === JSON.stringify(sample),
    "boot: codec round-trip failed",
  );
  return true;
}
