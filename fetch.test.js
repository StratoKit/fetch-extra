/* eslint no-shadow: ["error", { "allow": ["t"] }] */
import {describe, test, expect, beforeAll, afterAll} from 'vitest'
import fetch, {makeFetch} from './index.js'
import {fastify} from 'fastify'
import {Readable} from 'stream'
import {Blob} from 'buffer'
import debug from 'debug'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms).unref())

let globalId = 0
class TimeoutStream extends Readable {
	constructor(size, speed, requestTimeout = 0, timeouts = []) {
		super()
		this.size = size
		this.requestTimeout = requestTimeout
		this.timeouts = [...timeouts].sort(
			(a, b) => (a.after || 0) - (b.after || 0)
		)
		this._transferred = 0
		this.speed = speed
		this.dbg = debug(`timeoutStream:${globalId}`)
		this.dbg('init', {size, speed, requestTimeout, timeouts})
		globalId++
	}
	async _read(chunkSize) {
		if (this.requestTimeout) {
			this.dbg(`requestTimeout ${this.requestTimeout} ms`)
			await delay(this.requestTimeout)
			this.requestTimeout = 0
		}
		const toTransfer = Math.min(this.size - this._transferred, chunkSize)
		if (toTransfer === 0) {
			this.dbg('transfer done')
			this.push(null)
			return
		}
		// In Node 22+, fetch() waits for the first chunk before resolving,
		// so we send the first chunk immediately to avoid timeout during fetch()
		if (this.speed && this._transferred > 0) {
			await delay((toTransfer / this.speed) * 1000)
		}
		if (this.timeouts.length && this.timeouts[0].after <= this._transferred) {
			this.dbg(`bodyTimeout ${this.timeouts[0].time} ms`)
			await delay(this.timeouts[0].time)
			this.timeouts.splice(0, 1)
		}
		if (this.aborted) {
			this.dbg('transfer aborted')
			this.push(null)
			return
		}
		this.push(Buffer.alloc(toTransfer))
		this._transferred += toTransfer

		if (this.size <= this._transferred) {
			this.push(null)
		}
	}
	_destroy() {
		this.dbg('destroying...')
		this.aborted = true
		this.push(null)
	}
}

const dbg = debug('fastify')
function Logger(...args) {
	this.args = args
}
for (const k of ['info', 'error', 'debug', 'fatal', 'warn', 'trace']) {
	Logger.prototype[k] = dbg
}
Logger.prototype.child = function () {
	return new Logger()
}
const app = fastify({
	// @ts-ignore
	logger: new Logger(),
	forceCloseConnections: true,
})
app.route({
	method: 'GET',
	url: '/',
	handler: async (_req, _rep) => {
		return 'hello'
	},
})
app.route({
	method: 'POST',
	url: '/:id',
	handler: async (req, rep) => {
		const {
			requestTimeout,
			size = 1024 * 1024,
			speed,
			bodyTimeouts = [],
			status,
		} = /** @type {any} */ (req.body)
		if (status) {
			rep.code(status)
		}
		// @ts-ignore
		if (req.params.id) {
			// @ts-ignore
			rep.header(`received-id`, req.params.id)
		}
		for (const [header, value] of Object.entries(req.headers)) {
			rep.header(`received-${header}`, value)
		}

		return new TimeoutStream(size, speed, requestTimeout, bodyTimeouts)
	},
})

let port
/**
 * @param {{
 * 	requestTimeout?: number
 * 	size?: number
 * 	speed?: number
 * 	bodyTimeouts?: {time: number; after: number}[]
 * 	status?: number
 * 	id?: string
 * }} [reqOptions]
 * @param {import('./types.d.ts').FetchOptions} [options]
 */
const makeReq = async (reqOptions, options) => {
	return await fetch(`http://localhost:${port}/${reqOptions?.id || ''}`, {
		method: 'POST',
		body: JSON.stringify(reqOptions),
		headers: {'content-type': 'application/json'},
		...options,
	})
}

beforeAll(async () => {
	await app.listen({port: 0})
	// @ts-ignore
	port = app.server.address().port
})

afterAll(async () => {
	await app.close()
})

test('no options', async () => {
	const result = await fetch(`http://localhost:${port}`)
	expect(result.ok).toBe(true)
	expect(await result.text()).toBe('hello')
})

test('no timeout', async () => {
	const res = await makeReq()
	expect(await res.blob()).toBeTruthy()
})

describe('request timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {request: 150}})
		expect(await res.blob()).toBeTruthy()
	})
	test('times out', async () => {
		try {
			await makeReq({requestTimeout: 2000}, {timeouts: {request: 150}})
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('request')
			expect(err.message).toMatch('Timeout: request')
		}
	})
})

describe('body timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {body: 150}})
		expect(res).toBeTruthy()
		expect(await res.blob()).toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {body: 150}}
		)
		expect(res).toBeTruthy()
		try {
			await res.blob()
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('body')
			expect(err.message).toMatch('Timeout: body')
		}
	})
	test('times out (slow progress)', async () => {
		const res = await makeReq({speed: 128 * 1024}, {timeouts: {body: 150}})
		expect(res).toBeTruthy()
		try {
			await res.blob()
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('body')
			expect(err.message).toMatch('Timeout: body')
		}
	})
})

describe('stall timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {stall: 250}})
		expect(res).toBeTruthy()
		expect(await res.blob()).toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {stall: 150}}
		)
		expect(res).toBeTruthy()
		try {
			await res.blob()
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('stall')
			expect(err.message).toMatch('Timeout: stall')
		}
	})
	test('does not time out (no progress but for short term)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 50}]},
			{timeouts: {stall: 250}}
		)
		expect(res).toBeTruthy()
		expect(await res.blob()).toBeTruthy()
	})
	test('does not time out (slow progress)', async () => {
		const res = await makeReq({speed: 2048 * 1024}, {timeouts: {stall: 100}})
		expect(res).toBeTruthy()
		expect(await res.blob()).toBeTruthy()
	})
})

describe('overall timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {overall: 150}})
		expect(res).toBeTruthy()
		expect(await res.blob()).toBeTruthy()
	})
	test('times out (request)', async () => {
		try {
			await makeReq({requestTimeout: 2000}, {timeouts: {overall: 150}})
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('overall')
			expect(err.message).toMatch('Timeout: overall')
		}
	})
	test('times out (body)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {overall: 150}}
		)
		try {
			await res.blob()
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('overall')
			expect(err.message).toMatch('Timeout: overall')
		}
	})
	test('times out (body, slow progress)', async () => {
		const res = await makeReq({speed: 128 * 1024}, {timeouts: {overall: 150}})
		try {
			await res.blob()
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('overall')
			expect(err.message).toMatch('Timeout: overall')
		}
	})
	test('alias timeout -> timeouts.overall', async () => {
		try {
			await makeReq({requestTimeout: 2000}, {timeout: 150})
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('TimeoutError')
			expect(err.type).toBe('overall')
			expect(err.message).toMatch('Timeout: overall')
		}
	})
})

describe('Retrying', () => {
	test('Retry 5 times', async () => {
		try {
			await makeReq(
				{requestTimeout: 2000},
				{timeouts: {request: 150}, retry: 5}
			)
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.state.attempt).toBe(5)
			expect(err.message).toMatch('Timeout: request')
		}
	})

	test('Change timeout parameters on retry', async () => {
		const res = await makeReq(
			{requestTimeout: 500},
			{
				timeouts: {request: 50},
				retry: async ({state}) => {
					if (state.attempt < 2) return true
					return {
						options: {
							timeouts: {request: 2000},
						},
					}
				},
			}
		)
		await res.blob()
		await expect(res.completed).resolves.toBeTruthy()
		expect((await res.completed).attempts).toBe(3)
	})

	test('Add authorization header and modified body on retry', async () => {
		const res = await makeReq(
			{requestTimeout: 2000},
			{
				timeouts: {request: 250},
				retry: async ({state}) => {
					if (state.attempt > 2) return false
					// @ts-ignore
					if (!state.options.headers?.authorization) {
						return {
							options: {
								// so it doesn't time out on retry
								// @ts-ignore
								body: state.options.body.replace('2000', '10'),
								headers: {
									...state.options.headers,
									authorization: 'Bearer sometoken',
								},
							},
						}
					} else return false
				},
			}
		)
		await res.blob()
		expect(res.headers.get('received-authorization')).toBe('Bearer sometoken')
	})

	test('Change resource on retry', async () => {
		const res = await makeReq(
			{requestTimeout: 2000},
			{
				timeouts: {request: 250},
				retry: ({state}) => {
					return {
						resource: `http://localhost:${port}/foo`,
						options: {
							// so it doesn't time out on retry
							// @ts-ignore
							body: state.options.body.replace('2000', '10'),
							timeouts: {request: 1000},
						},
					}
				},
			}
		)
		await res.blob()
		expect(res.headers.get('received-id')).toBe('foo')
	})

	test('Response available in retry function', async () => {
		let capturedResponse = null

		const server = fastify()
		server.get('/test-response', (_request, reply) => {
			// Always return a 500 error with some headers
			reply.status(500)
			reply.header('x-error-code', 'TEMP_ERROR')
			reply.header('x-request-id', '12345')
			reply.send({error: 'Server error'})
		})

		await server.listen({port: 0})
		const address = server.server.address()
		const serverPort = typeof address === 'object' ? address?.port : null

		try {
			await expect(
				fetch(`http://localhost:${serverPort}/test-response`, {
					validate: true, // This will cause the 500 to throw an error
					retry: async ({error: _error, response}) => {
						capturedResponse = response

						// Verify we can access response and its properties
						expect(response).toBeTruthy()
						if (response) {
							expect(response.status).toBe(500)
							expect(response.headers.get('x-error-code')).toBe('TEMP_ERROR')
							expect(response.headers.get('x-request-id')).toBe('12345')
						}

						// Don't retry - we just want to test that response is available
						return false
					},
				})
			).rejects.toThrow()

			expect(capturedResponse).toBeTruthy()
		} finally {
			await server.close()
		}
	})
})

describe(`Providing custom abort signal`, () => {
	test('aborted after 100 ms', async () => {
		const controller = new AbortController()
		class CustomError extends Error {
			constructor(message) {
				super(message)
				this.name = 'CustomError'
			}
		}
		setTimeout(() => controller.abort(new CustomError('foo')), 100)
		try {
			await makeReq({requestTimeout: 2000}, {signal: controller.signal})
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('CustomError')
		}
		expect(controller.signal.aborted).toBe(true)
	})
	test('aborted immediately', async () => {
		const controller = new AbortController()
		controller.abort()
		try {
			await makeReq({requestTimeout: 2000}, {signal: controller.signal})
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.name).toBe('AbortError')
		}
	})
	test('successful', async () => {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 1000)
		const res = await makeReq({}, {signal: controller.signal})
		await res.blob()
		clearTimeout(timeout)
		expect(controller.signal.aborted).toBe(false)
	})
})

describe('Validation', () => {
	test('throw during validation', async () => {
		let good = false
		try {
			await makeReq(
				{},
				{
					validate: () => {
						if (!good) {
							good = true
							throw new Error('Error during validation')
						}
					},
					retry: 1,
				}
			)
			throw new Error('Should have thrown')
		} catch (err) {
			expect(err.message).toBe('Error during validation')
		}
	})

	test('throw during body validation (blob)', async () => {
		const e = new Error('Error during validating a blob')
		const res = await makeReq(
			{},
			{
				validate: {
					blob: () => {
						throw e
					},
				},
			}
		)
		await expect(res.blob()).rejects.toThrow(e)
	})

	test('throw during body validation (blob) and retry', async () => {
		let good = false
		const res = await makeReq(
			{},
			{
				validate: {
					blob: () => {
						if (!good) {
							good = true
							throw new Error('Error during validating a blob')
						}
					},
				},
				retry: 5,
			}
		)
		expect(await res.blob()).toBeInstanceOf(Blob)
		expect((await res.completed).attempts).toBe(2)
	})

	test('default validation', async () => {
		/** @type {Error | undefined} */
		let err
		const res = await makeReq(
			{id: 'validation-test', status: 403},
			{
				validate: true,
				retry: ({error, state}) => {
					err = error
					// @ts-ignore
					return {options: {body: state.options.body.replace('403', '200')}}
				},
			}
		)
		expect(await res.blob()).toBeInstanceOf(Blob)
		expect((await res.completed).attempts).toBe(2)
		expect(err?.message).toMatch(
			`HTTP 403 - Forbidden (POST http://localhost:${port}/validation-test)`
		)
	})

	test('alias validate.response: true to defaultValidate', async () => {
		/** @type {Error | undefined} */
		let err
		const res = await makeReq(
			{id: 'validation-test', status: 403},
			{
				validate: {response: true},
				retry: ({error, state}) => {
					err = error
					// @ts-ignore
					return {options: {body: state.options.body.replace('403', '200')}}
				},
			}
		)
		expect(await res.blob()).toBeInstanceOf(Blob)
		expect((await res.completed).attempts).toBe(2)
		expect(err?.message).toMatch(
			`HTTP 403 - Forbidden (POST http://localhost:${port}/validation-test)`
		)
	})
})

describe('body', () => {
	test('0-length body', async () => {
		const res = await makeReq({id: '0-body-test', size: 0})
		expect(res.body).toBeTruthy()
		const blob = await res.blob()
		expect(blob.size).toBe(0)
	})
	test('null body status', async () => {
		const res = await makeReq({id: 'null-body-test', status: 204, size: 10})
		expect(res.body).toBe(null)
	})
})

test('makeFetch', async () => {
	const limitedFetch = makeFetch(2, 4)
	expect(typeof limitedFetch).toBe('function')
})

describe('memory', () => {
	test('download stream', async () => {
		const mem0 = process.memoryUsage.rss()
		for (let i = 0; i < 100; i++) {
			const res = await makeReq({id: 'download stream 1mb', size: 1_000_000})
			const _blob = await res.blob()
		}
		expect(process.memoryUsage.rss()).toBeLessThan(mem0 + 100_000_000)
	})
})
