import assert from "node:assert/strict"
import test from "node:test"

import {
  createPromptSnippet,
  deletePromptSnippet,
  ensurePromptSnippets,
  setPromptSnippetContent,
  snippetNames,
  validSnippetName,
} from "./web/src/lib/prompt-model.js"

test("Prompt snippets normalize old snapshots and preserve deterministic names", () => {
  const snapshot = { schema: 1, kind: "promptctl-store", profiles: {} }
  assert.equal(ensurePromptSnippets(snapshot), snapshot)
  assert.deepEqual(snapshot.snippets, {})

  createPromptSnippet(snapshot, "review-code")
  createPromptSnippet(snapshot, "plan-first")
  assert.deepEqual(snippetNames(snapshot), ["plan-first", "review-code"])
  assert.equal(snapshot.snippets["review-code"].content, "")
  assert.match(snapshot.snippets["review-code"].sha256, /^0{64}$/)
})

test("Prompt snippet edits reset hashes and deletion never exposes content", () => {
  const snapshot = { snippets: {} }
  createPromptSnippet(snapshot, "review-code")
  const edited = setPromptSnippetContent(snapshot, "review-code", "private phrase")
  assert.equal(edited.content, "private phrase")
  assert.match(edited.sha256, /^0{64}$/)
  assert.equal(deletePromptSnippet(snapshot, "review-code"), true)
  assert.equal(deletePromptSnippet(snapshot, "review-code"), false)
})

test("Prompt snippet names are stable lowercase slugs", () => {
  for (const value of ["review-code", "daily", "commit-and-push"]) {
    assert.equal(validSnippetName(value), true)
  }
  for (const value of ["", "Review", "has space", "../unsafe", "double--dash"]) {
    assert.equal(validSnippetName(value), false)
  }
  assert.throws(() => createPromptSnippet({ snippets: {} }, "../unsafe"), /invalid/)
})
