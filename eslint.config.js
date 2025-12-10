import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

import {FlatCompat} from '@eslint/eslintrc'
import js from '@eslint/js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
	baseDirectory: __dirname,
})

const nicest = {
	'default-param-last': 1,
	eqeqeq: [2, 'allow-null'],
	'no-console': 2,
	'no-implicit-coercion': [2, {allow: ['!!']}],
	'no-shadow': 2,
	'no-unused-vars': [
		'error',
		{
			argsIgnorePattern: '^_',
			ignoreRestSiblings: true,
			varsIgnorePattern: '^_',
		},
	],
	'object-shorthand': 2,
	'prefer-destructuring': [
		2,
		{
			AssignmentExpression: {array: false, object: false},
		},
	],
	'prettier/prettier': 1,
	'valid-typeof': [2, {requireStringLiterals: true}],
}

const maybe = {
	'no-warning-comments': 1,
	'require-atomic-updates': 1,
}

const suck = {
	'capitalized-comments': 0,
	'no-eq-null': 0,
	'no-mixed-operators': 0,
	'one-var': 0,
	'padding-line-between-statements': 0,
	'prefer-template': 0,
}

const rules = {...nicest, ...maybe, ...suck}

export default [
	{
		ignores: [
			'build/**',
			'coverage/**',
			'dist/**',
			'node_modules/**',
			'playground.mjs',
		],
	},
	js.configs.recommended,
	...compat.config({
		env: {
			commonjs: true,
			es2021: true,
			node: true,
		},
		extends: ['plugin:prettier/recommended'],
		reportUnusedDisableDirectives: true,
		rules,
	}),
]
