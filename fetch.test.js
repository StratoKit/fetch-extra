const {fetch} = require('.')
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
	destroy() {
		this.aborted = true
		this.push(null)
		super.destroy()
	}
}

const fastify = require('fastify')()
fastify.route({
	method: 'POST',
	url: '/',
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
const makeReq = async (reqOptions, options) => {
	return await fetch(`http://localhost:${port}`, {
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
		expect(err.message).toMatch('Timeout while making a request')
	})
})

describe('body timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {body: 150}})
		await expect(res.buffer()).resolves.toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {body: 150}}
		)
		await expect(res.buffer()).rejects.toThrow('Timeout while fetching a body')
	})
	test('times out (slow progress)', async () => {
		const res = await makeReq({speed: 128 * 1024}, {timeouts: {body: 150}})
		await expect(res.buffer()).rejects.toThrow('Timeout while fetching a body')
	})
})

describe('no-progress timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {stall: 150}})
		await expect(res.buffer()).resolves.toBeTruthy()
	})
	test('times out (no progress)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {stall: 150}}
		)
		await expect(res.buffer()).rejects.toThrow(
			'Timeout - no progress while fetching a body'
		)
	})
	test('does not timeout (no progress but for short term)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 100}]},
			{timeouts: {noProgress: 150}}
		)
		await expect(res.buffer()).resolves.toBeTruthy()
	})
	test('does not timeout (slow progress)', async () => {
		const res = await makeReq(
			{speed: 2048 * 1024},
			{timeouts: {noProgress: 100}}
		)
		await expect(res.buffer()).resolves.toBeTruthy()
	})
})

describe('Retrying', () => {
	test('Retry 5 times', async () => {
		await makeReq(
			{requestTimeout: 1000},
			{timeouts: {request: 150}, retry: 5}
		).catch(e => {
			err = e
		})

		expect(err.message).toMatch('Timeout while making a request')
		expect(err.fetchState.retryCount).toBe(5)
	})

	test('Add authorization header on retry', async () => {
		await makeReq(
			{requestTimeout: 1000},
			{
				timeouts: {request: 150},
				retry: ({fetchState}) => {
					if (!fetchState.options.headers.authorization) {
						fetchState.options.headers.authorization = 'Bearer sometoken'
						return {options: fetchState.options}
					} else return false
				},
			}
		).catch(e => {
			err = e
		})

		expect(err.message).toMatch('Timeout while making a request')
		expect(err.fetchState.options.headers.authorization).toBe(
			'Bearer sometoken'
		)
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
		await expect(
			makeReq(
				{},
				{
					validate: args => {
						throw new Error('Error during validation')
					},
				}
			)
		).rejects.toThrow('Error during validation')
	})

	test('throw during body validation (buffer)', async () => {
		const res = await makeReq(
			{},
			{
				validateBuffer: () => {
					throw new Error('Error during validation a buffer')
				},
			}
		)
		await expect(res.buffer()).rejects.toThrow(
			'Error during validation a buffer'
		)
	})
})
