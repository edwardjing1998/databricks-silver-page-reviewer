ALTER TABLE education_rag.silver.fine_grained_pages ADD COLUMNS (
  review_status STRING COMMENT 'PENDING, APPROVED, REJECTED, or NEEDS_CHANGES',
  reviewed_by STRING COMMENT 'Identity that recorded the latest decision',
  reviewed_at TIMESTAMP COMMENT 'Timestamp of the latest decision',
  review_comment STRING COMMENT 'Latest reviewer comment',
  approved_content_hash STRING COMMENT 'SHA-256 hash approved by the reviewer'
);

UPDATE education_rag.silver.fine_grained_pages
SET review_status = 'PENDING'
WHERE review_status IS NULL;

CREATE TABLE IF NOT EXISTS education_rag.silver.fine_page_reviews (
  review_id STRING NOT NULL,
  fine_page_id STRING NOT NULL,
  decision STRING NOT NULL,
  reviewer STRING NOT NULL,
  reviewed_at TIMESTAMP NOT NULL,
  comment STRING,
  content_hash STRING NOT NULL
)
USING DELTA;

-- Replace the principal before running these GRANT statements.
-- GRANT USE CATALOG ON CATALOG education_rag TO `your-reviewer-service-principal`;
-- GRANT USE SCHEMA ON SCHEMA education_rag.silver TO `your-reviewer-service-principal`;
-- GRANT SELECT, MODIFY ON TABLE education_rag.silver.fine_grained_pages TO `your-reviewer-service-principal`;
-- GRANT SELECT, MODIFY ON TABLE education_rag.silver.fine_page_reviews TO `your-reviewer-service-principal`;
