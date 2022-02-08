const origFetch = require('node-fetch')
const AbortController = require('abort-controller')
const debug = require('debug')
const {Sema, RateLimit} = require('async-sema')
const dbg = debug('fetch')

const globalSema = new Sema(5)
const globalLimiter = RateLimit(10, {uniformDistribution: true})
let fetchId = 0

const responseTypes = [
	'buffer',
	'blob',
	'arrayBuffer',
	'json',
	'text',
	'textConverted',
]

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

const fetch = async (resource, options) => {
	fetchId++
	let err, res, sema, limiter
	if (!this.sema) sema = globalSema
	else sema = this.sema
	if (!this.limiter) limiter = globalLimiter
	else limiter = this.limiter

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

	const fetchState = {
		resource,
		options,
		retryCount: 0,
		fetchId,
	}

	const fetchStats = {}

	const retry = async () => {
		debugger
		const attempt = fetchState.retryCount
		if (typeof extraOptions.retry === 'number') {
			if (attempt > 1)
				dbg(`Request #${fetchState.fetchId} - attempt no.${attempt}...`)
			if (attempt >= extraOptions.retry) {
				dbg(`Aborting request #${fetchState.fetchId} - too many attempts.`)
				return false
			}
			return true
		} else if (typeof extraOptions.retry === 'function') {
			const retryResult = await extraOptions.retry({
				error: err,
				response: res,
				fetchState,
			})

			if (typeof retryResult === 'object') {
				fetchState.resource = retryResult.resource || fetchState.resource
				merge(fetchState.options, retryResult.options)
				return true
			}
			if (retryResult === true) return true
			if (!retryResult) return false
		} else return false
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
					options.signal.addEventListener('abort', () => controller.abort(), {
						once: true,
					})
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

			// cloneDeep(res) - this don't work, returns empty object
			if (options.validate)
				options.validate(omit(res, responseTypes), fetchState)
			clearTimeout(requestTimeout)

			// to put it somewhere...
			if (options.timeouts?.body && !bodyTimeout) {
				bodyTimeout = setTimeout(() => {
					timeoutReason = 'body'
					controller.abort(timeoutReason)
				}, options.timeouts.body)
			}

			res.body.on('resume', () => {
				if (options.timeouts?.stall && !stallTimeout) {
					stallTimeout = setTimeout(() => {
						timeoutReason = 'noProgress'
						controller.abort(timeoutReason)
					}, options.timeouts.stall)
				}
			})
			res.body.on('data', () => {
				if (!options.timeouts?.stall) return
				clearTimeout(stallTimeout)
				stallTimeout = setTimeout(async () => {
					timeoutReason = 'noProgress'
					controller.abort()
				}, options.timeouts?.stall)
			})
			res.body.on('close', () => {
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
			})

			res.body.on('error', err => {
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
				err = new HttpError(res.status, res.statusText, res, fetchState)
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

			res.completed = async () => {
				for (fKey of responseTypes) await res[fKey]()
				return fetchStats // empty now
			}
			return res
		} catch (e) {
			debugger
			if (e.type === 'aborted' && timeoutReason) {
				err = new TimeoutError(timeoutReason, fetchState)
			} else err = e

			dbg(`Error during request ${fetchState.fetchId}`, err)
		} finally {
			clearTimeout(requestTimeout)
			await sema.release()
		}
	} while (await retry())

	if (err) throw err
}

const makeFetch = (semaLimit, rateLimit) => {
	const sema = new Sema(semaLimit)
	const limiter = RateLimit(rateLimit, {uniformDistribution: true})

	return fetch.bind({sema, limiter})
}

module.exports = {
	fetch,
	makeFetch,
}
