const fetch = require('.')
const {Readable} = require('stream')
const delay = require('delay')

class TimeoutStream extends Readable {
	constructor(size, speed, timeouts) {
		super()
		this.size = size
		this.timeouts = [...timeouts].sort(
			(a, b) => (a.after || 0) - (b.after || 0)
		)
		this._transferred = 0
		this.speed = speed
	}
	async _read(chunkSize) {
		const toTransfer = Math.min(this.size - this._transferred, chunkSize)
		if (this.speed) await delay((toTransfer / this.speed) * 1000)
		if (this.timeouts.length && this.timeouts[0].after <= this._transferred) {
			await delay(this.timeouts[0].time)
			this.timeouts.splice(0, 1)
		}

		this.push(Buffer.alloc(toTransfer))
		this._transferred += toTransfer

		if (this.size <= this._transferred) {
			this.push(null)
		}
	}
}

const fastify = require('fastify')()
fastify.route({
	method: 'POST',
	url: '/',
	handler: async req => {
		const {
			requestTimeout,
			size = 1024 * 1024,
			speed,
			bodyTimeouts = [],
		} = req.body
		if (requestTimeout) {
			await delay(requestTimeout)
		}
		return new TimeoutStream(size, speed, bodyTimeouts)
	},
})

let port
const makeReq = (reqOptions, fetchOptions) =>
	fetch(`http://localhost:${port}`, {
		method: 'POST',
		body: JSON.stringify(reqOptions),
		headers: {'content-type': 'application/json'},
		...fetchOptions,
	})

beforeAll(async () => {
	await fastify.listen(0)
	port = fastify.server.address().port
})

afterAll(async () => {
	await fastify.close()
})

test('no timeout', async () => {
	const res = await makeReq()
	await res.buffer()
})

describe('request timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {request: 150}})
		await res.buffer()
	})
	test('times out', async () => {
		await expect(
			makeReq({requestTimeout: 500}, {timeouts: {request: 150}})
		).rejects.toThrow('Timeout while making a request')
	})
})

describe('body timeout', () => {
	test('makes it on time', async () => {
		const res = await makeReq({}, {timeouts: {body: 150}})
		await res.buffer()
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
		const res = await makeReq({}, {timeouts: {noProgress: 150}})
		await res.buffer()
	})
	test('times out (no progress)', async () => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {noProgress: 150}}
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
		await res.buffer()
	})
	test('does not timeout (slow progress)', async () => {
		const res = await makeReq(
			{speed: 512 * 1024},
			{timeouts: {noProgress: 150}}
		)
		await res.buffer()
	})
})
