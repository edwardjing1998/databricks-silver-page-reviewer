import path from 'node:path';

const tidy = value => String(value || '').trim();

export function candidateBibleBlobPaths(link, scene, source = {}) {
  const requested = tidy(link).replace(/^\.\//, '');
  if (!requested || requested.includes('..') || requested.startsWith('/')) throw new Error('Invalid image link');
  const candidates = [];
  const add = value => {
    const result = tidy(value);
    if (result && !candidates.includes(result)) candidates.push(result);
  };

  // If Bronze has a resolved image manifest, it is the authoritative location.
  let references = source.image_references_json || source.image_references || [];
  if (typeof references === 'string') {
    try { references = JSON.parse(references); } catch { references = []; }
  }
  if (Array.isArray(references)) {
    const image = references.find(item => item && (
      item.original_link === requested || item.file_name === path.posix.basename(requested)
    ));
    if (image?.blob_path) add(image.blob_path);
  }

  // Resolve relative Markdown figures against the directory of the source Markdown.
  for (const key of ['markdown_blob_path', 'markdown_path', 'blob_path', 'source_path', 'file_path', 'path']) {
    const sourcePath = tidy(source[key]);
    if (!sourcePath) continue;
    const cleanPath = sourcePath.split('?')[0].replace(/\\/g, '/');
    if (!/\.(md|markdown)$/i.test(cleanPath)) continue;
    add(cleanPath.slice(0, cleanPath.lastIndexOf('/') + 1) + requested);
  }

  // Compatible with the Document Intelligence output layout:
  // generated/{book}/{chapter}/{page}/content.md + figures/...
  const book = tidy(scene.book_id);
  const chapter = tidy(scene.chapter_id);
  const page = tidy(scene.page_number);
  if (book && chapter && page && /^\d+$/.test(page)) {
    add(`generated/${book}/${chapter}/${page}/${requested}`);
    add(`generated/${book}/${chapter}/page_${page}/${requested}`);
  }
  // Some Bronze rows retain the page's original filename instead of its ordinal.
  for (const key of ['page_id', 'page_name', 'source_page_id']) {
    const name = tidy(source[key]);
    if (book && chapter && name && !name.includes('/') && !name.includes('..')) {
      add(`generated/${book}/${chapter}/${name}/${requested}`);
    }
  }
  // Last resort for legacy entries already containing a complete blob path.
  add(requested);
  return candidates;
}
