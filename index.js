const origFetch = require('node-fetch')
const AbortController = require('abort-controller')
const crypto = require('crypto')
const debug = require('debug')
const {Sema, RateLimit} = require('async-sema')
const dbg = debug('fetch')

const globalSema = new Sema(5)
const globalLimiter = RateLimit(10, {uniformDistribution: true})

const responseTypes = [
	'buffer',
	'blob',
	'arrayBuffer',
	'json',
	'text',
	'textConverted',
]
class HttpError extends Error {
	constructor(status, statusText, response, requestState) {
		const {
			id,
			options: {method},
			resource,
		} = requestState
		super(`HTTP error ${status} - ${statusText} (${id} ${method} ${resource})`)
		this.status = status
		this.statusText = statusText
		this.response = response
		this.requestState = requestState
		Error.captureStackTrace(this, HttpError)
	}
}

class TimeoutError extends Error {
	static messages = {
		noProgress: 'Timeout - no progress while fetching a body',
		body: 'Timeout while fetching a body',
		request: 'Timeout while making a request',
	}

	constructor(type, requestState) {
		const {
			id,
			options: {method},
			resource,
		} = requestState

		super(`${TimeoutError.messages[type]} (${id} ${method} ${resource})`)
		this.type = type
		this.resource = resource
		this.method = method
		this.requestState = requestState
		this.headers = requestState.headers
		Error.captureStackTrace(this, TimeoutError)
	}
}

const fetch = async (resource, origOptions, extraOptions = {retry: 1}) => {
	let err, res, sema, limiter
	if (!this.sema) sema = globalSema
	else sema = this.sema
	if (!this.limiter) limiter = globalLimiter
	else limiter = this.limiter

	const options = Object.assign({}, origOptions, extraOptions)

	const fetchState = {
		resource,
		options,
		retryCount: 0,
		fetchId: crypto.randomBytes(3).toString('hex'),
	}

	const fetchStats = {}

	const retry = () => {
		const attempt = fetchState.retryCount
		if (typeof extraOptions.retry === 'number') {
			if (attempt > 1)
				dbg(`Request #${fetchState.fetchId} - attempt no.${attempt}...`)
			if (attempt >= extraOptions.retry) {
				dbg(`Aborting request #${fetchState.fetchId} - too many attempts.`)
				if (err) throw err
				return false
			}
		} else if (typeof extraOptions.retry === 'function') {
			const retryResult = extraOptions.retry({
				error: err,
				response: res,
				fetchState,
			})

			if (typeof retryResult === 'object') {
				fetchState = retryResult
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
		if (options.timeouts) {
			controller = new AbortController()
			if (options.timeouts.request) {
				requestTimeout = setTimeout(() => {
					timeoutReason = 'request'
					controller.abort()
				}, options.timeouts.request)
			}
		}
		if (controller) {
			// it means that we break the api
			// by removing signal given by the user
			// todo: combine signals https://github.com/whatwg/fetch/issues/905#issuecomment-491970649
			options.signal = controller.signal
		}

		try {
			if (dbg.enabled)
				dbg(fetchState.id, options.method, fetchState.url, options)
			await sema.acquire()
			const now = Date.now()
			await limiter()
			if (dbg.enabled) {
				const ms = Date.now() - now
				if (ms > 5) dbg(`limiter waited ${ms}ms`)
			}
			res = await origFetch(resource, options)
			// TODO call validate with res without body
			options.validate(res, fetchState)
			clearTimeout(requestTimeout)
			if (options.throwOnBadStatus && !res.ok) {
				throw new HttpError(res.status, res.statusText, res, fetchState)
			}

			res.body.on('resume', () => {
				if (options.stallTimeout && !stallTimeout) {
					stallTimeout = setTimeout(() => {
						timeoutReason = 'noProgress'
						controller.abort()
					}, options.timeouts.noProgress)
				}
			})
			res.body.on('data', () => {
				if (!options.stallTimeout) return
				clearTimeout(stallTimeout)
				stallTimeout = setTimeout(() => {
					timeoutReason = 'noProgress'
					controller.abort()
				}, options.timeouts.noProgress)
			})
			res.body.on('close', () => {
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
			})

			res.body.on('error', err => {
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
				throw new HttpError(res.status, res.statusText, res, fetchState)
			})

			for (const fKey of responseTypes) {
				const prev = res[fKey]
				res[fKey] = async function (...args) {
					try {
						const result = prev.call(res, args)
						const validator =
							options[`validate${fKey[0].toUpperCase()}${fKey.slice(1)}`]
						await validator?.(res, result, fetchState)
						return result
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
			if (e.type === 'aborted' && timeoutReason) {
				err = new TimeoutError(timeoutReason, fetchState)
			}
			err = e

			dbg(`Error during request ${fetchState.fetchId}`, err)
		} finally {
			clearTimeout(requestTimeout)
			await sema.release()
		}
	} while (retry())
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
