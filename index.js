const origFetch = require('node-fetch')
const AbortController = require('abort-controller')
const crypto = require('crypto')
const debug = require('debug')
const {Sema, RateLimit} = require('async-sema')
const dbg = debug('fetch')

const sema = new Sema(5)
const limiter = RateLimit(10, {uniformDistribution: true})
class HttpError extends Error {
	constructor(status, statusText, response, requestState) {
		const {
			id,
			options: {method},
			url,
		} = requestState
		super(`HTTP error ${status} - ${statusText} (${id} ${method} ${url})`)
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
			url,
		} = requestState

		super(`${TimeoutError.messages[type]} (${id} ${method} ${url})`)
		this.type = type
		this.url = url
		this.method = method
		this.requestState = requestState
		if (dbg.enabled)
			dbg(`Request #${requestState.id} failed, reason - ${type} timeout`)
		Error.captureStackTrace(this, TimeoutError)
	}
}

const fetch = async (
	url,
	origOptions = {maxAttempts: 5, shouldRetry: null},
	requestState = {attempts: 0}
) => {
	requestState.url = url
	requestState.options = origOptions
	requestState.id ||= crypto.randomBytes(3).toString('hex')
	if (!requestState.attempts) requestState.attempts = 0
	if (!origOptions.maxAttempts) origOptions.maxAttempts = 5
	requestState.attempts++

	const options = {...origOptions}

	const wrapShouldRetry = () => {
		if (requestState.attempts >= options.maxAttempts) return false
		if (options.shouldRetry && typeof options.shouldRetry === 'function')
			return options.shouldRetry({url, origOptions, requestState})
		else return false
	}

	const retry = async (url, origOptions, requestState) => {
		dbg(`#${requestState.id} retry no.${requestState.attempts}...`)
		return await fetch(url, origOptions, requestState)
	}

	options.method = options.method.toUpperCase() || 'GET'
	let controller, requestTimeout, bodyTimeout, noProgressTimeout
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
	let res
	try {
		if (dbg.enabled)
			dbg(requestState.id, options.method, requestState.url, options)
		await sema.acquire()
		await limiter()
		if (dbg.enabled) {
			const ms = Date.now() - now
			if (ms > 5) dbg(`limiter waited ${ms}ms`)
		}
		res = await origFetch(url, options)
		clearTimeout(requestTimeout)
		if (options.throwOnBadStatus && !res.ok) {
			throw new HttpError(res.status, res.statusText, res, requestState)
		}

		res.body.on('resume', () => {
			if (options.timeouts?.body && !bodyTimeout) {
				bodyTimeout = setTimeout(() => {
					timeoutReason = 'body'
					controller.abort()
				}, options.timeouts.body)
			}
			if (options.timeouts?.noProgress && !noProgressTimeout) {
				noProgressTimeout = setTimeout(() => {
					timeoutReason = 'noProgress'
					controller.abort()
				}, options.timeouts.noProgress)
			}
		})
		res.body.on('data', () => {
			if (!options.timeouts?.noProgress) return
			clearTimeout(noProgressTimeout)
			noProgressTimeout = setTimeout(() => {
				timeoutReason = 'noProgress'
				controller.abort()
			}, options.timeouts.noProgress)
		})
		res.body.on('close', () => {
			clearTimeout(bodyTimeout)
			clearTimeout(noProgressTimeout)
		})
		for (const fKey of [
			'buffer',
			'blob',
			'arrayBuffer',
			'json',
			'text',
			'textConverted',
		]) {
			const f = res[fKey]
			res[fKey] = function (...args) {
				return f.call(res, args).catch(async e => {
					if (e.type === 'aborted' && timeoutReason) {
						if (wrapShouldRetry())
							return await retry(url, origOptions, requestState)
						throw new TimeoutError(timeoutReason, requestState)
					}
					throw e
				})
			}
		}
		return res
	} catch (e) {
		if (e.type === 'aborted' && timeoutReason) {
			if (wrapShouldRetry()) return await retry(url, origOptions, requestState)
			throw new TimeoutError(timeoutReason, requestState)
		}
		throw e
	} finally {
		clearTimeout(requestTimeout)
		await sema.release()
	}
}

module.exports = fetch
