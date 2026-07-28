// The content collection is pointed at src/content/docs/guides, which is a
// symlink to the repository's own docs/ directory. Those files are the single
// copy of every guide: `just docs-examples` type-checks their TypeScript and
// `scripts/sync-docs.mjs` checks their shared fragments, so the site reads them
// in place rather than taking a copy that would drift.
//
// Two consequences of reading them in place, handled here:
//
//  1. docs/_shared/ holds fragments that sync-docs splices into the guides.
//     They are not pages, so the glob excludes them. Starlight's own
//     docsLoader() only skips files whose NAME starts with an underscore, which
//     would still route _shared/branch-model.md, so the loader is built from
//     astro/loaders' glob() with an explicit exclusion instead.
//  2. The guides carry no frontmatter — they are read as plain Markdown in the
//     repository — but Starlight requires a title. parseData is wrapped to take
//     the title from each file's first level-one heading. That heading is then
//     dropped from the rendered body by the remark plugin in astro.config.mjs,
//     so the title appears once.
import { readFile } from 'node:fs/promises';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
import type { Loader, LoaderContext } from 'astro/loaders';
import { defineCollection } from 'astro:content';

/** The first level-one ATX heading outside a fenced code block. */
function firstHeading(markdown: string): string | undefined {
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Wraps a loader so an entry with no `title` in its frontmatter takes one from
 * its first level-one heading. Everything else — schema validation included —
 * is left to the wrapped loader's own parseData.
 */
function titleFromHeading(loader: Loader): Loader {
  return {
    name: `${loader.name}-title-from-heading`,
    load: (context: LoaderContext) =>
      loader.load({
        ...context,
        parseData: async (props) => {
          const data = props.data as Record<string, unknown>;
          if (data.title === undefined && props.filePath) {
            const title = firstHeading(await readFile(props.filePath, 'utf8'));
            if (title === undefined) {
              throw new Error(
                `${props.filePath} has neither a \`title\` in its frontmatter nor a level-one heading to take one from.`,
              );
            }
            data.title = title;
          }
          return context.parseData(props);
        },
      }),
  };
}

export const collections = {
  docs: defineCollection({
    loader: titleFromHeading(
      glob({
        base: './src/content/docs',
        pattern: ['**/[^_]*.{md,mdx}', '!**/_*/**'],
      }),
    ),
    schema: docsSchema(),
  }),
};
