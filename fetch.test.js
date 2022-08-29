/* eslint no-shadow: ["error", { "allow": ["t"] }] */
const t = require('tap')
const fetch = require('.')
const {fastify} = require('fastify')
const {Readable} = require('stream')
const {Blob} = require('buffer')
// @ts-ignore
const debug = require('debug')

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
		if (this.speed) await delay((toTransfer / this.speed) * 1000)
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
 * @param {FetchOptions} [options]
 */
const makeReq = async (reqOptions, options) => {
	return await fetch(`http://localhost:${port}/${reqOptions?.id || ''}`, {
		method: 'POST',
		body: JSON.stringify(reqOptions),
		headers: {'content-type': 'application/json'},
		...options,
	})
}

t.before(async () => {
	await app.listen({port: 0})
	// @ts-ignore
	port = app.server.address().port
})

t.teardown(async () => {
	await app.close()
})

t.test('no options', async t => {
	const result = await fetch(`http://localhost:${port}`)
	t.equal(result.ok, true)
	t.equal(await result.text(), 'hello')
})

t.test('no timeout', async t => {
	const res = await makeReq()
	t.ok(await res.blob())
})

t.test('request timeout', async t => {
	t.test('makes it on time', async t => {
		const res = await makeReq({}, {timeouts: {request: 150}})
		t.ok(await res.blob())
	})
	t.test('times out', async t => {
		await t.rejects(
			makeReq({requestTimeout: 2000}, {timeouts: {request: 150}}),
			{name: 'TimeoutError', type: 'request', message: 'Timeout: request'}
		)
	})
})

t.test('body timeout', async t => {
	t.test('makes it on time', async t => {
		const res = await makeReq({}, {timeouts: {body: 150}})
		t.ok(res)
		t.ok(await res.blob())
	})
	t.test('times out (no progress)', async t => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {body: 150}}
		)
		t.ok(res)
		await t.rejects(res.blob(), {
			name: 'TimeoutError',
			type: 'body',
			message: 'Timeout: body',
		})
	})
	t.test('times out (slow progress)', async t => {
		const res = await makeReq({speed: 128 * 1024}, {timeouts: {body: 150}})
		t.ok(res)
		await t.rejects(res.blob(), {
			name: 'TimeoutError',
			type: 'body',
			message: 'Timeout: body',
		})
	})
})

t.test('stall timeout', async t => {
	t.test('makes it on time', async t => {
		const res = await makeReq({}, {timeouts: {stall: 250}})
		t.ok(res)
		t.ok(await res.blob())
	})
	t.test('times out (no progress)', async t => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {stall: 150}}
		)
		t.ok(res)
		await t.rejects(res.blob(), {
			name: 'TimeoutError',
			type: 'stall',
			message: 'Timeout: stall',
		})
	})
	t.test('does not time out (no progress but for short term)', async t => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 50}]},
			{timeouts: {stall: 250}}
		)
		t.ok(res)
		t.ok(await res.blob())
	})
	t.test('does not time out (slow progress)', async t => {
		const res = await makeReq({speed: 2048 * 1024}, {timeouts: {stall: 100}})
		t.ok(res)
		t.ok(await res.blob())
	})
})

t.test('overall timeout', async t => {
	t.test('makes it on time', async t => {
		const res = await makeReq({}, {timeouts: {overall: 150}})
		t.ok(res)
		t.ok(await res.blob())
	})
	t.test('times out (request)', async t => {
		await t.rejects(
			makeReq({requestTimeout: 2000}, {timeouts: {overall: 150}}),
			{
				name: 'TimeoutError',
				type: 'overall',
				message: 'Timeout: overall',
			}
		)
	})
	t.test('times out (body)', async t => {
		const res = await makeReq(
			{bodyTimeouts: [{after: 500, time: 500}]},
			{timeouts: {overall: 150}}
		)
		await t.rejects(res.blob(), {
			name: 'TimeoutError',
			type: 'overall',
			message: 'Timeout: overall',
		})
	})
	t.test('times out (body, slow progress)', async t => {
		const res = await makeReq({speed: 128 * 1024}, {timeouts: {overall: 150}})
		await t.rejects(res.blob(), {
			name: 'TimeoutError',
			type: 'overall',
			message: 'Timeout: overall',
		})
	})
	t.test('alias timeout -> timeouts.overall', async t => {
		await t.rejects(makeReq({requestTimeout: 2000}, {timeout: 150}), {
			name: 'TimeoutError',
			type: 'overall',
			message: 'Timeout: overall',
		})
	})
})

t.test('Retrying', async t => {
	t.test('Retry 5 times', async t => {
		await t.rejects(
			makeReq({requestTimeout: 2000}, {timeouts: {request: 150}, retry: 5}),
			{state: {attempt: 5}, message: 'Timeout: request'}
		)
	})

	t.test('Change timeout parameters on retry', async t => {
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
		await t.resolves(res.completed)
		t.equal((await res.completed).attempts, 3)
	})

	t.test('Add authorization header and modified body on retry', async t => {
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
		t.equal(res.headers.get('received-authorization'), 'Bearer sometoken')
	})

	t.test('Change resource on retry', async t => {
		const res = await makeReq(
			{requestTimeout: 2000},
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
		await res.blob()
		t.equal(res.headers.get('received-id'), 'foo')
	})
})

t.test(`Providing custom abort signal`, async t => {
	t.test('aborted after 100 ms', async t => {
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 100)
		await t.rejects(
			makeReq({requestTimeout: 2000}, {signal: controller.signal}),
			{name: 'AbortError'}
		)
		t.equal(controller.signal.aborted, true)
	})
	t.test('aborted immediately', async t => {
		const controller = new AbortController()
		controller.abort()
		await t.rejects(
			makeReq({requestTimeout: 2000}, {signal: controller.signal}),
			{name: 'AbortError'}
		)
	})
	t.test('successful', async t => {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 1000)
		const res = await makeReq({}, {signal: controller.signal})
		await res.blob()
		clearTimeout(timeout)
		t.equal(controller.signal.aborted, false)
	})
})

t.test('Validation', async t => {
	t.test('throw during validation', async t => {
		let good = false
		await t.rejects(
			makeReq(
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
			),
			{message: 'Error during validation'}
		)
	})

	t.test('throw during body validation (blob)', async t => {
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
		await t.rejects(res.blob(), e)
	})

	t.test('throw during body validation (blob) and retry', async t => {
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
		t.type(await res.blob(), Blob)
		t.equal((await res.completed).attempts, 2)
	})

	t.test('default validation', async t => {
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
		t.type(await res.blob(), Blob)
		t.equal((await res.completed).attempts, 2)
		t.match(
			err?.message,
			`HTTP 403 - Forbidden (POST http://localhost:${port}/validation-test)`
		)
	})

	t.test('alias validate.response: true to defaultValidate', async t => {
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
		t.type(await res.blob(), Blob)
		t.equal((await res.completed).attempts, 2)
		t.match(
			err?.message,
			`HTTP 403 - Forbidden (POST http://localhost:${port}/validation-test)`
		)
	})
})

t.test('body', async t => {
	t.test('0-length body', async t => {
		const res = await makeReq({id: '0-body-test', size: 0})
		t.ok(res.body)
		const blob = await res.blob()
		t.equal(blob.size, 0)
	})
	t.test('null body status', async t => {
		const res = await makeReq({id: 'null-body-test', status: 204, size: 10})
		t.equal(res.body, null)
	})
})
