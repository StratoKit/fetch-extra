class HttpError extends Error {
	constructor(status, statusText, response, state) {
		const {
			fullId,
			options: {method},
			resource,
		} = state
		super(`${fullId} HTTP ${status} - ${statusText} (${method} ${resource})`)
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
			fullId,
			options: {method},
			resource,
			startTs,
			bodyTs,
		} = state
		const now = performance.now()
		const reqMs = Math.round(bodyTs ? bodyTs - startTs : now - startTs)
		const bodyMs = Math.round(bodyTs ? now - bodyTs : 0)
		super(
			`${fullId} Timeout: ${type} (${method} ${resource} - ${
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

module.exports = {HttpError, TimeoutError}
