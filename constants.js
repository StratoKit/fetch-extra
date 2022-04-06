// https://github.com/nodejs/undici/blob/main/types/fetch.d.ts#L28
const RESPONSE_TYPES = new Set([
	'arrayBuffer',
	'blob',
	'formData',
	'json',
	'text',
])

const STATE_INTERNAL = Symbol('INTERNAL')

module.exports = {RESPONSE_TYPES, STATE_INTERNAL}
