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
		overall: 'Timeout while handling a request',
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

async function fetch(resource, options, fetchState) {
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
		signal,
		sema,
		limiter,
		...fetchOptions
	} = options

	let err, res

	if (!fetchState) {
		fetchState = {
			resource,
			options: fetchOptions,
			retryCount: 0,
			resCompletedResolve: null,
			fetchId,
			retry,
		}
	}

	const signalCompleted = (startTs = performance.now()) => {
		fetchStats.duration = (performance.now() - startTs) / 1000
		fetchStats.speed = fetchStats.size
			? Math.round(fetchStats.size / fetchStats.duration)
			: 0
		fetchStats.error = err
		fetchStats.ok = res?.ok
		fetchState.resCompletedResolve?.(fetchStats)
	}

	const shouldRetry = async () => {
		const attempt = fetchState.retryCount
		const retry = fetchState.retry
		if (typeof retry === 'number') {
			if (attempt > 1)
				dbg(`Request #${fetchState.fetchId} - attempt no.${attempt}...`)
			if (attempt >= retry) {
				dbg(`Aborting request #${fetchState.fetchId} - too many attempts.`)
				return false
			}
			return true
		} else if (typeof retry === 'function') {
			try {
				const retryResult = await retry({
					error: err,
					response: res,
					fetchState: fetchState,
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
			} catch (e) {
				err = e
			}
		} else return false
	}

	let fetchStats = {}
	do {
		fetchState.retryCount++
		fetchStats = {
			// bytes per seconds
			speed: 0,
			// in seconds
			duration: 0,
			// in bytes
			size: 0,
			error: err,
			ok: null,
			attempts: fetchState.retryCount,
		}

		err = null
		res = null
		let controller, requestTimeout, bodyTimeout, stallTimeout, overallTimeout
		let timeoutReason
		try {
			if (timeout && timeouts.length)
				throw new Error(
					'Specify general timeout in timeout option or divide timeouts in timeouts, not both at once'
				)
			if (timeouts || timeout || signal) {
				controller = new AbortController()
				fetchOptions.signal = controller.signal
				if (signal) {
					if (signal.aborted) controller.abort()
					signal.addEventListener(
						'abort',
						() => {
							controller.abort()
						},
						{once: true}
					)
				}
				if (timeouts?.request) {
					requestTimeout = setTimeout(() => {
						timeoutReason = 'request'
						controller.abort(timeoutReason)
					}, timeouts.request)
				}
			}

			if (timeout) {
				overallTimeout = setTimeout(() => {
					timeoutReason = 'overall'
				}, timeout)
			}

			if (dbg.enabled)
				dbg(
					fetchState.fetchId,
					fetchOptions.method,
					fetchState.resource,
					options
				)
			const now = performance.now()
			await limiter?.()

			res = await origFetch(resource, fetchOptions)

			if (validate) {
				resBody = res.body
				res.body = undefined
				validate(res, fetchState)
				res.body = resBody
			}

			clearTimeout(requestTimeout)

			let bodyStartTs = performance.now()
			res.body.on('resume', () => {
				if (timeouts?.stall && !stallTimeout) {
					stallTimeout = setTimeout(() => {
						timeoutReason = 'noProgress'
						controller.abort(timeoutReason)
					}, timeouts.stall)
				}
			})

			const stall = timeouts?.stall
			res.body.on('data', chunk => {
				fetchStats.size += Buffer.byteLength(chunk)
				if (!stall) return
				clearTimeout(stallTimeout)
				stallTimeout = setTimeout(async () => {
					timeoutReason = 'noProgress'
					controller.abort(timeoutReason)
				}, stall)
			})
			res.body.on('close', () => {
				signalCompleted(bodyStartTs)
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
			})

			res.body.on('error', err => {
				clearTimeout(bodyTimeout)
				clearTimeout(stallTimeout)
				controller.abort(timeoutReason)
			})

			for (const fKey of responseTypes) {
				const prev = res[fKey]
				res[fKey] = async (...args) => {
					try {
						if (timeouts?.body && !bodyTimeout) {
							bodyTimeout = setTimeout(() => {
								timeoutReason = 'body'
								// throw in async don't work in outer try...catch
								err = new TimeoutError(timeoutReason, fetchState)
							}, timeouts.body)
						}
						const result = await prev.call(res, args)
						const validator =
							options[`validate${fKey[0].toUpperCase()}${fKey.slice(1)}`]
						await validator?.(res, result, fetchState)
						if (err?.type === 'body') throw err
						return result
					} catch (e) {
						if (e.type === 'aborted' && timeoutReason) {
							throw new TimeoutError(timeoutReason, fetchState)
						}

						if (
							await shouldRetry({
								fetchState: fetchState,
								error: err,
								response: res,
							})
						) {
							return await fetch(resource, fetchState.options, fetchState)
						} else {
							fetchState.resCompletedResolve?.(fetchStats)
							throw e
						}
					} finally {
						clearTimeout(bodyTimeout)
					}
				}
			}

			res.completed = new Promise(resolve => {
				fetchState.resCompletedResolve = resolve
			})
			res.retryCount = fetchState.retryCount
		} catch (e) {
			if (e.type === 'aborted' && timeoutReason) {
				err = new TimeoutError(timeoutReason, fetchState)
			} else err = e

			dbg(`Error during request #${fetchState.fetchId}`, err)
		} finally {
			signal?.removeEventListener('abort')
			clearTimeout(requestTimeout)
		}
	} while (await shouldRetry())

	if (err) throw err
	dbg(`Request #${fetchId} finished.`)
	return res
}

const makeFetch = (maxParallel, maxRps) => {
	const sema = maxParallel ? new Sema(maxParallel) : null
	const limiter = maxRps ? RateLimit(maxRps, {uniformDistribution: true}) : null

	return async (resource, options) => {
		await sema.acquire()
		let res
		try {
			res = await fetch(resource, {
				...options,
				sema,
				limiter,
			})
			res.stats = await res.completed()
		} catch (e) {
			throw e
		} finally {
			await sema.release()
		}
		return res
	}
}

module.exports = fetch
exports.makeFetch = makeFetch
