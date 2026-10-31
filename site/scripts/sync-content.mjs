// Builds the Starlight content from the repository README.
//
// The README stays the single source of truth (and keeps rendering on GitHub and npm).
// This script splits it into pages: the introduction and the first sections make the home page,
// every other `##` section is a page of the "guide" folder. It adds the front matter, keeps the
// links between sections working by pointing them at the page that holds the heading. Its output is
// generated and git-ignored.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { base } from '../site.mjs';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.resolve(siteDir, '..', 'README.md');
const docsDir = path.join(siteDir, 'src/content/docs');

// Content that belongs to the README only (such as the link to this site and the list of
// sections, which the sidebar replaces) sits between these markers
const SKIP_START = '<!-- docs-site:skip-start -->';
const SKIP_END = '<!-- docs-site:skip-end -->';
// `##` sections that stay on the home page instead of getting a page of their own
const HOME_SECTIONS = new Set(['how it works', 'install']);
// Shorter page names than the slug of the section title
const PAGE_NAMES = new Map([
	['example: test a skill end to end', 'example'],
	['the release gate', 'release-gate'],
]);

// What GitHub renders for a heading: its anchor id is computed from this text
const headingText = (raw) =>
	raw
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/`/g, '')
		.replace(/\\(.)/g, '$1')
		.trim();

// Absolute links, with the `base`: the links validator only checks those (relative ones are skipped)
const pageLink = (slug) => `${base}/${slug === '' ? '' : `${slug}/`}`;

const source = readFileSync(readmePath, 'utf8')
	.replace(/\r\n/g, '\n')
	.replace(new RegExp(`${SKIP_START}[\\s\\S]*?${SKIP_END}\\n?`, 'g'), '');

// 1. Classify the lines, ignoring anything inside a code fence. A fence closes only with the same
//    character, at least as many times, so a ```` block can show a ``` block. `anchor` is the id
//    GitHub gives the heading in the whole README: it is what the README's own links point to.
const readmeSlugger = new GithubSlugger();
let fence = null;
const lines = source.split('\n').map((text) => {
	if (fence) {
		const close = text.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
		if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
		return { text, fence: true };
	}
	const open = text.match(/^ {0,3}(`{3,}|~{3,})/);
	if (open) {
		fence = open[1];
		return { text, fence: true };
	}
	const match = text.match(/^(#{1,6})\s+(.+?)\s*$/);
	if (!match) return { text, fence: false };
	const title = headingText(match[2]);
	return { text, fence: false, heading: { level: match[1].length, raw: match[2], title, anchor: readmeSlugger.slug(title) } };
});
if (fence) throw new Error('README.md: a code block is not closed');

// 2. The text before the first `##`, and the HOME_SECTIONS, make the home page. Every other `##`
//    section is a page of the "guide" folder.
const firstSection = lines.findIndex((line) => line.heading?.level === 2);
if (firstSection < 0) throw new Error('README.md has no "##" section to build pages from');

const fileSlugger = new GithubSlugger();
const home = { slug: '', title: '', home: true, lines: lines.slice(0, firstSection) };
const pages = [home];
let current = home;
for (const line of lines.slice(firstSection)) {
	if (line.heading?.level === 2) {
		const title = line.heading.title;
		if (HOME_SECTIONS.has(title.toLowerCase())) {
			current = home;
		} else {
			const file = fileSlugger.slug(PAGE_NAMES.get(title.toLowerCase()) ?? title);
			current = { slug: `guide/${file}`, title, home: false, lines: [] };
			pages.push(current);
		}
	}
	current.lines.push(line);
}

// 3. Work out what Starlight will render for each page, and the id every heading gets there.
//    The page title is rendered by Starlight (it is not part of the body) and, on the guide pages,
//    the deeper headings move one level up. Astro numbers duplicate headings per page, hence one
//    slugger per page.
const anchors = new Map(); // README anchor -> { page, id } (id is null for a page title)
for (const page of pages) {
	const slugger = new GithubSlugger();
	let titleSeen = false;
	for (const line of page.lines) {
		const heading = line.heading;
		if (!heading) continue;
		const isTitle = page.home ? heading.level === 1 && !titleSeen : heading.level === 2 && !titleSeen;
		if (isTitle) {
			titleSeen = true;
			if (page.home) page.title = heading.title;
			line.drop = true;
			anchors.set(heading.anchor, { page, id: null });
			continue;
		}
		heading.shownLevel = page.home ? heading.level : heading.level - 1;
		heading.id = slugger.slug(heading.title);
		anchors.set(heading.anchor, { page, id: heading.id });
	}
}

const rewriteLinks = (text, page) =>
	text.replace(/\]\(#([^)\s]+)\)/g, (_match, anchor) => {
		const target = anchors.get(anchor);
		if (!target) throw new Error(`README.md: the link "#${anchor}" does not match any heading`);
		if (target.page === page) return `](#${target.id ?? '_top'})`;
		return `](${pageLink(target.page.slug)}${target.id ? `#${target.id}` : ''})`;
	});

// Text such as <skill>.json written outside code would be read as an HTML tag and vanish
const warnAboutHtmlLikeText = (text, page) => {
	const plain = text.replace(/`[^`]*`/g, '').replace(/\\[<>]/g, '');
	if (/<(?!https?:|mailto:|!--|br\s*\/?>)[A-Za-z/]/.test(plain)) {
		console.warn(`warning: "${page.title || 'home'}" has text that may be read as an HTML tag: ${text.trim().slice(0, 80)}`);
	}
};

// 4. Write the pages
rmSync(docsDir, { recursive: true, force: true });

const guidePages = pages.filter((page) => !page.home);
let order = 0;
for (const page of pages) {
	const body = page.lines
		.filter((line) => !line.drop)
		.map((line) => {
			if (line.fence) return line.text;
			if (line.heading) return `${'#'.repeat(line.heading.shownLevel)} ${line.heading.raw}`;
			warnAboutHtmlLikeText(line.text, page);
			return rewriteLinks(line.text, page);
		});

	// no leading blank lines, no trailing blank lines or rules (the next section starts with its own title)
	while (body.length && /^\s*$/.test(body[0])) body.shift();
	while (body.length && /^(---|\s*)$/.test(body[body.length - 1])) body.pop();

	if (page.home) {
		const escape = (value) => value.replace(/[<>]/g, (char) => `\\${char}`);
		body.push('', '## Documentation', '', ...guidePages.map((guide) => `- [${escape(guide.title)}](${pageLink(guide.slug)})`));
	}

	const frontMatter = ['---', `title: ${JSON.stringify(page.title)}`];
	if (!page.home) frontMatter.push('sidebar:', `  order: ${++order}`);
	frontMatter.push('---');

	const outFile = path.join(docsDir, page.home ? 'index.md' : `${page.slug}.md`);
	mkdirSync(path.dirname(outFile), { recursive: true });
	writeFileSync(outFile, `${frontMatter.join('\n')}\n\n${body.join('\n')}\n`);
}

console.log(`sync-content: ${pages.length} pages from README.md`);
