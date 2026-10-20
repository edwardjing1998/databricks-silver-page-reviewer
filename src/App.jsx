import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";


const emptyFilters = {
  bookId: "",
  chapterId: "",
  pageType: "",
  reviewStatus: "",
};


async function request(
  url,
  options
) {
  const response =
    await fetch(url, options);

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ||
      `Request failed: ${response.status}`
    );
  }

  return data;
}


export default function App() {
  const [mode, setMode] = useState("math");
  const bible = mode === "bible";
  const apiBase = bible ? "/api/bible/pages" : "/api/pages";
  const [
    filters,
    setFilters,
  ] = useState(emptyFilters);

  const [
    filterOptions,
    setFilterOptions,
  ] = useState([]);

  const [
    pages,
    setPages,
  ] = useState([]);

  const [
    selected,
    setSelected,
  ] = useState(null);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    filtersLoading,
    setFiltersLoading,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  const [
    comment,
    setComment,
  ] = useState("");

  const [
    saving,
    setSaving,
  ] = useState(false);


  /**
   * Build the query string sent to GET /api/pages.
   */
  const query = useMemo(() => {
    const parameters =
      new URLSearchParams({
        limit: "100",
        offset: "0",
      });

    Object.entries(filters)
      .forEach(
        ([key, value]) => {
          if (value) {
            parameters.set(
              key,
              value
            );
          }
        }
      );

    return parameters.toString();
  }, [filters]);


  /**
   * Load fine-grained pages using the selected filters.
   */
  const loadPages =
    useCallback(
      async () => {
        setLoading(true);
        setError("");

        try {
          const data =
            await request(
              `${apiBase}?${query}`
            );

          const loadedPages =
            data.items || [];

          setPages(loadedPages);

          setSelected(current => {
            const currentStillExists =
              loadedPages.find(
                page =>
                  page.fine_page_id ===
                  current?.fine_page_id
              );

            return (
              currentStillExists ||
              loadedPages[0] ||
              null
            );
          });
        } catch (requestError) {
          setError(
            requestError.message
          );
        } finally {
          setLoading(false);
        }
      },
      [query, apiBase]
    );


  /**
   * Load pages whenever filter values change.
   */
  useEffect(() => {
    loadPages();
  }, [loadPages]);


  /**
   * Load distinct Book ID and Chapter ID values.
   */
  useEffect(() => {
    let cancelled = false;

    async function loadFilterOptions() {
      setFiltersLoading(true);

      try {
        const data =
          await request(
            bible ? "/api/bible/filter-options" : "/api/filter-options"
          );

        if (!cancelled) {
          setFilterOptions(
            data.items || []
          );
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(
            requestError.message
          );
        }
      } finally {
        if (!cancelled) {
          setFiltersLoading(false);
        }
      }
    }

    loadFilterOptions();

    return () => {
      cancelled = true;
    };
  }, [bible]);


  /**
   * Extract the distinct Book IDs.
   */
  const bookOptions =
    useMemo(
      () => [
        ...new Set(
          filterOptions
            .map(
              item =>
                item.book_id
            )
            .filter(Boolean)
        ),
      ],
      [filterOptions]
    );


  /**
   * Show only chapters belonging to the selected book.
   *
   * When no book is selected, chapters from every book are shown.
   */
  const chapterOptions =
    useMemo(
      () => [
        ...new Set(
          filterOptions
            .filter(
              item =>
                !filters.bookId ||
                item.book_id ===
                  filters.bookId
            )
            .map(
              item =>
                item.chapter_id
            )
            .filter(Boolean)
        ),
      ],
      [
        filterOptions,
        filters.bookId,
      ]
    );


  /**
   * Clear the current chapter whenever the Book ID changes.
   */
  function selectBook(bookId) {
    setFilters(current => ({
      ...current,
      bookId,
      chapterId: "",
    }));
  }


  const selectedIndex =
    pages.findIndex(
      page =>
        page.fine_page_id ===
        selected?.fine_page_id
    );


  function imageUrl(source) {
    if (!selected) {
      return "";
    }

    return (
      `${apiBase}/` +
      `${encodeURIComponent(
        selected.fine_page_id
      )}/image?link=` +
      encodeURIComponent(source)
    );
  }


  async function review(decision) {
    if (!selected) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      await request(
        `${apiBase}/${encodeURIComponent(
          selected.fine_page_id
        )}/review`,
        {
          method: "PUT",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            decision,
            comment,
          }),
        }
      );

      setComment("");

      await loadPages();
    } catch (requestError) {
      setError(
        requestError.message
      );
    } finally {
      setSaving(false);
    }
  }


  return (
    <div className="app-shell">
      <header>
        <div>
          <span className="eyebrow">
            Databricks Silver
          </span>

          <h1>
            {bible ? "Bible scene review" : "Fine-grained page review"}
          </h1>
        </div>

        <button
          className="secondary"
          onClick={loadPages}
          disabled={loading}
        >
          Refresh
        </button>
      </header>


      <nav className="mode-tabs" aria-label="Reviewer mode">
        <button className={bible ? "" : "selected"} onClick={() => {
          setMode("math"); setFilters({...emptyFilters}); setSelected(null); setComment("");
        }}>Mathematics pages</button>
        <button className={bible ? "selected" : ""} onClick={() => {
          setMode("bible"); setFilters({...emptyFilters}); setSelected(null); setComment("");
        }}>Bible pages &amp; scenes</button>
      </nav>
      <section className="filters">
        <label>
          Book ID

          <select
            value={filters.bookId}
            disabled={filtersLoading}
            onChange={event =>
              selectBook(
                event.target.value
              )
            }
          >
            <option value="">
              {filtersLoading
                ? "Loading books…"
                : "All books"}
            </option>

            {bookOptions.map(
              bookId => (
                <option
                  key={bookId}
                  value={bookId}
                >
                  {bookId}
                </option>
              )
            )}
          </select>
        </label>


        <label>
          Chapter ID

          <select
            value={filters.chapterId}
            disabled={filtersLoading}
            onChange={event =>
              setFilters(
                current => ({
                  ...current,
                  chapterId:
                    event.target.value,
                })
              )
            }
          >
            <option value="">
              {filtersLoading
                ? "Loading chapters…"
                : "All chapters"}
            </option>

            {chapterOptions.map(
              chapterId => (
                <option
                  key={chapterId}
                  value={chapterId}
                >
                  {chapterId}
                </option>
              )
            )}
          </select>
        </label>


        <label>
          Page type

          <select
            value={filters.pageType}
            onChange={event =>
              setFilters(
                current => ({
                  ...current,
                  pageType:
                    event.target.value,
                })
              )
            }
          >
            <option value="">
              All types
            </option>

            {bible ? <>
              {["SCRIPTURE_STORY", "SCRIPTURE_REFERENCE", "DOCTRINAL_TEACHING",
                "LIFE_APPLICATION", "DISCUSSION_QUESTION", "PRAYER_REFLECTION",
                "TABLE_OF_CONTENTS", "OTHER"].map(type =>
                  <option key={type} value={type}>{type}</option>)}
            </> : <>
            <option value="KNOWLEDGE">
              KNOWLEDGE
            </option>

            <option value="EXAMPLE">
              EXAMPLE
            </option>

            <option value="EXERCISE">
              EXERCISE
            </option>

            <option value="OTHER">
              OTHER
            </option>
            </>}
          </select>
        </label>


        <label>
          Review status

          <select
            value={filters.reviewStatus}
            onChange={event =>
              setFilters(
                current => ({
                  ...current,
                  reviewStatus:
                    event.target.value,
                })
              )
            }
          >
            <option value="">
              All statuses
            </option>

            <option value="PENDING">
              PENDING
            </option>

            <option value="APPROVED">
              APPROVED
            </option>

            <option value="REJECTED">
              REJECTED
            </option>

            <option value="NEEDS_CHANGES">
              NEEDS_CHANGES
            </option>
          </select>
        </label>
      </section>


      {error && (
        <div className="error">
          <strong>
            Unable to complete request
          </strong>

          <span>
            {error}
          </span>
        </div>
      )}


      <main>
        <aside>
          <div className="list-title">
            <strong>
              Pages
            </strong>

            <span>
              {pages.length}
            </span>
          </div>

          {loading ? (
            <p className="muted">
              Loading…
            </p>
          ) : (
            pages.map(page => (
              <button
                key={page.fine_page_id}
                className={
                  `page-row ${
                    selected
                      ?.fine_page_id ===
                    page.fine_page_id
                      ? "active"
                      : ""
                  }`
                }
                onClick={() =>
                  setSelected(page)
                }
              >
                <span
                  className={
                    `type ${
                      page.page_type
                        ?.toLowerCase()
                    }`
                  }
                >
                  {page.page_type}
                </span>

                <strong>
                  {page.title ||
                    "Untitled page"}
                </strong>

                <small>
                  {page.book_id}
                  {" · "}
                  {page.chapter_id}
                  {" · #"}
                  {page.sequence_number}
                </small>

                <span
                  className={
                    `status ${
                      String(
                        page.review_status ||
                        "PENDING"
                      ).toLowerCase()
                    }`
                  }
                >
                  {page.review_status ||
                    "PENDING"}
                </span>
              </button>
            ))
          )}
        </aside>


        <article>
          {!selected ? (
            <div className="empty">
              {bible ? "No active Bible scenes" : "No active fine-grained pages"}
              {" matched the selected filters."}
            </div>
          ) : (
            <>
              <div className="article-head">
                <div>
                  <span
                    className={
                      `type ${
                        selected.page_type
                          ?.toLowerCase()
                      }`
                    }
                  >
                    {selected.page_type}
                  </span>

                  <h2>
                    {selected.title}
                  </h2>
                </div>

                <div className="pager">
                  <button
                    className="secondary"
                    disabled={
                      selectedIndex <= 0
                    }
                    onClick={() =>
                      setSelected(
                        pages[
                          selectedIndex - 1
                        ]
                      )
                    }
                  >
                    ← Previous
                  </button>

                  <span>
                    {selectedIndex + 1}
                    {" / "}
                    {pages.length}
                  </span>

                  <button
                    className="secondary"
                    disabled={
                      selectedIndex < 0 ||
                      selectedIndex >=
                        pages.length - 1
                    }
                    onClick={() =>
                      setSelected(
                        pages[
                          selectedIndex + 1
                        ]
                      )
                    }
                  >
                    Next →
                  </button>
                </div>
              </div>


              <div className="metadata">
                <span>
                  <b>{bible ? "Scripture references" : "Knowledge"}</b>
                  {bible ? (selected.scripture_references || []).join(", ") : selected.knowledge_id}
                </span>

                <span>
                  <b>Confidence</b>
                  {Math.round(
                    (
                      selected
                        .classification_confidence ||
                      0
                    ) * 100
                  )}
                  %
                </span>

                <span>
                  <b>Classification</b>
                  {
                    selected
                      .classification_status
                  }
                </span>

                <span>
                  <b>Review</b>
                  {
                    selected.review_status ||
                    "PENDING"
                  }
                </span>

                <span>
                  <b>{bible ? "Page number" : "Source pages"}</b>
                  {bible ? selected.page_number : (
                    selected
                      .source_page_numbers ||
                    []
                  ).join(", ")}
                </span>

                <span>
                  <b>{bible ? "AI review required" : "Preserved"}</b>
                  {bible ? (selected.review_required === true || String(selected.review_required) === "true" ? "Yes" : "No") : (
                    selected
                      .preserved_original
                      ? "Yes"
                      : "No"
                  )}
                </span>
              </div>


              <div className="markdown-page">
                <ReactMarkdown
                  remarkPlugins={[
                    remarkGfm,
                  ]}
                  rehypePlugins={[
                    rehypeSanitize,
                  ]}
                  components={{
                    img: ({
                      src = "",
                      alt = "",
                    }) => (
                      <img
                        src={imageUrl(src)}
                        alt={alt}
                        loading="lazy"
                      />
                    ),
                  }}
                >
                  {
                    selected
                      .markdown_content ||
                    "_No Markdown content._"
                  }
                </ReactMarkdown>
              </div>


              <section className="review-panel">
                <h3>
                  Human review
                </h3>

                <textarea
                  placeholder={
                    "Add a review comment…"
                  }
                  value={comment}
                  onChange={event =>
                    setComment(
                      event.target.value
                    )
                  }
                />

                <div className="review-actions">
                  <button
                    disabled={saving}
                    className="approve"
                    onClick={() =>
                      review("APPROVED")
                    }
                  >
                    ✓ Approve
                  </button>

                  <button
                    disabled={saving}
                    className="changes"
                    onClick={() =>
                      review(
                        "NEEDS_CHANGES"
                      )
                    }
                  >
                    Needs changes
                  </button>

                  <button
                    disabled={saving}
                    className="reject"
                    onClick={() =>
                      review("REJECTED")
                    }
                  >
                    Reject
                  </button>
                </div>

                {selected.reviewed_by && (
                  <small>
                    Last reviewed by{" "}
                    {selected.reviewed_by}
                    {" at "}
                    {selected.reviewed_at}
                  </small>
                )}
              </section>
            </>
          )}
        </article>
      </main>
    </div>
  );
}