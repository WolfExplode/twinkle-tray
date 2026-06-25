const { test } = require('node:test')
const assert = require('node:assert')

const Translate = require('../src/Translate')

const locale = { GREETING: "Hello {{1}}", RANGE: "{{1}} to {{2}}", EMPTY: "" }
const fallback = { GREETING: "Hi {{1}}", ONLY_FALLBACK: "Fallback {{1}}", EMPTY: "Default" }

test('getString returns the localized string with positional args filled in', () => {
  const t = new Translate(locale, fallback)
  assert.strictEqual(t.getString("GREETING", "Sam"), "Hello Sam")
  assert.strictEqual(t.getString("RANGE", "10", "90"), "10 to 90")
})

test('getString falls back when the key is missing from the primary locale', () => {
  const t = new Translate(locale, fallback)
  assert.strictEqual(t.getString("ONLY_FALLBACK", "X"), "Fallback X")
})

test('getString falls back when the primary value is an empty string', () => {
  // An empty translation is treated as "not translated" and defers to the fallback.
  const t = new Translate(locale, fallback)
  assert.strictEqual(t.getString("EMPTY"), "Default")
})

test('getString returns "" when the key exists in neither locale nor fallback', () => {
  const t = new Translate(locale, fallback)
  assert.strictEqual(t.getString("UNKNOWN"), "")
})

test('the t shorthand is an alias for getString', () => {
  const t = new Translate(locale, fallback)
  assert.strictEqual(t.t("GREETING", "Sam"), t.getString("GREETING", "Sam"))
})

test('setLocalizationData swaps the active dictionaries', () => {
  const t = new Translate()
  assert.strictEqual(t.getString("GREETING", "Sam"), "")
  t.setLocalizationData(locale, fallback)
  assert.strictEqual(t.getString("GREETING", "Sam"), "Hello Sam")
})

test('makeTranslation leaves placeholders intact when no arg is supplied for them', () => {
  const t = new Translate()
  // Only one arg given for a two-placeholder string; the second token stays as-is.
  assert.strictEqual(t.makeTranslation("{{1}} to {{2}}", ["10"]), "10 to {{2}}")
})

test('makeTranslation with no args returns the template unchanged', () => {
  const t = new Translate()
  assert.strictEqual(t.makeTranslation("Hello {{1}}", []), "Hello {{1}}")
})

test('getHTML forwards multiple args positionally', () => {
  // Regression: getHTML used to pass the whole args array as a single argument,
  // so {{2}} never filled and {{1}} got "10,90". It must spread like getString.
  const t = new Translate(locale, fallback)
  assert.strictEqual(t.getHTML("RANGE", "10", "90"), "10 to 90")
  assert.strictEqual(t.h("GREETING", "Sam"), "Hello Sam")
})
