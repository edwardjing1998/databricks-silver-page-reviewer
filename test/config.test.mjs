import test from "node:test";
import assert from "node:assert/strict";
import { safeTableName } from "../server/config.mjs";

test("accepts a three-part Unity Catalog table name", () => {
  assert.equal(
    safeTableName("education_rag.silver.fine_grained_pages"),
    "education_rag.silver.fine_grained_pages"
  );
});

test("rejects a table name containing SQL", () => {
  assert.throws(
    () => safeTableName("education_rag.silver.pages; DROP TABLE x"),
    /Unsafe Databricks table name/
  );
});
