const fetch = require('.')
const {Readable} = require('stream')
const {Blob} = require('buffer')
const delay = require('delay')

jest.setTimeout(5000)
class TimeoutStream extends Readable {
	constructor(size, speed, requestTimeout = 0, timeouts) {
		super()
		this.size = size
		this.requestTimeout = requestTimeout
		this.timeouts = [...timeouts].sort(
			(a, b) => (a.after || 0) - (b.after || 0)
		)
		this._transferred = 0
		this.speed = speed
	}
	async _read(chunkSize) {
		if (this.requestTimeout) {
			await delay(this.requestTimeout)
			this.requestTimeout = 0
		}
		const toTransfer = Math.min(this.size - this._transferred, chunkSize)
		if (toTransfer === 0) {
			this.push(null)
			return
		}
		if (this.speed) await delay((toTransfer / this.speed) * 1000)
		if (this.timeouts.length && this.timeouts[0].after <= this._transferred) {
			await delay(this.timeouts[0].time)
			this.timeouts.splice(0, 1)
		}
		if (this.aborted) {
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
		this.aborted = true
		this.push(null)
	}
}

const dbg = require('debug')('fastify')
function Logger(...args) {
	this.args = args
}
for (const k of ['info', 'error', 'debug', 'fatal', 'warn', 'trace']) {
	Logger.prototype[k] = dbg
}
Logger.prototype.child = function () {
	return new Logger()
}
const fastify = require('fastify')({
	logger: new Logger(),
})
fastify.route({
	method: 'POST',
	url: '/:id',
	handler: async (req, rep) => {
		const {
			requestTimeout,
			size = 1024 * 1024,
			speed,
			bodyTimeouts = [],
			status,
		} = req.body
		if (status) {
			rep.code(status)
		}
		if (req.params.id) {
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
 * @param {import('.').ExtendedOptions} [options]
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
	await fastify.listen(0)
	port = fastify.server.address().port
})

afterAll(async () => {
	await fastify.close()
})

test('no timeout', async () => {
	const res = await makeReq()
	await expect(res.blob()).resolves.toBeTruthy()
})

describe('request timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {request: 150}})
		await expect(res.blob()).resolves.toBeTruthy()
	})
	test('times out', async () => {
		await expect(
			makeReq({requestTimeout: 500}, {timeouts: {request: 150}})
		).rejects.toThrow('Timeout: request')
	})
})

describe('body timeout', () => {
	test('makes it on time', async () => {
		const resP = makeReq({}, {timeouts: {body: 150}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).resolves.toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const resP = makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {body: 150}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).rejects.toThrow('Timeout: body')
	})
	test('times out (slow progress)', async () => {
		const resP = makeReq({speed: 128 * 1024}, {timeouts: {body: 150}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).rejects.toThrow('Timeout: body')
	})
})

describe('no-progress timeout', () => {
	test('makes it on time', async () => {
		const resP = makeReq({id: 'miot'}, {timeouts: {stall: 250}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).resolves.toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const resP = makeReq(
			{id: 'tonp', bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {stall: 150}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).rejects.toThrow('Timeout: stall')
	})
	test('does not timeout (no progress but for short term)', async () => {
		const resP = makeReq(
			{id: 'dntnpbfs', bodyTimeouts: [{after: 500, time: 50}]},
			{timeouts: {stall: 250}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).resolves.toBeTruthy()
	})
	test('does not timeout (slow progress)', async () => {
		const res = await makeReq(
			{id: 'dntsp', speed: 2048 * 1024},
			{timeouts: {stall: 100}}
		)
		await expect(res.blob()).resolves.toBeTruthy()
	})
})

describe('overall timeout', () => {
	test('makes it on time', async () => {
		const resP = makeReq({}, {timeouts: {overall: 150}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).resolves.toBeTruthy()
	})
	test('times out (request)', async () => {
		await expect(
			makeReq({requestTimeout: 500}, {timeouts: {overall: 150}})
		).rejects.toThrow('Timeout: overall')
	})
	test('times out (body)', async () => {
		const resP = makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {overall: 150}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).rejects.toThrow('Timeout: overall')
	})
	test('times out (body, slow progress)', async () => {
		const resP = makeReq({speed: 128 * 1024}, {timeouts: {overall: 150}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).blob()).rejects.toThrow('Timeout: overall')
	})
	test('alias timeout -> timeouts.overall', async () => {
		await expect(
			makeReq({requestTimeout: 500}, {timeout: 150})
		).rejects.toThrow('Timeout: overall')
	})
})

describe('Retrying', () => {
	test('Retry 5 times', async () => {
		expect.assertions(2)
		try {
			await makeReq(
				{requestTimeout: 1000},
				{timeouts: {request: 150}, retry: 5}
			)
		} catch (e) {
			expect(e.state.attempt).toBe(5)
			expect(e.message).toMatch('Timeout: request')
		}
	})

	test('Change timeout parameters on retry', async () => {
		const res = await makeReq(
			{requestTimeout: 500},
			{
				timeouts: {request: 250},
				retry: async ({state}) => {
					if (state.attempt < 2) return true
					return {
						options: {
							timeouts: {request: 1000},
						},
					}
				},
			}
		)
		await res.blob()
		await expect(res.completed).resolves.toHaveProperty('attempts', 3)
	})

	test('Add authorization header and modified body on retry', async () => {
		const res = await makeReq(
			{requestTimeout: 500},
			{
				timeouts: {request: 250},
				retry: async ({state}) => {
					if (state.attempt > 2) return false
					if (!state.options.headers?.authorization) {
						return {
							options: {
								// so it doesn't time out on retry
								body: state.options.body.replace('500', '100'),
								headers: {
									authorization: 'Bearer sometoken',
								},
							},
						}
					} else return false
				},
			}
		)
		expect(res.headers.get('received-authorization')).toBe('Bearer sometoken')
	})

	test('Change resource on retry', async () => {
		const res = await makeReq(
			{requestTimeout: 500},
			{
				timeouts: {request: 250},
				retry: () => {
					return {
						resource: `http://localhost:${port}/foo`,
						options: {
							timeouts: {request: 1000},
						},
					}
				},
			}
		)
		expect(res.headers.get('received-id')).toBe('foo')
	})
})

describe(`Providing custom abort signal`, () => {
	test('aborted after 100 ms', async () => {
		const controller = new (AbortController || require('abort-controller'))()
		expect.assertions(2)
		try {
			setTimeout(() => controller.abort(), 100)
			await makeReq({requestTimeout: 1000}, {signal: controller.signal})
		} catch (e) {
			expect(controller.signal.aborted).toBe(true)
			expect(e.code).toBe('ABORT_ERR')
		}
	})
	test('aborted immediately', async () => {
		const controller = new (AbortController || require('abort-controller'))()
		controller.abort()
		expect.assertions(1)
		try {
			await makeReq({requestTimeout: 500}, {signal: controller.signal})
		} catch (e) {
			expect(e.code).toBe('ABORT_ERR')
		}
	})
	test('successful', async () => {
		const controller = new (AbortController || require('abort-controller'))()
		const t = setTimeout(() => controller.abort(), 1000)
		const res = await makeReq({}, {signal: controller.signal})
		await res.blob()
		clearTimeout(t)
		expect(controller.signal.aborted).toBe(false)
	})
})

describe('Validation', () => {
	test('throw during validation', async () => {
		let good = false
		expect.assertions(1)
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
		} catch (e) {
			expect(e.message).toBe('Error during validation')
		}
	})

	test('throw during body validation (blob)', async () => {
		expect.assertions(1)
		try {
			const res = await makeReq(
				{},
				{
					validate: {
						blob: () => {
							throw new Error('Error during validation a blob')
						},
					},
				}
			)
			await expect(res.blob()).resolves.toBeInstanceOf(Blob)
		} catch (e) {
			expect(e.message).toMatch('Error during validation a blob')
		}
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
							throw new Error('Error during validation a blob')
						}
					},
				},
				retry: 5,
			}
		)
		await expect(res.blob()).resolves.toBeInstanceOf(Blob)
		await expect(res.completed).resolves.toHaveProperty('attempts', 2)
	})

	test('default validation', async () => {
		let err
		const res = await makeReq(
			{id: 'validation-test', status: 403},
			{
				validate: true,
				retry: ({error, state}) => {
					err = error
					return {options: {body: state.options.body.replace('403', '200')}}
				},
			}
		)
		await expect(res.blob()).resolves.toBeInstanceOf(Blob)
		await expect(res.completed).resolves.toHaveProperty('attempts', 2)
		expect(err?.message).toMatch(
			`HTTP 403 - Forbidden (POST http://localhost:${port}/validation-test)`
		)
	})

	test('alias validate.response: true to defaultValidate', async () => {
		let err
		const res = await makeReq(
			{id: 'validation-test', status: 403},
			{
				validate: {response: true},
				retry: ({error, state}) => {
					err = error
					return {options: {body: state.options.body.replace('403', '200')}}
				},
			}
		)
		await expect(res.blob()).resolves.toBeInstanceOf(Blob)
		await expect(res.completed).resolves.toHaveProperty('attempts', 2)
		expect(err?.message).toMatch(
			`HTTP 403 - Forbidden (POST http://localhost:${port}/validation-test)`
		)
	})
})

describe('body', () => {
	test('0-length body', async () => {
		const res = await makeReq({id: '0-body-test', size: 0})
		expect(res.body).toBeDefined()
		const blob = await res.blob()
		expect(blob.size).toBe(0)
	})
	test('null body status', async () => {
		const res = await makeReq({id: 'null-body-test', status: 204, size: 10})
		expect(res).toHaveProperty('body', null)
	})
})
