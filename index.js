const origFetch = require('node-fetch')
const AbortController = require('abort-controller')
const crypto = require('crypto')

class TimeoutError extends Error {
	constructor(type, url, method, reqId) {
		super(
			type === 'noProgress'
				? `Timeout - no progress while fetching a body (${reqId} ${method} ${url})`
				: type === 'body'
				? `Timeout while fetching a body (${reqId} ${method} ${url})`
				: `Timeout while making a request (${reqId} ${method} ${url})`
		)
		this.type = type
		this.url = url
		this.method = method
		this.reqId = reqId
		Error.captureStackTrace(this, TimeoutError)
	}
}

const fetch = async (url, options = {}, requestState = {}) => {
	options.method = options.method.toUpperCase() || 'GET'
	if (!requestState.id) {
		requestState.id = crypto.randomBytes(3).toString('hex')
	}
	if (!requestState.attempts) {
		requestState.attempts = 0
	}
	let controller, requestTimeout, bodyTimeout, noProgressTimeout
	let timeoutReason
	if (options.timeouts) {
		controller = new AbortController()
		if (options.timeouts.request) {
			requestTimeout = setTimeout(() => {
				controller.abort()
			}, options.timeouts.request)
		}
	}
	if (controller) {
		options.signal = controller.signal
	}
	let res
	try {
		res = await origFetch(url, options)
		clearTimeout(requestTimeout)

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
				return f.call(res, args).catch(e => {
					if (e.type === 'aborted') {
						throw new TimeoutError(
							timeoutReason,
							url,
							options.method,
							requestState.id
						)
					}
					throw e
				})
			}
		}
		return res
	} catch (e) {
		if (e.type === 'aborted') {
			throw new TimeoutError(
				timeoutReason,
				url,
				options.method,
				requestState.id
			)
		}
		throw e
	} finally {
		clearTimeout(requestTimeout)
	}
}

module.exports = fetch
