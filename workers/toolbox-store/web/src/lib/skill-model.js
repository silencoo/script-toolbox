export function resolvePack(snapshot, name, target = "", stack = [], result = new Set()) {
  const pack = snapshot.packs[name];
  if (!pack || stack.includes(name)) return result;
  for (const parent of pack.extends || []) {
    resolvePack(snapshot, parent, target, [...stack, name], result);
  }
  for (const skill of pack.enable || []) result.add(skill);
  for (const skill of pack.disable || []) result.delete(skill);
  const override = target && isObject(pack.target_overrides?.[target])
    ? pack.target_overrides[target]
    : null;
  for (const skill of override?.enable || []) result.add(skill);
  for (const skill of override?.disable || []) result.delete(skill);
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
