const SAFE_SNIPPET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EMPTY_SHA256 = "0".repeat(64)

export function validSnippetName(value) {
  return typeof value === "string" && value.length <= 64 &&
    SAFE_SNIPPET_NAME.test(value)
}

export function ensurePromptSnippets(snapshot) {
  if (snapshot.snippets === undefined) snapshot.snippets = {}
  return snapshot
}

export function snippetNames(snapshot) {
  return Object.keys(snapshot.snippets || {}).sort((left, right) =>
    left.localeCompare(right),
  )
}

export function createPromptSnippet(snapshot, name) {
  if (!validSnippetName(name)) throw new Error("Snippet name is invalid.")
  ensurePromptSnippets(snapshot)
  if (snapshot.snippets[name]) throw new Error("Snippet already exists.")
  snapshot.snippets[name] = {
    schema: 1,
    name,
    content: "",
    sha256: EMPTY_SHA256,
  }
  return snapshot.snippets[name]
}

export function setPromptSnippetContent(snapshot, name, content) {
  const snippet = snapshot.snippets?.[name]
  if (!snippet) throw new Error("Snippet does not exist.")
  snippet.content = content
  snippet.sha256 = EMPTY_SHA256
  return snippet
}

export function deletePromptSnippet(snapshot, name) {
  if (!snapshot.snippets?.[name]) return false
  delete snapshot.snippets[name]
  return true
}
