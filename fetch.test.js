const fetch = require('.')
const {Readable} = require('stream')
const AbortController = require('abort-controller')
const delay = require('delay')

jest.setTimeout(1000000)
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

const fastify = require('fastify')()
fastify.route({
	method: 'POST',
	url: '/:any',
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
	return await fetch(`http://localhost:${port}/${reqOptions.id || ''}`, {
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
	await expect(res.buffer()).resolves.toBeTruthy()
})

describe('request timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {request: 150}})
		await expect(res.buffer()).resolves.toBeTruthy()
	})
	test('times out', async () => {
		let err
		await makeReq({requestTimeout: 500}, {timeouts: {request: 150}}).catch(
			e => {
				err = e
			}
		)
		expect(err.message).toMatch('Timeout: request')
	})
})

describe('body timeout', () => {
	test('makes it on time', async () => {
		const resP = makeReq({}, {timeouts: {body: 150}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).buffer()).resolves.toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const resP = makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {body: 150}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).buffer()).rejects.toThrow('Timeout: body')
	})
	test('times out (slow progress)', async () => {
		const resP = makeReq({speed: 128 * 1024}, {timeouts: {body: 150}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).buffer()).rejects.toThrow('Timeout: body')
		console.log('look at me (proof that test succeeeds)')
	})
})

describe.only('no-progress timeout', () => {
	test('makes it on time', async () => {
		const resP = makeReq({id: 'miot'}, {timeouts: {stall: 250}})
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).buffer()).resolves.toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const resP = makeReq(
			{id: 'tonp', bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {stall: 150}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).buffer()).rejects.toThrow('Timeout: stall')
		console.log('look at me tonp (proof that test succeeeds)')
	})
	test('does not timeout (no progress but for short term)', async () => {
		const resP = makeReq(
			{id: 'dntnpbfs', bodyTimeouts: [{after: 500, time: 50}]},
			{timeouts: {stall: 250}}
		)
		await expect(resP).resolves.toBeDefined()
		await expect((await resP).buffer()).resolves.toBeTruthy()
		console.log('look at me 2 (proof that test succeeeds)')
	})
	test('does not timeout (slow progress)', async () => {
		const res = await makeReq(
			{id: 'dntsp', speed: 2048 * 1024},
			{timeouts: {stall: 100}}
		)
		await expect(res.buffer()).resolves.toBeTruthy()
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

	test('Add authorization header on retry', async () => {
		expect.assertions(1)
		const res = await makeReq(
			{requestTimeout: 1000},
			{
				timeouts: {request: 150},
				retry: async ({state}) => {
					if (state.attempt > 2) return false
					if (!state.options.headers?.authorization) {
						return {
							options: {
								headers: {
									authorization: 'Bearer sometoken',
								},
							},
						}
					} else return false
				},
			}
		)
		await expect(res.completed).resolves.toBeDefined()
	})
})

test(`Providing custom abort signal`, async () => {
	const controller = new AbortController()
	try {
		await makeReq({requestTimeout: 500}, {signal: controller.signal})
		setTimeout(() => controller.abort(), 100)
	} catch (e) {
		expect(controller.aborted).toBe(true)
		expect(e.message).toBe('User aborted a request')
	}
})

// This suite is passing, but test is hanging and never quits
describe('Validation', () => {
	test('throw during validation', async () => {
		let good = false
		expect.assertions(1)
		try {
			await makeReq(
				{},
				{
					validate: args => {
						console.log('Good - ' + good)
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

	test('throw during body validation (buffer)', async () => {
		expect.assertions(1)
		try {
			const res = await makeReq(
				{},
				{
					validate: {
						buffer: () => {
							throw new Error('Error during validation a buffer')
						},
					},
				}
			)
			await expect(res.buffer()).resolves.toBeInstanceOf(Buffer)
		} catch (e) {
			expect(e.message).toMatch('Error during validation a buffer')
		}
	})

	test('throw during body validation (buffer) and retry', async () => {
		let good = false
		expect.assertions(2)
		const res = await makeReq(
			{},
			{
				validate: {
					buffer: () => {
						if (!good) {
							good = true
							throw new Error('Error during validation a buffer')
						}
					},
				},
				retry: 5,
			}
		)
		await expect(res.buffer()).resolves.toBeInstanceOf(Buffer)
		await expect(res.completed).resolves.toHaveProperty('attempts', 2)
	})
})
