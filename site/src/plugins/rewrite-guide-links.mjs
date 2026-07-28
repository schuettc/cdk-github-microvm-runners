import { existsSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory the content collection is rooted at. A page's route is its path
 * relative to this, without the extension.
 */
const CONTENT_ROOT = fileURLToPath(new URL('../content/docs', import.meta.url));

/** A link this plugin leaves alone: absolute, external, or an anchor. */
const IS_NOT_RELATIVE = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * Files that live outside the content collection but do have a page on the
 * site, keyed by file name and mapped to the route that serves them.
 *
 * A guide's `[API.md](../API.md)` is the correct link on GitHub, where the
 * generated reference sits at the repository root. On the site that file is
 * the page at `/api/`, written into the collection by
 * scripts/generate-api-page.mjs. Without this the link would resolve to a path
 * outside the collection and be left alone — right for a link that has no page
 * here, wrong for this one.
 *
 * Matching on the file name rather than on the resolved path keeps the result
 * the same on every filesystem: a case-insensitive one resolves `../API.md`
 * from a guide onto the generated `api.md` and would yield a `/API/` route
 * that exists only on macOS.
 */
const PAGES_OUTSIDE_THE_COLLECTION = new Map([['API.md', '/api/']]);

/**
 * Rewrites a guide's relative Markdown links to the routes they become.
 *
 * The guides under docs/ are the same files a reader browses on GitHub, where
 * `[toolchains](toolchains.md)` is the correct link. Published, that file is
 * served at `/guides/toolchains/`, so the link has to be rewritten — otherwise
 * every cross-reference between guides is a dead link on the site.
 *
 * A link whose target is not a file in the collection is left untouched, so a
 * link out of the collection stays visible as one rather than being rewritten
 * into a route that does not exist. The exception is a file listed in
 * PAGES_OUTSIDE_THE_COLLECTION, which does have a route to point at.
 *
 * @returns {(tree: object, file: { path?: string }) => void}
 */
export function rewriteGuideLinks() {
  return (tree, file) => {
    const from = file?.path;
    if (!from) return;
    const dir = dirname(from);

    walk(tree, (node) => {
      if (node.type !== 'link' && node.type !== 'definition') return;
      const url = node.url;
      if (typeof url !== 'string' || IS_NOT_RELATIVE.test(url)) return;

      const [target, hash] = splitHash(url);
      if (!target.endsWith('.md') && !target.endsWith('.mdx')) return;

      const mapped = PAGES_OUTSIDE_THE_COLLECTION.get(basename(target));
      if (mapped) {
        node.url = `${mapped}${hash}`;
        return;
      }

      const absolute = resolve(dir, target);
      if (!existsSync(absolute)) return;

      const route = relative(CONTENT_ROOT, absolute).replace(/\.mdx?$/, '');
      if (route.startsWith('..')) return;

      node.url = `/${route}/${hash}`;
    });
  };
}

/** @param {string} url */
function splitHash(url) {
  const index = url.indexOf('#');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)];
}

/**
 * @param {any} node
 * @param {(node: any) => void} visit
 */
function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}
