// The docs site for cdk-github-microvm-runners.
//
// Content comes from the repository's own docs/ directory through the symlink
// at src/content/docs/guides, so the pages published here are the same files
// `just docs-examples` type-checks. There is no second copy to drift.
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import mermaid from 'astro-mermaid';
import starlightLlmsTxt from 'starlight-llms-txt';
import { dropLeadingHeading } from './src/plugins/drop-leading-heading.mjs';
import { rewriteGuideLinks } from './src/plugins/rewrite-guide-links.mjs';

export default defineConfig({
  site: 'https://runnerset.dev',
  markdown: {
    // Two consequences of publishing the repository's own Markdown as pages.
    // The guides carry no frontmatter, so each one's title is its first `#`
    // heading (see src/content.config.ts) and Starlight renders that title
    // itself, so the heading is dropped from the body. And a guide links to
    // another guide by file name, which is right when the file is browsed on
    // GitHub but has to become a route when it is served.
    //
    // `markdown.remarkPlugins` is deprecated in Astro 7; the pipeline is
    // extended through `unified()` instead.
    processor: unified({
      remarkPlugins: [dropLeadingHeading, rewriteGuideLinks],
    }),
  },
  integrations: [
    // The guides embed mermaid diagrams in ```mermaid fences, which GitHub
    // renders natively — so they looked right in the repository and fell
    // through to a plain code block here, which is how it went unnoticed.
    //
    // Rendering happens in the browser rather than at build time. The
    // build-time alternative renders to SVG through a headless browser, which
    // would mean installing Playwright and a Chromium download in CI on every
    // pull request, for two diagrams.
    //
    // MUST come before starlight() — the integration rewrites the fences the
    // Starlight pipeline then renders.
    mermaid({
      // Follow the reader's light/dark choice. Starlight writes the theme to
      // html[data-theme], which this reads, and re-renders when it changes.
      autoTheme: true,
      theme: 'neutral',
    }),
    starlight({
      title: 'cdk-github-microvm-runners',
      description:
        'GitHub Actions jobs on AWS Lambda MicroVMs, one ephemeral runner per job.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/schuettc/cdk-github-microvm-runners',
        },
      ],
      plugins: [
        starlightLlmsTxt({
          // llms-small.txt is the abridged set, for a model with a small
          // context window. Left alone it was 90% the size of llms-full.txt,
          // which makes it pointless: the generated API reference is 65% of
          // the total on its own. Both pages dropped here are ones a model
          // can answer without.
          //
          // `api` is the exhaustive generated reference. The guides state the
          // options and their defaults inline, so the abridged set can teach
          // the library without it; a model that needs every property reads
          // llms-full.txt or /api/.
          //
          // `guides/architecture` describes how the control plane works
          // internally, which does not change how the API is used.
          //
          // The service quotas guide stays: it carries hard AWS limits that
          // decide what a deployment can actually run, so answers are wrong
          // without it.
          exclude: ['api', 'guides/architecture'],
        }),
      ],
      // Ordered as a reader moves through it: deploy a runner set, point a
      // repository at it, understand what that built, then tune it. Onboarding
      // is the direct sequel to getting started rather than one guide among
      // several, and architecture is the bridge from doing to tuning.
      sidebar: [
        { label: 'Getting started', slug: 'guides/getting-started' },
        { label: 'Onboarding a repository', slug: 'guides/onboarding' },
        { label: 'Architecture', slug: 'guides/architecture' },
        {
          label: 'Guides',
          items: [
            { label: 'Runner images', slug: 'guides/images' },
            { label: 'Toolchains', slug: 'guides/toolchains' },
            { label: 'Warm pools', slug: 'guides/warm-pools' },
            { label: 'Logging', slug: 'guides/logging' },
            { label: 'Monitoring', slug: 'guides/monitoring' },
            { label: 'Service quotas', slug: 'guides/service-quotas' },
          ],
        },
        { label: 'Security', slug: 'guides/security' },
        // Written from the repository root's generated API.md by
        // scripts/generate-api-page.mjs, which runs as the `prebuild` script.
        { label: 'API reference', slug: 'api' },
      ],
    }),
  ],
});
