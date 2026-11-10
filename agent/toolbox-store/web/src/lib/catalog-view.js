export function catalogEntriesForView(entries, enabled, query = "", mode = "enabled") {
  const normalizedQuery = String(query).trim().toLowerCase();
  return [...entries]
    .filter(([name, item]) => {
      if (mode === "enabled" && !enabled.has(name)) return false;
      return `${name} ${item?.description || ""}`.toLowerCase().includes(normalizedQuery);
    })
    .sort(([nameA], [nameB]) =>
      Number(enabled.has(nameB)) - Number(enabled.has(nameA)) ||
      nameA.localeCompare(nameB)
    );
}

export function collectionOptionLabel(name, enabledCount, scope = "") {
  return `${name} · ${enabledCount} enabled${scope ? ` · ${scope}` : ""}`;
}
