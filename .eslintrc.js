/* eslint sort-keys: "error" */

// The nicest rules
const nicest = {
	'default-param-last': 1,
	eqeqeq: [2, 'allow-null'], // == and != are nice for null+undefined
	'no-console': 2, // we want a clean console - eslint-disable every wanted one
	'no-implicit-coercion': [2, {allow: ['!!']}], // !! is fun
	'no-shadow': 2, // sometimes causes logic bugs.
	'no-unused-vars': [
		'error',
		{
			argsIgnorePattern: '^_',
			ignoreRestSiblings: true,
			varsIgnorePattern: '^_',
		},
	], // allow unused vars starting with _
	'object-shorthand': 2,
	'prefer-destructuring': [
		2,
		{AssignmentExpression: {array: false, object: false}},
	],
	'prettier/prettier': 1, // don't distract while programming
	'valid-typeof': [2, {requireStringLiterals: true}],
}

// Would be nice to make these error
const maybe = {
	'no-warning-comments': 1, // set to 0 and remove allowWarning from unicorn rule above
	'require-atomic-updates': 1, // too many false positives
}

// these rules suck
const suck = {
	'capitalized-comments': 0,
	'no-eq-null': 0,
	'no-mixed-operators': 0,
	'one-var': 0,
	'padding-line-between-statements': 0,
	'prefer-template': 0,
}

const rules = {...nicest, ...maybe, ...suck}

module.exports = {
	env: {
		commonjs: true,
		es2021: true,
		node: true,
	},
	extends: [
		'eslint:recommended',
		'plugin:jest/recommended',
		// Keep this last, it overrides all style rules
		'plugin:prettier/recommended',
	],
	ignorePatterns: ['/build/**/*', '/coverage/**/*', '/dist/**/*'],
	plugins: ['jest'],
	reportUnusedDisableDirectives: true,
	rules,
	settings: {
		jest: {version: '27'},
	},
}
