// https://github.com/nodejs/undici/blob/main/types/fetch.d.ts#L28
export const RESPONSE_TYPES = new Set([
	'arrayBuffer',
	'blob',
	'formData',
	'json',
	'text',
])

export const STATE_INTERNAL = Symbol('INTERNAL')
