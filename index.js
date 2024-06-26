const debug = require('debug')
const {performance} = require('perf_hooks')
const {ReadableStream} = require('stream/web')
const {HttpError, TimeoutError} = require('./errors')
const dbg = debug('fetch')
const {RESPONSE_TYPES, STATE_INTERNAL} = require('./constants')

let origFetch = globalThis.fetch,
	Headers = globalThis.Headers,
	Request = globalThis.Request,
	Response = globalThis.Response,
	DOMException = globalThis.DOMException

try {
	const undici = require('undici')
	// @ts-ignore
	origFetch = undici.fetch
	// @ts-ignore
	Headers = undici.Headers
	// @ts-ignore
	Request = undici.Request
	// @ts-ignore
	Response = undici.Response
	if (!DOMException) {
		DOMException = require('undici/lib/fetch/constants').DOMException
	}
} catch (err) {
	if (
		err.code === 'MODULE_NOT_FOUND' &&
		// @ts-ignore
		origFetch
	) {
		// do nothing, we'll use the built-in fetch
	} else {
		throw err
	}
}

let globalFetchId = 0
class FetchState {
	constructor(resource, options) {
		this[STATE_INTERNAL] = {
			signalCompleted: error => {
				const {size, startTs} = this
				const duration = performance.now() - startTs
				const speed = this.size ? Math.round(this.size / duration) : 0
				const stats = {size, duration, speed, attempts: this.attempt}
				if (error) {
					// @ts-ignore
					error.stats = stats
					// @ts-ignore
					this[STATE_INTERNAL].reject(error)
				} else {
					this[STATE_INTERNAL].resolve(stats)
				}
			},
		}
		this.resource = resource
		this.options = {...options}
		this.id = this.options.operationId || ++globalFetchId
		delete this.options.operationId
		this.completed = new Promise((resolve, reject) => {
			this[STATE_INTERNAL].resolve = resolve
			this[STATE_INTERNAL].reject = reject
		})
		// prevent node uncaught exception
		this.completed.catch(() => {})
		this.attempt = 0
		this.size = undefined
		this.startTs = undefined
	}

	get fullId() {
		return `${this.id}-${this.attempt}`
	}
}

const wrapBodyStream = (stream, state) => {
	const {makeAbort, clearAbort, onBodyResolve, onBodyError} =
		state[STATE_INTERNAL]
	let reader

	return new ReadableStream({
		type: 'bytes',

		start() {
			reader = stream.getReader()
		},

		async pull(controller) {
			if (!state.bodyTs) {
				dbg(`${state.fullId} body processing started`)
				makeAbort?.('body')
				state.bodyTs = performance.now()
				state.size = 0
			}
			makeAbort?.('stall')
			const {done, value} = await reader.read().catch(e => {
				onBodyError(e)
				throw e
			})
			clearAbort?.('stall')
			if (done) {
				onBodyResolve()
				return controller.close()
			}
			state.size += value.byteLength
			controller.enqueue(value)
		},

		cancel(reason) {
			reader.cancel(reason)
		},
	})
}

/**
 * Mutates `params`
 *
 * @param {RetryFnParams} params
 * @returns {Promise<boolean>}
 */
const shouldRetry = async params => {
	const {state} = params
	const attempt = state.attempt
	const retry = state.options.retry
	if (typeof retry === 'number') {
		if (attempt < retry) {
			dbg('retry', attempt, retry)
			return true
		}
	} else if (typeof retry === 'function') {
		try {
			const retryResult = await retry(params)
			dbg('retry fn', retryResult)
			if (typeof retryResult === 'object') {
				if (retryResult.resource) {
					state.resource = retryResult.resource
					dbg('new resource', state.options)
				}
				if (retryResult.options) {
					Object.assign(state.options, retryResult.options)
					dbg('new options', state.options)
				}
				return true
			}
			if (retryResult === true) return true
		} catch (e) {
			dbg(state.id, `retry fn thrown: ${e}`)
		}
	}
	dbg(state.id, 'retry denied')
	return false
}

const defaultValidate = (response, state) => {
	if (!response.ok)
		throw new HttpError(response.status, response.statusText, response, state)
}

const prepareOptions = state => {
	const options = {...state.options}
	let makeAbort, clearAbort, abortController, userSignal, userSignalHandler

	if (!options.method) options.method = 'GET'

	if (options.timeout) {
		options.timeouts = {...options.timeouts, overall: options.timeout}
		delete options.timeout
	}

	if (options.validate === true) {
		options.validate = {response: defaultValidate}
	} else if (typeof options.validate === 'function') {
		options.validate = {response: options.validate}
	} else if (options.validate?.response === true) {
		options.validate.response = defaultValidate
	}

	if (options.timeouts || options.signal || options.validate?.response) {
		// @ts-ignore
		abortController = new AbortController()
		userSignal = options.signal
		if (userSignal) {
			userSignalHandler = () => {
				abortController.abort(userSignal.reason)
			}
			if (userSignal.aborted) {
				userSignalHandler()
			}
			userSignal.addEventListener('abort', userSignalHandler, {
				once: true,
			})
		}
		options.signal = abortController.signal
		if (options.timeouts) {
			const myTimeouts = {}
			makeAbort = reason => {
				const ms = /** @type {{[n: string]: number}} */ (options.timeouts)[
					reason
				]
				if (!ms) return
				clearTimeout(myTimeouts[reason])
				myTimeouts[reason] = setTimeout(() => {
					dbg(`${state.fullId}`, reason, 'timeout')
					state[STATE_INTERNAL].timedout = reason
					abortController.abort(new TimeoutError(reason, state))
				}, ms).unref()
			}
			clearAbort = reason => clearTimeout(myTimeouts[reason])
		}
	}

	const onBodyResolve = () => {
		dbg(state.fullId, `body complete`)
		if (!state[STATE_INTERNAL].validateStarted) {
			state[STATE_INTERNAL].signalCompleted()
		}
		onBodyFinish()
	}

	const onBodyError = error => {
		if (!state[STATE_INTERNAL].validateStarted) {
			state[STATE_INTERNAL].signalCompleted(error)
		}
		dbg(state.fullId, `body failed`, error)
		onBodyFinish()
	}

	const onBodyFinish = () => {
		if (userSignalHandler)
			userSignal?.removeEventListener('abort', userSignalHandler)
		if (clearAbort) {
			clearAbort('body')
			clearAbort('overall')
		}
	}

	Object.assign(state[STATE_INTERNAL], {
		options,
		makeAbort,
		clearAbort,
		abortController,
		onBodyResolve,
		onBodyError,
	})
}

// Reasoning: https://github.com/nodejs/undici/discussions/2194
const dump = async body => {
	try {
		let limit = 1e5
		for await (const buf of body) {
			limit -= buf.byteLength
			if (limit < 0) {
				// Leaving for await prematurely will close the stream
				return
			}
		}
	} catch {
		// Do nothing...
	}
}

const proxyResponse = (response, state) =>
	new Proxy(response, {
		get(target, prop, receiver) {
			if (!RESPONSE_TYPES.has(String(prop)))
				return Reflect.get(target, prop, receiver)

			const prev = response[prop]
			return async (...args) => {
				// Notify that we'll handle signaling
				try {
					dbg(state.fullId, prop, `called`)
					const validateFn = state[STATE_INTERNAL].options.validate?.[prop]
					if (validateFn) state[STATE_INTERNAL].validateStarted = true
					const result = await prev.call(response, args)
					await validateFn?.(result, state)
					dbg(state.fullId, prop, `success`)
					state[STATE_INTERNAL].signalCompleted()
					return result
				} catch (error) {
					dbg(state.fullId, prop, `failed`, error)
					if (
						await shouldRetry({
							state,
							error,
							response,
						}).catch(() => false)
					) {
						return fetch(state.resource, undefined, state).then(r =>
							r[prop](...args)
						)
					}
					state[STATE_INTERNAL].signalCompleted(error)
					throw error
				}
			}
		},
	})

/**
 * @param {Resource}     resource
 * @param {FetchOptions} [options]
 * @param {FetchState}   [state]
 * @returns {Promise<FetchResponse>}
 */
const fetch = async (resource, options, state) => {
	state ||= new FetchState(resource, options)
	do {
		state.attempt++
		if (state.attempt > 1) dbg(state.fullId, `retrying...`)
		state.size = undefined
		state[STATE_INTERNAL].timedout = undefined
		state[STATE_INTERNAL].validateStarted = false
		try {
			prepareOptions(state)
			const {
				options: currOptions,
				makeAbort,
				clearAbort,
			} = state[STATE_INTERNAL]
			await currOptions.limiter?.()

			makeAbort?.('overall')
			makeAbort?.('request')
			dbg(
				state.fullId,
				state[STATE_INTERNAL].options.method,
				state.resource,
				state.options
			)

			state.startTs = performance.now()
			let response = /** @type {FetchResponse} */ (
				await origFetch(state.resource, currOptions)
			)
			const {body, status} = response
			// Prevent null body errors on Response creation
			const hasBody =
				body &&
				// https://fetch.spec.whatwg.org/#statuses
				status !== 101 &&
				status !== 103 &&
				status !== 204 &&
				status !== 205 &&
				status !== 304
			if (hasBody) {
				response = /** @type {FetchResponse} */ (
					new Response(wrapBodyStream(body, state), response)
				)
				// We handle this case for now, relevent issue: https://github.com/nodejs/undici/issues/1339
			} else if (body) {
				// Clear body from response and consume stream to prevent leaks
				dump(body)
				response = /** @type {FetchResponse} */ (new Response(null, response))
			}
			response.completed = state.completed

			clearAbort?.('request')

			if (currOptions.validate?.response) {
				state[STATE_INTERNAL].validateStarted = true
				await currOptions.validate.response(response, state)
			}

			if (!hasBody) {
				state[STATE_INTERNAL].signalCompleted()
				return response
			}

			// eslint-disable-next-line require-atomic-updates
			state[STATE_INTERNAL].validateStarted = false
			return proxyResponse(response, state)
		} catch (error) {
			// Here we catch request errors only
			state[STATE_INTERNAL].clearAbort?.('request')
			dbg(`${state.fullId} failed`, error)
			if (await shouldRetry({state, error})) {
				continue
			}
			state[STATE_INTERNAL].signalCompleted(error)
			throw error
		}
		// eslint-disable-next-line no-constant-condition
	} while (true)
}

const makeFetch = (maxParallel, maxRps) => {
	if (!(maxParallel || maxRps)) return fetch

	const {Sema, RateLimit} = require('async-sema')
	const sema = maxParallel && new Sema(maxParallel)
	const limiter = maxRps && RateLimit(maxRps, {uniformDistribution: true})

	return async (resource, options) => {
		if (sema) await sema.acquire()
		const res = await fetch(resource, {
			...options,
			limiter,
		})
		if (sema) res.completed.finally(() => sema.release())
		return res
	}
}

module.exports = fetch
Object.assign(module.exports, {
	makeFetch,
	HttpError,
	TimeoutError,
	Headers,
	Request,
	Response,
})
