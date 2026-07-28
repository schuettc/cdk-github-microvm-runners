/**
 * Removes a document's leading level-one heading.
 *
 * The guides under docs/ are read from the repository as plain Markdown, so
 * their title is the first `#` heading in the body rather than frontmatter.
 * src/content.config.ts lifts that heading into the entry's `title`, and
 * Starlight renders the title itself — so the heading is dropped here to keep
 * it from appearing a second time in the page body.
 *
 * @returns {(tree: { children: Array<{ type: string, depth?: number }> }) => void}
 */
export function dropLeadingHeading() {
  return (tree) => {
    const first = tree.children[0];
    if (first?.type === 'heading' && first.depth === 1) {
      tree.children.shift();
    }
  };
}
