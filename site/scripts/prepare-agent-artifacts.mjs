// Prepares the model-facing artifacts the site serves, and refuses to build
// when they have drifted from the repository.
//
// 1. Copies the agent skills from .claude/skills/ to public/skills/<name>.md,
//    so the same files an npm consumer gets under skills/ are fetchable at
//    runnerset.dev/skills/<name>.md. Copied verbatim, frontmatter included —
//    the frontmatter is what makes the file an installable skill.
//
// 2. Checks src/llms-details.md, the hand-authored body of /llms.txt:
//    every /guides/<slug>/ link must name a file in docs/, every /skills/
//    link must name a skill that was just copied, and every guide in docs/
//    must be linked at least once — the routing table covers the whole set
//    or the build fails. Mechanical, so the authored index cannot rot the
//    way hand-maintained indexes do.
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');

const skillsDir = join(repo, '.claude', 'skills');
const skills = readdirSync(skillsDir);
mkdirSync(join(site, 'public', 'skills'), { recursive: true });
for (const name of skills) {
  copyFileSync(
    join(skillsDir, name, 'SKILL.md'),
    join(site, 'public', 'skills', `${name}.md`),
  );
}

const details = readFileSync(join(site, 'src', 'llms-details.md'), 'utf8');
const guides = readdirSync(join(repo, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''));

const errors = [];

for (const [, slug] of details.matchAll(
  /runnerset\.dev\/guides\/([\w-]+)\//g,
)) {
  if (!guides.includes(slug)) {
    errors.push(
      `llms-details.md links /guides/${slug}/ but docs/${slug}.md does not exist`,
    );
  }
}
for (const [, name] of details.matchAll(
  /runnerset\.dev\/skills\/([\w-]+)\.md/g,
)) {
  if (!skills.includes(name)) {
    errors.push(
      `llms-details.md links /skills/${name}.md but .claude/skills/${name}/ does not exist`,
    );
  }
}
for (const slug of guides) {
  if (!details.includes(`runnerset.dev/guides/${slug}/`)) {
    errors.push(
      `docs/${slug}.md is not linked from llms-details.md — add it to the routing list`,
    );
  }
}
for (const name of skills) {
  if (!details.includes(`runnerset.dev/skills/${name}.md`)) {
    errors.push(
      `skill "${name}" is not linked from llms-details.md — add it to the agent-skills list`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.map((e) => `prepare-agent-artifacts: ${e}`).join('\n'));
  process.exit(1);
}
console.log(
  `prepare-agent-artifacts: ${skills.length} skills staged, llms-details links verified`,
);
