import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import {
  BlobServiceClient,
} from "@azure/storage-blob";
import {
  DefaultAzureCredential,
} from "@azure/identity";

import {
  config,
  safeTableName,
} from "./config.mjs";

import {
  execute,
  parameter,
} from "./databricks.mjs";


const applicationConfig = config();

const finePagesTable = safeTableName(
  applicationConfig.finePagesTable
);

const reviewsTable = safeTableName(
  applicationConfig.reviewsTable
);

const bibleAnalysisTable = safeTableName(applicationConfig.bibleAnalysisTable);
const bibleScenesTable = safeTableName(applicationConfig.bibleScenesTable);
const bibleReviewsTable = safeTableName(applicationConfig.bibleReviewsTable);

// Store human review decisions outside model-generated classification tables.
// This table requires CREATE TABLE permission on the configured Silver schema.
let bibleReviewTableReady = false;
async function ensureBibleReviewTable() {
  if (bibleReviewTableReady) return;
  await execute(applicationConfig, `
    CREATE TABLE IF NOT EXISTS ${bibleReviewsTable} (
      scene_id STRING NOT NULL,
      review_status STRING,
      reviewed_by STRING,
      reviewed_at TIMESTAMP,
      review_comment STRING,
      reviewed_content_hash STRING
    ) USING DELTA
  `);
  bibleReviewTableReady = true;
}

const azureCredential =
  new DefaultAzureCredential();

const blobServiceClient =
  new BlobServiceClient(
    applicationConfig.storageEndpoint,
    azureCredential
  );

const blobContainerClient =
  blobServiceClient.getContainerClient(
    applicationConfig.storageContainer
  );

const app = express();

app.use(
  express.json({
    limit: "100kb",
  })
);


const arrayColumns = new Set([
  "source_page_numbers",
  "source_document_ids",
  "block_ids",
  "image_links",
  "scripture_references",
]);


/**
 * Convert values returned by the Databricks SQL API into
 * values that are easier for React to consume.
 */
function parseRow(row) {
  for (const columnName of arrayColumns) {
    if (typeof row[columnName] === "string") {
      try {
        row[columnName] =
          JSON.parse(row[columnName]);
      } catch {
        row[columnName] = [];
      }
    }
  }

  row.preserved_original =
    String(row.preserved_original)
      .toLowerCase() === "true";

  row.classification_confidence =
    Number(
      row.classification_confidence || 0
    );

  row.review_status =
    row.review_status || "PENDING";

  row.review_required =
    String(row.review_required).toLowerCase() === "true";

  return row;
}


/**
 * Build the optional WHERE conditions used by GET /api/pages.
 */
function sqlFilters(query) {
  const clauses = [
    "is_active = true",
  ];

  const parameters = [];

  const fields = {
    bookId: "book_id",
    chapterId: "chapter_id",
    pageType: "page_type",
    reviewStatus: "review_status",
  };

  for (
    const [inputName, columnName]
    of Object.entries(fields)
  ) {
    const value = String(
      query[inputName] || ""
    ).trim();

    if (value) {
      clauses.push(
        `${columnName} = :${inputName}`
      );

      parameters.push(
        parameter(inputName, value)
      );
    }
  }

  return {
    where: clauses.join(" AND "),
    parameters,
  };
}


/**
 * Convert ABFSS, HTTPS or relative paths into an Azure Blob name.
 */
function resolveBlobReference(
  storedPath,
  configuredContainer
) {
  const normalizedPath = String(
    storedPath || ""
  ).trim();

  if (!normalizedPath) {
    throw new Error(
      "Image reference does not contain blob_path"
    );
  }

  let referencedContainer;
  let blobName;

  /*
   * Example:
   *
   * abfss://education@account.dfs.core.windows.net/generated/...
   */
  const abfssMatch = normalizedPath.match(
    /^abfss:\/\/([^@/]+)@[^/]+\/(.+)$/
  );

  /*
   * Examples:
   *
   * https://account.blob.core.windows.net/education/generated/...
   * https://account.dfs.core.windows.net/education/generated/...
   */
  const httpsMatch = normalizedPath.match(
    /^https:\/\/[^/]+\/([^/]+)\/(.+)$/
  );

  if (abfssMatch) {
    referencedContainer = abfssMatch[1];
    blobName = abfssMatch[2];
  } else if (httpsMatch) {
    referencedContainer = httpsMatch[1];
    blobName = httpsMatch[2];
  } else {
    referencedContainer =
      configuredContainer;

    blobName =
      normalizedPath.replace(/^\/+/, "");
  }

  if (
    referencedContainer !==
    configuredContainer
  ) {
    throw new Error(
      `The image uses container ` +
      `'${referencedContainer}', but ` +
      `'${configuredContainer}' is configured`
    );
  }

  try {
    blobName =
      decodeURIComponent(blobName);
  } catch {
    throw new Error(
      "The image path contains invalid URL encoding"
    );
  }

  blobName =
    blobName.replace(/^\/+/, "");

  if (
    blobName.startsWith("abfss://") ||
    blobName.startsWith("http://") ||
    blobName.startsWith("https://")
  ) {
    throw new Error(
      "Unable to convert the image path " +
      "to an Azure Blob name"
    );
  }

  if (
    blobName.includes("../") ||
    blobName === ".."
  ) {
    throw new Error(
      "The image Blob path is invalid"
    );
  }

  return {
    containerName: referencedContainer,
    blobName,
  };
}


/**
 * Verify the Node server, Databricks authentication and SQL warehouse.
 */
app.get(
  "/api/health",
  async (_request, response, next) => {
    try {
      const [row] = await execute(
        applicationConfig,
        `
        SELECT current_user()
          AS databricks_identity
        `
      );

      response.json({
        status: "UP",
        databricksIdentity:
          row.databricks_identity,
        table: finePagesTable,
      });
    } catch (error) {
      next(error);
    }
  }
);


/**
 * Return active fine-grained pages.
 */
app.get(
  "/api/pages",
  async (request, response, next) => {
    try {
      const requestedLimit =
        Number(request.query.limit || 100);

      const requestedOffset =
        Number(request.query.offset || 0);

      const limit = Number.isFinite(
        requestedLimit
      )
        ? Math.max(
            1,
            Math.min(requestedLimit, 200)
          )
        : 100;

      const offset = Number.isFinite(
        requestedOffset
      )
        ? Math.max(0, requestedOffset)
        : 0;

      const {
        where,
        parameters,
      } = sqlFilters(request.query);

      const statement = `
        SELECT
          fine_page_id,
          window_id,
          section_id,
          book_id,
          chapter_id,
          page_type,
          sequence_number,
          title,
          knowledge_id,
          markdown_content,
          block_ids,
          source_document_ids,
          source_page_numbers,
          image_links,
          image_references_json,
          preserved_original,
          classification_confidence,
          classification_method,
          classification_status,
          classification_error,
          review_status,
          reviewed_by,
          reviewed_at,
          review_comment,
          approved_content_hash,
          model_endpoint,
          prompt_version
        FROM ${finePagesTable}
        WHERE ${where}
        ORDER BY
          book_id,
          chapter_id,
          sequence_number,
          fine_page_id
        LIMIT :limit
        OFFSET :offset
      `;

      const items = await execute(
        applicationConfig,
        statement,
        [
          ...parameters,
          parameter(
            "limit",
            limit,
            "INT"
          ),
          parameter(
            "offset",
            offset,
            "INT"
          ),
        ]
      );

      response.json({
        items: items.map(parseRow),
        limit,
        offset,
      });
    } catch (error) {
      next(error);
    }
  }
);


/**
 * Return distinct Book ID and Chapter ID combinations.
 *
 * React uses this endpoint to populate the filter dropdowns.
 */
app.get(
  "/api/filter-options",
  async (_request, response, next) => {
    try {
      const items = await execute(
        applicationConfig,
        `
        SELECT DISTINCT
          book_id,
          chapter_id
        FROM ${finePagesTable}
        WHERE is_active = true
          AND book_id IS NOT NULL
          AND chapter_id IS NOT NULL
        ORDER BY
          book_id,
          chapter_id
        `
      );

      response.json({
        items,
      });
    } catch (error) {
      next(error);
    }
  }
);


/**
 * Securely return an image from Azure Blob Storage.
 */
app.get(
  "/api/pages/:id/image",
  async (request, response, next) => {
    try {
      const link = String(
        request.query.link || ""
      ).trim();

      if (
        !link ||
        link.includes("..")
      ) {
        return response.status(400).json({
          error: "Invalid image link",
        });
      }

      const [row] = await execute(
        applicationConfig,
        `
        SELECT image_references_json
        FROM ${finePagesTable}
        WHERE fine_page_id = :id
          AND is_active = true
        LIMIT 1
        `,
        [
          parameter(
            "id",
            request.params.id
          ),
        ]
      );

      if (!row) {
        return response.status(404).json({
          error: "Page not found",
        });
      }

      let imageReferences;

      try {
        imageReferences =
          JSON.parse(
            row.image_references_json ||
              "[]"
          );
      } catch {
        return response.status(500).json({
          error:
            "image_references_json " +
            "is not valid JSON",
        });
      }

      if (
        !Array.isArray(imageReferences)
      ) {
        return response.status(500).json({
          error:
            "image_references_json " +
            "must contain a JSON array",
        });
      }

      const reference =
        imageReferences.find(
          item =>
            item.original_link === link ||
            item.file_name ===
              path.basename(link)
        );

      if (!reference) {
        return response.status(404).json({
          error:
            "Image reference not found",
          requestedLink: link,
        });
      }

      if (!reference.blob_path) {
        return response.status(404).json({
          error:
            "Image reference does not " +
            "contain blob_path",
          requestedLink: link,
        });
      }

      let resolved;

      try {
        resolved =
          resolveBlobReference(
            reference.blob_path,
            applicationConfig
              .storageContainer
          );
      } catch (error) {
        return response.status(400).json({
          error: error.message,
          storedPath:
            reference.blob_path,
        });
      }

      console.log(
        "Loading Azure image",
        {
          markdownLink: link,
          storedPath:
            reference.blob_path,
          container:
            resolved.containerName,
          blobName:
            resolved.blobName,
        }
      );

      const blobClient =
        blobContainerClient.getBlobClient(
          resolved.blobName
        );

      const exists =
        await blobClient.exists();

      if (!exists) {
        return response.status(404).json({
          error:
            "Referenced image does not " +
            "exist in Azure Storage",
          container:
            resolved.containerName,
          blobName:
            resolved.blobName,
        });
      }

      const download =
        await blobClient.download();

      response.setHeader(
        "Content-Type",
        download.contentType ||
          reference.content_type ||
          "image/png"
      );

      response.setHeader(
        "Cache-Control",
        "private, max-age=300"
      );

      if (
        !download.readableStreamBody
      ) {
        return response.status(500).json({
          error:
            "Azure Storage did not " +
            "return an image stream",
        });
      }

      download.readableStreamBody.on(
        "error",
        next
      );

      download.readableStreamBody.pipe(
        response
      );
    } catch (error) {
      next(error);
    }
  }
);


/**
 * Approve, reject or request changes for a fine-grained page.
 */
app.put(
  "/api/pages/:id/review",
  async (request, response, next) => {
    try {
      const decision = String(
        request.body.decision || ""
      )
        .trim()
        .toUpperCase();

      const comment = String(
        request.body.comment || ""
      )
        .trim()
        .slice(0, 4000);

      const validDecisions = [
        "APPROVED",
        "REJECTED",
        "NEEDS_CHANGES",
      ];

      if (
        !validDecisions.includes(decision)
      ) {
        return response.status(400).json({
          error:
            "decision must be APPROVED, " +
            "REJECTED, or NEEDS_CHANGES",
        });
      }

      const reviewId =
        crypto.randomUUID();

      const commonParameters = [
        parameter(
          "decision",
          decision
        ),
        parameter(
          "comment",
          comment
        ),
        parameter(
          "id",
          request.params.id
        ),
      ];

      await execute(
        applicationConfig,
        `
        UPDATE ${finePagesTable}
        SET
          review_status = :decision,
          reviewed_by = current_user(),
          reviewed_at =
            current_timestamp(),
          review_comment = :comment,
          approved_content_hash =
            CASE
              WHEN :decision =
                   'APPROVED'
              THEN sha2(
                markdown_content,
                256
              )
              ELSE NULL
            END
        WHERE fine_page_id = :id
          AND is_active = true
        `,
        commonParameters
      );

      await execute(
        applicationConfig,
        `
        INSERT INTO ${reviewsTable} (
          review_id,
          fine_page_id,
          decision,
          reviewer,
          reviewed_at,
          comment,
          content_hash
        )
        SELECT
          :reviewId,
          fine_page_id,
          :decision,
          current_user(),
          current_timestamp(),
          :comment,
          sha2(
            markdown_content,
            256
          )
        FROM ${finePagesTable}
        WHERE fine_page_id = :id
          AND is_active = true
        `,
        [
          ...commonParameters,
          parameter(
            "reviewId",
            reviewId
          ),
        ]
      );

      response.json({
        finePageId:
          request.params.id,
        reviewStatus:
          decision,
      });
    } catch (error) {
      next(error);
    }
  }
);



/** Bible-scene filter options, independent of maths. */
app.get("/api/bible/filter-options", async (_req, res, next) => {
  try {
    const items = await execute(applicationConfig, `
      SELECT DISTINCT book_id, chapter_id
      FROM ${bibleScenesTable}
      WHERE is_active = true AND book_id IS NOT NULL AND chapter_id IS NOT NULL
      ORDER BY book_id, chapter_id
    `);
    res.json({items});
  } catch (error) { next(error); }
});

/** List classified Bible scenes with their persisted analysis status and reviewer decisions. */
app.get("/api/bible/pages", async (req, res, next) => {
  try {
    await ensureBibleReviewTable();
    const params = [];
    const clauses = ["s.is_active = true"];
    const choices = {
      bookId: "s.book_id", chapterId: "s.chapter_id",
      pageType: "s.scene_type", reviewStatus: "COALESCE(r.review_status, 'PENDING')",
    };
    for (const [key, column] of Object.entries(choices)) {
      const value = String(req.query[key] || "").trim();
      if (value) { clauses.push(`${column} = :${key}`); params.push(parameter(key, value)); }
    }
    const limit = Math.max(1, Math.min(200, Math.trunc(Number(req.query.limit) || 100)));
    const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));
    const items = await execute(applicationConfig, `
      SELECT s.scene_id AS fine_page_id, s.analysis_id AS window_id,
        s.scene_id AS section_id, s.book_id, s.chapter_id,
        s.scene_type AS page_type, s.sequence_number, s.title,
        s.caption, s.scripture_references,
        CAST(NULL AS STRING) AS knowledge_id,
        s.markdown_content, s.block_ids, s.image_links,
        s.document_id, s.page_number,
        s.classification_confidence, s.review_required,
        a.processing_status AS classification_status,
        a.processing_error AS classification_error,
        COALESCE(r.review_status, 'PENDING') AS review_status,
        r.reviewed_by, r.reviewed_at, r.review_comment
      FROM ${bibleScenesTable} s
      LEFT JOIN ${bibleAnalysisTable} a ON s.analysis_id = a.analysis_id
      LEFT JOIN ${bibleReviewsTable} r ON s.scene_id = r.scene_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.book_id, s.chapter_id, s.page_number, s.sequence_number, s.scene_id
      LIMIT :limit OFFSET :offset
    `, [...params, parameter("limit", limit, "INT"), parameter("offset", offset, "INT")]);
    res.json({items: items.map(parseRow), limit, offset});
  } catch (error) { next(error); }
});

/** Persist Bible reviewer decisions independently of AI output, preserving rerun safety. */
app.put("/api/bible/pages/:id/review", async (req, res, next) => {
  try {
    await ensureBibleReviewTable();
    const decision = String(req.body?.decision || "").trim().toUpperCase();
    const comment = String(req.body?.comment || "").trim().slice(0, 4000);
    if (!["APPROVED", "REJECTED", "NEEDS_CHANGES"].includes(decision))
      return res.status(400).json({error:"Invalid review decision"});
    const [scene] = await execute(applicationConfig, `
      SELECT scene_id FROM ${bibleScenesTable} WHERE scene_id = :id AND is_active = true LIMIT 1
    `, [parameter("id", req.params.id)]);
    if (!scene) return res.status(404).json({error:"Active Bible scene not found"});
    await execute(applicationConfig, `
      MERGE INTO ${bibleReviewsTable} AS r
      USING (
        SELECT :id AS scene_id, :decision AS review_status,
          current_user() AS reviewed_by, current_timestamp() AS reviewed_at,
          :comment AS review_comment,
          sha2(markdown_content, 256) AS reviewed_content_hash
        FROM ${bibleScenesTable} WHERE scene_id = :id AND is_active = true
      ) AS n ON r.scene_id = n.scene_id
      WHEN MATCHED THEN UPDATE SET
        r.review_status = n.review_status, r.reviewed_by = n.reviewed_by,
        r.reviewed_at = n.reviewed_at, r.review_comment = n.review_comment,
        r.reviewed_content_hash = n.reviewed_content_hash
      WHEN NOT MATCHED THEN INSERT (
        scene_id, review_status, reviewed_by, reviewed_at, review_comment, reviewed_content_hash
      ) VALUES (n.scene_id, n.review_status, n.reviewed_by, n.reviewed_at,
        n.review_comment, n.reviewed_content_hash)
    `, [parameter("id", req.params.id), parameter("decision", decision), parameter("comment", comment)]);
    res.json({sceneId:req.params.id, reviewStatus:decision});
  } catch (error) { next(error); }
});

/** Serve only Azure image links explicitly associated with the requested Bible scene. */
app.get("/api/bible/pages/:id/image", async (req, res, next) => {
  try {
    const link = String(req.query.link || "").trim();
    if (!link || link.includes("..")) return res.status(400).json({error:"Invalid image link"});
    const [scene] = await execute(applicationConfig, `
      SELECT image_links FROM ${bibleScenesTable} WHERE scene_id = :id AND is_active = true LIMIT 1
    `, [parameter("id", req.params.id)]);
    if (!scene) return res.status(404).json({error:"Bible scene not found"});
    const links = typeof scene.image_links === "string"
      ? JSON.parse(scene.image_links) : (scene.image_links || []);
    if (!Array.isArray(links) || !links.includes(link))
      return res.status(404).json({error:"Image is not linked to this scene"});
    const resolved = resolveBlobReference(link, applicationConfig.storageContainer);
    const client = blobContainerClient.getBlobClient(resolved.blobName);
    if (!(await client.exists())) return res.status(404).json({error:"Image not found in Azure Storage"});
    const download = await client.download();
    res.setHeader("Content-Type", download.contentType || "image/png");
    res.setHeader("Cache-Control", "private, max-age=300");
    if (!download.readableStreamBody) return res.status(500).json({error:"Empty Azure image stream"});
    download.readableStreamBody.on("error", next);
    download.readableStreamBody.pipe(res);
  } catch (error) { next(error); }
});

/**
 * Serve the production React build.
 */
const currentFile =
  fileURLToPath(import.meta.url);

const currentDirectory =
  path.dirname(currentFile);

const distributionDirectory =
  path.resolve(
    currentDirectory,
    "../dist"
  );

app.use(
  express.static(
    distributionDirectory
  )
);


/**
 * React routing fallback for Express 5.
 */
app.get(
  "/{*path}",
  (_request, response) => {
    response.sendFile(
      path.join(
        distributionDirectory,
        "index.html"
      )
    );
  }
);


/**
 * Central API error handler.
 */
app.use(
  (
    error,
    _request,
    response,
    _next
  ) => {
    console.error(error);

    if (response.headersSent) {
      return;
    }

    response.status(500).json({
      error:
        error.message ||
        "Unexpected server error",
    });
  }
);


app.listen(
  applicationConfig.port,
  "0.0.0.0",
  () => {
    console.log(
      `Silver Page Reviewer listening on ` +
      `${applicationConfig.port}`
    );
  }
);