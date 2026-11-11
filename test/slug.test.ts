import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug } from "../src/slug.ts";

test("slugify lowercases and replaces non-alphanumerics with dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("Step 1: Do Things!"), "step-1-do-things");
  assert.equal(slugify("already-a-slug"), "already-a-slug");
});

test("slugify trims leading/trailing dashes produced by punctuation", () => {
  assert.equal(slugify("  leading and trailing  "), "leading-and-trailing");
  assert.equal(slugify("***weird***"), "weird");
});

test('slugify falls back to "step" for an all-punctuation name', () => {
  assert.equal(slugify("!!!"), "step");
});

test("uniqueSlug returns the base slug when there is no collision", () => {
  const used = new Set<string>();
  assert.equal(uniqueSlug("Build", used), "build");
  assert.equal(uniqueSlug("Test", used), "test");
});

test("uniqueSlug appends numeric suffixes on collision", () => {
  const used = new Set<string>();
  assert.equal(uniqueSlug("Build", used), "build");
  assert.equal(uniqueSlug("Build", used), "build-2");
  assert.equal(uniqueSlug("Build", used), "build-3");
});

test("uniqueSlug treats differently-cased/punctuated names that collapse to the same slug as collisions", () => {
  const used = new Set<string>();
  assert.equal(uniqueSlug("Build!", used), "build");
  assert.equal(uniqueSlug("build", used), "build-2");
});

test("slugify falls back for non-ASCII-only names, and uniqueSlug numbers the repeats", () => {
  assert.equal(slugify("日本語"), "step");
  assert.equal(slugify("😀", "flow"), "flow");
  const used = new Set<string>();
  assert.deepEqual(
    ["日本語", "😀", "x"].map((n) => uniqueSlug(n, used)),
    ["step", "step-2", "x"],
  );
});

test("uniqueSlug doesn't collide with a name that already looks suffixed", () => {
  const used = new Set<string>();
  assert.deepEqual(
    ["a", "a", "a-2"].map((n) => uniqueSlug(n, used)),
    ["a", "a-2", "a-2-2"],
  );
});
