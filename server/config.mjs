const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
};

export function config() {
  return {
    port: Number(process.env.SERVER_PORT || 8080),
    databricksHost: required("DATABRICKS_HOST").replace(/\/$/, ""),
    databricksClientId: required("DATABRICKS_CLIENT_ID"),
    databricksClientSecret: required("DATABRICKS_CLIENT_SECRET"),
    warehouseId: required("DATABRICKS_SQL_WAREHOUSE_ID"),
    finePagesTable: process.env.DATABRICKS_FINE_PAGES_TABLE || "education_rag.silver.fine_grained_pages",
    reviewsTable: process.env.DATABRICKS_REVIEWS_TABLE || "education_rag.silver.fine_page_reviews",
    bibleAnalysisTable: process.env.DATABRICKS_BIBLE_ANALYSIS_TABLE || "education_rag.silver.bible_page_analysis",
    bibleScenesTable: process.env.DATABRICKS_BIBLE_SCENES_TABLE || "education_rag.silver.bible_story_scenes",
    bibleReviewsTable: process.env.DATABRICKS_BIBLE_REVIEWS_TABLE || "education_rag.silver.bible_scene_reviews",
    storageEndpoint: required("AZURE_STORAGE_ENDPOINT").replace(/\/$/, ""),
    storageContainer: required("AZURE_STORAGE_CONTAINER")
  };
}

export function safeTableName(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe Databricks table name: ${value}`);
  }
  return value;
}
