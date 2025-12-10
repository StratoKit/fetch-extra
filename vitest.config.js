import {defineConfig} from 'vitest/config'

export default defineConfig({
	test: {
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			lines: 92,
			functions: 81,
			branches: 81,
			statements: 91,
		},
	},
})
