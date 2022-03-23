const origFetch = require('node-fetch')
const AbortController = require('abort-controller')
const debug = require('debug')
const {performance} = require('perf_hooks')
const dbg = debug('fetch')

let globalFetchId = 0

const responseTypes = [
	'buffer',
	'blob',
	'arrayBuffer',
	'json',
	'text',
	'textConverted',
]

class HttpError extends Error {
	constructor(status, statusText, response, state) {
		const {
			fetchId,
			attempt,
			options: {method},
			resource,
		} = state
		super(
			`${fetchId}-${attempt} HTTP ${status} - ${statusText} (${method} ${resource})`
		)
		this.status = status
		this.statusText = statusText
		this.response = response
		this.state = state
		Error.captureStackTrace(this, HttpError)
	}
}

class TimeoutError extends Error {
	constructor(type, state) {
		const {
			fetchId,
			attempt,
			options: {method},
			resource,
			startTs,
			bodyTs,
		} = state
		const now = performance.now()
		const reqMs = Math.round(bodyTs ? bodyTs - startTs : now - startTs)
		const bodyMs = Math.round(bodyTs ? now - bodyTs : 0)
		super(
			`${fetchId}-${attempt} Timeout: ${type} (${method} ${resource} - ${
				bodyMs ? `${reqMs}ms+${bodyMs}` : reqMs
			}ms)`
		)
		this.type = type
		this.resource = resource
		this.method = method
		this.state = state
		this.headers = state.options.headers
		Error.captureStackTrace(this, TimeoutError)
	}
}

/**
 * @typedef {string | Request} Resource
 * @typedef {{
 * 	method?: string
 * 	signal?: AbortSignal
 * 	headers?: Headers | {[header: string]: string}
 * 	body?: string | Buffer | ReadableStream
 * }} Options
 * @typedef {Options & {
 * 	retry?: RetryDef
 * 	timeout?: number
 * 	timeouts?: {
 * 		overall?: number
 * 		request?: number
 * 		stall?: number
 * 		body?: number
 * 	}
 * 	validate?:
 * 		| true
 * 		| ValidateFn
 * 		| {
 * 				response?: boolean | ValidateFn
 * 				buffer?: ValidateFn
 * 				blob?: ValidateFn
 * 				arrayBuffer?: ValidateFn
 * 				json?: ValidateFn
 * 				text?: ValidateFn
 * 				textConverted?: ValidateFn
 * 		  }
 * 	signal?: AbortSignal
 * 	limiter?: ReturnType<import('async-sema').RateLimit>
 * }} ExtendedOptions
 * @typedef {(data: any, state: FetchState) => Promise<void> | void} ValidateFn
 * @typedef {{
 * 	resource: Resource
 * 	options: Options
 * 	userSignal?: AbortSignal
 * 	retry?: RetryDef
 * 	fetchId: number | string
 * 	attempt: number
 * 	completed: Promise<FetchStats>
 * 	resolve: (stats: FetchStats) => void
 * 	reject: (error: Error & {stats: FetchStats}) => void
 * 	startTs: number
 * 	bodyTs?: number
 * 	size: number
 * }} FetchState
 * @typedef {{
 * 	size: number
 * 	duration: number
 * 	attempts: number
 * 	speed: number
 * }} FetchStats
 * @typedef {{
 * 	state: FetchState
 * 	error?: Error
 * 	response?: Response
 * }} RetryFnParams
 * @typedef {| {
 * 			resource?: Resource
 * 			options?: Options
 * 	  }
 * 	| boolean} RetryResponse
 * @typedef {| number
 * 	| ((params: RetryFnParams) => Promise<RetryResponse> | RetryResponse)} RetryDef
 */

/**
 * Mutates `params`
 *
 * @param {RetryFnParams} params
 * @returns {Promise<boolean>}
 */
const shouldRetry = async params => {
	const {state} = params
	const {retry} = state
	if (!retry) return false
	const attempt = state.attempt
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
		} catch {}
	}
	dbg(state.fetchId, 'retry denied')
	return false
}

/**
 * @param {FetchState} state
 * @param {Error}      [error]
 */
const signalCompleted = (state, error) => {
	const {size, startTs} = state
	const duration = performance.now() - startTs
	const speed = state.size ? Math.round(state.size / duration) : 0
	const stats = {size, duration, speed, attempts: state.attempt}
	if (error) {
		// @ts-ignore
		error.stats = stats
		// @ts-ignore
		state.reject(error)
	} else {
		state.resolve(stats)
	}
}

const defaultValidate = (response, state) => {
	if (!response.ok)
		throw new HttpError(response.status, response.statusText, response, state)
}

/**
 * @param {Resource}        resource
 * @param {ExtendedOptions} [options]
 * @param {FetchState}      [state]
 * @returns {Promise<Response & {completed: Promise<FetchStats>}>} }
 */
const fetch = async (
	resource,
	options,
	state = /** @type {FetchState} */ ({})
) => {
	let {
		retry,
		timeout,
		timeouts,
		validate,
		signal: userSignal,
		limiter,
		...rest
	} = options || {}

	state.resource = resource
	state.options = /** @type {Options} */ (rest)
	if (!state.options.method) state.options.method = 'GET'
	if (!state.fetchId) state.fetchId = ++globalFetchId
	if (retry) state.retry = retry
	if (userSignal) state.userSignal = userSignal
	if (!state.completed) {
		// @ts-ignore
		state.completed = new Promise((resolve, reject) => {
			state.resolve = resolve
			state.reject = reject
		})
		// prevent node uncaught exception
		state.completed.catch(() => {})
	}

	if (timeout) {
		if (!timeouts) timeouts = {}
		timeouts.overall = timeout
	}

	if (validate) {
		if (validate === true) {
			validate = {response: defaultValidate}
		} else if (typeof validate === 'function') {
			validate = {response: validate}
		}
		if (validate.response === true) {
			validate.response = defaultValidate
		}
	} else {
		validate = undefined
	}
	do {
		let attempt = state.attempt || 0
		state.attempt = ++attempt
		const id = `${state.fetchId}-${attempt}`
		if (attempt > 1) dbg(id, `retrying...`)
		state.size = 0
		let controller, userSignalHandler
		let makeAbort, clearAbort, timedout
		try {
			if (timeouts || userSignal || validate?.response) {
				// @ts-ignore
				controller = new AbortController()
				state.options.signal = controller.signal
				if (state.userSignal) {
					if (state.userSignal.aborted) {
						const error = new Error(`User aborted fetch.`)
						// @ts-ignore
						error.type = 'aborted'
						throw error
					}
					userSignalHandler = arg => controller.abort(arg)
					state.userSignal.addEventListener('abort', userSignalHandler, {
						once: true,
					})
				}
				if (timeouts) {
					const myTimeouts = {}
					makeAbort = reason => {
						const ms = /** @type {{[n: string]: number}} */ (timeouts)[reason]
						if (!ms) return
						clearTimeout(myTimeouts[reason])
						myTimeouts[reason] = setTimeout(() => {
							dbg(id, reason, 'timeout')
							timedout = reason
							controller.abort(reason)
						}, ms).unref()
					}
					clearAbort = reason => clearTimeout(myTimeouts[reason])
				}
			}

			await limiter?.()

			makeAbort?.('overall')
			makeAbort?.('request')
			dbg(id, state.options.method, state.resource, state.options)

			state.startTs = performance.now()
			const response = /**
			 * @type {Response & {
			 * 	completed: Promise<FetchStats>
			 * }}
			 */ (await origFetch(state.resource, state.options))
			response.completed = state.completed

			clearAbort?.('request')

			const {body} = response
			if (validate?.response) {
				response.body = undefined
				try {
					// @ts-ignore
					await validate?.response(response, state)
				} catch (e) {
					controller.abort()
					throw e
				}
				response.body = body
			}

			if (!body) {
				signalCompleted(state)
				return response
			}

			makeAbort?.('body')
			makeAbort?.('stall')

			state.bodyTs = performance.now()

			const onBodyResolve = () => {
				dbg(id, `body complete`)
				if (!validateStarted) {
					signalCompleted(state)
				}
				onBodyFinish()
			}
			const onBodyError = error => {
				dbg(id, `body failed`, error)
				if (!validateStarted) {
					if (error.type === 'aborted' && timedout) {
						error = new TimeoutError(timedout, state)
					}
					signalCompleted(state, error)
				}
				onBodyFinish()
			}
			const onBodyFinish = () => {
				if (userSignalHandler)
					userSignal?.removeEventListener('abort', userSignalHandler)
				if (clearAbort) {
					clearAbort('body')
					clearAbort('stall')
					clearAbort('overall')
				}
			}

			let validateStarted = false
			// the blocks below are just to keep the indentation
			// and make the commit more readable
			{
				{
					body.on('data', chunk => {
						state.size += Buffer.byteLength(chunk)
						makeAbort?.('stall')
					})
					body.on('close', onBodyResolve)
					body.on('error', error => {
						// HACK: we can't change the error from here
						// we would need to wrap the stream
						if (error.type === 'aborted' && timedout) {
							const tErr = new TimeoutError(timedout, state)
							error.type = 'timeout'
							error.message = tErr.message
						}
						onBodyError(error)
					})

					for (const fKey of responseTypes) {
						const validator = validate?.[fKey]
						if (!validator && !retry) continue
						const prev = response[fKey]
						response[fKey] = async (...args) => {
							// Notify that we'll handle signaling
							validateStarted = true
							try {
								dbg(id, fKey, `called`)
								const result = await prev.call(response, args)
								await validator?.(result, state)
								dbg(id, fKey, `success`)
								signalCompleted(state)
								return result
							} catch (error) {
								dbg(id, fKey, `failed`)
								if (error.type === 'aborted' && timedout) {
									error = new TimeoutError(timedout, state)
								}
								if (
									retry &&
									(await shouldRetry({
										state,
										error,
										response,
									}).catch(() => false))
								) {
									return fetch(state.resource, state.options, state).then(r =>
										r[fKey](...args)
									)
								}
								signalCompleted(state, error)
								throw error
							}
						}
					}
				}
			}

			return response
		} catch (error) {
			// Here we catch request errors only
			clearAbort?.('request')
			if (error.type === 'aborted' && timedout) {
				error = new TimeoutError(timedout, state)
			}
			dbg(`${state.fetchId}-${state.attempt} failed`, error)
			if (retry && (await shouldRetry({state, error}))) {
				continue
			}
			signalCompleted(state, error)
			throw error
		}
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
Object.assign(module.exports, {makeFetch, HttpError, TimeoutError})
