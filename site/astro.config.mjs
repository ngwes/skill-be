// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import { base } from './site.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://ngwes.github.io',
	base,
	integrations: [
		starlight({
			title: 'skillBe',
			description:
				'A CLI that benchmarks Agent Skills: baseline versus with-skill, LLM-graded and gated, on any harness.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/ngwes/skillBe' },
				// Add the npm link ({ icon: 'npm', ... @ngwes/skillbe }) once the package is published
			],
			// Fails the build on a broken page or anchor link. It only checks absolute links (with the
			// `base`), which is what the sync script generates.
			plugins: [starlightLinksValidator()],
			sidebar: [
				{ label: 'Start here', slug: 'index' },
				{ label: 'Documentation', items: [{ autogenerate: { directory: 'guide' } }] },
			],
		}),
	],
});
