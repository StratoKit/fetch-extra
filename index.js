const origFetch = require('node-fetch')
const AbortController = require('abort-controller')
const debug = require('debug')
const {Sema, RateLimit} = require('async-sema')
const dbg = debug('fetch')

let fetchId = 0

const responseTypes = [
	'buffer',
	'blob',
	'arrayBuffer',
	'json',
	'text',
	'textConverted',
]

const calculateFetchStats = (stats, startTs = Date.now()) => {
	let fetchStats = Object.assign({}, stats)
	fetchStats.duration = (Date.now() - startTs) / 1000
	// No infinity values
	if (fetchStats.duration === 0) fetchStats.duration = 0.001
	fetchStats.speed = Math.round(fetchStats.size / fetchStats.duration)
	return fetchStats
}

class HttpError extends Error {
	constructor(status, statusText, response, fetchState) {
		const {
			fetchId,
			options: {method},
			resource,
		} = fetchState
		super(
			`HTTP error ${status} - ${statusText} (#${fetchId} ${method} ${resource})`
		)
		this.status = status
		this.statusText = statusText
		this.response = response
		this.fetchState = fetchState
		Error.captureStackTrace(this, HttpError)
	}
}

class TimeoutError extends Error {
	static messages = {
		noProgress: 'Timeout - no progress while fetching a body',
		body: 'Timeout while fetching a body',
		request: 'Timeout while making a request',
	}

	constructor(type, fetchState) {
		const {
			fetchId,
			options: {method},
			resource,
		} = fetchState

		super(`${TimeoutError.messages[type]} (#${fetchId} ${method} ${resource})`)
		this.type = type
		this.resource = resource
		this.method = method
		this.fetchState = fetchState
		this.headers = fetchState.options.headers
		Error.captureStackTrace(this, TimeoutError)
	}
}

const shouldRetry = async ({fetchState, error, response}) => {
	const attempt = fetchState.retryCount
	const retry = fetchState.options.retry
	if (typeof retry === 'number') {
		if (attempt > 1)
			dbg(`Request #${fetchState.fetchId} - attempt no.${attempt}...`)
		if (attempt >= retry) {
			dbg(`Aborting request #${fetchState.fetchId} - too many attempts.`)
			return false
		}
		return true
	} else if (typeof retry === 'function') {
		const retryResult = await retry({
			error,
			response,
			fetchState,
		})

		if (typeof retryResult === 'object') {
			fetchState = {
				...fetchState,
				options: {
					...fetchState.options,
				},
			}
			if (typeof retryResult.options === 'object') {
				Object.assign(fetchState.options, retryResult.options)
			}
			return true
		}
		if (retryResult === true) return true
		if (!retryResult) return false
	} else return false
}

const fetch = async (resource, options) => {
	fetchId++

	let {
		retry,
		timeout,
		timeouts,
		validate,
		validateBuffer,
		validateBlob,
		validateArrayBuffer,
		validateJson,
		validateText,
		validateTextConverted,
		sema,
		limiter,
		...fetchOptions
	} = options

	let err, res, resCompletedResolve
	// Should we require sema in options or not? new Sema(5) will create new instance on every fetch
	// which can be misguided with limiting number of requests, and can be truly used only while retrying
	if (!sema) sema = new Sema(5)
	if (!limiter) limiter = RateLimit(10, {uniformDistribution: true})

	const fetchState = {
		resource,
		options,
		retryCount: 0,
		fetchId,
	}

	let fetchStats = {
		// bytes per seconds
		speed: 0,
		// in seconds
		duration: 0,
		// in bytes
		size: 0,
	}

	do {
		fetchState.retryCount++
		err = null
		res = null
		let controller, requestTimeout, bodyTimeout, stallTimeout
		let timeoutReason
		try {
			if (options.timeouts || options.timeout || options.signal) {
				controller = new AbortController()
				fetchOptions.signal = controller.signal
				if (options.signal) {
					options.signal.addEventListener(
						'abort',
						() => {
							controller.abort()
						},
						{
							once: true,
						}
					)
				}
				if (options.timeouts?.request) {
					requestTimeout = setTimeout(() => {
						timeoutReason = 'request'
						controller.abort(timeoutReason)
					}, options.timeouts.request)
				}
			}
			if (dbg.enabled)
				dbg(fetchState.fetchId, options.method, fetchState.resource, options)
			await sema.acquire()
			const now = Date.now()
			await limiter()
			if (dbg.enabled) {
				const ms = Date.now() - now
				if (ms > 5) dbg(`limiter waited ${ms}ms`)
			}
			res = await origFetch(resource, fetchOptions)

			if (options.validate) {
				resBody = res.body
				res.body = undefined
				options.validate(res, fetchState)
				res.body = resBody
			}

			clearTimeout(requestTimeout)

			// to put it somewhere...
			if (options.timeouts?.body && !bodyTimeout) {
				bodyTimeout = setTimeout(() => {
					timeoutReason = 'body'
					controller.abort(timeoutReason)
				}, options.timeouts.body)
			}

			let bodyStartTs = Date.now()
			res.body.on('resume', () => {
				if (options.timeouts?.stall && !stallTimeout) {
					stallTimeout = setTimeout(() => {
						timeoutReason = 'noProgress'
						controller.abort(timeoutReason)
					}, options.timeouts.stall)
				}
			})
			res.body.on('data', chunk => {
				fetchStats.size += Buffer.byteLength(chunk)
				if (!options.timeouts?.stall) return
				clearTimeout(stallTimeout)
				stallTimeout = setTimeout(async () => {
					timeoutReason = 'noProgress'
					controller.abort(timeoutReason)
				}, options.timeouts?.stall)
			})
			res.body.on('close', () => {
				fetchStats = calculateFetchStats(fetchStats, bodyStartTs)
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
				console.log('FETCH STATS', fetchStats)
				resCompletedResolve(fetchStats)
			})

			res.body.on('error', err => {
				fetchStats = calculateFetchStats(fetchStats, bodyStartTs)
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
				resCompletedResolve(fetchStats)
			})

			for (const fKey of responseTypes) {
				const prev = res[fKey]
				res[fKey] = async function (...args) {
					try {
						const result = prev.call(res, args)
						const validator =
							options[`validate${fKey[0].toUpperCase()}${fKey.slice(1)}`]
						await validator?.(res, result, fetchState)
						return await result
					} catch (e) {
						if (e.type === 'aborted' && timeoutReason) {
							throw new TimeoutError(timeoutReason, fetchState)
						}
						throw e
					}
				}
			}

			res.completed = new Promise(resolve => {
				resCompletedResolve = resolve
			})
			res.retryCount = fetchState.retryCount
			return res
		} catch (e) {
			if (e.type === 'aborted' && timeoutReason) {
				err = new TimeoutError(timeoutReason, fetchState)
			} else err = e

			dbg(`Error during request ${fetchState.fetchId}`, err)
		} finally {
			clearTimeout(requestTimeout)
			await sema.release()
		}
	} while (await shouldRetry({fetchState, error: err, response: res}))

	if (err) throw err
}

const makeFetch = (semaLimit, rateLimit) => {
	const sema = new Sema(semaLimit)
	const limiter = RateLimit(rateLimit, {uniformDistribution: true})

	return (resource, options) =>
		fetch(resource, {
			...options,
			sema,
			limiter,
		})
}

module.exports = {
	fetch,
	makeFetch,
}
